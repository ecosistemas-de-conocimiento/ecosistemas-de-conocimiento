// Stalled-job double-execution test (real Postgres + real Redis + real BullMQ).
//
// ── The defect ─────────────────────────────────────────────────────────────
// BullMQ's worker holds a per-job LOCK and renews it on a timer. When the
// renewal misses — a stalled event loop, a paused container, a SIGSTOP — the
// stalled checker moves the job back to `wait` and a SECOND worker runs it.
// Both workers then executed the whole job body, because the row was flipped
// to `status:'running', attempts + 1` unconditionally with no guard.
//
// MEASURED on this tree before the fix, with W1 SIGSTOPped mid-job:
//   - `generation_jobs.attempts` = 2
//   - TWO trace rows for one unit
//   - the LLM called twice, the org's budget charged twice
//   - W1's late write landed AFTER W2's, leaving a job W2 had COMPLETED with
//     `status = 'cancelled'`
// BullMQ's own "Missing lock for job … moveToFinished" error is raised only
// after those DB writes, so it prevents none of them.
//
// ── THE RULE THIS FILE IS THE REFERENCE FOR ────────────────────────────────
// 🔴 A timing-dependent SETUP is acceptable only if the test PROVES the setup
// happened; a timing-dependent ASSERTION, or a setup without that proof, is
// not. Here the proof is assertion 0 below, and the setup is forced rather
// than raced. Copy both halves together — the guard alone leaves a flake, the
// forcing alone leaves a test nobody can tell has rotted.
//
// ── How the stall is FORCED (not raced) ────────────────────────────────────
// The precondition for a stall is one fact: THE DELIVERY'S LOCK IS GONE while
// the job is still in `active`. This test creates that fact directly instead of
// hoping a timer misses.
//
//   1. The job is enqueued with a KNOWN `jobId`, so the BullMQ lock key
//      (`<prefix>:<queue>:<jobId>:lock`) is computable before any worker can
//      pick the job up.
//   2. Inside the processor — W1 is holding the job — the test DELETEs that
//      lock key. BullMQ 5.76.8's `extendLocks-1.lua` does NOT recreate a lock
//      that is absent: `GET lockKey` returns nil, so the job is reported as
//      failed-to-renew (`lockRenewalFailed` + an `error` event) and the key
//      stays gone. One DELETE is therefore PERMANENT for this delivery.
//   3. W1 then STAYS INSIDE the processor, awaiting (an `await`, so the event
//      loop is FREE) until a `stalled` event actually arrives. That is what
//      makes the re-delivery inevitable rather than likely:
//        - `moveStalledJobsToWait-8.lua` needs TWO passes `stalledInterval`
//          apart — the first SADDs every `active` job into the `stalled` set,
//          the second moves the ones whose lock is missing back to `wait`.
//        - Both passes need the job to still BE in `active`, and both need the
//          event loop to run. Holding the processor open guarantees both.
//
// 🔴 THE OLD REPRO WAS A RACE, AND CI CAUGHT IT. It busy-waited
// (`while (Date.now() < until) {}`) for 2.5 s to starve the lock-renewal timer.
// That also starves the STALLED CHECKER — same process, same event loop — so
// nothing at all happened during the block, and the two stalled passes had to
// win a sprint against W1's own resumption once the loop unblocked. MEASURED
// on this branch: 15/15 green on node 22 at load 2-5, but the GitHub runner
// went red twice in a row on node 26 on the anti-vacuity guard alone. A repro
// whose outcome depends on which of two continuations the event loop picks
// first is not a repro. `lockDuration` / `stalledInterval` are still patched
// down through `startGenerationWorker({ runtime })` so the two stalled passes
// take ~600 ms rather than a minute.
//
// ── What is asserted ───────────────────────────────────────────────────────
//   0. A STALL ACTUALLY HAPPENED — see below.
//   1. exactly ONE trace row for the unit (⇒ one provider call)
//   2. exactly ONE charge: `remaining_usd` moved by the actual cost, once
//   3. terminal status is `completed` and NEVER `cancelled`
//   4. `attempts` is 1 — the row was claimed once
//
// 🔴 ASSERTION 0 IS LOAD-BEARING AND WAS MISSING. Every one of assertions 1-4
// also holds when BullMQ never redelivers the job at all: one trace, one
// charge, `completed`, `attempts = 1` is exactly what a boring uneventful run
// produces. So the test could go green while testing NOTHING — a timing change
// (a faster machine, a larger `lockDuration`, a BullMQ upgrade) would silently
// turn the repro into a no-op and nobody would learn that the guard had
// stopped being exercised. We therefore count BullMQ `stalled` events off both
// workers and require at least one, and cross-check `attemptsMade` on the
// BullMQ job — that counter only passes 1 when the job was re-delivered.
//
// ⚠ TWO workers on ONE queue is the whole point; do not "simplify" this to a
// single worker calling `processGenerationJob` twice. The re-delivery has to
// come from BullMQ for the test to describe the real failure.

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

