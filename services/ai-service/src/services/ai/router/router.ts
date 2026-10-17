// Router — the seam between orchestrator/worker and the OpenRouter HTTP adapter.
//
// Notes:
//   - inputs: no `surface`/`dimension`; a free-form `label` plus `unitKey`/
//     `unitType` for trace-row stamping. `effortLevel` + `effortProfile` are
//     pre-resolved by the orchestrator and passed in (the router doesn't
//     re-resolve).
//   - persistence: Drizzle-backed `TraceWriter` + `BudgetEnforcer` instead of
//     Payload Local API.
//   - validators: real `runValidators` (M3.2) instead of a stub.
//
// Pipeline per call (see plan §A.2):
//   1. Cross-org parent-trace check (hard reject on mismatch).
//   2. Cache lookup. HIT ⇒ trace + return with `cached: true`; no budget spent.
//   3. Reserve estimated cost on the org budget. `BudgetExceeded` ⇒ failed trace.
//   4. Call OpenRouter under `retry(breaker(timeout(call)))` — see
//      `resilience.ts`. Time it. Breaker open ⇒ `ProviderUnavailable` (503).
//   5. Run validators on the draft.
//   6. Self-critique loop on `deep`/`maximum` (or on `blocker` flags): run a
//      refine pass; keep whichever pass has fewer blockers.
//   7. Multi-sample: when `profile.multiSample > 1`, run extra parallel passes
//      after the first and pick the winner by fewest flags (tie-break: first).
//   8. True up the budget reserve against actual cost.
//   9. Cache write. Final trace + usage row.
//   On adapter exception: refund full reserve, write failed trace, re-throw.
//   On OUR timeout (deadline or stall) in ANY pass: refund every hold, write a
//   $0 `aborted` trace marked `truncated`, throw `ProviderTimeout` (504). See
//   `provider-timeout.ts`.

import { runValidators } from '../validators/index.js';
// Imported directly from the leaf module (not the barrel) so it stays available
// even when a test mocks `../validators/index.js` — this is the authoritative,
// strict Ajv gate that decides whether `parsed` may be surfaced.
import { validateJsonSchema, type JsonSchema } from '../validators/json-schema.js';
import type { Flag } from '../validators/types.js';
import { env } from '../../../config/env.js';

import type {
  callOpenRouter} from './adapters/openrouter.js';
import {
  OpenRouterAbortError,
  streamingCallOpenRouter,
  type OpenRouterCompletion,
  type OpenRouterResponseFormat,
} from './adapters/openrouter.js';
import type { RouterCache} from './cache.js';
import { hashKey, getSharedRouterCache } from './cache.js';
import {
  ProviderUnavailable,
  getSharedProviderResilience,
  type ProviderResilience,
} from './resilience.js';
import {
  recordBreakerState,
  recordBudgetRefusal,
  recordPass,
  type PassPurpose,
} from '../../../metrics/llm.js';
import { normalizeFinishReason } from './finish-reason.js';
import {
  PROVIDER_TIMEOUT_REASON,
  ProviderTimeout,
  isProviderTimeout,
} from './provider-timeout.js';
import { buildRefineMessages, decideRefine } from './self-critique.js';
import { strictResponseFormat } from './strict-schema.js';
import { checkStrictSchema } from '../../registry/resolve.js';
import { priceForUsage } from './task-profiles.js';
import {
  MAX_MULTI_SAMPLE,
  MAX_OUTPUT_TOKENS,
} from '../../registry/caller-limits.js';
import type { TraceWriter } from './trace-writer.js';
import { withRequestTimeout, type AbortCause } from './timeout-signal.js';
import type {
  ChatMessage,
  LLMRouter,
  ProviderKey,
  RouteRequest,
  RouteResult,
  TokenUsage,
} from './types.js';

import type { BudgetEnforcer } from '../../budget/enforcer.js';
import {
  BudgetExceeded,
  BudgetMisconfigured,
  BudgetNotConfigured,
} from '../../budget/errors.js';

const DEFAULT_PROVIDER: ProviderKey = 'openrouter';

export interface RouterOptions {
  apiKey?: string;
  cache?: RouterCache;
  metaPromptVersion?: string;
  budget?: BudgetEnforcer;
  traceWriter?: TraceWriter;
  /** Inject a custom adapter for tests. Matches the `callOpenRouter` signature. */
  adapter?: typeof callOpenRouter;
  /**
   * Wall-clock backstop (ms) on the whole `route()` provider work, combined
   * with the inbound `req.signal`. Defaults to `env.LLM_REQUEST_TIMEOUT_MS`.
   * `0` disables it (inbound disconnect signal still applies). Exposed so tests
   * can drive the timeout with a tiny value.
   */
  requestTimeoutMs?: number;
  /**
   * Retry + circuit-breaker + per-attempt-timeout stack around the provider
   * call. Defaults to the PROCESS-WIDE one — the breaker is state, and a
   * per-Router breaker would count to five on its own and never open.
   *
   * Tests inject their own so one file's five failures don't open the circuit
   * for the next file in the same process.
   */
  resilience?: ProviderResilience;
}

type BreakdownEntry = NonNullable<RouteResult['breakdown']>[number];

/** Local carrier for one completed pass; collected then folded into a winner. */
interface PassRecord {
  completion: OpenRouterCompletion;
  flags: Flag[];
  /** Adapter return is non-null on success. */
  durationMs: number;
  /**
   * Parsed structured output when `responseSchema` was set (json_object mode).
   * `undefined` for plain-text passes — see `validatePass`.
   */
  parsed?: unknown;
}

function blockerCount(flags: Flag[]): number {
  let n = 0;
  for (const f of flags) if (f.severity === 'blocker') n++;
  return n;
}

/** Stable identity for a flag, used to drop the exact-duplicate
 *  `json-schema-mismatch` that appears when the responseSchema gate AND a
 *  consumer-configured `json-schema` validator both validate the same schema. */
function flagKey(f: Flag): string {
  return `${f.severity}|${f.code}|${f.message}|${f.path ?? ''}`;
}

