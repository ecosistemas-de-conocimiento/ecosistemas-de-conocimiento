// In-process BullMQ worker for the `generation` queue.
//
// Implements plan/m3-step5-detailed-plan.md §C steps 1–11. The BullMQ surface
// is a thin wrapper around `processGenerationJob` which is exported for direct
// unit-test invocation without Redis.
//
// Key behaviours:
//   - Cancel check at start AND after the router.route() return (plan §D.4).
//   - Two-phase prompt rendering (plan §C.4 + decisions §16): leaf units carry
//     `__renderedPrompt` already; dependent units render here with merged
//     predecessor outputs, then write the rendered string back to the row.
//   - Validator retry capped at MAX_VALIDATOR_RETRIES (decisions §4) — single
//     refine pass on blocker flags.
//   - Parent-counter transaction marks the request terminal when totals match.
//   - Callback URL fires unsigned + best-effort via setImmediate (decisions §7).
//
// TODO(M3.7): use Fastify pino logger via context injection — for now we log
// through console.warn / console.error.

import { Worker } from 'bullmq';
import { and, eq, inArray, sql } from 'drizzle-orm';

import { db as defaultDb, type Db } from '../db/client.js';
import {
  generationJobs,
  generationRequests,
  projectConfigs,
} from '../db/schema/index.js';
import { redisConnection } from '../queue/connection.js';
import { GENERATION_QUEUE_NAME } from '../queue/queues.js';
import { BudgetEnforcer } from '../services/budget/enforcer.js';
import { enqueueCallback } from '../services/callbacks/emit.js';
import { getEventBus, type EventBus } from '../services/events/bus.js';
import { createOpenRouter } from '../services/ai/router/openrouter.js';
import { OpenRouterAbortError } from '../services/ai/router/adapters/openrouter.js';
import { TraceWriter } from '../services/ai/router/trace-writer.js';
import type { LLMRouter, RouteResult } from '../services/ai/router/types.js';
import { renderPrompt } from '../services/render/handlebars.js';
import { resolveSpec } from '../services/registry/resolve.js';
import {
  resolveSystemPrompt,
  withSystemMessage,
} from '../services/generation/system-prompt.js';
import type { Flag } from '../services/ai/validators/types.js';
import { getCancelBus, type CancelBus } from '../services/generation/cancel-bus.js';
import type { GenerationJobData } from '../types/generation.js';

/**
 * Per-pod registry of in-flight AbortControllers keyed by `generationRequestId`.
 * The cancel-bus subscriber looks here to abort a running LLM call when a
 * `/cancel` lands on any other pod.
 *
 * This map is intentionally per-process: AbortControllers are local objects
 * and can't be serialized. The cross-pod fan-out is the pub/sub broadcast
 * itself — every pod's subscriber gets the message; only the pod holding the
 * controller actually aborts. The post-LLM-call status re-read at step 8b
 * is the correctness safety net for any pod that missed the message.
 */
export type InFlightMap = Map<string, AbortController>;

// Hardcoded per plan/m3-m4-decisions.md §4. Upgrade path documented in
// plan/m3-validator-retry-followup.md.
export const MAX_VALIDATOR_RETRIES = 1;

export interface WorkerDeps {
  db?: Db;
  router?: LLMRouter;
  bus?: EventBus;
  /**
   * Map shared with the cancel-bus subscriber. Tests can pass a fresh Map;
   * production code lets `startGenerationWorker` create + own one.
   */
  inFlight?: InFlightMap;
  cancelBus?: CancelBus;
}

interface ParentCountersResult {
  status: 'queued' | 'running' | 'partial' | 'completed' | 'failed' | 'cancelled';
  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
  actualCostUsd: number;
  callbackUrl: string | null;
  apiKeyId: string | null;
  clientRequestId: string | null;
  org: string;
  project: string | null;
  /** True when this UPDATE took the parent from non-terminal to terminal. */
  terminalNow: boolean;
}

/** Number stored in numeric(12, 6) — `.toFixed(6)` matches the trace writer. */
function usdString(v: number): string {
  return v.toFixed(6);
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v);
  return 0;
}