import { generationJobs, generationRequests, traces } from '../db/schema/index.js';
import { GENERATION_QUEUE_NAME, generationJobName } from '../queue/queues.js';
import { createRouter } from '../services/ai/router/router.js';
import { BudgetEnforcer } from '../services/budget/enforcer.js';
import { TraceWriter } from '../services/ai/router/trace-writer.js';
import { createEventBus } from '../services/events/bus.js';
import { startGenerationWorker } from './generation.worker.js';
import type { CancelBus } from '../services/generation/cancel-bus.js';
import type { Db } from '../db/client.js';
import type {
  callOpenRouter,
  OpenRouterCompletion,
} from '../services/ai/router/adapters/openrouter.js';

const ORG = 'stalled-org';
const PROJECT = 'stalled-project';
const CALL_COST = 0.002;
const INITIAL_BUDGET = 10;

/** Short lock window so the two stalled passes are quick, not so the lock
 *  expires on its own — the test DELETES the lock, it does not wait it out. */
const LOCK_DURATION_MS = 700;
const STALLED_INTERVAL_MS = 300;
/** Ceiling on how long W1 stays inside the processor waiting for the stall.
 *  Two stalled passes take ~2 × STALLED_INTERVAL_MS; this is ~15× that, so
 *  reaching it means the forcing BROKE, and assertion 0 must then go red. */
const STALL_WAIT_CAP_MS = 10_000;

/**
 * Adapter whose FIRST call runs `onFirstCall` — the hook the test uses to kill
 * the delivery's lock and then hold the processor open until BullMQ has really
 * re-delivered. It `await`s: the event loop must stay FREE, or BullMQ's own
 * stalled checker cannot run and there is nothing to wait for.
 */
function makeStallingAdapter(): {
  adapter: typeof callOpenRouter;
  callCount: () => number;
  onFirstCall: (fn: () => Promise<void>) => void;
} {
  let calls = 0;
  let hook: () => Promise<void> = async () => undefined;
  const adapter = (async (opts): Promise<OpenRouterCompletion> => {
    calls += 1;
    if (calls === 1) await hook();
    return {
      contentText: `output for call ${calls}`,
      finishReason: 'stop',
      model: opts.model,
      usage: {
        promptTokens: 10,
        completionTokens: 20,
        costUsd: CALL_COST,
        costSource: 'openrouter',
      },
    };
  }) as typeof callOpenRouter;
  return {
    adapter,
    callCount: () => calls,
    onFirstCall: (fn) => {
      hook = fn;
    },
  };
}

/** No-op cancel bus: this test is about locks, not about /cancel, and the real
 *  one would open two more Redis connections per worker. */
function noopCancelBus(): CancelBus {
  return {
    start: async () => {},
    publish: async () => {},
    onCancel: () => () => {},
    stop: async () => {},
  };
}