function dedupeFlags(flags: Flag[]): Flag[] {
  const seen = new Set<string>();
  const out: Flag[] = [];
  for (const f of flags) {
    const k = flagKey(f);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out;
}

/**
 * Validate one completion against the request's validators.
 *
 * When `responseSchema` is set the provider was asked for `json_object` mode,
 * so the completion text is expected to be a JSON document. We PARSE it once
 * here and validate the *parsed value* (not the raw string) — otherwise an
 * object `responseSchema` always fails with `/ must be object` even on a
 * perfectly valid JSON object. The parsed value is returned so the worker can
 * surface it as `RouteResult.parsed` (the structured output consumers read).
 *
 * Parse failure is a clean `blocker` validation flag (retry-eligible), never a
 * thrown error. When there is no `responseSchema`, behaviour is unchanged: the
 * raw string is validated (regex / string-schema consumers keep working).
 *
 * STRICT `parsed` GATE: when `responseSchema` is set, the parsed value is
 * surfaced as `parsed` ONLY if it validates against the FULL schema. We do NOT
 * trust the provider's structured-output enforcement — OpenRouter does not
 * strictly enforce `required` fields nested under `$ref`/`definitions`, so a
 * weak model can return schema-violating JSON that parses cleanly. Ajv (which
 * resolves `$ref`/`definitions` and enforces `required` at every level) is the
 * source of truth. On schema miss we emit the same `json-schema-mismatch`
 * blocker the `json-schema` validator uses and withhold `parsed` — matching the
 * contract for the `json-parse-error` case (no `parsed`, a blocker flag, no
 * throw) so ai-service never reports `parsed` for output it can't vouch for.
 */
function validatePass(
  req: RouteRequest,
  contentText: string,
): { flags: Flag[]; parsed?: unknown } {
  const context = {
    unitKey: req.unitKey,
    unitType: req.unitType,
    responseSchema: req.responseSchema,
  };

  if (req.responseSchema === undefined) {
    // Plain-text path — validate the raw string (regex, string schemas, …).
    return { flags: runValidators(req.validators ?? [], contentText, context) };
  }

  // JSON mode: parse first, then validate the parsed value.
  let parsed: unknown;
  try {
    parsed = JSON.parse(contentText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      flags: [
        {
          severity: 'blocker',
          code: 'json-parse-error',
          message: `model output was not valid JSON: ${msg}`,
        },
      ],
    };
  }

  // Authoritative gate: validate the parsed value against the response schema.
  const schemaFlags = validateJsonSchema(parsed, req.responseSchema as JsonSchema, context);
  const flags = dedupeFlags([
    ...schemaFlags,
    ...runValidators(req.validators ?? [], parsed, context),
  ]);

  // Surface `parsed` only when it actually satisfies the response schema.
  if (schemaFlags.length > 0) {
    return { flags };
  }
  return { flags, parsed };
}

/**
 * The provider `response_format` for a request: none for plain text, JSON mode
 * (`json_object`) when a `responseSchema` is set, strict `json_schema` when
 * `responseSchemaStrict` is also set. Every pass (generate, refine, sample)
 * uses the same one.
 */
function responseFormatFor(req: RouteRequest): OpenRouterResponseFormat | undefined {
  if (req.responseSchema === undefined || req.responseSchema === null) return undefined;
  return req.responseSchemaStrict
    ? strictResponseFormat(req.responseSchema)
    : { type: 'json_object' };
}

/**
 * The HTTP correlation id, for `traces.metadata`.
 *
 * It goes in the EXISTING `metadata` jsonb column rather than a new one: no
 * migration, and no schema churn for a field whose only job is to be greppable
 * (`metadata->>'httpRequestId'`). Omitted entirely when absent, so the async
 * worker path — which has no HTTP request of its own — writes exactly the rows
 * it wrote before.
 *
 * Exported because the MOCK_LLM router in `openrouter.ts` writes its own trace
 * row on a path that never reaches this class, and consumers run their e2e
 * suites against exactly that router — correlation has to work there too.
 */
export function httpRequestIdMeta(req: RouteRequest): { httpRequestId?: string } {
  return req.httpRequestId ? { httpRequestId: req.httpRequestId } : {};
}

export class Router implements LLMRouter {
  private readonly apiKey: string | undefined;
  private readonly cache: RouterCache;
  private readonly metaPromptVersion: string;
  private readonly budget: BudgetEnforcer | undefined;
  private readonly traceWriter: TraceWriter | undefined;
  private readonly adapter: typeof callOpenRouter;
  private readonly requestTimeoutMs: number;
  private readonly resilience: ProviderResilience;

  constructor(opts: RouterOptions = {}) {
    this.apiKey = opts.apiKey ?? env.OPENROUTER_API_KEY;
    this.cache = opts.cache ?? getSharedRouterCache();
    this.metaPromptVersion = opts.metaPromptVersion ?? 'router-default-2026-04-22';
    this.budget = opts.budget;
    this.traceWriter = opts.traceWriter;
    // Default to the streaming adapter: it returns the same OpenRouterCompletion
    // shape as the non-streaming one, but throws OpenRouterAbortError (with
    // partial usage) when the signal fires — so cancelled calls record real
    // tokens spent instead of $0. Tests can still inject a non-streaming mock.
    this.adapter = opts.adapter ?? streamingCallOpenRouter;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? env.LLM_REQUEST_TIMEOUT_MS;
    this.resilience = opts.resilience ?? getSharedProviderResilience();
  }

  async route(req: RouteRequest): Promise<RouteResult> {
    const start = performance.now();
    const traceId = req.traceId ?? crypto.randomUUID();

    // Wall-clock backstop combined with the inbound disconnect signal. Whichever
    // fires first aborts every adapter call below. A disconnect or shutdown
    // bills the partial; the deadline ends the call as an UNBILLED
    // `ProviderTimeout` (see `settleProviderTimeout`). Disposed in `finally`
    // so the backstop timer never leaks past the call.
    const deadline = withRequestTimeout(req.signal, this.requestTimeoutMs);
    try {
      return await this.routeWithSignal(req, deadline.signal, deadline, start, traceId);
    } finally {
      deadline.dispose();
    }
  }

  private async routeWithSignal(
    req: RouteRequest,
    signal: AbortSignal,
    deadline: { cause(): AbortCause },
    start: number,
    traceId: string,
  ): Promise<RouteResult> {

    const model = req.model;
    const profile = req.effortProfile;
    const effort = req.effortLevel;
    // Security clamp — audit finding C4, step 1. `resolveSpec`
    // already bounds this (see `registry/caller-limits.ts`), but the router is
    // also reachable with a hand-built profile (`/v1/route`, RAG condense,
    // direct `Router` users), so the ceiling is re-applied at the provider
    // boundary rather than trusted from upstream. Ceiling ONLY: a caller
    // asking for FEWER tokens keeps its number — that is the chat product's
    // per-user credit cap, and deleting it is the trap documented in
    // `plan/open-maxoutputtokens-clamp-not-delete.md`.
    const requestedMaxTokens = profile.maxOutputTokens ?? req.maxTokens ?? 800;
    const maxTokens = Math.min(
      Number.isFinite(requestedMaxTokens) ? requestedMaxTokens : 800,
      MAX_OUTPUT_TOKENS,
    );
    const temperature = profile.temperature ?? req.temperature ?? 0.4;

    // 1. Cross-org parent-trace check (no-op when traceWriter is missing — the
    //    DB-less unit-test path).
    if (this.traceWriter && req.parentTraceId) {
      await this.traceWriter.assertParentTraceOrg({
        parentTraceId: req.parentTraceId,
        callerOrg: req.org,
      });
    }

    // 2. Cache lookup. Skip on deep/maximum since those run the self-critique
    //    loop — caching the post-refine output would mean later callers never
    //    see the critique chain in their breakdown / traces.
    //
    // 🔴 THE TENANT IS (org, project), AND BOTH ARE IN THE KEY.
    // This used to pass the org as `namespace` and nothing carried the project,
    // so two projects inside one organisation shared a cached completion for the
    // 5-minute TTL. `namespace` goes back to what its own comment says it is for
    // — keeping critique/refine entries apart — and the tenant is named.
    // ⚠ This cache is process-shared (`getSharedRouterCache`), which is why the
    // tenant has to be part of the key and not merely part of the context.
    // Strict mode fails LOUDLY here, before the cache and before any budget is
    // reserved: an unsupported model or a schema outside the strict subset is a
    // 400, never a silent fall back to JSON mode. (`resolveSpec` runs the same
    // check earlier on the /v1/generate* paths; this is the seam every caller
    // crosses.)
    if (req.responseSchemaStrict) checkStrictSchema(model, req.responseSchema);
    const responseFormat = responseFormatFor(req);

    // ⚠ The response format is part of the key. A plain call, a JSON-mode call
    // and a strict call with the same messages are three different provider
    // requests; before this they shared one entry, so a plain-text completion
    // could be re-served to a structured caller (and fail its parse gate).
    const cacheKey = hashKey({
      model,
      messages: req.messages,
      maxTokens,
      temperature,
      org: req.org,
      project: req.project ?? null,
      ...(responseFormat ? { responseFormat } : {}),
    });
    const cacheEnabled = effort !== 'deep' && effort !== 'maximum';
    if (cacheEnabled) {
      const hit = this.cache.get(cacheKey);
      if (hit) {
        const usage: TokenUsage = {
          inputTokens: hit.inputTokens,
          outputTokens: hit.outputTokens,
          totalTokens: hit.inputTokens + hit.outputTokens,
          estimatedCostUsd: 0,
        };
        await this.writeTraceSafe({
          org: req.org,
          project: req.project ?? null,
          label: req.label,
          status: 'completed',
          model: hit.model,
          provider: DEFAULT_PROVIDER,
          generationRequestId: req.generationRequestId,
          generationJobId: req.generationJobId,
          registryEntryId: req.registryEntryId,
          parentTraceId: req.parentTraceId,
          promptVersion: req.promptVersion,
          tokenUsage: usage,
          durationMs: 0,
          effort,
          effortProfileUsed: profile,
          estimatedCostUsd: 0,
          actualCostUsd: 0,
          outputPayload: { content: hit.contentText },
          metadata: {
            cached: true,
            traceId,
            unitKey: req.unitKey,
            unitType: req.unitType,
            ...httpRequestIdMeta(req),
          },
        });
        await this.writeUsageSafe({
          org: req.org,
          project: req.project ?? null,
          traceId,
          generationRequestId: req.generationRequestId,
          generationJobId: req.generationJobId,
          provider: DEFAULT_PROVIDER,
          model: hit.model,
          endpoint: 'router.route',
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0,
          actualCostUsd: 0,
          status: 'completed',
        });
        // Re-surface the parsed structured output on cache hits, but hold it to
        // the SAME strict gate as a fresh pass: only surface `parsed` when the
        // cached content still validates against the response schema. The cache
        // write is not conditioned on schema validity, so a cached entry may
        // carry schema-violating JSON; if it fails to parse OR fails the schema
        // we leave `parsed` undefined rather than reporting output we can't
        // vouch for. (Cache hits carry no flags, so we don't fabricate any.)
        let cachedParsed: unknown;
        if (req.responseSchema !== undefined) {
          try {
            const candidate = JSON.parse(hit.contentText);
            if (
              validateJsonSchema(candidate, req.responseSchema as JsonSchema).length === 0
            ) {
              cachedParsed = candidate;
            }
          } catch {
            cachedParsed = undefined;
          }
        }
        return {
          content: hit.contentText,
          ...(cachedParsed !== undefined ? { parsed: cachedParsed } : {}),
          flags: [],
          usage,
          model: hit.model,
          provider: DEFAULT_PROVIDER,
          traceId,
          cached: true,
          durationMs: 0,
          effort,
          effortProfileUsed: profile,
        };
      }
    }

    // 3. Reserve. Per-call estimate; refine + extra samples reserve additionally.
    //
    // Sanitised before use — audit finding C4, step 3. `resolveSpec`
    // guarantees a finite number (`clampCallerLimits` collapses anything else
    // to the admin baseline), but the router is also reachable with a
    // hand-built profile, and a non-finite reserve is worse than a wrong one:
    // it flows into `totalReservedUsd`, then into `budgetAdjust`, where
    // Postgres `numeric` ACCEPTS NaN and would latch
    // `budget_state.remaining_usd` at NaN permanently — an unrecoverable org.
    // Non-finite or negative therefore collapses to 0, which `budgetReserve`'s
    // fail-closed branch below then REFUSES outright (strict) —
    // `BudgetNotConfigured` if the org has no budget row, `BudgetMisconfigured`
    // if it has one. A normal positive estimate passes through byte-identically.
    const rawReservePerCall = profile.estimatedCostUsdPerCall;
    const reservePerCall = Number.isFinite(rawReservePerCall)
      ? Math.max(0, rawReservePerCall)
      : 0;
    let totalReservedUsd = 0;
    // softCap fires from the first reserve only — extra-pass reserves are
    // best-effort and don't re-evaluate the threshold semantics here.
    let softCap = false;
    try {
      const reserveOutcome = await this.budgetReserve({
        org: req.org,
        project: req.project,
        unitKey: req.unitKey,
        amountUsd: reservePerCall,
        rawAmountUsd: rawReservePerCall,
        traceId,
        jobId: req.generationJobId ?? undefined,
      });
      if (reserveOutcome?.softCap) softCap = true;
      totalReservedUsd += reservePerCall;
    } catch (err) {
      // Write a failed trace for every budget rejection: an over-cap reserve
      // (BudgetExceeded), a fail-closed unconfigured org (BudgetNotConfigured,
      // ADR-0003 D5) and a zero/invalid per-call estimate (BudgetMisconfigured,
      // C4 step 3 strict) — all three end the call with $0 actual spend, and
      // all three need to be auditable as refusals rather than vanishing.
      if (
        err instanceof BudgetExceeded ||
        err instanceof BudgetNotConfigured ||
        err instanceof BudgetMisconfigured
      ) {
        recordBudgetRefusal(
          err instanceof BudgetExceeded
            ? 'exceeded'
            : err instanceof BudgetNotConfigured
              ? 'not_configured'
              : 'misconfigured',
        );
        await this.writeTraceSafe({
          org: req.org,
          project: req.project ?? null,
          label: req.label,
          status: 'failed',
          model,
          provider: DEFAULT_PROVIDER,
          generationRequestId: req.generationRequestId,
          generationJobId: req.generationJobId,
          registryEntryId: req.registryEntryId,
          parentTraceId: req.parentTraceId,
          promptVersion: req.promptVersion,
          durationMs: Math.round(performance.now() - start),
          effort,
          effortProfileUsed: profile,
          estimatedCostUsd: reservePerCall,
          actualCostUsd: 0,
          metadata: {
            traceId,
            unitKey: req.unitKey,
            ...httpRequestIdMeta(req),
            errorCode: err.code,
            ...(err instanceof BudgetExceeded ? { shortfallUsd: err.shortfallUsd } : {}),
          },
        });
      }
      throw err;
    }

    const breakdown: BreakdownEntry[] = [];

    // 4. Generate (pass 1).
    let genRecord: PassRecord;
    try {
      const t0 = performance.now();
      // 🔴 RETRY vs LIVE STREAMING. Once a token has been forwarded to the
      // client, the call is COMMITTED: a retry would append a second
      // generation's tokens to the first one's, and the consumer would render
      // one garbled document. `streamed` flips on the first forwarded delta
      // and `callAdapter` stops retrying from that point on. A failure that
      // arrives BEFORE any token (the common case — 429s and 5xx come from the
      // response head) is still fully retryable, which is the whole point.
      let streamed = false;
      const onDelta = req.onDelta
        ? (text: string): void => {
            streamed = true;
            req.onDelta?.(text);
          }
        : undefined;
      const completion = await this.callAdapter({
        purpose: 'generate',
        org: req.org,
        signal,
        committed: () => streamed,
        call: (attemptSignal) =>
          this.adapter({
            model,
            messages: req.messages,
            maxTokens,
            temperature,
            apiKey: this.apiKey,
            signal: attemptSignal,
            responseFormat,
            includeUsage: true,
            // Stream tokens out on the primary pass only. Refine/sample passes
            // (runExtraPass) intentionally omit this — they may be discarded, so
            // their tokens must not reach the client.
            ...(onDelta ? { onDelta } : {}),
          }),
      });
      const passDur = Math.round(performance.now() - t0);
      const { flags, parsed } = validatePass(req, completion.contentText);
      genRecord = { completion, flags, durationMs: passDur, parsed };
      breakdown.push({
        traceId,
        model: completion.model,
        inputTokens: completion.usage.promptTokens,
        outputTokens: completion.usage.completionTokens,
        costUsd: completion.usage.costUsd,
        purpose: 'generate',
      });
    } catch (err) {
      // OUR timeout (wall-clock deadline or stall backstop) is a failure the
      // org does not pay for — checked FIRST, because it also arrives as an
      // `OpenRouterAbortError` and would otherwise take the partial-billing
      // path below, which is for shutdowns and client disconnects only.
      if (isProviderTimeout(err, deadline.cause())) {
        throw await this.settleProviderTimeout({
          req,
          err,
          start,
          traceId,
          model,
          totalReservedUsd,
          spentUsd: err instanceof OpenRouterAbortError ? (err.partial?.usage.costUsd ?? 0) : 0,
        });
      }
      // Mid-call abort? `streamingCallOpenRouter` throws `OpenRouterAbortError`
      // carrying a partial OpenRouterCompletion. We record the partial spend
      // (so the org's ledger matches the provider invoice) and only refund the
      // unspent portion of the reserve. Non-abort errors fall back to the
      // legacy "refund everything, log $0" behaviour.
      const partial = err instanceof OpenRouterAbortError ? err.partial : undefined;
      const actualCostUsd = partial?.usage.costUsd ?? 0;
      const refundUsd = Math.max(0, totalReservedUsd - actualCostUsd);
      const failureStatus: 'aborted' | 'failed' = partial ? 'aborted' : 'failed';
      const inputTokens = partial?.usage.promptTokens ?? 0;
      const outputTokens = partial?.usage.completionTokens ?? 0;

      // Distinguish a wall-clock timeout from a client disconnect. The trace
      // `status` stays `'aborted'` (a timeout IS a kind of abort, and the enum
      // is consumer-facing — adding a value would be a breaking migration), but
      // we record WHICH on the trace metadata and in the log so operators can
      // split "provider stalled / ran away" from "client hung up".
      const abortCause: AbortCause = partial ? deadline.cause() : 'unknown';

      await this.budgetRefund({
        org: req.org,
        amountUsd: refundUsd,
        traceId,
        jobId: req.generationJobId ?? undefined,
      });
      await this.writeTraceSafe({
        org: req.org,
        project: req.project ?? null,
        label: req.label,
        status: failureStatus,
        model: partial?.model ?? model,
        provider: DEFAULT_PROVIDER,
        generationRequestId: req.generationRequestId,
        generationJobId: req.generationJobId,
        registryEntryId: req.registryEntryId,
        parentTraceId: req.parentTraceId,
        promptVersion: req.promptVersion,
        durationMs: Math.round(performance.now() - start),
        effort,
        effortProfileUsed: profile,
        estimatedCostUsd: totalReservedUsd,
        actualCostUsd,
        outputPayload: partial
          ? { content: partial.contentText, partial: true }
          : undefined,
        tokenUsage: partial
          ? {
              inputTokens,
              outputTokens,
              totalTokens: inputTokens + outputTokens,
              estimatedCostUsd: actualCostUsd,
            }
          : undefined,
        metadata: {
          traceId,
          unitKey: req.unitKey,
          ...httpRequestIdMeta(req),
          errorCode: err instanceof Error ? err.name : 'unknown',
          errorMessage: err instanceof Error ? err.message : String(err),
          ...providerGenerationIdMeta(partial),
          ...(partial
            ? {
                partial: true,
                partialCostSource: partial.usage.costSource,
                refundedUsd: refundUsd,
                // 'timeout' = wall-clock backstop fired; 'disconnect' = client
                // closed the socket; 'unknown' = signal source indeterminate.
                abortCause,
              }
            : {}),
        },
      });
      await this.writeUsageSafe({
        org: req.org,
        project: req.project ?? null,
        traceId,
        generationRequestId: req.generationRequestId,
        generationJobId: req.generationJobId,
        provider: DEFAULT_PROVIDER,
        model: partial?.model ?? model,
        endpoint: 'router.route',
        inputTokens,
        outputTokens,
        estimatedCostUsd: totalReservedUsd,
        actualCostUsd,
        status: failureStatus,
      });
      throw err;
    }

    // 5. Self-critique: refine pass on deep/maximum or when blockers present.
    let winning: PassRecord = genRecord;
    const decision = decideRefine({ effort, flags: genRecord.flags });
    if (decision.shouldRefine) {
      const refined = await this.runExtraPass({
        req,
        signal,
        model,
        maxTokens,
        temperature,
        messages: buildRefineMessages({
          originalMessages: req.messages,
          draftContent: genRecord.completion.contentText,
          feedback: decision.feedback,
        }),
        purpose: 'refine',
        traceId,
        breakdown,
        reserve: reservePerCall,
        deadline,
      });
      if (refined.timeout) {
        throw await this.settleProviderTimeout({
          req,
          err: refined.timeout.err,
          start,
          traceId,
          model,
          totalReservedUsd,
          spentUsd: sumCost(breakdown) + refined.timeout.partialCostUsd,
        });
      }
      totalReservedUsd += refined.reservedUsd;
      if (refined.record) {
        // Keep the refined output only if it doesn't have MORE blockers than
        // the original draft. Equal or fewer blockers ⇒ refine wins; otherwise
        // fall back to the generate output.
        if (blockerCount(refined.record.flags) <= blockerCount(genRecord.flags)) {
          winning = refined.record;
        }
      }
    }

    // 6. Multi-sample: kick off N-1 additional generations and pick best by
    //    fewest flags (tie-break: first generated). We treat the original
    //    `genRecord` (or refined winner) as sample #1 and add `multiSample-1`
    //    more, drawing the comparison pool from the same prompt+temperature.
    // Security clamp — audit finding C4, step 4 (clamp half). Each
    // extra sample is an extra BILLED provider call from a single request, so
    // the ceiling is re-applied here as well as in `resolveSpec`.
    const requestedSamples = profile.multiSample ?? 1;
    const multiSample = Math.min(
      Math.max(1, Number.isFinite(requestedSamples) ? requestedSamples : 1),
      MAX_MULTI_SAMPLE,
    );
    if (multiSample > 1) {
      const candidates: PassRecord[] = [winning];
      for (let i = 1; i < multiSample; i++) {
        const extra = await this.runExtraPass({
          req,
          signal,
          model,
          maxTokens,
          temperature,
          messages: req.messages,
          purpose: 'sample',
          traceId,
          breakdown,
          reserve: reservePerCall,
          deadline,
        });
        // A deadline that fires in an extra sample ends the CALL, not just the
        // sample: returning the earlier winner would be a billed 200 for a
        // request that ran out of time (audit §3 item 5).
        if (extra.timeout) {
          throw await this.settleProviderTimeout({
            req,
            err: extra.timeout.err,
            start,
            traceId,
            model,
            totalReservedUsd,
            spentUsd: sumCost(breakdown) + extra.timeout.partialCostUsd,
          });
        }
        totalReservedUsd += extra.reservedUsd;
        if (extra.record) candidates.push(extra.record);
      }
      // Sort stable by (blockerCount, totalFlagCount). First entry remains
      // genRecord when ties exist, preserving the "tie-break: first generated"
      // rule from the plan.
      candidates.sort((a, b) => {
        const ab = blockerCount(a.flags) - blockerCount(b.flags);
        if (ab !== 0) return ab;
        return a.flags.length - b.flags.length;
      });
      winning = candidates[0] ?? winning;
    }

    // 7. True-up budget. Actual is the sum of all attempted call costs (so we
    //    refund unused reserves on losing samples too).
    const actualCostUsd = sumCost(breakdown);
    const deltaUsd = totalReservedUsd - actualCostUsd; // positive ⇒ refund
    await this.budgetAdjust({ org: req.org, deltaUsd, traceId });

    // 8. Cache write (only when caching enabled for this effort).
    const win = winning;
    if (cacheEnabled) {
      this.cache.set(cacheKey, {
        contentText: win.completion.contentText,
        inputTokens: win.completion.usage.promptTokens,
        outputTokens: win.completion.usage.completionTokens,
        costUsd: win.completion.usage.costUsd,
        model: win.completion.model,
      });
    }

    const winUsage: TokenUsage = {
      inputTokens: win.completion.usage.promptTokens,
      outputTokens: win.completion.usage.completionTokens,
      totalTokens:
        win.completion.usage.promptTokens + win.completion.usage.completionTokens,
      estimatedCostUsd: actualCostUsd,
    };
    const durationMs = Math.round(performance.now() - start);

    await this.writeTraceSafe({
      org: req.org,
      project: req.project ?? null,
      label: req.label,
      status: 'completed',
      model: win.completion.model,
      provider: DEFAULT_PROVIDER,
      generationRequestId: req.generationRequestId,
      generationJobId: req.generationJobId,
      registryEntryId: req.registryEntryId,
      parentTraceId: req.parentTraceId,
      promptVersion: req.promptVersion,
      tokenUsage: winUsage,
      durationMs,
      effort,
      effortProfileUsed: profile,
      estimatedCostUsd: totalReservedUsd,
      actualCostUsd,
      outputPayload: { content: win.completion.contentText },
      costBreakdown: breakdown,
      metadata: {
        traceId,
        unitKey: req.unitKey,
        unitType: req.unitType,
        ...httpRequestIdMeta(req),
        ...providerGenerationIdMeta(win.completion),
        flags: win.flags,
      },
    });
    await this.writeUsageSafe({
      org: req.org,
      project: req.project ?? null,
      traceId,
      generationRequestId: req.generationRequestId,
      generationJobId: req.generationJobId,
      provider: DEFAULT_PROVIDER,
      model: win.completion.model,
      endpoint: 'router.route',
      inputTokens: winUsage.inputTokens,
      outputTokens: winUsage.outputTokens,
      estimatedCostUsd: totalReservedUsd,
      actualCostUsd,
      status: 'completed',
    });

    // Project the winning pass's finish reason. Multi-pass specs (refine /
    // multiSample) can have several completions; the WINNER is the one whose
    // text we return, so its reason is the only one that describes the body on
    // the wire. Omitted entirely when the provider reported nothing.
    const winFinishReason = normalizeFinishReason(win.completion.finishReason);

    return {
      content: win.completion.contentText,
      ...(win.parsed !== undefined ? { parsed: win.parsed } : {}),
      flags: win.flags,
      usage: winUsage,
      ...(winFinishReason !== undefined ? { finishReason: winFinishReason } : {}),
      model: win.completion.model,
      provider: DEFAULT_PROVIDER,
      traceId,
      cached: false,
      durationMs,
      effort,
      effortProfileUsed: profile,
      breakdown: breakdown.length > 1 ? breakdown : undefined,
      ...(softCap ? { softCap: true } : {}),
    };
  }

  // ---------- internal helpers ---------------------------------------------

  /**
   * ONE provider pass, run under retry + circuit breaker + per-attempt timeout,
   * with the pass metrics emitted.
   *
   * 🔴 THE BUDGET RESERVE IS TAKEN OUTSIDE THIS METHOD AND IS NEVER RE-TAKEN.
   * Every caller reserves once, then calls this once; the retry ladder lives
   * strictly INSIDE that single reserve. A retry that re-reserved would hold
   * `attempts ×` the estimate against the org's cap for work that produced one
   * completion, and the true-up — which settles against the FINAL attempt's
   * usage, because that is the only completion whose tokens were billed —
   * would refund the wrong number. The invariant is asserted directly:
   * `router-resilience.test.ts` counts `budget.reserve` calls across a
   * three-attempt ladder and requires exactly one.
   *
   * Errors are re-thrown UNCHANGED (an `OpenRouterAbortError` still carries its
   * partial, so the abort/partial-billing path in `route()` is untouched), with
   * the one exception of an open circuit, which becomes `ProviderUnavailable`.
   */
  private async callAdapter(args: {
    purpose: PassPurpose;
    org: string;
    signal: AbortSignal;
    call: (signal: AbortSignal) => Promise<OpenRouterCompletion>;
    /** See the streaming note at the primary call site. */
    committed?: () => boolean;
  }): Promise<OpenRouterCompletion> {
    try {
      const completion = await this.resilience.execute(
        async (attemptSignal) => {
          try {
            return await args.call(attemptSignal);
          } catch (err) {
            // Tokens already on the wire ⇒ this attempt is the only attempt.
            if (args.committed?.()) throw new CommittedPassError(err);
            throw err;
          }
        },
        args.signal,
      );
      recordPass({
        purpose: args.purpose,
        status: 'success',
        org: args.org,
        costUsd: completion.usage.costUsd,
      });
      return completion;
    } catch (err) {
      const unwrapped = err instanceof CommittedPassError ? err.original : err;
      recordPass({ purpose: args.purpose, status: passFailureStatus(unwrapped) });
      throw unwrapped;
    } finally {
      // The gauge is published from here rather than from a timer: the router
      // is the only thing that touches the breaker, so this is the only place
      // that can know a state change happened at the instant it happened.
      recordBreakerState(this.resilience.provider, this.resilience.state());
    }
  }

  /** Reserve + adapter call for a non-initial pass (refine or sample). Best-
   *  effort: on failure we refund the per-call reserve we held and return
   *  `record: null` so the caller keeps the previous winner. Adapter errors do
   *  not bubble — multi-pass attempts are explicitly best-effort. */
  private async runExtraPass(args: {
    req: RouteRequest;
    /** Combined disconnect+timeout signal from `route()`. */
    signal: AbortSignal;
    model: string;
    maxTokens: number;
    temperature: number;
    messages: ChatMessage[];
    purpose: BreakdownEntry['purpose'];
    traceId: string;
    breakdown: BreakdownEntry[];
    reserve: number;
    /** The route's deadline, to tell OUR timeout from any other failure. */
    deadline: { cause(): AbortCause };
  }): Promise<{
    record: PassRecord | null;
    reservedUsd: number;
    /**
     * Set when OUR timeout cut this pass. The pass's own hold is already
     * refunded; the caller must END the call (`settleProviderTimeout`) rather
     * than keep an earlier draft — that draft was the billed 200 of req-1gk.
     */
    timeout?: { err: unknown; partialCostUsd: number };
  }> {
    let reservedUsd = 0;
    try {
      await this.budgetReserve({
        org: args.req.org,
        project: args.req.project,
        unitKey: args.req.unitKey,
        amountUsd: args.reserve,
        traceId: args.traceId,
        jobId: args.req.generationJobId ?? undefined,
      });
      reservedUsd = args.reserve;
    } catch {
      // Couldn't reserve — skip this extra pass entirely. The caller keeps the
      // initial draft. We deliberately do NOT bubble BudgetExceeded here:
      // partial-multi-sample is acceptable; full reservation failure already
      // fired upstream.
      return { record: null, reservedUsd: 0 };
    }
    try {
      const t0 = performance.now();
      const completion = await this.callAdapter({
        purpose: args.purpose,
        org: args.req.org,
        signal: args.signal,
        call: (attemptSignal) =>
          this.adapter({
            model: args.model,
            messages: args.messages,
            maxTokens: args.maxTokens,
            temperature: args.temperature,
            apiKey: this.apiKey,
            signal: attemptSignal,
            responseFormat: responseFormatFor(args.req),
            includeUsage: true,
          }),
      });
      const passDur = Math.round(performance.now() - t0);
      const { flags, parsed } = validatePass(args.req, completion.contentText);
      args.breakdown.push({
        traceId: args.traceId,
        model: completion.model,
        inputTokens: completion.usage.promptTokens,
        outputTokens: completion.usage.completionTokens,
        costUsd: completion.usage.costUsd,
        purpose: args.purpose,
      });
      return { record: { completion, flags, durationMs: passDur, parsed }, reservedUsd };
    } catch (err) {
      // Adapter threw — refund this pass's reserve and keep the previous winner.
      //
      // ⚠ NO ledger key here, deliberately. This refund returns ONE pass's
      // hold while the SAME `traceId`'s other holds (the primary pass, earlier
      // samples) are still live and still owed a true-up. Closing out by
      // `traceId` would mark all of them refunded and the true-up would then
      // find nothing to settle. The one stale `reserved` row this leaves is
      // closed by the `budgetAdjust` that ends the call.
      await this.budgetRefund({ org: args.req.org, amountUsd: reservedUsd });
      // ...EXCEPT on our own timeout, which is not "best effort failed" but
      // "the request is out of time". The caller ends the call unbilled.
      if (isProviderTimeout(err, args.deadline.cause())) {
        const partialCostUsd =
          err instanceof OpenRouterAbortError ? (err.partial?.usage.costUsd ?? 0) : 0;
        return { record: null, reservedUsd: 0, timeout: { err, partialCostUsd } };
      }
      return { record: null, reservedUsd: 0 };
    }
  }

  /**
   * End a call that OUR timeout cut, in any pass. The org is NOT charged:
   * every hold still live under this `traceId` is refunded and its ledger rows
   * closed, the trace and usage rows carry `actualCostUsd: 0`, and the trace
   * says `truncated: true`, `reason: 'provider_timeout'`. What the provider
   * charged US (`spentUsd`) stays on the trace as `providerCostUsd`, so the
   * ledger can still be reconciled with the provider invoice.
   *
   * Returns the error for the caller to `throw`, so the control flow at each
   * call site reads as the exit it is.
   */
  private async settleProviderTimeout(args: {
    req: RouteRequest;
    err: unknown;
    start: number;
    traceId: string;
    model: string;
    /** Holds still live — every pass's reserve not yet refunded. */
    totalReservedUsd: number;
    /** Provider spend so far: completed passes plus the cut pass's partial. */
    spentUsd: number;
  }): Promise<ProviderTimeout> {
    const { req, err, traceId } = args;
    const partial = err instanceof OpenRouterAbortError ? err.partial : undefined;
    const inputTokens = partial?.usage.promptTokens ?? 0;
    const outputTokens = partial?.usage.completionTokens ?? 0;

    await this.budgetRefund({
      org: req.org,
      amountUsd: args.totalReservedUsd,
      traceId,
      jobId: req.generationJobId ?? undefined,
    });
    console.warn(
      `[router] provider timeout org=${req.org} project=${req.project ?? '-'} ` +
        `unitKey=${req.unitKey ?? '-'} traceId=${traceId} — returned as ` +
        `ProviderTimeout, unbilled (provider spend $${args.spentUsd.toFixed(6)}).`,
    );
    await this.writeTraceSafe({
      org: req.org,
      project: req.project ?? null,
      label: req.label,
      status: 'aborted',
      model: partial?.model ?? args.model,
      provider: DEFAULT_PROVIDER,
      generationRequestId: req.generationRequestId,
      generationJobId: req.generationJobId,
      registryEntryId: req.registryEntryId,
      parentTraceId: req.parentTraceId,
      promptVersion: req.promptVersion,
      durationMs: Math.round(performance.now() - args.start),
      effort: req.effortLevel,
      effortProfileUsed: req.effortProfile,
      estimatedCostUsd: args.totalReservedUsd,
      actualCostUsd: 0,
      outputPayload: partial ? { content: partial.contentText, partial: true } : undefined,
      tokenUsage: partial
        ? {
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
            estimatedCostUsd: 0,
          }
        : undefined,
      metadata: {
        traceId,
        unitKey: req.unitKey,
        ...httpRequestIdMeta(req),
        errorCode: 'ERR_PROVIDER_TIMEOUT',
        errorMessage: err instanceof Error ? err.message : String(err),
        abortCause: 'timeout',
        truncated: true,
        reason: PROVIDER_TIMEOUT_REASON,
        providerCostUsd: args.spentUsd,
        refundedUsd: args.totalReservedUsd,
        ...providerGenerationIdMeta(partial),
        ...(partial ? { partial: true, partialCostSource: partial.usage.costSource } : {}),
      },
    });
    await this.writeUsageSafe({
      org: req.org,
      project: req.project ?? null,
      traceId,
      generationRequestId: req.generationRequestId,
      generationJobId: req.generationJobId,
      provider: DEFAULT_PROVIDER,
      model: partial?.model ?? args.model,
      endpoint: 'router.route',
      inputTokens,
      outputTokens,
      estimatedCostUsd: args.totalReservedUsd,
      actualCostUsd: 0,
      status: 'aborted',
    });
    return new ProviderTimeout({ traceId, cause: err });
  }

  /**
   * Reserve `amountUsd` against the org budget. A non-positive or non-finite
   * reserve is a CONFIG FAULT and REFUSES — it is never a skip, and never a
   * "proceed and settle up later".
   *
   * ── Why the `<= 0` branch is not a skip ───────────────────────────────────
   * Security audit, finding C4, fix-spec step 3. This method used to
   * read `if (!this.budget || args.amountUsd <= 0) return undefined;` — a zero
   * reserve skipped the budget system ENTIRELY, so an org with no
   * `budget_state` row generated for free, in direct contradiction of ADR-0003
   * D5 ("an org with no explicit cap is rejected, not bootstrapped").
   *
   * The caller-driven half of that hole is already closed upstream:
   * `clampCallerLimits` floors `estimatedCostUsdPerCall` at the ADMIN-resolved
   * value, so nothing on the wire can push the reserve down to zero. What
   * remains — and what this branch closes — is an ADMIN-configured
   * `estimatedCostUsdPerCall: 0` on a `project_configs` / `registry_entries`
   * effort profile, which resolves to a zero reserve for every caller of that
   * org and silently disables the gate.
   *
   * ── STRICT, by Rodrigo's ruling ────────────────────────────────
   * The first cut of this fix was SOFT: it called `assertConfigured` and let a
   * budget-row-having org proceed, on the theory that the post-call true-up
   * would still charge it and that refusing would turn a metering
   * misconfiguration into an outage. That reading was overruled.
   *
   * A zero hold means METERING IS BROKEN for that org, and a broken meter is
   * not served. The true-up is a settlement mechanism, not a gate: it runs
   * AFTER the provider call, cannot decline anything, and (with no reserve
   * held) leaves an unbounded number of concurrent calls in flight against a
   * cap that was never consulted. The outage argument cuts the other way too —
   * the population it protects is exactly the population whose spend is
   * unmetered, and a loud 402 naming the faulty field gets that fixed in
   * minutes where a silent under-reserve hides for weeks.
   *
   * ── Two faults, two codes ─────────────────────────────────────────────────
   * `assertConfigured` still runs FIRST, so an org that is BOTH unconfigured
   * and zero-estimated keeps reporting the more fundamental fault
   * (`BudgetNotConfigured`, ADR-0003 D5) — its behaviour is unchanged by this
   * ruling. Only an org that HAS a budget row reaches the throw below, and it
   * gets `BudgetMisconfigured`: a sibling 402 whose message names
   * `estimatedCostUsdPerCall` and explicitly says the budget row is fine, so
   * the admin is not sent to provision a cap that already exists.
   *
   * Both codes are mapped on BOTH transports — `mapGenerateError` (402 status
   * on `/v1/generate/sync`) and `classifyStreamError` (terminal `error` frame
   * on `/v1/generate/stream`, where the status line is already gone).
   *
   * ── Scope: the generation reserve only ────────────────────────────────────
   * `/v1/embed` also reserves a genuinely-$0 amount whenever the embedding
   * model is absent from `MODEL_PRICING`, and `BudgetEnforcer.reserve` handles
   * its own `amountUsd === 0` case with `assertConfigured` (the soft rule).
   * That is deliberately UNTOUCHED: an unpriced embedding model is a pricing-
   * table gap, not an admin writing a zero into an effort profile, and the
   * ruling was about the generation-time reserve.
   *
   * `!(amountUsd > 0)` rather than `amountUsd <= 0` so NaN takes this branch
   * too; passing NaN to `BudgetEnforcer.reserve` throws a bare `Error` (500).
   */
  private async budgetReserve(args: {
    org: string;
    project?: string | undefined;
    unitKey?: string | undefined;
    amountUsd: number;
    /**
     * The PRE-sanitiser value, for diagnostics only — never for arithmetic.
     * `amountUsd` has already had `NaN`/`Infinity`/negatives collapsed to `0`,
     * so reporting it would tell an admin who wrote `null` (→ `NaN`) that the
     * profile says `0`, and send them looking for a zero that isn't in the row.
     * Defaults to `amountUsd` for callers that never sanitised.
     */
    rawAmountUsd?: number | undefined;
    traceId: string;
    jobId?: string | undefined;
  }): Promise<{ softCap: boolean } | undefined> {
    if (!this.budget) return undefined;
    if (!(args.amountUsd > 0)) {
      const reported = args.rawAmountUsd ?? args.amountUsd;
      // The thrown error reaches the CONSUMER; this line reaches the OPERATOR,
      // with the trace id and the tenant coordinates needed to find the row.
      console.warn(
        `[budget] effort profile resolved a non-positive reserve ` +
          `(estimatedCostUsdPerCall=${String(reported)}) for ` +
          `org=${args.org} project=${args.project ?? '-'} ` +
          `unitKey=${args.unitKey ?? '-'} traceId=${args.traceId}. ` +
          `REFUSED (402) — a zero hold means the budget cap cannot bind, so ` +
          `the call is not served. Fix effortProfile.estimatedCostUsdPerCall ` +
          `on the project_configs / registry_entries row for this org.`,
      );
      // Fail closed, more fundamental fault first: no budget_state row at all
      // is still ADR-0003 D5's `BudgetNotConfigured`.
      await this.budget.assertConfigured(args.org);
      // Row exists, but nothing can be held against it. Refuse.
      throw new BudgetMisconfigured(args.org, reported, {
        project: args.project,
        unitKey: args.unitKey,
      });
    }
    const out = await this.budget.reserve({
      org: args.org,
      amountUsd: args.amountUsd,
      traceId: args.traceId,
      project: args.project,
      // The reaper's only handle on this hold — without it a dead worker's
      // refund falls back to guessing from `metadata.reservePerCallUsd`.
      jobId: args.jobId,
    });
    return { softCap: out.softCap };
  }

  /**
   * Return an unspent hold AND close out its ledger rows.
   *
   * ⚠ `traceId` is not optional in spirit. A refund that moves the money but
   * leaves the `budget_reservations` rows at `reserved` means the reaper finds
   * a live hold for a call that already settled, and refunds it a SECOND time.
   */
  private async budgetRefund(args: {
    org: string;
    amountUsd: number;
    traceId?: string | undefined;
    jobId?: string | undefined;
  }): Promise<void> {
    if (!this.budget) return;
    if (args.amountUsd > 0) {
      await this.budget.refund({
        org: args.org,
        amountUsd: args.amountUsd,
        traceId: args.traceId,
        jobId: args.jobId,
      });
      return;
    }
    // Nothing to give back, but the holds still have to stop being live.
    await this.budget.settleReservations({ traceId: args.traceId, jobId: args.jobId });
  }

  private async budgetAdjust(args: {
    org: string;
    deltaUsd: number;
    traceId?: string | undefined;
  }): Promise<void> {
    if (!this.budget) return;
    await this.budget.adjust({
      org: args.org,
      deltaUsd: args.deltaUsd,
      traceId: args.traceId,
    });
  }

  private async writeTraceSafe(input: Parameters<TraceWriter['writeTrace']>[0]): Promise<void> {
    if (!this.traceWriter) return;
    await this.traceWriter.writeTrace(input);
  }

  private async writeUsageSafe(input: Parameters<TraceWriter['writeUsage']>[0]): Promise<void> {
    if (!this.traceWriter) return;
    await this.traceWriter.writeUsage(input);
  }
}

/**
 * Internal marker: the wrapped error happened AFTER tokens reached the client,
 * so the pass may not be retried. Never escapes `callAdapter` — it unwraps
 * `original` before rethrowing, so `route()`'s catch sees exactly the error the
 * adapter threw. It is a class rather than a flag on the error because the
 * adapter's errors are shared objects we must not mutate.
 */
class CommittedPassError extends Error {
  constructor(readonly original: unknown) {
    super('pass already streamed to the client; not retryable');
    this.name = 'CommittedPassError';
  }
}

/**
 * `metadata.providerGenerationId`: OpenRouter's `gen-…` id for the pass whose
 * result the trace records (the winner on success, the cut pass's partial on
 * an abort or provider timeout). It is the key to OpenRouter's own record of
 * the call (`GET /api/v1/generation?id=`), so a disputed or partial charge can
 * be reconciled against the provider invoice. Omitted when the provider sent
 * none. ⚠ Multi-pass specs record only that one pass's id.
 */
function providerGenerationIdMeta(
  completion: { rawId?: string } | undefined,
): { providerGenerationId?: string } {
  return completion?.rawId ? { providerGenerationId: completion.rawId } : {};
}

/** Provider spend across the passes that completed. */
function sumCost(breakdown: BreakdownEntry[]): number {
  return breakdown.reduce((s, b) => s + b.costUsd, 0);
}

/** Which `ai_llm_pass_total{status}` bucket a thrown pass belongs in. */
function passFailureStatus(err: unknown): 'failure' | 'aborted' | 'unavailable' {
  if (err instanceof ProviderUnavailable) return 'unavailable';
  if (err instanceof OpenRouterAbortError) return 'aborted';
  if (err instanceof Error && err.name === 'AbortError') return 'aborted';
  return 'failure';
}

/** Convenience factory. */
export function createRouter(opts: RouterOptions = {}): Router {
  return new Router(opts);
}

// `priceForUsage` is imported but not used at runtime here — it's the
// adapter's fallback when OpenRouter omits `usage.cost`. Re-exported below so
// callers can fall back to the same table for pre-call estimation.
export { priceForUsage };

// The C4 cost ceilings are DEFINED in `registry/caller-limits.ts` (both
// `resolveSpec` and the router need them, and the router already depends on
// the registry for `EffortProfile`). Re-exported here because the security
// branches' version of this fix — commits `4ca0838` / `936a427`, which never
// reached `main` — declared `MAX_OUTPUT_TOKENS` on this module, and anything
// written against that import path should keep resolving.
export { MAX_MULTI_SAMPLE, MAX_OUTPUT_TOKENS };

// Re-exported so a consumer reading the router's surface finds the 503 it can
// be handed, and so tests can construct it without reaching into the
// resilience module. The ROUTES no longer need it: the wire mapping is generic
// over the taxonomy (`src/errors/base.ts`), not an `instanceof` chain.
export { ProviderTimeout } from './provider-timeout.js';
export {
  ProviderUnavailable,
  createProviderResilience,
  getSharedProviderResilience,
  resetSharedProviderResilience,
} from './resilience.js';
