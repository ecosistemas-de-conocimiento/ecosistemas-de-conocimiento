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
//   - 🔴 EXACTLY-ONCE-ISH JOB LIFECYCLE (see `claimJob` + `writeTerminalStatus`
//     below): the row is CLAIMED with a conditional UPDATE, and every terminal
//     write carries `WHERE status NOT IN ('completed','failed','cancelled')`.
//     A second worker handed the same job by BullMQ's stalled checker finds
//     nothing to claim and returns; a late writer from the first worker finds
//     nothing to overwrite. Without both, a stalled job ran twice and a
//     COMPLETED job's row could end up reading 'cancelled'.
//
// TODO(M3.7): use Fastify pino logger via context injection — for now we log
// through console.warn / console.error.

import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';

import { db as defaultDb, type Db } from '../db/client.js';
import { isAiServiceError } from '../errors/base.js';
import {
  generationJobs,
  generationRequests,
  projectConfigs,
} from '../db/schema/index.js';
import {
  GENERATION_QUEUE_NAME,
  attachWorkerLifecycleLogging,
  workerRuntimeOptions,
  type WorkerRuntimeOptions,
} from '../queue/queues.js';
import { BudgetEnforcer } from '../services/budget/enforcer.js';
import { env } from '../config/env.js';
import { enqueueCallback } from '../services/callbacks/emit.js';
import { getEventBus, type EventBus } from '../services/events/bus.js';
import { createOpenRouter } from '../services/ai/router/openrouter.js';
import { OpenRouterAbortError } from '../services/ai/router/adapters/openrouter.js';
import { TraceWriter } from '../services/ai/router/trace-writer.js';
import type { LLMRouter, RouteResult } from '../services/ai/router/types.js';
import { renderPrompt } from '../services/render/handlebars.js';
import { EFFORT_PROFILES, resolveSpec } from '../services/registry/resolve.js';
import type { EffortLevel } from '../contract/registry.js';
import {
  resolveSystemPrompt,
  withSystemMessage,
} from '../services/generation/system-prompt.js';
import type { Flag } from '../services/ai/validators/types.js';
import type { CancelBus } from '../services/generation/cancel-bus.js';
import {
  WORKER_LOST_CODE,
  WORKER_LOST_ERROR,
  lostWindowMs,
} from '../services/jobs/lost.js';
import {
  SHUTDOWN_ABORT_REASON,
  SHUTDOWN_CODE,
  SHUTDOWN_ERROR,
  SHUTDOWN_SETTLE_MS,
  awaitBounded,
  shutdownGraceMs,
  waitForDrain,
} from '../services/jobs/shutdown.js';
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
  /**
   * The BullMQ Redis connection. Required by `startGenerationWorker`; comes
   * from `Runtime.redis` (`src/runtime.ts`). Named `connection`, NOT `runtime`
   * — `runtime` is already taken here by the lock/stall overrides below.
   */
  connection?: Redis;
  router?: LLMRouter;
  bus?: EventBus;
  /**
   * Map shared with the cancel-bus subscriber. Tests can pass a fresh Map;
   * production code lets `startGenerationWorker` create + own one.
   */
  inFlight?: InFlightMap;
  cancelBus?: CancelBus;
  /**
   * BullMQ lock/stall overrides for `startGenerationWorker`. Production leaves
   * this undefined and gets `workerRuntimeOptions()`. The integration test for
   * the stalled double-run patches `lockDuration` + `stalledInterval` down to
   * milliseconds so a stall is reproducible inside a test timeout.
   */
  runtime?: Partial<WorkerRuntimeOptions>;
  /** Worker concurrency override. Test seam only. */
  concurrency?: number;
  /**
   * How old a `running` row must be before a redelivery presumes its owner
   * died. Production leaves this undefined and gets `lostWindowMs()`; the
   * integration repro shrinks it so a SIGKILL fits inside a test timeout.
   */
  lostWindowMs?: number;
  /**
   * Overrides `env.SHUTDOWN_GRACE_MS` for `stop()`. Production leaves this
   * undefined; the shutdown integration test shrinks it so a whole
   * grace-expiry-then-abort cycle fits inside a test timeout.
   */
  shutdownGraceMs?: number;
}

/**
 * The three statuses a `generation_jobs` row never leaves. Every terminal write
 * in this file is conditional on the row NOT already being one of them, so the
 * guard lives in SQL rather than in a read-then-write window.
 */
export const TERMINAL_JOB_STATUSES = ['completed', 'failed', 'cancelled'] as const;

/**
 * The statuses a `generation_requests` (parent) row never leaves. `partial` is
 * one of them and is NOT in the job-level list — a request that ended with a
 * mix of completed and failed jobs is finished, and must not be re-settled.
 */
export const TERMINAL_REQUEST_STATUSES = [
  'completed',
  'failed',
  'partial',
  'cancelled',
] as const;

interface ParentCountersResult {
  status: 'queued' | 'running' | 'partial' | 'completed' | 'failed' | 'cancelled';
  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
  /**
   * How many of the request's jobs ended CANCELLED, counted INSIDE the same
   * transaction as the columns above.
   *
   * 🔴 IT USED TO BE A SECOND SNAPSHOT. A `countCancelledJobs(db, requestId)`
   * helper (now deleted) ran
   * after the counters transaction had already committed, so the envelope's own
   * arithmetic — `totalJobs == completed + failed + cancelled` — was assembled
   * from two different readings of the table with a window in between. Worse,
   * it was ALWAYS 0 in practice: a cancelled job never bumps a parent counter,
   * so `allDone` never fires on one, so the terminal envelope this number rides
   * on is only ever produced by a request whose cancelled siblings were settled
   * by `/cancel` — which takes the request terminal itself, through
   * `cancel.ts`'s own `request.cancelled` envelope, and never reaches here.
   *
   * ⚠ SO THIS NUMBER IS INFORMATIONAL. It is the honest count of what the table
   * says at the moment the parent went terminal, and it makes the envelope's
   * arithmetic add up; it is not the channel a consumer learns about a
   * cancellation on. That is `request.cancelled`.
   */
  cancelledJobs: number;
  actualCostUsd: number;
  callbackUrl: string | null;
  apiKeyId: string | null;
  clientRequestId: string | null;
  org: string;
  project: string | null;
  /** True when this UPDATE took the parent from non-terminal to terminal. */
  terminalNow: boolean;
}

