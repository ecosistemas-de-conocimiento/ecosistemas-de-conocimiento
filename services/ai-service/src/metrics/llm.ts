// LLM / budget metrics. EMIT SIDE ONLY.
//
// This module owns the metric DEFINITIONS and the increment helpers. It does
// NOT own `/metrics`, the Fastify plugin, or the registry wiring — those live in
// `src/metrics/registry.ts`, `src/server.ts` and `src/routes/metrics.ts`.
// Everything here registers on the registry `registry.ts` exports, which is
// exactly the one `GET /metrics` scrapes.
//
// ⚠ NEVER IMPORT THE CLIENT BY PACKAGE NAME HERE — take it from
// `./registry.js`. Two copies of a prometheus client in one process means two
// default registries, and a counter on the one nothing scrapes increments
// correctly and never appears on `/metrics`. `registry.ts` documents the three
// interchangeable-looking package names that make that mistake easy.
//
// ⚠ REGISTRATION IS IDEMPOTENT, ON PURPOSE. the client THROWS on a duplicate
// metric name, and this module is imported by the router, the budget enforcer
// and their tests — under vitest a module graph can be instantiated more than
// once per process (module mocking, `vi.resetModules`, several config files in
// one run). A throw there would fail tests for a reason that has nothing to do
// with the code under test, so every metric goes through `reuse` (from
// `./registry.js`), which
// hands back the already-registered instrument instead.
//
// ⚠ LABEL CARDINALITY. `org` is a tenant identifier and therefore unbounded in
// principle. It is on the COST counter only — the one number an operator
// genuinely needs per tenant — and deliberately NOT on the pass counter, where
// it would multiply by `purpose × status`. It is never joined by `project`,
// `unitKey`, `model` or `traceId`: those are trace/usage-row columns, and a
// time series per unit key is how a Prometheus falls over.

// The client and the idempotent-registration helper both come from
// `./registry.js` — never from the package name. See that module's header: two
// copies of a prometheus client in one process means two default registries,
// and a counter on the one `GET /metrics` does not serve is invisible.
import { client, reuse } from './registry.js';

const { Counter, Gauge } = client;

/**
 * One provider pass. `purpose` mirrors `RouteResult.breakdown[].purpose`
 * ('generate' | 'critique' | 'refine' | 'sample'), so a spike in `refine` reads directly as
 * "first-pass output is failing validation more often".
 *
 * `status`:
 *   · `success`   — the adapter returned a completion.
 *   · `failure`   — it threw, and the failure was not one of the below.
 *   · `aborted`   — client disconnect or the wall-clock deadline (billing path;
 *                   partial tokens WERE spent).
 *   · `unavailable` — the circuit was open, so the provider was never dialled.
 *
 * `aborted` is split out because it is the one failure that still COSTS money,
 * and `unavailable` because it is the one that costs neither money nor a
 * socket — folding either into `failure` makes an outage and a cancel-storm
 * look identical on the graph.
 */
export const llmPassTotal = reuse(
  'ai_llm_pass_total',
  () =>
    new Counter({
      name: 'ai_llm_pass_total',
      help: 'LLM provider passes attempted, by purpose and outcome.',
      labelNames: ['purpose', 'status'] as const,
    }),
);

/** Cumulative provider spend, per org. USD. */
export const llmCostUsdTotal = reuse(
  'ai_llm_cost_usd_total',
  () =>
    new Counter({
      name: 'ai_llm_cost_usd_total',
      help: 'Cumulative LLM provider cost in USD, by org.',
      labelNames: ['org'] as const,
    }),
);

/**
 * Budget refusals, by REMEDY — which is the only reason the three budget error
 * classes are separate in the first place (see `services/budget/errors.ts`).
 *
 *   · `exceeded`       — top the org up.
 *   · `not_configured` — provision a cap; the org has no `budget_state` row.
 *   · `misconfigured`  — fix `estimatedCostUsdPerCall` on the effort profile.
 *
 * `misconfigured` climbing is an ADMIN error and is the one to alert on: it
 * means an org is being refused service by a config fault, not by spend.
 */
export const budgetRefusalsTotal = reuse(
  'ai_budget_refusals_total',
  () =>
    new Counter({
      name: 'ai_budget_refusals_total',
      help: 'Budget refusals, by remedy (exceeded | not_configured | misconfigured).',
      labelNames: ['reason'] as const,
    }),
);

/**
 * Circuit-breaker state per provider: 0 closed, 1 open, 2 half-open,
 * 3 isolated. The numbering is cockatiel's `CircuitState` enum verbatim, so
 * the gauge and a heap dump agree.
 *
 * A GAUGE, not a counter — it is a level, not an accumulation. Set from the
 * router after every pass rather than on a timer: a state change that nobody
 * scrapes is a state change nobody can alert on, and the router is the only
 * thing that touches the breaker.
 */
export const breakerState = reuse(
  'ai_breaker_state',
  () =>
    new Gauge({
      name: 'ai_breaker_state',
      help: 'LLM provider circuit-breaker state: 0=closed 1=open 2=half-open 3=isolated.',
      labelNames: ['provider'] as const,
    }),
);

/**
 * Mirrors `RouteResult.breakdown[].purpose` EXACTLY — including `critique`,
 * which the current router never emits but the wire type allows. Keeping the
 * union identical means a future purpose is a compile error here rather than a
 * silently unlabelled metric.
 */
export type PassPurpose = 'generate' | 'critique' | 'refine' | 'sample';
export type PassStatus = 'success' | 'failure' | 'aborted' | 'unavailable';
export type RefusalReason = 'exceeded' | 'not_configured' | 'misconfigured';

/**
 * Record one pass outcome, and its cost when there was one.
 *
 * Never throws: a metrics backend is not allowed to fail a generation. The
 * only realistic thrower is a label-value type error, and losing a data point
 * beats losing a completion the org has already paid for.
 */
export function recordPass(args: {
  purpose: PassPurpose;
  status: PassStatus;
  org?: string;
  costUsd?: number;
}): void {
  try {
    llmPassTotal.inc({ purpose: args.purpose, status: args.status });
    if (args.org && typeof args.costUsd === 'number' && Number.isFinite(args.costUsd) && args.costUsd > 0) {
      llmCostUsdTotal.inc({ org: args.org }, args.costUsd);
    }
  } catch {
    // See the doc comment.
  }
}

/** Record a budget refusal. Never throws — same reasoning as `recordPass`. */
export function recordBudgetRefusal(reason: RefusalReason): void {
  try {
    budgetRefusalsTotal.inc({ reason });
  } catch {
    // See `recordPass`.
  }
}

/** Publish the current breaker state. Never throws — same reasoning. */
export function recordBreakerState(provider: string, state: number): void {
  try {
    breakerState.set({ provider }, state);
  } catch {
    // See `recordPass`.
  }
}

/**
 * `/v1/route` answered with the default route instead of a model choice. One
 * tick per fallback, labelled by `cause` (see `RouteFallbackCause`): a 200 that
 * hides a provider error must still show up on a graph. Measured:
 * 14/14 calls fell back silently on a provider 400.
 */
export const routeFallbackTotal = reuse(
  'ai_route_fallback_total',
  () =>
    new Counter({
      name: 'ai_route_fallback_total',
      help: '/v1/route answers that used the default route instead of a model choice, by cause.',
      labelNames: ['cause'] as const,
    }),
);

/** Never throws — same reasoning as `recordPass`. */
export function recordRouteFallback(cause: string): void {
  try {
    routeFallbackTotal.inc({ cause });
  } catch {
    // See `recordPass`.
  }
}