/**
 * Process one generation job. Exported so tests can drive it without spinning
 * up a real BullMQ Worker. Errors here are NOT thrown to BullMQ — the worker
 * records `status: 'failed'` on the row and emits a `generation.job.failed`
 * event; throwing would trigger BullMQ's default retry, which we don't want
 * (validator retry is handled internally).
 */
export async function processGenerationJob(
  bullJob: { id?: string | number | null; data: GenerationJobData },
  deps: WorkerDeps = {},
): Promise<void> {
  const db = deps.db ?? defaultDb;
  const bus = deps.bus ?? getEventBus();
  const router =
    deps.router ??
    createOpenRouter({
      budget: new BudgetEnforcer(db),
      traceWriter: new TraceWriter(db),
    });

  const data = bullJob.data;

  // ── 1. Load DB rows ────────────────────────────────────────────────────
  const rowResult = await db
    .select()
    .from(generationJobs)
    .where(eq(generationJobs.id, data.jobId))
    .limit(1);
  const row = rowResult[0];
  if (!row) {
    console.warn(`generation worker: job row ${data.jobId} missing; orphan`);
    return;
  }

  const parentResult = await db
    .select()
    .from(generationRequests)
    .where(eq(generationRequests.id, row.generationRequestId))
    .limit(1);
  const parent = parentResult[0];
  if (!parent) {
    console.warn(
      `generation worker: parent request ${row.generationRequestId} missing for job ${row.id}`,
    );
    return;
  }

  // ── 2. Cancel check (pre-pickup) ──────────────────────────────────────
  if (parent.status === 'cancelled') {
    await db
      .update(generationJobs)
      .set({ status: 'cancelled', finishedAt: new Date() })
      .where(eq(generationJobs.id, row.id));
    return;
  }

  // ── 3. Predecessor merge ──────────────────────────────────────────────
  const dependsOn = (row.dependsOn ?? null) as Record<string, string> | null;
  const predecessorVars: Record<string, unknown> = {};
  if (dependsOn && Object.keys(dependsOn).length > 0) {
    const predKeys = Object.values(dependsOn);
    const siblingRows = await db
      .select()
      .from(generationJobs)
      .where(
        and(
          eq(generationJobs.generationRequestId, row.generationRequestId),
          inArray(generationJobs.unitKey, predKeys),
        ),
      );
    const byKey = new Map<string, (typeof siblingRows)[number]>();
    for (const s of siblingRows) byKey.set(s.unitKey, s);

    for (const [slotName, predUnitKey] of Object.entries(dependsOn)) {
      const predRow = byKey.get(predUnitKey);
      if (!predRow || predRow.status !== 'completed') {
        const errorMessage = `predecessor unitKey '${predUnitKey}' ${predRow ? predRow.status : 'missing'}`;
        await markJobFailed({
          db,
          row,
          parent,
          error: errorMessage,
          bus,
        });
        return;
      }
      predecessorVars[slotName] = predRow.output;
    }
  }

  // ── 4. Render prompt (two-phase) ──────────────────────────────────────
  const input = (row.input ?? {}) as Record<string, unknown>;
  let renderedPrompt = typeof input.__renderedPrompt === 'string'
    ? input.__renderedPrompt
    : undefined;
  if (!renderedPrompt) {
    const template = typeof input.__promptTemplate === 'string'
      ? input.__promptTemplate
      : undefined;
    if (!template) {
      await markJobFailed({
        db,
        row,
        parent,
        error: 'no rendered prompt and no template on row input',
        bus,
      });
      return;
    }
    const promptVars = (input.__promptVars ?? {}) as Record<string, unknown>;
    try {
      renderedPrompt = renderPrompt(template, {
        ...promptVars,
        ...predecessorVars,
      });
    } catch (err) {
      await markJobFailed({
        db,
        row,
        parent,
        error: `render error: ${err instanceof Error ? err.message : String(err)}`,
        bus,
      });
      return;
    }
    // Persist for audit + retry idempotence.
    await db.execute(sql`
      UPDATE ${generationJobs}
         SET "input" = jsonb_set(
           COALESCE("input", '{}'::jsonb),
           '{__renderedPrompt}',
           to_jsonb(${renderedPrompt}::text)
         )
       WHERE "id" = ${row.id}
    `);
  }

  // ── 5. Resolve spec at worker time ────────────────────────────────────
  let spec;
  try {
    spec = await resolveSpec(db, {
      org: row.org,
      project: row.project ?? '',
      unitType: row.unitType ?? undefined,
      unitKey: row.unitKey,
      specOverride: (row.specOverride ?? undefined) as Parameters<typeof resolveSpec>[1]['specOverride'],
      // Spec FLOOR, persisted at enqueue time on `input.__specDefault` (see
      // orchestrator step 9) because there is no column for it. Without this
      // the async path would resolve a DIFFERENT spec than `/v1/generate` did
      // when it costed the batch — the silent kind of drift.
      specDefault: (input.__specDefault ?? undefined) as Parameters<typeof resolveSpec>[1]['specDefault'],
      requestOverrides: {
        promptOverride: parent.promptOverride ?? undefined,
        modelOverride: parent.modelOverride ?? undefined,
        effortLevel: parent.effort,
        effortOverrides:
          (parent.effortOverrides ?? undefined) as Record<string, unknown> as
            | undefined
            | Parameters<typeof resolveSpec>[1]['requestOverrides'] extends infer R
              ? R extends { effortOverrides?: infer E }
                ? E
                : never
              : never,
      },
    });
  } catch (err) {
    await markJobFailed({
      db,
      row,
      parent,
      error: `spec resolution failed: ${err instanceof Error ? err.message : String(err)}`,
      bus,
    });
    return;
  }

  // ── 5b. Resolve the system prompt ─────────────────────────────────────
  // Precedence + rendering rules live in one shared module (used identically
  // by /v1/generate/sync and /v1/generate/stream) — see
  // `src/services/generation/system-prompt.ts`. Levels:
  //   unit.systemPrompt (persisted as `input.__systemPrompt` at enqueue time)
  //   → specOverride.metaPromptTemplate → generation_requests.
  //     meta_prompt_override → registry_entries.meta_prompt_template.
  // Nothing supplied ⇒ `undefined` ⇒ the messages array below is byte-identical
  // to what this worker sent before system prompts existed.
  let systemPrompt: string | undefined;
  try {
    // Same variable bag the prompt was rendered with: `__promptVars` for
    // dependent units (plus their merged predecessor outputs), otherwise the
    // row's own `input`.
    const renderVars = {
      ...((input.__promptVars as Record<string, unknown> | undefined) ?? input),
      ...predecessorVars,
    };
    systemPrompt = resolveSystemPrompt({
      unitSystemPrompt:
        typeof input.__systemPrompt === 'string' ? input.__systemPrompt : undefined,
      requestSystemPrompt: parent.metaPromptOverride,
      spec,
      vars: renderVars,
    }).systemPrompt;
  } catch (err) {
    await markJobFailed({
      db,
      row,
      parent,
      error: `system prompt render error: ${err instanceof Error ? err.message : String(err)}`,
      bus,
    });
    return;
  }

  // ── 6. Mark running + emit started event ──────────────────────────────
  const startedAt = new Date();
  await db
    .update(generationJobs)
    .set({
      status: 'running',
      startedAt,
      attempts: (row.attempts ?? 0) + 1,
    })
    .where(eq(generationJobs.id, row.id));
  bus.emit({
    type: 'generation.job.started',
    requestId: row.generationRequestId,
    jobId: row.id,
    unitKey: row.unitKey,
    org: row.org,
    project: row.project ?? undefined,
  });

  // ── 7. Call router ────────────────────────────────────────────────────
  const label = `unit:${row.unitType ?? row.unitKey}`;
  const baseRouteReq = {
    label,
    unitKey: row.unitKey,
    unitType: row.unitType ?? undefined,
    org: row.org,
    project: row.project ?? undefined,
    model: spec.model,
    effortLevel: spec.effortLevel,
    effortProfile: spec.effortProfile,
    responseSchema: spec.responseSchema,
    validators: spec.validators,
    generationRequestId: row.generationRequestId,
    generationJobId: row.id,
    traceId: row.traceId ?? undefined,
    promptVersion: spec.registryEntryVersion,
    registryEntryId: spec.registryEntryId,
  } as const;

  // ── 6b. Register AbortController for cancel-bus fast path ──────────────
  // The cancel-bus subscriber looks up this requestId in the in-flight map
  // and calls `ctrl.abort()` when a /cancel publish lands on any pod.
  const ctrl = new AbortController();
  const requestId = row.generationRequestId;
  const inFlight = deps.inFlight;
  inFlight?.set(requestId, ctrl);

  const hasBlocker = (flags: Flag[]): boolean =>
    flags.some((f) => f.severity === 'blocker');

  let result: RouteResult;
  // Sum of the actual cost of EVERY router.route() call we make for this unit.
  // The router writes one trace row (with its own actual_cost_usd) and spends
  // real budget per call, so a validator retry produces a second trace + a
  // second charge. The job/request rollup must reflect the SUM of all calls,
  // not just the final winning `result` — otherwise `generation_requests.
  // actual_cost_usd` undercounts Σ(trace.actual_cost_usd) by the dropped
  // first-call cost (ADR-0003 S2: the ~2× rollup undercount). `result.usage.
  // estimatedCostUsd` carries the router's per-call actual (it sets
  // `estimatedCostUsd = Σ breakdown` on success); we accumulate it across calls.
  let accumulatedCostUsd = 0;
  try {
    // ── 6c. Race-close re-check ──
    // If /cancel landed between step 2's pre-pickup check and now, the
    // publish fired into an empty map (we hadn't registered yet). Re-read
    // parent.status to catch that window and skip paying for an LLM call
    // whose output we'd discard anyway.
    const raceCheck = await db
      .select({ status: generationRequests.status })
      .from(generationRequests)
      .where(eq(generationRequests.id, requestId))
      .limit(1);
    if (raceCheck[0]?.status === 'cancelled') {
      await db
        .update(generationJobs)
        .set({ status: 'cancelled', finishedAt: new Date() })
        .where(eq(generationJobs.id, row.id));
      return;
    }

    try {
      result = await router.route({
        ...baseRouteReq,
        messages: withSystemMessage(systemPrompt, [
          { role: 'user', content: renderedPrompt },
        ]),
        signal: ctrl.signal,
      });
      accumulatedCostUsd += result.usage.estimatedCostUsd ?? 0;
    } catch (err) {
      if ((err as Error)?.name === 'AbortError' || ctrl.signal.aborted) {
        await markJobCancelledFromAbort({ db, row, err });
        return;
      }
      await markJobFailed({
        db,
        row,
        parent,
        error: `router error: ${err instanceof Error ? err.message : String(err)}`,
        bus,
      });
      return;
    }

    // ── 8. Validator retry (cap = MAX_VALIDATOR_RETRIES) ──────────────────
    // First attempt = the call we just made; the row's attempts counter was
    // bumped to 1 in step 6. We allow ONE retry — total = 2 calls max.
    if (hasBlocker(result.flags) && MAX_VALIDATOR_RETRIES >= 1) {
      const blockerMsg = result.flags
        .filter((f) => f.severity === 'blocker')
        .map((f) => `[${f.code}] ${f.message}`)
        .join('\n');
      try {
        const retry = await router.route({
          ...baseRouteReq,
          // The retry MUST carry the same system prompt as the first pass —
          // otherwise the model is asked to fix its output while losing the
          // very contract it was violating.
          messages: withSystemMessage(systemPrompt, [
            { role: 'user', content: renderedPrompt },
            { role: 'assistant', content: result.content },
            {
              role: 'user',
              content: `Your previous output failed validation:\n${blockerMsg}\nTry again.`,
            },
          ]),
          signal: ctrl.signal,
        });
        // The retry call was made + traced + charged regardless of whether we
        // keep its output, so its cost ALWAYS counts toward the rollup.
        accumulatedCostUsd += retry.usage.estimatedCostUsd ?? 0;
        if (!hasBlocker(retry.flags)) {
          result = retry;
        }
      } catch (err) {
        if ((err as Error)?.name === 'AbortError' || ctrl.signal.aborted) {
          await markJobCancelledFromAbort({ db, row, err });
          return;
        }
        // Retry-time router exception — keep the original result; log and move on.
        console.warn(
          `generation worker: validator retry threw for job ${row.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // ── 8b. Cancel check (post-LLM-call race window — plan §D.3/D.4) ──────
    // Still load-bearing as the correctness safety net when a /cancel lands
    // after router.route already returned successfully (no abort signal),
    // or when the pub/sub message was missed due to subscriber reconnect.
    const parentReread = await db
      .select({ status: generationRequests.status })
      .from(generationRequests)
      .where(eq(generationRequests.id, row.generationRequestId))
      .limit(1);
    if (parentReread[0]?.status === 'cancelled') {
      await db
        .update(generationJobs)
        .set({
          status: 'cancelled',
          finishedAt: new Date(),
          traceId: result.traceId,
          // Stamp the cumulative cost of every call made (first + any retry),
          // matching the traces already written, not just the last result.
          actualCostUsd: usdString(accumulatedCostUsd),
        })
        .where(eq(generationJobs.id, row.id));
      return;
    }
  } finally {
    // Always remove ourselves from the in-flight map so a late /cancel for
    // this requestId doesn't accidentally abort a future unrelated job.
    inFlight?.delete(requestId);
  }

  // ── 9. Write output + status ──────────────────────────────────────────
  const stillHasBlocker = hasBlocker(result.flags);
  const finalStatus: 'completed' | 'failed' = stillHasBlocker ? 'failed' : 'completed';
  const outputPayload =
    result.parsed !== undefined
      ? (result.parsed as object)
      : { text: result.content, flags: result.flags };
  const finishedAt = new Date();
  // Authoritative per-unit cost = the sum of EVERY router call we made (the
  // initial pass plus any validator retry), which equals Σ of the trace rows
  // the router wrote for this unit. Using the final `result.usage` alone would
  // drop the cost of a discarded retry (or of the first pass when the retry
  // wins), undercounting the request rollup. See ADR-0003 S2.
  const cost = accumulatedCostUsd;

  await db
    .update(generationJobs)
    .set({
      status: finalStatus,
      output: outputPayload as Record<string, unknown>,
      finishedAt,
      actualCostUsd: usdString(cost),
      traceId: result.traceId,
      error: stillHasBlocker
        ? result.flags
            .filter((f) => f.severity === 'blocker')
            .map((f) => `[${f.code}] ${f.message}`)
            .join('\n')
        : null,
    })
    .where(eq(generationJobs.id, row.id));

  // ── 10. Parent counters + terminal transition ─────────────────────────
  const counters = await updateParentCounters({
    db,
    requestId: row.generationRequestId,
    status: finalStatus,
    costDelta: cost,
    now: finishedAt,
  });

  // ── job-level event ──
  if (finalStatus === 'completed') {
    bus.emit({
      type: 'generation.job.completed',
      requestId: row.generationRequestId,
      jobId: row.id,
      unitKey: row.unitKey,
      org: row.org,
      project: row.project ?? undefined,
      flags: result.flags,
      costUsd: cost,
    });
  } else {
    bus.emit({
      type: 'generation.job.failed',
      requestId: row.generationRequestId,
      jobId: row.id,
      unitKey: row.unitKey,
      org: row.org,
      project: row.project ?? undefined,
      errorCode: 'validator-blocker',
      errorMessage: result.flags
        .filter((f) => f.severity === 'blocker')
        .map((f) => `[${f.code}] ${f.message}`)
        .join('\n'),
    });
  }

  // ── Callback contract: per-unit terminal envelope. Fires unconditionally
  // (even if the request has no callbackUrl on it, we look it up via the
  // counters or project_configs fallback) — fire-and-forget, never blocks
  // the terminal transition.
  const perUnitCallbackUrl =
    counters?.callbackUrl ?? (await resolveProjectCallbackUrl(db, row.org, row.project));
  if (perUnitCallbackUrl) {
    const apiKeyId = counters?.apiKeyId ?? null;
    const clientRequestId = counters?.clientRequestId ?? null;
    const baseEnv = {
      emittedAt: finishedAt.toISOString(),
      requestId: row.generationRequestId,
      clientRequestId,
      unitKey: row.unitKey,
      unitType: row.unitType ?? null,
    };
    if (finalStatus === 'completed') {
      void enqueueCallback(
        {
          ...baseEnv,
          event: 'unit.completed',
          output: {
            text: result.content,
            structured: result.parsed ?? null,
            flags: result.flags,
          },
          costUsd: cost,
          durationMs: result.durationMs ?? 0,
          modelUsed: result.model,
          traceId: result.traceId,
          registryEntryId: spec.registryEntryId ?? null,
        },
        {
          url: perUnitCallbackUrl,
          apiKeyId,
          source: 'generate',
          sourceId: row.generationRequestId,
          itemKey: row.unitKey,
          org: row.org,
          project: row.project ?? null,
        },
        { db },
      ).catch((err) => {
        console.warn(
          `generation worker: enqueueCallback (unit.completed) failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    } else {
      const errorMessage = result.flags
        .filter((f) => f.severity === 'blocker')
        .map((f) => `[${f.code}] ${f.message}`)
        .join('\n');
      void enqueueCallback(
        {
          ...baseEnv,
          event: 'unit.failed',
          error: { code: 'validator-blocker', message: errorMessage },
          costUsd: cost,
          durationMs: result.durationMs ?? 0,
          traceId: result.traceId,
        },
        {
          url: perUnitCallbackUrl,
          apiKeyId,
          source: 'generate',
          sourceId: row.generationRequestId,
          itemKey: row.unitKey,
          org: row.org,
          project: row.project ?? null,
        },
        { db },
      ).catch((err) => {
        console.warn(
          `generation worker: enqueueCallback (unit.failed) failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  }

  // ── request-level terminal event + callback ──
  if (counters && counters.terminalNow) {
    const terminalStatus = counters.status === 'cancelled' ? 'failed' : counters.status;
    if (
      terminalStatus === 'completed' ||
      terminalStatus === 'partial' ||
      terminalStatus === 'failed'
    ) {
      bus.emit({
        type: 'generation.request.completed',
        requestId: row.generationRequestId,
        org: row.org,
        project: row.project ?? undefined,
        status: terminalStatus,
        totalCostUsd: counters.actualCostUsd,
      });
    }

    // Callback contract: request-level terminal envelope. We map our internal
    // tri-state ('completed' | 'partial' | 'failed') to the contract's
    // 'request.completed' (any docs completed) / 'request.failed' (none).
    const callbackUrl = counters.callbackUrl ?? (await resolveProjectCallbackUrl(db, row.org, row.project));
    if (callbackUrl) {
      const event: 'request.completed' | 'request.failed' =
        terminalStatus === 'failed' ? 'request.failed' : 'request.completed';
      void enqueueCallback(
        {
          event,
          emittedAt: new Date().toISOString(),
          requestId: row.generationRequestId,
          clientRequestId: counters.clientRequestId,
          totalJobs: counters.totalJobs,
          completedJobs: counters.completedJobs,
          failedJobs: counters.failedJobs,
          cancelledJobs: 0,
          totalCostUsd: counters.actualCostUsd,
        },
        {
          url: callbackUrl,
          apiKeyId: counters.apiKeyId,
          source: 'generate',
          sourceId: row.generationRequestId,
          itemKey: null,
          org: counters.org,
          project: counters.project,
        },
        { db },
      ).catch((err) => {
        console.warn(
          `generation worker: enqueueCallback (request terminal) failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The router's streaming adapter throws `OpenRouterAbortError` (name='AbortError')
 * carrying a partial completion whenever it aborts mid-stream. The router has
 * already written the trace + usage rows with status='aborted' and the partial
 * actualCostUsd; here we only need to flip the corresponding `generation_jobs`
 * row to 'cancelled' and stamp the same actualCostUsd so the per-job ledger
 * matches the trace.
 *
 * Non-OpenRouterAbortError aborts (e.g. ctrl.signal.aborted but the adapter
 * was already in res.text() and threw a plain AbortError) still land here;
 * we just don't have a partial in that case and record $0.
 */
async function markJobCancelledFromAbort(args: {
  db: Db;
  row: typeof generationJobs.$inferSelect;
  err: unknown;
}): Promise<void> {
  const { db, row, err } = args;
  const partial = err instanceof OpenRouterAbortError ? err.partial : undefined;
  const partialCost = partial?.usage.costUsd ?? 0;
  await db
    .update(generationJobs)
    .set({
      status: 'cancelled',
      finishedAt: new Date(),
      actualCostUsd: usdString(partialCost),
    })
    .where(eq(generationJobs.id, row.id));
}

async function markJobFailed(args: {
  db: Db;
  row: typeof generationJobs.$inferSelect;
  parent: typeof generationRequests.$inferSelect;
  error: string;
  bus: EventBus;
}): Promise<void> {
  const { db, row, parent, error, bus } = args;
  const finishedAt = new Date();
  await db
    .update(generationJobs)
    .set({
      status: 'failed',
      error,
      finishedAt,
    })
    .where(eq(generationJobs.id, row.id));

  bus.emit({
    type: 'generation.job.failed',
    requestId: row.generationRequestId,
    jobId: row.id,
    unitKey: row.unitKey,
    org: row.org,
    project: row.project ?? undefined,
    errorCode: 'job-failed',
    errorMessage: error,
  });

  const counters = await updateParentCounters({
    db,
    requestId: row.generationRequestId,
    status: 'failed',
    costDelta: 0,
    now: finishedAt,
  });

  // ── Callback contract: per-unit `unit.failed` ──
  const perUnitCallbackUrl =
    counters?.callbackUrl ?? (await resolveProjectCallbackUrl(db, row.org, row.project));
  if (perUnitCallbackUrl) {
    void enqueueCallback(
      {
        event: 'unit.failed',
        emittedAt: finishedAt.toISOString(),
        requestId: row.generationRequestId,
        clientRequestId: counters?.clientRequestId ?? null,
        unitKey: row.unitKey,
        unitType: row.unitType ?? null,
        error: { code: 'job-failed', message: error },
        costUsd: 0,
        durationMs: 0,
        traceId: row.traceId ?? null,
      },
      {
        url: perUnitCallbackUrl,
        apiKeyId: counters?.apiKeyId ?? null,
        source: 'generate',
        sourceId: row.generationRequestId,
        itemKey: row.unitKey,
        org: row.org,
        project: row.project ?? null,
      },
      { db },
    ).catch((err) => {
      console.warn(
        `generation worker: enqueueCallback (unit.failed) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  if (counters && counters.terminalNow) {
    const terminalStatus = counters.status === 'cancelled' ? 'failed' : counters.status;
    if (
      terminalStatus === 'completed' ||
      terminalStatus === 'partial' ||
      terminalStatus === 'failed'
    ) {
      bus.emit({
        type: 'generation.request.completed',
        requestId: row.generationRequestId,
        org: row.org,
        project: row.project ?? undefined,
        status: terminalStatus,
        totalCostUsd: counters.actualCostUsd,
      });
    }
    const callbackUrl = counters.callbackUrl ?? (await resolveProjectCallbackUrl(db, row.org, row.project));
    if (callbackUrl) {
      const event: 'request.completed' | 'request.failed' =
        terminalStatus === 'failed' ? 'request.failed' : 'request.completed';
      void enqueueCallback(
        {
          event,
          emittedAt: new Date().toISOString(),
          requestId: row.generationRequestId,
          clientRequestId: counters.clientRequestId,
          totalJobs: counters.totalJobs,
          completedJobs: counters.completedJobs,
          failedJobs: counters.failedJobs,
          cancelledJobs: 0,
          totalCostUsd: counters.actualCostUsd,
        },
        {
          url: callbackUrl,
          apiKeyId: counters.apiKeyId,
          source: 'generate',
          sourceId: row.generationRequestId,
          itemKey: null,
          org: counters.org,
          project: counters.project,
        },
        { db },
      ).catch((err) => {
        console.warn(
          `generation worker: enqueueCallback (request terminal) failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  }
  void parent;
}

async function updateParentCounters(args: {
  db: Db;
  requestId: string;
  status: 'completed' | 'failed';
  costDelta: number;
  now: Date;
}): Promise<ParentCountersResult | null> {
  const { db, requestId, status, costDelta, now } = args;
  return db.transaction(async (tx) => {
    // Atomic counter bump.
    if (status === 'completed') {
      await tx
        .update(generationRequests)
        .set({
          completedJobs: sql`${generationRequests.completedJobs} + 1`,
          actualCostUsd: sql`${generationRequests.actualCostUsd} + ${costDelta.toFixed(6)}::numeric`,
        })
        .where(eq(generationRequests.id, requestId));
    } else {
      await tx
        .update(generationRequests)
        .set({
          failedJobs: sql`${generationRequests.failedJobs} + 1`,
          actualCostUsd: sql`${generationRequests.actualCostUsd} + ${costDelta.toFixed(6)}::numeric`,
        })
        .where(eq(generationRequests.id, requestId));
    }

    const after = await tx
      .select()
      .from(generationRequests)
      .where(eq(generationRequests.id, requestId))
      .limit(1);
    const parent = after[0];
    if (!parent) return null;

    const total = parent.totalJobs ?? 0;
    const completed = parent.completedJobs ?? 0;
    const failed = parent.failedJobs ?? 0;
    const allDone = total > 0 && completed + failed >= total;
    const wasTerminal =
      parent.status === 'completed' ||
      parent.status === 'failed' ||
      parent.status === 'partial' ||
      parent.status === 'cancelled';
    const terminalNow = allDone && !wasTerminal;

    let nextStatus: ParentCountersResult['status'] = parent.status;
    if (terminalNow) {
      if (failed === 0) nextStatus = 'completed';
      else if (completed === 0) nextStatus = 'failed';
      else nextStatus = 'partial';
      await tx
        .update(generationRequests)
        .set({ status: nextStatus, finishedAt: now })
        .where(eq(generationRequests.id, requestId));
    } else if (parent.status === 'queued') {
      // First job to land — bump to running.
      nextStatus = 'running';
      await tx
        .update(generationRequests)
        .set({ status: 'running' })
        .where(eq(generationRequests.id, requestId));
    }

    return {
      status: nextStatus,
      totalJobs: total,
      completedJobs: completed,
      failedJobs: failed,
      actualCostUsd: toNumber(parent.actualCostUsd),
      callbackUrl: parent.callbackUrl ?? null,
      apiKeyId: parent.apiKeyId ?? null,
      clientRequestId: parent.clientRequestId ?? null,
      org: parent.org,
      project: parent.project ?? null,
      terminalNow,
    };
  });
}

async function resolveProjectCallbackUrl(
  db: Db,
  org: string,
  project: string | null | undefined,
): Promise<string | null> {
  if (!project) return null;
  const rows = await db
    .select({ callbackUrl: projectConfigs.callbackUrl })
    .from(projectConfigs)
    .where(and(eq(projectConfigs.org, org), eq(projectConfigs.project, project)))
    .limit(1);
  return rows[0]?.callbackUrl ?? null;
}

// ---------------------------------------------------------------------------
// BullMQ Worker bootstrap
// ---------------------------------------------------------------------------

export async function startGenerationWorker(
  deps: WorkerDeps = {},
): Promise<{ worker: Worker<GenerationJobData>; stop: () => Promise<void> }> {
  // Shared between every job picked up by this worker process AND the cancel
  // bus subscriber installed below.
  const inFlight: InFlightMap = deps.inFlight ?? new Map();
  const cancelBus = deps.cancelBus ?? getCancelBus();
  await cancelBus.start();
  const unsubscribe = cancelBus.onCancel((requestId) => {
    inFlight.get(requestId)?.abort();
  });

  const worker = new Worker<GenerationJobData>(
    GENERATION_QUEUE_NAME,
    async (job) => {
      await processGenerationJob({ id: job.id, data: job.data }, {
        ...deps,
        inFlight,
        cancelBus,
      });
    },
    {
      connection: redisConnection,
      concurrency: 5,
      limiter: { max: 10, duration: 1000 },
    },
  );

  worker.on('failed', (job, err) => {
    console.error(
      `generation worker: BullMQ-level failure for job ${job?.id}: ${err.message}`,
    );
  });

  return {
    worker,
    stop: async () => {
      unsubscribe();
      await worker.close().catch(() => undefined);
      // Don't stop a bus that was injected by the caller (tests own its
      // lifecycle); only tear down the default singleton.
      if (!deps.cancelBus) {
        await cancelBus.stop().catch(() => undefined);
      }
    },
  };
}