/**
 * Log suffix carrying the inbound HTTP correlation id, when the enqueuer sent
 * one. Returns '' for a job enqueued before `httpRequestId` existed (jobs
 * already sitting in Redis at deploy time), so no log line degrades to the
 * string 'undefined'.
 *
 * ⚠ `httpRequestId`, never `requestId` — `requestId` is
 * `generation_requests.id` throughout this service.
 */
export function correlationSuffix(data: {
  httpRequestId?: string | undefined;
}): string {
  return data.httpRequestId ? ` [httpRequestId=${data.httpRequestId}]` : '';
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
 * Conditional terminal write. Returns TRUE when this call actually moved the
 * row, FALSE when the row was already terminal and nothing was written.
 *
 * 🔴 THE `notInArray` IS THE WHOLE POINT. Every caller used to write
 * `.where(eq(generationJobs.id, row.id))` unconditionally, so the LAST writer
 * won regardless of what it was overwriting. Under a stalled re-delivery that
 * meant the first worker's late `status = 'cancelled'` landing on top of the
 * second worker's `status = 'completed'` — a finished job reported as
 * cancelled, with its output already written. A false return means "someone
 * else already settled this job"; the caller MUST then skip its side effects
 * (parent counters, events, callbacks), because those are not idempotent.
 */
async function writeTerminalStatus(
  db: Db,
  jobId: string,
  values: Partial<typeof generationJobs.$inferInsert>,
): Promise<boolean> {
  const written = await db
    .update(generationJobs)
    .set(values)
    .where(
      and(
        eq(generationJobs.id, jobId),
        notInArray(generationJobs.status, [...TERMINAL_JOB_STATUSES]),
      ),
    )
    .returning({ id: generationJobs.id });
  return written.length > 0;
}

/**
 * Claim the row for THIS worker. One conditional UPDATE, so exactly one of N
 * concurrent workers can win: `status = 'queued'` is the only state a claim is
 * allowed from, and the winner flips it to 'running' in the same statement.
 * `attempts` increments in SQL, not from the row we read at step 1, so two
 * racing readers can't both write `attempts = 1`.
 *
 * ⚠ A job whose worker DIED while the row said 'running' is deliberately NOT
 * re-claimable — re-running it would make a second LLM call, charge the org
 * twice and write a second trace, all invisibly. It is not left stuck either:
 * `reapLostGenerationJob` below turns a row that outlived the lock window into
 * a NAMED FAILURE (`error = 'worker_lost'`), refunds the reserve and pushes it
 * through the ordinary job-failure path so the consumer is told. Never re-run,
 * always reported — see `src/services/jobs/lost.ts`.
 */
async function claimJob(db: Db, jobId: string): Promise<boolean> {
  const claimed = await db
    .update(generationJobs)
    .set({
      status: 'running',
      // 🔴 POSTGRES' clock, not node's. The reap compares `started_at` against
      // `now()` on the server; stamping it from a worker whose clock runs
      // ahead makes a live job look older than the window (a false reap), and
      // one that runs behind hides a genuinely lost job. One clock, both ends.
      startedAt: sql`now()`,
      attempts: sql`${generationJobs.attempts} + 1`,
    })
    .where(
      and(eq(generationJobs.id, jobId), eq(generationJobs.status, 'queued')),
    )
    .returning({ id: generationJobs.id });
  return claimed.length > 0;
}


// ---------------------------------------------------------------------------
// Worker lost — a claimed row whose worker died
// ---------------------------------------------------------------------------
//
// The full reasoning lives in `src/services/jobs/lost.ts`. The short version:
// a `running` row that outlived the lock window belongs to a process that is
// gone. It is never re-run; it is FAILED with a named reason, its reserve is
// refunded, and it goes through `markJobFailed` so the parent settles, the
// event fires and the consumer's callback lands like any other failure.

/**
 * The reserve the router took for this unit and never trued up.
 *
 * `metadata.reservePerCallUsd` is written by the orchestrator at enqueue time
 * and is the EXACT number `RouterImpl.budgetReserve` holds PER PROVIDER CALL
 * (`effortProfile.estimatedCostUsdPerCall`). It is NOT the money a job can
 * strand: the router reserves once per PASS and once per extra SAMPLE, so the
 * reservable total is `perCall × validationPasses × multiSample`.
 *
 * 🔴 Returning the bare per-call number UNDER-refunded every multi-pass tier.
 * Measured on `deep` (2 × 1): 0.00287 returned against 0.00574 held — half the
 * money left on the org's cap. `maximum` (2 × 3) was worse.
 *
 * ── Where the two factors come from ───────────────────────────────────────
 * NOT from `metadata` — the orchestrator records only `reservePerCallUsd`
 * there, and this module does not get to add fields to a row that was written
 * by a process that is now gone. Two sources are used together:
 *
 *   · `EFFORT_PROFILES[row.effort]` — the built-in profile for the tier the
 *     row was enqueued at. Exact for every job that took the built-in
 *     profile, which is all of them unless a project overrode the tier.
 *   · `estimated_cost_usd` on the row, which the orchestrator computes as
 *     `perCall × validationPasses × multiSample` FROM THE RESOLVED PROFILE,
 *     so it already carries any per-project override of those factors.
 *
 * The answer is the LARGER of the two, which keeps an overridden profile
 * (more passes than the built-in) from being under-refunded and still answers
 * correctly for rows that carry only one of the two numbers. Rows enqueued
 * before `reservePerCallUsd` existed fall through to `estimated_cost_usd`
 * alone, which is the same product and therefore AGREES rather than
 * over-refunding — the older claim that it over-refunded on deep/maximum was
 * comparing it against the per-call bug above, and the real direction of that
 * bug was UNDER-refund.
 *
 * ⚠ Deliberately generous at the other end: a worker killed in the window
 * between the claim and the router's reserve had NOTHING held, and this
 * refunds anyway. That window is a few statements wide (the spec is already
 * resolved before the claim), and the ruling is that a stranded consumer gets
 * their money back.
 */
export function lostReserveUsd(row: {
  metadata: unknown;
  estimatedCostUsd: string | null;
  /** The tier the row was enqueued at; supplies the pass/sample factors. */
  effort?: EffortLevel | null;
}): number {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const recorded = Number(meta['reservePerCallUsd']);
  const profile = row.effort ? EFFORT_PROFILES[row.effort] : undefined;
  // A missing, NaN or non-positive factor means "one call", never "no money".
  const passes = positiveFactor(profile?.validationPasses);
  const samples = positiveFactor(profile?.multiSample);
  const fromPerCall =
    Number.isFinite(recorded) && recorded > 0 ? recorded * passes * samples : 0;
  const estimate = Number(row.estimatedCostUsd ?? 0);
  const fromEstimate = Number.isFinite(estimate) && estimate > 0 ? estimate : 0;
  return Math.max(fromPerCall, fromEstimate);
}

/** A pass/sample multiplier, defaulted to 1 for missing / NaN / non-positive. */
function positiveFactor(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 1;
}

/**
 * The refund a lost job is actually owed — the LARGER of what the ledger can
 * prove and what the row estimates.
 *
 * `budget_reservations` records one row per hold the router took, keyed by
 * `job_id`, so the sum of this job's still-`reserved` rows is money that is
 * provably stranded on the org's cap. It is exact only when EVERY hold made it
 * into the ledger, and the ledger is explicitly "audit, not authority" — a
 * failed INSERT is warned about and swallowed (see `writeReservation` in
 * `services/budget/enforcer.ts`).
 *
 * 🔴 THE PARTIAL SUM. `deep` / `maximum` take SEVERAL holds under one job
 * (initial pass + refine + each extra sample). When only SOME of those rows
 * landed, the sum is a real number, greater than zero, and WRONG — measured at
 * 50% of the money held on `deep`. Taking it because it is non-null
 * under-refunded the org by the missing rows.
 *
 * ── THE THREE-WAY RULE ────────────────────────────────────────────────────
 *   · ledger `null`  ⇒ refund the estimate ({@link lostReserveUsd}).
 *   · ledger `0`     ⇒ refund NOTHING. Authoritative: rows exist and none is
 *     still `reserved`, which is exactly the state a completed refund leaves
 *     behind. Collapsing this into the estimate would let a repeat sweep pay
 *     the same money out twice — a worse defect than the partial sum.
 *   · ledger `> 0`   ⇒ refund `max(ledger, estimate)`. A hold that landed can
 *     only ever RAISE the floor, never lower it.
 *
 * ── What the ledger read's `null` and `0` mean ────────────────────────────
 * Settled from the SQL in `BudgetEnforcer.heldReserveUsd`, not from prose: it
 * aggregates `SUM(amount_usd) FILTER (WHERE state = 'reserved')` alongside
 * `COUNT(*)` over the job's rows, and answers
 *   · `null`  when `COUNT(*) = 0` — the job has NO ledger rows at all (every
 *     job enqueued before the ledger migration, every job whose INSERT
 *     failed, and every worker killed BEFORE the router's first reserve);
 *   · `0`     when rows exist but none is still `reserved` (already settled or
 *     refunded), or they sum to zero.
 * A worker killed between the claim and the reserve therefore lands in the
 * `null` branch and gets the estimate — it does NOT "say 0 and refund 0", as
 * an earlier version of this docstring claimed.
 *
 * ⚠ THE PRICE OF THE MAX. Since {@link lostReserveUsd} now answers the full
 * `perCall × passes × samples`, a `deep` job that legitimately took only its
 * first hold before dying is refunded the whole tier estimate, not the one
 * hold. That is over-refunding, on purpose: this module's standing ruling is
 * that over-refunding a job that will never run is the safe direction, because
 * the alternative silently keeps a stranded consumer's money.
 */
export async function heldOrEstimatedReserveUsd(
  budget: BudgetEnforcer,
  jobId: string,
  row: { metadata: unknown; estimatedCostUsd: string | null; effort?: EffortLevel | null },
): Promise<number> {
  try {
    const held = await budget.heldReserveUsd(jobId);
    // GUARDED max, not a bare one: a partial sum is raised to the estimate,
    // but an authoritative ZERO stays zero — see the three-way rule above.
    if (held !== null) return held > 0 ? Math.max(held, lostReserveUsd(row)) : 0;
  } catch (err) {
    // A ledger read must never block a stranded consumer's refund.
    console.warn(
      `generation worker: reading the held reserve for job ${jobId} failed ` +
        `(${err instanceof Error ? err.message : String(err)}); falling back to the estimate.`,
    );
  }
  return lostReserveUsd(row);
}

/**
 * The guarded transition. ONE statement, so the rowcount is the whole
 * concurrency story: exactly one sweeper (or worker, or `/cancel`) can move a
 * given row, and everything non-idempotent downstream — the refund, the parent
 * counter bump, the event, the callback — hangs off that single winner.
 *
 * `now() - make_interval` is evaluated by Postgres so replicas with drifting
 * clocks still agree on what "past the window" means.
 */
export async function settleLostGenerationJob(
  db: Db,
  jobId: string,
  opts: { windowMs: number; status: 'failed' | 'cancelled'; error: string; code: string },
): Promise<typeof generationJobs.$inferSelect | null> {
  const seconds = opts.windowMs / 1000;
  const rows = await db
    .update(generationJobs)
    .set({
      status: opts.status,
      error: opts.error,
      finishedAt: new Date(),
      actualCostUsd: usdString(0),
      metadata: sql`COALESCE(${generationJobs.metadata}, '{}'::jsonb) || ${JSON.stringify({ errorCode: opts.code })}::jsonb`,
    })
    .where(
      and(
        eq(generationJobs.id, jobId),
        eq(generationJobs.status, 'running'),
        sql`${generationJobs.startedAt} IS NOT NULL`,
        sql`${generationJobs.startedAt} < now() - make_interval(secs => ${seconds})`,
      ),
    )
    .returning();
  return rows[0] ?? null;
}

export interface ReapDeps {
  db?: Db;
  bus?: EventBus;
  budget?: BudgetEnforcer;
  windowMs?: number;
}

/**
 * Reap ONE generation job if it is lost. Returns true when this call was the
 * one that settled it.
 *
 * Called from two places, with identical behaviour:
 *   · the worker's claim-failure branch, when BullMQ redelivers a job whose
 *     first owner died (the fast path — the consumer hears within one lock
 *     window);
 *   · the periodic reaper, for rows BullMQ will never redeliver at all
 *     (Redis flushed, job evicted by `removeOnComplete`, queue drained).
 */
export async function reapLostGenerationJob(
  jobId: string,
  deps: ReapDeps = {},
): Promise<boolean> {
  const db = deps.db ?? defaultDb;
  const bus = deps.bus ?? getEventBus();
  const budget = deps.budget ?? new BudgetEnforcer(db);
  const windowMs = deps.windowMs ?? lostWindowMs();

  let settledRow: typeof generationJobs.$inferSelect | null = null;
  const settle = async (): Promise<boolean> => {
    settledRow = await settleLostGenerationJob(db, jobId, {
      windowMs,
      status: 'failed',
      error: WORKER_LOST_ERROR,
      code: WORKER_LOST_CODE,
    });
    return settledRow !== null;
  };

  // `markJobFailed` needs the pre-transition row and the parent for its
  // callback fields; read them first, but let the guarded UPDATE decide.
  const before = (
    await db.select().from(generationJobs).where(eq(generationJobs.id, jobId)).limit(1)
  )[0];
  if (!before) return false;
  const parent = (
    await db
      .select()
      .from(generationRequests)
      .where(eq(generationRequests.id, before.generationRequestId))
      .limit(1)
  )[0];
  if (!parent) return false;

  await markJobFailed({
    db,
    row: before,
    parent,
    error: WORKER_LOST_ERROR,
    errorCode: WORKER_LOST_CODE,
    bus,
    settle,
  });
  if (!settledRow) return false;

  // Refund AFTER the transition won, never before: the rowcount is the only
  // thing standing between one refund and one refund per sweep.
  const refundUsd = await heldOrEstimatedReserveUsd(budget, jobId, before);
  if (refundUsd > 0) {
    // `jobId` closes this job's ledger rows out as `refunded`, so a second
    // sweep sees no live hold and cannot refund the same money twice.
    await budget.refund({ org: before.org, amountUsd: refundUsd, jobId }).catch((err: unknown) => {
      console.warn(
        `generation worker: refunding the lost reserve for job ${jobId} failed: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }
  console.warn(
    `generation worker: job ${jobId} presumed LOST (running for longer than ` +
      `${windowMs} ms) — failed as '${WORKER_LOST_ERROR}', refunded ` +
      `${refundUsd.toFixed(6)} USD to org ${before.org}. It is NOT re-run.`,
  );
  return true;
}

/**
 * Sweep every lost generation job. Ids are selected first and each row is then
 * reaped through its own guarded UPDATE, so two replicas sweeping at once
 * simply both try and exactly one wins per row.
 */
export async function reapLostGenerationJobs(
  deps: ReapDeps & { batchSize?: number } = {},
): Promise<string[]> {
  const db = deps.db ?? defaultDb;
  const windowMs = deps.windowMs ?? lostWindowMs();
  const seconds = windowMs / 1000;
  const candidates = await db
    .select({ id: generationJobs.id })
    .from(generationJobs)
    .where(
      and(
        eq(generationJobs.status, 'running'),
        sql`${generationJobs.startedAt} IS NOT NULL`,
        sql`${generationJobs.startedAt} < now() - make_interval(secs => ${seconds})`,
      ),
    )
    .limit(deps.batchSize ?? 100);
  const reaped: string[] = [];
  for (const c of candidates) {
    if (await reapLostGenerationJob(c.id, { ...deps, windowMs })) reaped.push(c.id);
  }
  return reaped;
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
  // ── THE DRAIN REGISTRATION, AT HANDLER ENTRY ──────────────────────────
  //
  // 🔴 THIS WRAPPER IS THE WHOLE POINT OF THE SPLIT. The controller used to be
  // created and registered two thirds of the way down `runGenerationJob`,
  // immediately before `router.route()`, and deleted in a `finally` that closed
  // BEFORE step 9 — the terminal write, the parent rollup and the callback
  // insert. So the in-flight map answered "is anything running?" for the LLM
  // call ONLY.
  //
  // MEASURED on this tree before the fix: a SIGTERM landing while a job was in
  // step 9/10 found an EMPTY map, printed no drain line, took no grace branch —
  // and the process still sat there for 20 s against a 2 s grace, because
  // `worker.close()` was underneath waiting on a job the drain could not see.
  // Registering here and deleting in the `finally` below makes the map mean
  // "this handler has not returned yet", which is the only reading `stop()`'s
  // `waitForDrain` can safely act on.
  //
  // `data.generationRequestId` is the key the cancel bus publishes on, and it
  // is on the QUEUE PAYLOAD — no database read is needed to know it, so the
  // registration genuinely happens before the first `await`.
  const inFlight = deps.inFlight;
  const entryRequestId = bullJob.data.generationRequestId;
  const ctrl = new AbortController();
  inFlight?.set(entryRequestId, ctrl);
  try {
    await runGenerationJob(bullJob, deps, ctrl);
  } finally {
    // Always remove ourselves so a late /cancel for this requestId doesn't
    // abort a future unrelated job — and so the drain map empties only once
    // the rollup is genuinely done.
    inFlight?.delete(entryRequestId);
  }
}

async function runGenerationJob(
  bullJob: { id?: string | number | null; data: GenerationJobData },
  deps: WorkerDeps,
  /**
   * Registered in `deps.inFlight` by the caller. Aborted by the cancel bus on
   * a `/cancel`, and by `stop()` with `SHUTDOWN_ABORT_REASON` when the shutdown
   * grace expires; `settleAbortedJob` reads the reason to tell the two apart.
   */
  ctrl: AbortController,
): Promise<void> {
  const db = deps.db ?? defaultDb;
  const bus = deps.bus ?? getEventBus();
  const router =
    deps.router ??
    createOpenRouter({
      budget: new BudgetEnforcer(db),
      traceWriter: new TraceWriter(db),
      // Async units get their own deadline: no HTTP client is waiting, and a
      // `deep` unit can outrun the 120 s sync wall. See env.ts.
      requestTimeoutMs: env.LLM_ASYNC_REQUEST_TIMEOUT_MS,
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
    console.warn(
      `generation worker: job row ${data.jobId} missing; orphan${correlationSuffix(data)}`,
    );
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
      `generation worker: parent request ${row.generationRequestId} missing for ` +
        `job ${row.id}${correlationSuffix(data)}`,
    );
    return;
  }

  // ── 2. Cancel check (pre-pickup) ──────────────────────────────────────
  if (parent.status === 'cancelled') {
    await writeTerminalStatus(db, row.id, {
      status: 'cancelled',
      finishedAt: new Date(),
    });
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
        errorCode: taxonomyErrorCode(err),
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
      errorCode: taxonomyErrorCode(err),
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
      errorCode: taxonomyErrorCode(err),
      bus,
    });
    return;
  }

  // ── 6. CLAIM the row (exclusive) + emit started event ─────────────────
  // The claim is what makes a stalled re-delivery harmless: BullMQ can hand
  // this job to a second worker at any time, and only one of them finds the
  // row in 'queued'. Everything after this line — the LLM call, the trace, the
  // budget charge — happens exactly once per claim.
  if (!(await claimJob(db, row.id))) {
    // A redelivery. Either a live worker still owns the row (leave it — this
    // is the stalled-redelivery case the claim was built for) or its owner
    // died and the row has outlived the lock window, in which case it is
    // FAILED here rather than left running forever. Never re-run either way:
    // this branch returns before the router is touched.
    const reaped = await reapLostGenerationJob(row.id, {
      db,
      bus,
      windowMs: deps.lostWindowMs ?? lostWindowMs(),
    }).catch((err: unknown) => {
      console.warn(
        `generation worker: reaping job ${row.id} failed: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    });
    if (!reaped) {
      console.warn(
        `generation worker: job ${row.id} was not claimable (row status ` +
          `'${row.status}') — another worker owns it or it is already terminal; ` +
          `skipping.${correlationSuffix(data)}`,
      );
    }
    return;
  }
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
    ...(spec.responseSchemaStrict ? { responseSchemaStrict: true } : {}),
    validators: spec.validators,
    generationRequestId: row.generationRequestId,
    generationJobId: row.id,
    traceId: row.traceId ?? undefined,
    promptVersion: spec.registryEntryVersion,
    registryEntryId: spec.registryEntryId,
  } as const;

  // ── 6b. The AbortController is the CALLER'S ──────────────────────────
  // `processGenerationJob` created it and put it in the in-flight map BEFORE
  // this function was entered, and takes it back out in a `finally` that only
  // runs once step 10's rollup has returned. Registering it here — which is
  // what this line used to do — is the drain hole F2 measured: the map covered
  // the router call and nothing else, so `stop()` saw an EMPTY map while a job
  // was still writing its terminal row, bumping its parent and enqueuing its
  // callback, and the process overran a 2 s grace by 20 s with no drain line.
  const requestId = row.generationRequestId;

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
    await writeTerminalStatus(db, row.id, {
      status: 'cancelled',
      finishedAt: new Date(),
    });
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
      await settleAbortedJob({ db, row, parent, err, ctrl, bus });
      return;
    }
    await markJobFailed({
      db,
      row,
      parent,
      error: `router error: ${err instanceof Error ? err.message : String(err)}`,
      errorCode: taxonomyErrorCode(err),
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
        await settleAbortedJob({ db, row, parent, err, ctrl, bus });
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
    await writeTerminalStatus(db, row.id, {
      status: 'cancelled',
      finishedAt: new Date(),
      traceId: result.traceId,
      // Stamp the cumulative cost of every call made (first + any retry),
      // matching the traces already written, not just the last result.
      actualCostUsd: usdString(accumulatedCostUsd),
    });
    return;
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

  const settled = await writeTerminalStatus(db, row.id, {
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
  });
  if (!settled) {
    // Someone else already settled this row (a /cancel that raced us, or a
    // duplicate delivery that won). Bailing here is what keeps the parent
    // counters, the events and the callbacks single-fire — they are NOT
    // idempotent, and double-counting them is how `completed_jobs` overshoots
    // `total_jobs`.
    console.warn(
      `generation worker: job ${row.id} was already terminal when this worker ` +
        `tried to write '${finalStatus}'; skipping rollup, events and callbacks.`,
    );
    return;
  }

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
          // Counted on the counters transaction itself — see `cancelledJobs`
          // on `ParentCountersResult` for why it is informational.
          cancelledJobs: counters.cancelledJobs,
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
/**
 * Settle a job whose LLM call was ABORTED — the one place that decides which
 * kind of abort it was.
 *
 * 🔴 THE TWO KINDS ARRIVE AS THE SAME EXCEPTION and must settle DIFFERENTLY.
 *
 *   `/cancel`  — `cancelGeneration` has ALREADY written the parent request to
 *                'cancelled' in Postgres; the pub/sub abort is only the
 *                wake-up hint (see `cancel-bus.ts`). The parent rollup and the
 *                consumer notification are that call's job, already done. All
 *                this job has to do is record ITSELF as cancelled with the
 *                partial cost, which is what `markJobCancelledFromAbort` does.
 *                Running the failure rollup here instead would fire a SECOND
 *                terminal callback for a request the consumer was already told
 *                about, and bump `failed_jobs` on a cancelled request.
 *
 *   shutdown   — nobody wrote anything. If this job only recorded itself, the
 *                parent would sit at 'running' with no worker left to finish
 *                it, no callback, and no reaper coverage either (the reaper
 *                looks for `status = 'running'` JOB rows, and this one is now
 *                terminal). So a shutdown abort takes the FULL failure rollup:
 *                parent counters, bus event, `unit.failed`, and the terminal
 *                `request.*` envelope — the same path a lost worker takes, and
 *                named differently from it on purpose.
 *
 * The only thing that can tell them apart at this point is the abort REASON,
 * which the shutdown path stamps on the controller.
 */
async function settleAbortedJob(args: {
  db: Db;
  row: typeof generationJobs.$inferSelect;
  parent: typeof generationRequests.$inferSelect;
  err: unknown;
  ctrl: AbortController;
  bus: EventBus;
}): Promise<void> {
  const { db, row, parent, err, ctrl, bus } = args;
  if (ctrl.signal.reason !== SHUTDOWN_ABORT_REASON) {
    await markJobCancelledFromAbort({ db, row, err });
    return;
  }
  await markJobFailed({
    db,
    row,
    parent,
    bus,
    error: SHUTDOWN_ERROR,
    errorCode: SHUTDOWN_CODE,
    // Partial billing, exactly as on the cancel path: the provider streamed
    // (and charged for) whatever arrived before the abort, and the router
    // already wrote that trace. Dropping it here would make the request
    // rollup disagree with the sum of its own trace rows.
    costUsd: partialCostOf(err),
  });
}

/** The cost of whatever a stream delivered before it was aborted. */
function partialCostOf(err: unknown): number {
  return err instanceof OpenRouterAbortError ? (err.partial?.usage.costUsd ?? 0) : 0;
}

async function markJobCancelledFromAbort(args: {
  db: Db;
  row: typeof generationJobs.$inferSelect;
  err: unknown;
}): Promise<void> {
  const { db, row, err } = args;
  const partialCost = partialCostOf(err);
  await writeTerminalStatus(db, row.id, {
    status: 'cancelled',
    finishedAt: new Date(),
    actualCostUsd: usdString(partialCost),
  });
}

/**
 * Settle a job as failed and run EVERYTHING that hangs off a job failure:
 * the parent counter bump, the parent's terminal transition, the
 * `generation.job.failed` bus event, the per-unit `unit.failed` callback and
 * the terminal `request.failed` / `request.completed` callback.
 *
 * `settle` is the seam. By default it is the ordinary guarded terminal write
 * ("this row is not already terminal"). The reaper passes a DIFFERENT guard
 * ("this row is 'running' and older than the lock window") so that a lost job
 * takes exactly this path — one rollup implementation, so a consumer cannot
 * tell a reaped failure from any other failed job except by reading `error`.
 *
 * Whatever the guard, the rowcount is the answer: `false` means somebody else
 * settled the row and this caller must skip the side effects below, none of
 * which are idempotent.
 */
/**
 * The taxonomy `ERR_*` string for a caught throwable, or `undefined`.
 *
 * The BullMQ boundary is why this exists. `/v1/generate/sync` and `/stream`
 * classify a refusal from the error INSTANCE, but the async path re-enters
 * through a queue: the worker's `catch` only ever kept `err.message`, so a
 * `BudgetExceeded` and a broken template both landed on `markJobFailed`'s
 * `'job-failed'` default — in the `generation_jobs.error` column, the
 * `generation.job.failed` bus event and the `unit.failed` callback alike. A
 * consumer could type a budget refusal on two transports out of three.
 *
 * The brand (not `instanceof`) is deliberate: see `AiServiceError`.
 */
function taxonomyErrorCode(err: unknown): string | undefined {
  return isAiServiceError(err) ? err.code : undefined;
}

async function markJobFailed(args: {
  db: Db;
  row: typeof generationJobs.$inferSelect;
  parent: typeof generationRequests.$inferSelect;
  error: string;
  bus: EventBus;
  /** Overrides the guarded terminal write. Must return "I settled it". */
  settle?: () => Promise<boolean>;
  /** `errorCode` on the bus event + callback. Defaults to 'job-failed'. */
  errorCode?: string;
  /**
   * Cost ALREADY INCURRED on this unit, in USD. Defaults to 0, which is right
   * for every failure that produced no provider call worth charging for (a
   * blown template, a lost worker, a predecessor that failed).
   *
   * A shutdown abort is the case that is not: the provider streamed part of a
   * completion and charged for it, and the router has already written that
   * trace row. Passing 0 there would leave `generation_requests.actual_cost_usd`
   * short of Σ(traces.actual_cost_usd) for the request — the same rollup
   * undercount ADR-0003 S2 names, arriving through a different door.
   */
  costUsd?: number;
}): Promise<void> {
  const { db, row, parent, error, bus } = args;
  const errorCode = args.errorCode ?? 'job-failed';
  const costUsd = args.costUsd ?? 0;
  const finishedAt = new Date();
  const settled = args.settle
    ? await args.settle()
    : await writeTerminalStatus(db, row.id, {
        status: 'failed',
        error,
        finishedAt,
        ...(costUsd > 0 ? { actualCostUsd: usdString(costUsd) } : {}),
      });
  if (!settled) {
    // Already terminal — another writer owns the rollup. Same reasoning as the
    // success path: the counters/events/callbacks below must fire once per job.
    console.warn(
      `generation worker: job ${row.id} was already terminal when marking it ` +
        `failed ('${error}'); skipping rollup, events and callbacks.`,
    );
    void parent;
    return;
  }

  bus.emit({
    type: 'generation.job.failed',
    requestId: row.generationRequestId,
    jobId: row.id,
    unitKey: row.unitKey,
    org: row.org,
    project: row.project ?? undefined,
    errorCode,
    errorMessage: error,
  });

  const counters = await updateParentCounters({
    db,
    requestId: row.generationRequestId,
    status: 'failed',
    costDelta: costUsd,
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
        error: { code: errorCode, message: error },
        costUsd,
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
          // Counted on the counters transaction itself — see `cancelledJobs`
          // on `ParentCountersResult` for why it is informational.
          cancelledJobs: counters.cancelledJobs,
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
    // Atomic counter bump, CAPPED. The bump used to be a bare `+ 1`, so a
    // duplicate report for one job — a stalled re-delivery, a retried callback
    // path, any caller that reaches here twice — pushed `completed_jobs +
    // failed_jobs` PAST `total_jobs`. That is not a cosmetic count: it is what
    // `allDone` below is computed from, so an overshoot can flip a request
    // terminal while jobs are still running, and the number is served to
    // consumers on `GET /v1/generate/:id`.
    //
    // The cap is the invariant itself — `completed + failed <= total` — not a
    // per-column `LEAST(col + 1, total)`, which would still let the two columns
    // sum past the total one bump each. `total_jobs = 0` (legacy / not-yet-set
    // rows) keeps the old unbounded behaviour rather than freezing at zero.
    //
    // ⚠ Belt, not braces: the CLAIM in `claimJob` is what stops a job being
    // reported twice in the first place. This is the second line, for the
    // report paths that do not go through a job row at all.
    const cappedBump = sql`CASE
        WHEN ${generationRequests.totalJobs} > 0
         AND ${generationRequests.completedJobs} + ${generationRequests.failedJobs}
             >= ${generationRequests.totalJobs}
        THEN 0 ELSE 1 END`;
    if (status === 'completed') {
      await tx
        .update(generationRequests)
        .set({
          completedJobs: sql`${generationRequests.completedJobs} + ${cappedBump}`,
          actualCostUsd: sql`${generationRequests.actualCostUsd} + ${costDelta.toFixed(6)}::numeric`,
        })
        .where(eq(generationRequests.id, requestId));
    } else {
      await tx
        .update(generationRequests)
        .set({
          failedJobs: sql`${generationRequests.failedJobs} + ${cappedBump}`,
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

    // The cancelled count, read on the SAME transaction as the columns above so
    // the envelope's arithmetic comes from ONE view of the table rather than
    // two. Counted from the job rows, not derived as `total − completed −
    // failed` the way `cancel.ts` does it: that subtraction is right at cancel
    // time (every non-terminal job is being cancelled by that very call) and
    // wrong here, where it would silently count a job the counter cap dropped,
    // or one still running, as "cancelled".
    //
    // `filter (where …)` rather than a second WHERE clause: the row filter is
    // the request, the status is an aggregate condition, and keeping them
    // apart means the same scan answers both. The status is INTERPOLATED, not
    // inlined, so the value stays visible to a test that asserts on what was
    // bound — a filter compiled against 'failed' names the same column and
    // answers a different question.
    const cancelledRows = await tx
      .select({
        n: sql<number>`count(*) filter (where ${generationJobs.status} = ${'cancelled'})::int`,
      })
      .from(generationJobs)
      .where(eq(generationJobs.generationRequestId, requestId));
    const cancelledRaw = Number(cancelledRows[0]?.n ?? 0);
    const cancelledJobs = Number.isFinite(cancelledRaw) && cancelledRaw > 0 ? cancelledRaw : 0;

    const total = parent.totalJobs ?? 0;
    const completed = parent.completedJobs ?? 0;
    const failed = parent.failedJobs ?? 0;
    const allDone = total > 0 && completed + failed >= total;

    let nextStatus: ParentCountersResult['status'] = parent.status;
    // 🔴 `terminalNow` is decided by the WRITE, not by the read above. It was
    // `allDone && !wasTerminal` — a read-then-write window in which two workers
    // finishing the last two jobs could both see a non-terminal parent and both
    // claim the transition, firing the request-level event and the terminal
    // callback TWICE. Same shape, same fix as `writeTerminalStatus` on the job
    // row: the guard lives in SQL and the row count is the answer.
    let terminalNow = false;
    if (allDone) {
      const candidate: ParentCountersResult['status'] =
        failed === 0 ? 'completed' : completed === 0 ? 'failed' : 'partial';
      const written = await tx
        .update(generationRequests)
        .set({ status: candidate, finishedAt: now })
        .where(
          and(
            eq(generationRequests.id, requestId),
            notInArray(generationRequests.status, [...TERMINAL_REQUEST_STATUSES]),
          ),
        )
        .returning({ id: generationRequests.id });
      terminalNow = written.length > 0;
      if (terminalNow) nextStatus = candidate;
    } else if (parent.status === 'queued') {
      // First job to land — bump to running. Also conditional: an unguarded
      // write here could drag a request that another worker had just settled
      // back out of its terminal state.
      nextStatus = 'running';
      await tx
        .update(generationRequests)
        .set({ status: 'running' })
        .where(
          and(
            eq(generationRequests.id, requestId),
            eq(generationRequests.status, 'queued'),
          ),
        );
    }

    return {
      status: nextStatus,
      totalJobs: total,
      completedJobs: completed,
      failedJobs: failed,
      cancelledJobs,
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
  const connection = deps.connection;
  if (!connection) {
    throw new Error('startGenerationWorker: deps.connection (Runtime.redis) is required');
  }
  const inFlight: InFlightMap = deps.inFlight ?? new Map();
  const cancelBus = deps.cancelBus;
  if (!cancelBus) {
    throw new Error('startGenerationWorker: deps.cancelBus (Runtime.cancelBus) is required');
  }
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
      connection,
      concurrency: deps.concurrency ?? 5,
      limiter: { max: 10, duration: 1000 },
      // Lock/stall window sized off `LLM_REQUEST_TIMEOUT_MS` instead of
      // BullMQ's 30 s default — see `workerRuntimeOptions` in queue/queues.ts
      // for the measured double-run this prevents.
      ...workerRuntimeOptions(deps.runtime),
    },
  );

  worker.on('failed', (job, err) => {
    console.error(
      `generation worker: BullMQ-level failure for job ${job?.id}: ` +
        `${err.message}${correlationSuffix(job?.data ?? {})}`,
    );
  });
  attachWorkerLifecycleLogging(worker, 'generation worker');

  return {
    worker,
    /**
     * COOPERATIVE SHUTDOWN. Four steps, in this order — see
     * `services/jobs/shutdown.ts` for why each one is there.
     *
     *   1. stop taking NEW jobs, without waiting for the active ones
     *   2. let the active ones finish, for up to `SHUTDOWN_GRACE_MS`
     *   3. abort whatever is left, so it settles as a NAMED terminal job
     *   4. close the worker
     *
     * 🔴 STEP 1 STARTS `close()` WITHOUT AWAITING IT, and it must not be
     * `pause()`. MEASURED against a real Redis: `worker.pause()` only flags
     * the fetch LOOP, so a fetch already blocked inside Redis still returns
     * its job and the worker runs it — a job enqueued after SIGTERM was
     * claimed and processed anyway. `close()` disconnects the blocking
     * connection, which cancels that outstanding fetch; it is the only one of
     * the two that actually stops taking new work.
     *
     * ⚠ …and it is NOT awaited here, because awaiting it is the original bug:
     * `close()` then waits on the active jobs with no bound, which is what
     * left steps 2 and 3 unreachable and the process sitting there until the
     * platform's SIGKILL. Starting it and awaiting it LAST gives both halves:
     * the fetch stops now, the drain is bounded by us.
     */
    stop: async () => {
      unsubscribe();

      // 1. No new work. From here the only jobs that exist are the ones
      //    already inside the handler, i.e. the ones in `inFlight`.
      //    `closing` is awaited at step 4; nothing between here and there may
      //    await it, or the grace window collapses into the old unbounded wait.
      const closing = worker.close().catch(() => undefined);

      // 2. Grace. The common case drains here and nothing below runs.
      const graceMs = deps.shutdownGraceMs ?? shutdownGraceMs();
      if (inFlight.size > 0) {
        console.info(
          `generation worker: draining ${inFlight.size} in-flight job(s), ` +
            `grace ${graceMs}ms`,
        );
      }
      await waitForDrain(inFlight, graceMs);

      // 3. Past the window: abort through the SAME controllers `/cancel` uses,
      //    stamped with the shutdown reason so `settleAbortedJob` runs the
      //    full rollup instead of the cancel shorthand. Then give each job a
      //    bounded moment to write its terminal row, bump its parent and
      //    enqueue its callback.
      if (inFlight.size > 0) {
        console.warn(
          `generation worker: shutdown grace of ${graceMs}ms expired with ` +
            `${inFlight.size} job(s) still running; aborting them as ` +
            `'${SHUTDOWN_ERROR}'`,
        );
        for (const ctrl of inFlight.values()) ctrl.abort(SHUTDOWN_ABORT_REASON);
        const drained = await waitForDrain(inFlight, SHUTDOWN_SETTLE_MS);
        if (!drained) {
          console.error(
            `generation worker: ${inFlight.size} job(s) did not settle within ` +
              `${SHUTDOWN_SETTLE_MS}ms of being aborted; the reaper will ` +
              `recover them as '${WORKER_LOST_ERROR}'`,
          );
        }
      }

      // 4. Await the close started at step 1 — never `close(true)`. By now
      //    there is nothing active for it to wait on, so it returns promptly;
      //    forcing it would drop the job lock without settling the row, which
      //    is the exact state this whole sequence exists to avoid.
      //
      //    🔴 BOUNDED. A bare `await closing` here was the last place an
      //    unbounded LLM call could keep the process alive past its promised
      //    exit: `close()` waits on the active jobs, and step 3's abort only
      //    helps for a call that honours its AbortSignal. One that does not
      //    (a provider socket wedged open) pinned the process until the
      //    platform's SIGKILL — the very outcome this sequence exists to
      //    avoid. Past the grace we stop waiting; the reaper owns the rest.
      if (!(await awaitBounded(closing, graceMs))) {
        console.error(
          `generation worker: worker.close() did not return within ${graceMs}ms of ` +
            `the shutdown grace; leaving it and exiting. Any job still held will be ` +
            `recovered as '${WORKER_LOST_ERROR}'.`,
        );
      }
      // Don't stop a bus that was injected by the caller (tests own its
      // lifecycle); only tear down the default singleton.
      if (!deps.cancelBus) {
        await cancelBus.stop().catch(() => undefined);
      }
    },
  };
}
