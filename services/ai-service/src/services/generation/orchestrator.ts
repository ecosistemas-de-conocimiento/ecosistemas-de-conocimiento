// Generation orchestrator — entry point of `POST /v1/generate`.
//
// Walks the 13-step pipeline laid out in plan/m3-step5-detailed-plan.md §B:
// resolve deps → idempotency probe → per-unit spec resolution → DAG validation
// → context fetch → two-phase prompt render → estimate → transactional inserts
// → transactional inserts (NO budget movement — see below) → FlowProducer
// enqueue (DAG-aware) → emit start event → return handle.
//
// Two-phase rendering (§B step 6 + plan/m3-m4-decisions.md §16 amendment):
// leaf units render now; dependent units defer to the worker because their
// predecessor outputs literally don't exist yet.
//
// ── 🔴 WHY THERE IS NO BATCH RESERVE HERE ─────────────────────────────────
// This function used to reserve the WHOLE-request estimate inside the insert
// transaction. Nothing ever released it. The only refund/adjust callers in the
// service are the router (its own PER-CALL reserve/true-up) and
// `routes/embed.ts`, so the batch estimate stayed subtracted from
// `budget_state.remaining_usd` forever.
//
// MEASURED before the fix: remaining 10 → 9.999263 on `POST /v1/generate`,
// still 9.999263 after the job completed with actual cost 0; on a 2-trace run
// remaining ended at 10 − 0.000737 − 0.000106 — the stranded estimate sitting
// on top of the real cost. Every batch leaked its estimate, so a busy org
// drifted to a false $0 and started 402-ing on money it had never spent.
//
// THREE FIXES WERE ON THE TABLE — release per job as the router's per-call
// reserve takes over; release the whole batch when the request goes terminal;
// or drop the batch reserve. We dropped it, because the other two add release
// paths that must fire on EVERY terminal route (completed, failed, cancelled,
// orphaned row, worker killed mid-job) and any one of them missing recreates
// exactly this leak — while double-holding the money in the meantime, since
// the router reserves per call anyway.
//
// WHAT STILL ENFORCES THE CAP (ADR-0003 D5 fail-closed is UNCHANGED):
//   1. `budget.assertConfigured(org)` below — an org with no `budget_state`
//      row gets a 402 `BudgetNotConfigured` UP FRONT, before any work.
//   2. The advisory `estimateBatch` gate below — a batch whose estimate
//      exceeds `remaining_usd` is rejected with 402 `BudgetExceeded` up front.
//   3. `BudgetEnforcer.reserve()` inside the router, per LLM call, which is
//      the ATOMIC boundary that actually moves money and refuses when the row
//      cannot cover the call. It is already the sole enforcement on
//      `/v1/generate/sync` and `/v1/generate/stream`; the async path now
//      matches it instead of holding a second, never-released claim.
//
// Net invariant, asserted in `orchestrator-budget.integration.test.ts`:
// after a batch settles, `remaining_usd == initial − Σ(actual cost)`.
//
// ── RESIDUAL EXPOSURE, STATED HONESTLY ────────────────────────────────────
// The advisory gate above is not a lock: any number of batches can pass it
// concurrently. What actually bounds spend is the router's per-call atomic
// reserve — but `BudgetEnforcer.adjust()` (the true-up after a call) has NO
// FLOOR, so an actual cost above its reserve pushes `remaining_usd` down past
// where the reserve alone would have stopped.
//
// The bound is therefore NOT "one call's estimate". It is:
//
//   overshoot ≤ Σ over all CONCURRENTLY IN-FLIGHT calls of
//               max(0, actual_cost − reserved_estimate)
//
// and "concurrently in-flight" spans the whole deployment: `concurrency: 5`
// per generation-worker replica, plus every in-flight `/v1/generate/sync` and
// `/v1/generate/stream` call, which reserve on the same row. With N workers
// that is 5N + (open sync/stream calls) simultaneous true-ups.
//
// We still prefer this to the old code, and the reason is the SHAPE of the
// error, not its size: this gap is bounded by in-flight concurrency and
// SELF-CORRECTING (each true-up settles to the real cost, and the next
// reserve sees the true remaining), whereas the batch reserve leaked a
// PERMANENT, UNBOUNDED amount — every batch ever enqueued stayed subtracted
// forever, drifting a busy org to a false $0. A transient overshoot that
// heals is strictly better than a monotonic leak that does not.
//
// Same bound the sync path has always carried; making it explicit here so a
// future reader does not mistake the per-call reserve for a hard cap.

