// Router — the seam between orchestrator/worker and the OpenRouter HTTP adapter.
//
// Ported from a prototype `services/ai/router/router.ts`. The pipeline is 1:1; what
// differs is:
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
//   4. Call OpenRouter (one shot). Time it.
//   5. Run validators on the draft.
//   6. Self-critique loop on `deep`/`maximum` (or on `blocker` flags): run a
//      refine pass; keep whichever pass has fewer blockers.
//   7. Multi-sample: when `profile.multiSample > 1`, run extra parallel passes
//      after the first and pick the winner by fewest flags (tie-break: first).
//   8. True up the budget reserve against actual cost.
//   9. Cache write. Final trace + usage row.
//   On adapter exception: refund full reserve, write failed trace, re-throw.

import { runValidators } from '../validators/index.js';
// Imported directly from the leaf module (not the barrel) so it stays available
// even when a test mocks `../validators/index.js` — this is the authoritative,
// strict Ajv gate that decides whether `parsed` may be surfaced.
import { validateJsonSchema, type JsonSchema } from '../validators/json-schema.js';
import type { Flag } from '../validators/types.js';
import { env } from '../../../config/env.js';

import {
  callOpenRouter,
  OpenRouterAbortError,
  streamingCallOpenRouter,
  type OpenRouterCompletion,
} from './adapters/openrouter.js';
import { RouterCache, hashKey, getSharedRouterCache } from './cache.js';
import { buildRefineMessages, decideRefine } from './self-critique.js';
import { priceForUsage } from './task-profiles.js';
import { TraceWriter } from './trace-writer.js';
import { withRequestTimeout, type AbortCause } from './timeout-signal.js';
import type {
  ChatMessage,
  LLMRouter,
  ProviderKey,
  RouteRequest,
  RouteResult,
  TokenUsage,
} from './types.js';

import { BudgetEnforcer } from '../../budget/enforcer.js';
import { BudgetExceeded, BudgetNotConfigured } from '../../budget/errors.js';

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