async function seedBudget(db: Db, org: string, amountUsd: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO "budget_state" ("org", "limit_usd", "remaining_usd")
    VALUES (${org}, ${amountUsd}::numeric, ${amountUsd}::numeric)
    ON CONFLICT ("org") DO UPDATE
      SET "limit_usd" = ${amountUsd}::numeric,
          "remaining_usd" = ${amountUsd}::numeric
  `);
}

describe('generation worker — stalled job is not run twice (integration)', () => {
  let db: Db;

  beforeAll(async () => {
    ({ db } = await import('../db/client.js'));
  });

  afterAll(async () => {
    const { closeDb } = await import('../db/client.js');
    await closeDb().catch(() => undefined);
  });

  it('a stalled re-delivery produces ONE trace, ONE charge, and never turns a completed job cancelled', async () => {
    await seedBudget(db, ORG, INITIAL_BUDGET);

    const reqInsert = await db
      .insert(generationRequests)
      .values({
        org: ORG,
        project: PROJECT,
        status: 'queued',
        totalJobs: 1,
        effort: 'standard',
        estimatedCostUsd: '0',
        actualCostUsd: '0',
        startedAt: new Date(),
      })
      .returning({ id: generationRequests.id });
    const requestId = reqInsert[0]!.id;

    const jobInsert = await db
      .insert(generationJobs)
      .values({
        generationRequestId: requestId,
        org: ORG,
        project: PROJECT,
        unitKey: 'stalled-unit',
        status: 'queued',
        attempts: 0,
        effort: 'standard',
        specOverride: {
          promptTemplate: 'generate {{thing}}',
          effortLevel: 'standard' as const,
          model: 'mock/model',
          validators: [],
        },
        input: { __renderedPrompt: 'generate a thing' },
        estimatedCostUsd: '0',
      })
      .returning({ id: generationJobs.id });
    const jobId = jobInsert[0]!.id;

    const { adapter, callCount, onFirstCall } = makeStallingAdapter();
    const router = createRouter({
      budget: new BudgetEnforcer(db),
      traceWriter: new TraceWriter(db),
      adapter,
    });
    const bus = createEventBus();
    const runtime = {
      lockDuration: LOCK_DURATION_MS,
      stalledInterval: STALLED_INTERVAL_MS,
      maxStalledCount: 1,
    };

    // TWO workers on ONE queue. W1 takes the job and is HELD inside its
    // processor with its lock deleted; the stalled checker re-delivers the job
    // and W2 picks it up while W1 is still in there.
    //
    // Both workers run BullMQ's stalled checker (and it is dedup'd across them
    // by the `stalled-check` key), so either may be the one to emit — the
    // assertion is on the TOTAL, not on which worker saw it.
    // A real BullMQ queue and the real connection the workers are handed.
    // A test Runtime hands back an in-memory mock queue under NODE_ENV=test,
    // which would never reach a worker.
    const redis = new Redis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });
    const queue = new Queue(GENERATION_QUEUE_NAME, { connection: redis });

    const stalledEvents: string[] = [];
    const w1 = await startGenerationWorker({
      connection: redis,
      db,
      router,
      bus,
      runtime,
      concurrency: 1,
      cancelBus: noopCancelBus(),
    });
    const w2 = await startGenerationWorker({
      connection: redis,
      db,
      router,
      bus,
      runtime,
      concurrency: 1,
      cancelBus: noopCancelBus(),
    });
    w1.worker.on('stalled', (id) => stalledEvents.push(`w1:${id}`));
    w2.worker.on('stalled', (id) => stalledEvents.push(`w2:${id}`));

    // 🔴 CLEAR THE QUEUE'S STALL BOOKKEEPING FIRST — MEASURED: this file was
    // green ALONE and red IN-SUITE without it, on assertion 0.
    // `moveStalledJobsToWait-8.lua` dedups the checker across the whole QUEUE
    // with a `stalled-check` key set `PX = stalledInterval`. Other integration
    // files start generation workers on this same queue name with the
    // PRODUCTION interval (`WORKER_STALLED_INTERVAL_MS`, 30 s), so one of their
    // checks can leave that key alive for 30 s — longer than this test's whole
    // window — and suppress every stalled pass here. `stalled` and `active` go
    // too: an orphan job left in `active` by another file has no lock either,
    // so it would be moved to wait and emit a `stalled` event of its own, which
    // is a way for assertion 0 to be satisfied by something that is not the job
    // under test. After this, the only job that can stall is ours.
    const stalledCheckKey = queue.toKey('stalled-check');
    await redis.del(stalledCheckKey, queue.toKey('stalled'), queue.toKey('active'));

    // A KNOWN BullMQ job id, so the lock key is computable BEFORE the job
    // exists — a worker may start processing inside the same tick as
    // `queue.add` resolves, which is too late to look the id up. Randomised
    // so a leftover row from an interrupted run cannot collide (the job is
    // deliberately kept with `removeOnComplete: false`).
    const bullJobId = `stalled-${randomUUID()}`;

    try {
      // (id chosen above so the lock key is known before the job
      // exists.)
      const lockKey = `${queue.toKey(bullJobId)}:lock`;

      onFirstCall(async () => {
        // ── FORCE the stall ──────────────────────────────────────────────
        // Delete the lock this delivery is holding. This is the whole
        // precondition of a stall, created as a fact rather than raced for.
        // `extendLocks-1.lua` reads the key first and only re-SETs a lock it
        // finds, so it will NOT resurrect this one — the worker reports
        // `lockRenewalFailed` instead and the key stays gone.
        await redis.del(lockKey);
        // Now hold the job. The stalled checker needs two passes
        // STALLED_INTERVAL_MS apart with the job still in `active`; staying
        // inside the processor is what guarantees that, and the `await` below
        // keeps the event loop free so those passes can actually run.
        const until = Date.now() + STALL_WAIT_CAP_MS;
        while (stalledEvents.length === 0 && Date.now() < until) {
          await new Promise((r) => setTimeout(r, 25));
        }
      });

      const bullJob = await queue.add(
        generationJobName(ORG, undefined),
        {
          jobId,
          generationRequestId: requestId,
          org: ORG,
          project: PROJECT,
          unitKey: 'stalled-unit',
        },
        {
          jobId: bullJobId,
          attempts: 1,
          removeOnComplete: false,
          removeOnFail: false,
        },
      );

      // Wait for the row to go terminal, then give the stalled re-delivery a
      // further window to land its (guarded) late write.
      const deadline = Date.now() + 20_000;
      let status = 'queued';
      while (Date.now() < deadline) {
        const rows = await db
          .select({ status: generationJobs.status })
          .from(generationJobs)
          .where(eq(generationJobs.id, jobId))
          .limit(1);
        status = String(rows[0]?.status);
        if (['completed', 'failed', 'cancelled'].includes(status)) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      await new Promise((r) => setTimeout(r, 2_000));

      const finalRows = await db
        .select({
          status: generationJobs.status,
          attempts: generationJobs.attempts,
          actualCostUsd: generationJobs.actualCostUsd,
        })
        .from(generationJobs)
        .where(eq(generationJobs.id, jobId))
        .limit(1);
      const final = finalRows[0]!;

      // 0. 🔴 THE STALL REALLY HAPPENED. Without this the whole test passes
      // on a run where BullMQ never re-delivered — every assertion below is
      // also true of an ordinary single-delivery run, so the repro would rot
      // into a no-op unnoticed.
      const redelivered = await queue.getJob(bullJob.id!);
      expect(
        stalledEvents.length > 0 || (redelivered?.attemptsMade ?? 0) >= 2,
      ).toBe(true);

      // 1. One provider call ⇒ one trace row for this job. Asserted FIRST
      // because it is the strongest statement of the defect: two traces means
      // the model really was called twice for one unit.
      const traceRows = await db
        .select({ id: traces.id })
        .from(traces)
        .where(eq(traces.generationJobId, jobId));
      expect(traceRows).toHaveLength(1);
      expect(callCount()).toBe(1);

      // 3. A completed job must never be reported as cancelled.
      expect(final.status).toBe('completed');
      // 4. Claimed exactly once.
      expect(final.attempts).toBe(1);

      // 2. One charge. The router reserves then trues up, so `remaining_usd`
      // lands exactly one CALL_COST below the seeded budget.
      const budgetRows = await db.execute(sql`
        SELECT "remaining_usd" FROM "budget_state" WHERE "org" = ${ORG} LIMIT 1
      `);
      const remaining = Number(
        (budgetRows as unknown as { rows?: Array<Record<string, unknown>> }).rows?.[0]?.[
          'remaining_usd'
        ] ?? (budgetRows as unknown as Array<Record<string, unknown>>)[0]?.['remaining_usd'],
      );
      expect(remaining).toBeCloseTo(INITIAL_BUDGET - CALL_COST, 6);

      // The parent counter moved once too — a double-run overshot it.
      const parentRows = await db
        .select({
          completedJobs: generationRequests.completedJobs,
          status: generationRequests.status,
        })
        .from(generationRequests)
        .where(eq(generationRequests.id, requestId))
        .limit(1);
      expect(parentRows[0]!.completedJobs).toBe(1);
      expect(parentRows[0]!.status).toBe('completed');
    } finally {
      // W1's delivery can never leave `active` — its lock is gone, so BullMQ's
      // `moveToFinished` refuses it, exactly as in production. Left there it is
      // an unlocked orphan that the NEXT integration file's stalled checker
      // would pick up and report. Clear it here rather than making every other
      // file defend against this one.
      await redis.lrem(queue.toKey('active'), 0, bullJobId).catch(() => undefined);
      await queue.close().catch(() => undefined);
      await redis.quit().catch(() => undefined);
      await w1.stop().catch(() => undefined);
      await w2.stop().catch(() => undefined);
    }
  }, 60_000);

  /**
   * The status-corruption half of the defect, on real Postgres.
   *
   * MEASURED before the fix: W1 woke from its stall AFTER W2 had completed the
   * job, took the "parent is cancelled" branch at step 2, and wrote
   * `status = 'cancelled'` straight over W2's `completed` — output present,
   * status wrong. This drives exactly that sequence: a settled row, a parent
   * flipped to cancelled, and one more delivery of the same job.
   */
  it('a late writer cannot turn a COMPLETED job into cancelled', async () => {
    await seedBudget(db, ORG, INITIAL_BUDGET);

    const reqInsert = await db
      .insert(generationRequests)
      .values({
        org: ORG,
        project: PROJECT,
        status: 'cancelled',
        totalJobs: 1,
        completedJobs: 1,
        effort: 'standard',
        estimatedCostUsd: '0',
        actualCostUsd: '0',
        startedAt: new Date(),
      })
      .returning({ id: generationRequests.id });
    const requestId = reqInsert[0]!.id;

    const jobInsert = await db
      .insert(generationJobs)
      .values({
        generationRequestId: requestId,
        org: ORG,
        project: PROJECT,
        unitKey: 'late-writer-unit',
        status: 'completed',
        attempts: 1,
        effort: 'standard',
        input: { __renderedPrompt: 'already done' },
        output: { text: 'the winner output' },
        estimatedCostUsd: '0',
        finishedAt: new Date(),
      })
      .returning({ id: generationJobs.id });
    const jobId = jobInsert[0]!.id;

    const { processGenerationJob } = await import('./generation.worker.js');
    await processGenerationJob(
      {
        id: 'late-1',
        data: {
          jobId,
          generationRequestId: requestId,
          org: ORG,
          project: PROJECT,
          unitKey: 'late-writer-unit',
        },
      },
      { db, bus: createEventBus() },
    );

    const after = await db
      .select({ status: generationJobs.status, output: generationJobs.output })
      .from(generationJobs)
      .where(eq(generationJobs.id, jobId))
      .limit(1);
    expect(after[0]!.status).toBe('completed');
    expect(after[0]!.output).toEqual({ text: 'the winner output' });
  });
});