import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import type { FlowJob } from 'bullmq';

import { db as defaultDb, type Db } from '../../db/client.js';
import { generationJobs, generationRequests } from '../../db/schema/index.js';
import { BudgetEnforcer } from '../budget/enforcer.js';
import { BudgetExceeded } from '../budget/errors.js';
import { getEventBus, type EventBus } from '../events/bus.js';
import { fetchContext } from '../context/fetch.js';
import type { RetrieveLogger } from '../rag/retrieve.js';
import {
  checkIdempotency,
  hashPayload,
  IdempotencyConflictError,
} from '../idempotency.js';
import {
  GENERATION_QUEUE_NAME,
  generationJobName,
  orgPriorityBucket,
  type GenerationQueueLike,
  type MockFlowProducer,
  type MockJobNode,
  type Queues,
} from '../../queue/queues.js';
import { renderPrompt } from '../render/handlebars.js';
import {
  resolveSpec,
  type ResolvedSpec,
} from '../registry/resolve.js';
import type {
  GenerateRequest,
  LaunchGenerationResult,
  ResolvedUnit,
  Unit,
} from '../../types/generation.js';

import { estimateBatch } from './estimate.js';
import {
  BudgetExceededError,
  BudgetMisconfigured,
  BudgetNotConfigured,
  CrossBatchDependencyError,
  DependencyCycleError,
} from './types.js';

// Re-exports for the route layer's error mapping (one import surface).
export {
  BudgetExceededError,
  BudgetMisconfigured,
  BudgetNotConfigured,
  CrossBatchDependencyError,
  DependencyCycleError,
};
export { IdempotencyConflictError } from '../idempotency.js';
export { SpecResolutionError } from '../registry/resolve.js';

// ---------------------------------------------------------------------------
// Dependency injection surface
// ---------------------------------------------------------------------------

export interface OrchestratorDeps {
  db?: Db;
  /** The generation queue. Required — see the resolution block in `enqueueGeneration`. */
  queue: GenerationQueueLike;
  /** The generation flow producer (parent/child `dependsOn` fan-out). Required. */
  flow: Queues['flow'];
  resolver?: typeof resolveSpec;
  bus?: EventBus;
  budget?: BudgetEnforcer;
  rng?: () => string;
  clock?: () => Date;
  /**
   * Logger forwarded to the context fetch, so the RAG retrieve it performs can
   * warn when it clamps an over-bound stored chunk. Without it that warn is
   * swallowed on the async generate path.
   */
  logger?: RetrieveLogger;
}