export class Router implements LLMRouter {
  private readonly apiKey: string | undefined;
  private readonly cache: RouterCache;
  private readonly metaPromptVersion: string;
  private readonly budget: BudgetEnforcer | undefined;
  private readonly traceWriter: TraceWriter | undefined;
  private readonly adapter: typeof callOpenRouter;
  private readonly requestTimeoutMs: number;

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
  }

  async route(req: RouteRequest): Promise<RouteResult> {
    const start = performance.now();
    const traceId = req.traceId ?? crypto.randomUUID();

    // Wall-clock backstop combined with the inbound disconnect signal. Whichever
    // fires first aborts every adapter call below through the SAME
    // OpenRouterAbortError partial-billing/refund path. Disposed in `finally`
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
    const maxTokens = profile.maxOutputTokens ?? req.maxTokens ?? 800;
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
    const cacheNamespace = req.org;
    const cacheKey = hashKey({
      model,
      messages: req.messages,
      maxTokens,
      temperature,
      namespace: cacheNamespace,
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
          metadata: { cached: true, traceId, unitKey: req.unitKey, unitType: req.unitType },
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
    const reservePerCall = profile.estimatedCostUsdPerCall;
    let totalReservedUsd = 0;
    // softCap fires from the first reserve only — extra-pass reserves are
    // best-effort and don't re-evaluate the threshold semantics here.
    let softCap = false;
    try {
      const reserveOutcome = await this.budgetReserve({
        org: req.org,
        amountUsd: reservePerCall,
        traceId,
      });
      if (reserveOutcome?.softCap) softCap = true;
      totalReservedUsd += reservePerCall;
    } catch (err) {
      // Write a failed trace for both budget rejections: an over-cap reserve
      // (BudgetExceeded) and a fail-closed unconfigured org (BudgetNotConfigured,
      // ADR-0003 D5) — both end the call with $0 actual spend.
      if (err instanceof BudgetExceeded || err instanceof BudgetNotConfigured) {
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
      const completion = await this.adapter({
        model,
        messages: req.messages,
        maxTokens,
        temperature,
        apiKey: this.apiKey,
        signal,
        responseFormat: req.responseSchema ? { type: 'json_object' } : undefined,
        includeUsage: true,
        // Stream tokens out on the primary pass only. Refine/sample passes
        // (runExtraPass) intentionally omit this — they may be discarded, so
        // their tokens must not reach the client.
        ...(req.onDelta ? { onDelta: req.onDelta } : {}),
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

      await this.budgetRefund({ org: req.org, amountUsd: refundUsd });
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
          errorCode: err instanceof Error ? err.name : 'unknown',
          errorMessage: err instanceof Error ? err.message : String(err),
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
      });
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
    //    fewest flags (tie-break: first generated). A prototype's router never wired
    //    this branch; the plan §A.2 calls for it. We treat the original
    //    `genRecord` (or refined winner) as sample #1 and add `multiSample-1`
    //    more, drawing the comparison pool from the same prompt+temperature.
    const multiSample = Math.max(1, profile.multiSample ?? 1);
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
        });
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
    const actualCostUsd = breakdown.reduce((s, b) => s + b.costUsd, 0);
    const deltaUsd = totalReservedUsd - actualCostUsd; // positive ⇒ refund
    await this.budgetAdjust({ org: req.org, deltaUsd });

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
      metadata: { traceId, unitKey: req.unitKey, unitType: req.unitType, flags: win.flags },
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

    return {
      content: win.completion.contentText,
      ...(win.parsed !== undefined ? { parsed: win.parsed } : {}),
      flags: win.flags,
      usage: winUsage,
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

  /** Reserve + adapter call for a non-initial pass (refine or sample). Best-
   *  effort: on failure we refund the per-call reserve we held and return
   *  `record: null` so the caller keeps the previous winner. Adapter errors do
   *  not bubble — multi-pass attempts are explicitly best-effort to match a prototype. */
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
  }): Promise<{ record: PassRecord | null; reservedUsd: number }> {
    let reservedUsd = 0;
    try {
      await this.budgetReserve({
        org: args.req.org,
        amountUsd: args.reserve,
        traceId: args.traceId,
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
      const completion = await this.adapter({
        model: args.model,
        messages: args.messages,
        maxTokens: args.maxTokens,
        temperature: args.temperature,
        apiKey: this.apiKey,
        signal: args.signal,
        responseFormat: args.req.responseSchema ? { type: 'json_object' } : undefined,
        includeUsage: true,
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
    } catch {
      // Adapter threw — refund this pass's reserve and keep the previous winner.
      await this.budgetRefund({ org: args.req.org, amountUsd: reservedUsd });
      return { record: null, reservedUsd: 0 };
    }
  }

  private async budgetReserve(args: {
    org: string;
    amountUsd: number;
    traceId: string;
  }): Promise<{ softCap: boolean } | undefined> {
    if (!this.budget || args.amountUsd <= 0) return undefined;
    const out = await this.budget.reserve({
      org: args.org,
      amountUsd: args.amountUsd,
      traceId: args.traceId,
    });
    return { softCap: out.softCap };
  }

  private async budgetRefund(args: { org: string; amountUsd: number }): Promise<void> {
    if (!this.budget || args.amountUsd <= 0) return;
    await this.budget.refund({ org: args.org, amountUsd: args.amountUsd });
  }

  private async budgetAdjust(args: { org: string; deltaUsd: number }): Promise<void> {
    if (!this.budget || Math.abs(args.deltaUsd) < 1e-9) return;
    await this.budget.adjust({ org: args.org, deltaUsd: args.deltaUsd });
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

/** Convenience factory mirroring a prototype's surface. */
export function createRouter(opts: RouterOptions = {}): Router {
  return new Router(opts);
}

// `priceForUsage` is imported but not used at runtime here — it's the
// adapter's fallback when OpenRouter omits `usage.cost`. Re-exported below so
// callers can fall back to the same table for pre-call estimation.
export { priceForUsage };