export interface OrchestratorCtx {
  org: string;
  project: string;
  requestedBy?: string;
  /**
   * SHA-256(api-key) fingerprint — captured on `generation_requests.api_key_id`
   * so the callback emitter can look up the per-consumer `callbackSecret`
   * later from `env.API_KEYS`.
   */
  apiKeyId?: string;
  /**
   * Per-HTTP-request correlation id, minted at the edge and carried into the
   * BullMQ payload so a worker log line can be tied back to the inbound call
   * that enqueued it.
   *
   * ⚠ NOT `requestId`. In this service `requestId` already means
   * `generation_requests.id` — the DB row for a batch, which outlives the HTTP
   * call and is shared by every unit in it. `httpRequestId` is the transport
   * id and is deliberately named so the two can never be confused at a call
   * site. Not persisted: it rides the job payload only.
   */
  httpRequestId?: string;
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export async function enqueueGeneration(
  req: GenerateRequest,
  ctx: OrchestratorCtx,
  deps: OrchestratorDeps,
): Promise<LaunchGenerationResult> {
  // ── Step 1. Resolve deps with defaults. ─────────────────────────────────
  const db = deps.db ?? defaultDb;
  // 🔴 REQUIRED, NOT DEFAULTED. These used to fall back to
  // `getGenerationQueue()` / `getGenerationFlowProducer()` — module-scope
  // singletons, so the queue a caller actually enqueued to was invisible at the
  // call site. The HTTP layer passes `app.runtime.queues.*`; tests pass their
  // own runtime's.
  const flow = deps.flow;
  const resolver = deps.resolver ?? resolveSpec;
  const bus = deps.bus ?? getEventBus();
  const budget = deps.budget ?? new BudgetEnforcer(db);
  const clock = deps.clock ?? (() => new Date());
  const rng = deps.rng ?? (() => randomUUID());

  // ── Step 2. Idempotency check (only when caller supplied a key). ────────
  // Hash excludes `requestedBy` + `callbackUrl` (transport-level — same units
  // + same effort knobs == same generation request).
  // `systemPromptOverride` is semantic (it changes what the model is told), so
  // it belongs in the hash. `safe-stable-stringify` drops `undefined` values,
  // so adding the key leaves the hash byte-identical for every caller that
  // doesn't send one — existing idempotency keys keep replaying, not conflicting.
  const payloadHash = hashPayload({
    units: req.units,
    effortLevel: req.effortLevel,
    effortOverrides: req.effortOverrides,
    promptOverride: req.promptOverride,
    modelOverride: req.modelOverride,
    systemPromptOverride: req.systemPromptOverride,
    includeContext: req.includeContext,
  });

  let staleId: string | null = null;
  if (req.clientRequestId) {
    const decision = await checkIdempotency(db, {
      org: ctx.org,
      clientRequestId: req.clientRequestId,
      payloadHash,
      windowMs: 24 * 3600 * 1000,
      clock,
    });
    if (decision.kind === 'replay') return decision.existing;
    if (decision.kind === 'conflict') {
      throw new IdempotencyConflictError(decision.existingRequestId);
    }
    // `new` ⇒ either no prior row, or the prior row is stale. The
    // idempotency helper doesn't expose the stale id, so probe once more
    // for a same-key row and capture its id for DELETE-in-tx (step 9).
    //
    // 🔴 `eq(generationRequests.org, ctx.org)` IS LOAD-BEARING AND WAS MISSING.
    // Without it this probe matched ANY org's row for the key, and its result
    // goes straight to `tx.delete(generationRequests).where(eq(id, staleId))`
    // in step 9 — with `generation_jobs` cascading. `clientRequestId` is
    // caller-supplied (`z.string().min(1).max(200)`) and never namespaced, and
    // the unique index is `("org","client_request_id")`, so the same key
    // legitimately exists in two orgs. `checkIdempotency` above IS org-scoped,
    // which is exactly what made the hole reachable: it returns `new` for the
    // caller's org precisely when the only row holding the key belongs to
    // SOMEONE ELSE, and this probe then resolved to that someone else's row and
    // deleted it. Any authenticated app key could destroy another tenant's
    // finished generation batch by guessing a correlation id.
    //
    // Proven by `src/routes/tenant-isolation.integration.test.ts` →
    // "cross-ORG: A enqueueing with B's clientRequestId does NOT delete B's
    // request or its jobs", which read the victim's rows back and found
    // `{ requests: 0, jobs: 0 }` before this line existed.
    const priorRows = await db
      .select({ id: generationRequests.id })
      .from(generationRequests)
      .where(
        and(
          eq(generationRequests.org, ctx.org),
          eq(generationRequests.clientRequestId, req.clientRequestId),
        ),
      )
      .limit(1);
    if (priorRows[0]) staleId = priorRows[0].id;
  }

  // ── Step 3. Per-unit spec resolution. ───────────────────────────────────
  const specs: ResolvedSpec[] = await Promise.all(
    req.units.map((u) =>
      resolver(db, {
        org: ctx.org,
        project: ctx.project,
        unitType: u.unitType,
        unitKey: u.unitKey,
        specOverride: u.specOverride,
        // FLOOR — see `SpecDefault` in services/registry/resolve.ts. Resolved
        // here for the estimate AND re-resolved by the worker, so it must be
        // persisted onto the row below (`input.__specDefault`).
        specDefault: u.specDefault,
        requestOverrides: {
          promptOverride: req.promptOverride,
          modelOverride: req.modelOverride,
          effortLevel: req.effortLevel,
          effortOverrides: req.effortOverrides,
        },
      }),
    ),
  );

  // ── Step 4. DAG construction + cross-batch validation + cycle detection.
  validateDag(req.units);

  // ── Step 5. Context fetch (M3 stub returns {} per fetchContext). ────────
  const contextMap = await fetchContext({
    org: ctx.org,
    project: ctx.project,
    includeContext: req.includeContext,
    ...(deps.logger ? { logger: deps.logger } : {}),
  });

  // ── Step 6. Two-phase prompt rendering. ─────────────────────────────────
  // Leaf units render now; dependent units defer to the worker (their
  // predecessor outputs aren't known yet). See decisions §16 amendment.
  const resolvedUnits: ResolvedUnit[] = req.units.map((unit, i) => {
    const spec = specs[i]!;
    const hasDeps = unit.dependsOn && Object.keys(unit.dependsOn).length > 0;
    let renderedPromptOrTemplate: string;
    let rendered: boolean;
    if (hasDeps) {
      renderedPromptOrTemplate = spec.promptTemplate;
      rendered = false;
    } else {
      const vars = { ...(unit.input ?? {}), __context: contextMap };
      renderedPromptOrTemplate = renderPrompt(spec.promptTemplate, vars);
      rendered = true;
    }
    const profile = spec.effortProfile;
    const estimatedCostUsd =
      profile.estimatedCostUsdPerCall *
      profile.validationPasses *
      profile.multiSample;
    return {
      unit,
      spec,
      estimatedCostUsd,
      renderedPromptOrTemplate,
      rendered,
    };
  });

  // ── Step 7. Variable merging — documented for the worker; nothing to do
  //    here beyond having already stashed `__context` and `__promptVars` on
  //    the per-unit input below in step 9.

  // ── Step 8. Cost estimate + advisory budget gate. ───────────────────────
  // Fail-closed (ADR-0003 D5): reject up-front with a clear "no budget
  // configured" 402 when the org has no explicit cap, rather than letting the
  // estimate gate bottom out as a $0 BudgetExceeded. The atomic reserve in
  // step 9 enforces the same invariant, so this is the friendly early exit.
  await budget.assertConfigured(ctx.org);
  const remaining = await budget.getRemaining(ctx.org);
  const estimate = estimateBatch(resolvedUnits, remaining);
  if (estimate.overBudget) {
    throw new BudgetExceeded(
      ctx.org,
      estimate.estimatedCostUsd,
      estimate.budgetRemainingUsd ?? 0,
    );
  }
  // Soft-cap warning for the launch response. It used to fall out of the batch
  // reserve's `ReserveResult`; with the reserve gone it is probed directly so
  // the `BUDGET_SOFT_CAP` warning consumers already parse keeps arriving
  // unchanged.
  //
  // 🔴 THE ESTIMATE IS PASSED ON PURPOSE. The old reserve judged the soft cap
  // on the POST-reserve remaining, so the batch that CROSSES the threshold is
  // the batch that warns. Probing the PRE-spend remaining warns one batch late
  // — measured on real Postgres (limit 100, soft_cap_pct 90 ⇒ threshold 10,
  // remaining 10.5, estimate 1.0): post-spend 9.5 fires, pre-spend 10.5 does
  // not. A consumer can treat this as its one advance notice, so losing the crossing
  // batch's warning is a consumer-visible regression.
  const reserveSoftCap = await budget.checkSoftCap(
    ctx.org,
    estimate.estimatedCostUsd,
  );

  // ── Step 9. Transaction: stale-row delete (if any) + request row insert
  //    + per-unit job rows. No budget movement — see the header. ─────────
  const insertedJobIds: string[] = [];
  let requestId = '';
  await db.transaction(async (tx) => {
    if (staleId) {
      await tx
        .delete(generationRequests)
        .where(eq(generationRequests.id, staleId));
    }

    const requestInsert = await tx
      .insert(generationRequests)
      .values({
        org: ctx.org,
        project: ctx.project,
        requestedBy: ctx.requestedBy ?? req.requestedBy ?? null,
        clientRequestId: req.clientRequestId ?? null,
        status: 'queued',
        totalJobs: req.units.length,
        effort: req.effortLevel ?? 'standard',
        effortOverrides: req.effortOverrides ?? null,
        promptOverride: req.promptOverride ?? null,
        // Batch-wide system prompt. The column has existed since 0001 and was
        // never written; the worker now reads it as precedence level 3.
        metaPromptOverride: req.systemPromptOverride ?? null,
        modelOverride: req.modelOverride ?? null,
        includeContext: req.includeContext ?? null,
        callbackUrl: req.callbackUrl ?? null,
        apiKeyId: ctx.apiKeyId ?? null,
        estimatedCostUsd: estimate.estimatedCostUsd.toFixed(6),
        metadata: {
          payloadHash,
          contextResolved: contextMap,
          ...(req.metadata ?? {}),
        },
        startedAt: clock(),
      })
      .returning({ id: generationRequests.id });
    requestId = requestInsert[0]!.id;

    for (const ru of resolvedUnits) {
      const unit = ru.unit;
      const spec = ru.spec;
      const baseInput = { ...(unit.input ?? {}), __context: contextMap };
      let input: Record<string, unknown>;
      if (ru.rendered) {
        input = { ...baseInput, __renderedPrompt: ru.renderedPromptOrTemplate };
      } else {
        input = {
          ...baseInput,
          __promptTemplate: spec.promptTemplate,
          __promptVars: baseInput,
          __dependencySlots: unit.dependsOn,
        };
      }
      // Per-unit system prompt rides alongside `__renderedPrompt` on the row's
      // `input` jsonb (no migration needed). Deliberately NOT folded into
      // `__promptVars` — it is payload for the worker, not a template variable.
      if (unit.systemPrompt) input.__systemPrompt = unit.systemPrompt;
      // Same trick for the spec FLOOR: the worker re-resolves the spec at
      // execution time, so a `specDefault` that lived only on the request body
      // would silently vanish between enqueue and run — the unit would resolve
      // with no prompt and fail, or worse, resolve differently than the
      // estimate assumed. `spec_override` has its own column; this rides on
      // `input` instead (no migration), exactly like `__systemPrompt`.
      // Deliberately NOT folded into `__promptVars` — payload, not a variable.
      if (unit.specDefault) input.__specDefault = unit.specDefault;

      const inserted = await tx
        .insert(generationJobs)
        .values({
          generationRequestId: requestId,
          org: ctx.org,
          project: ctx.project,
          unitKey: unit.unitKey,
          unitType: unit.unitType ?? null,
          dependsOn: unit.dependsOn ?? null,
          input,
          registryEntryId: spec.registryEntryId ?? null,
          specOverride: unit.specOverride ?? null,
          status: 'queued',
          attempts: 0,
          effort: spec.effortLevel,
          priority: orgPriorityBucket(ctx.org),
          estimatedCostUsd: ru.estimatedCostUsd.toFixed(6),
          // The EXACT amount `RouterImpl.budgetReserve` will hold per provider
          // call for this unit. `estimated_cost_usd` above is this number
          // multiplied by `validationPasses × multiSample`, which is the right
          // number to quote a consumer and the WRONG number to refund when a
          // worker dies with one reserve outstanding. Recorded here so the
          // lost-worker reaper refunds exactly what was taken — see
          // `lostReserveUsd` in src/workers/generation.worker.ts.
          metadata: { reservePerCallUsd: spec.effortProfile.estimatedCostUsdPerCall },
          traceId: rng(),
        })
        .returning({ id: generationJobs.id });
      insertedJobIds.push(inserted[0]!.id);
    }
  });

  // ── Step 10. Enqueue via FlowProducer — DAG-aware. ──────────────────────
  // Build a unitKey → jobId map for FlowJob.data, then memoise FlowJob
  // construction so shared predecessors aren't duplicated. Predecessors are
  // BullMQ "children" (they must complete before this unit runs).
  const jobIdByUnitKey = new Map<string, string>();
  req.units.forEach((u, i) => jobIdByUnitKey.set(u.unitKey, insertedJobIds[i]!));
  const unitByKey = new Map<string, Unit>();
  for (const u of req.units) unitByKey.set(u.unitKey, u);

  const flowJobMemo = new Map<string, FlowJob>();
  const buildFlowJobFor = (unitKey: string): FlowJob => {
    const cached = flowJobMemo.get(unitKey);
    if (cached) return cached;
    const unit = unitByKey.get(unitKey)!;
    const children: FlowJob[] = [];
    if (unit.dependsOn) {
      for (const predKey of Object.values(unit.dependsOn)) {
        children.push(buildFlowJobFor(predKey));
      }
    }
    const job: FlowJob = {
      name: generationJobName(ctx.org, unit.unitType),
      queueName: GENERATION_QUEUE_NAME,
      data: {
        jobId: jobIdByUnitKey.get(unitKey)!,
        generationRequestId: requestId,
        org: ctx.org,
        project: ctx.project,
        unitKey,
        // Transport correlation id, forwarded verbatim so worker logs can be
        // joined to the inbound HTTP call. Omitted (not `undefined`) when the
        // caller supplied none, so the payload stays byte-identical for
        // consumers that don't send one.
        ...(ctx.httpRequestId ? { httpRequestId: ctx.httpRequestId } : {}),
      },
      opts: { priority: orgPriorityBucket(ctx.org) },
      ...(children.length > 0 ? { children } : {}),
    };
    flowJobMemo.set(unitKey, job);
    return job;
  };

  // Roots are units NOT referenced by anyone's dependsOn (they aren't
  // predecessors to anything ⇒ FlowProducer treats them as the top-level
  // parents). Note: in our model dependent units are PARENTS of their
  // predecessor CHILDREN, so a unit with no inbound reference (= nothing
  // depends on it) sits at the top of the tree.
  const referenced = new Set<string>();
  for (const u of req.units) {
    if (u.dependsOn) {
      for (const predKey of Object.values(u.dependsOn)) referenced.add(predKey);
    }
  }
  const rootKeys = req.units
    .map((u) => u.unitKey)
    .filter((k) => !referenced.has(k));

  // Mock FlowProducer exposes `add`; real bullmq FlowProducer does too. Use
  // `add` per-root to keep the surface uniform between mock + real impls.
  const jobNodes: Array<MockJobNode | { job: { id?: string }; children?: unknown[] }> = [];
  for (const key of rootKeys) {
    const node = await flow.add(buildFlowJobFor(key));
    jobNodes.push(node as MockJobNode);
  }

  // Step 10b. Stamp `queueJobId` for each job (best-effort; used by cancel).
  // Walk the JobNode tree to pull BullMQ ids paired with our jobId in
  // `data`. Done outside the transaction — failure here is non-fatal.
  const queueIdByJobId = new Map<string, string>();
  for (const node of jobNodes) collectQueueIds(node as MockJobNode, queueIdByJobId);
  for (const [jobId, queueJobId] of queueIdByJobId) {
    await db
      .update(generationJobs)
      .set({ queueJobId })
      .where(eq(generationJobs.id, jobId))
      .catch(() => undefined);
  }

  // ── Step 11. Channel computation. ───────────────────────────────────────
  const channel = `request:${requestId}:generations`;

  // ── Step 12. Emit start event. ──────────────────────────────────────────
  bus.emit({
    type: 'generation.request.started',
    requestId,
    org: ctx.org,
    project: ctx.project,
    totalJobs: req.units.length,
    estimatedCostUsd: estimate.estimatedCostUsd,
  });

  // ── Step 13. Return handle. ─────────────────────────────────────────────
  // `warnings` surfaces transient advisory flags (today: only soft-cap).
  // Reserved for future codes — consumers should treat unknown codes as
  // informational.
  const warnings = reserveSoftCap
    ? [
        {
          code: 'BUDGET_SOFT_CAP' as const,
          message: `Budget is below 10% remaining for org=${ctx.org}`,
        },
      ]
    : undefined;
  return {
    requestId,
    channel,
    totalJobs: req.units.length,
    estimatedCostUsd: estimate.estimatedCostUsd,
    ...(warnings ? { warnings } : {}),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Walks the resulting JobNode tree (mock or real) and links each BullMQ job
 * id to our `generation_jobs.id` (carried inside `data.jobId`).
 */
function collectQueueIds(
  node: MockJobNode | { job: { id?: string; data?: unknown }; children?: unknown[] },
  out: Map<string, string>,
): void {
  const job = node.job as { id?: string; data?: unknown };
  const data = (job.data ?? {}) as { jobId?: string };
  if (job.id && data.jobId) out.set(data.jobId, job.id);
  const children = (node as { children?: MockJobNode[] }).children;
  if (children) for (const c of children) collectQueueIds(c, out);
}

/**
 * Validate dependsOn references resolve within the batch + detect cycles.
 * Throws `CrossBatchDependencyError` for missing predecessors and
 * `DependencyCycleError` for cycles. White/gray/black DFS coloring captures
 * the cycle path for the error message.
 */
function validateDag(units: Unit[]): void {
  const keys = new Set(units.map((u) => u.unitKey));
  const adj = new Map<string, string[]>();
  const missing: string[] = [];
  for (const u of units) {
    const preds: string[] = [];
    if (u.dependsOn) {
      for (const predKey of Object.values(u.dependsOn)) {
        if (!keys.has(predKey)) missing.push(predKey);
        else preds.push(predKey);
      }
    }
    adj.set(u.unitKey, preds);
  }
  if (missing.length > 0) {
    // De-dup while preserving order.
    const seen = new Set<string>();
    const uniq = missing.filter((m) => (seen.has(m) ? false : seen.add(m) && true));
    throw new CrossBatchDependencyError(uniq);
  }

  // 0 = white (unvisited), 1 = gray (on the current DFS stack), 2 = black (done).
  const color = new Map<string, number>();
  for (const k of keys) color.set(k, 0);
  const stack: string[] = [];

  const dfs = (node: string): void => {
    color.set(node, 1);
    stack.push(node);
    for (const next of adj.get(node) ?? []) {
      const c = color.get(next) ?? 0;
      if (c === 1) {
        // Cycle: slice stack from the first occurrence of `next` for a
        // human-readable cycle path.
        const idx = stack.indexOf(next);
        const cycle = stack.slice(idx).concat(next);
        throw new DependencyCycleError(cycle);
      }
      if (c === 0) dfs(next);
    }
    stack.pop();
    color.set(node, 2);
  };

  for (const k of keys) {
    if (color.get(k) === 0) dfs(k);
  }
}

// `MockFlowProducer` is the interface shape, exported for tests + adapters.
export type { MockFlowProducer };
