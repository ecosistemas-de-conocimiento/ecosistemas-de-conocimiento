// A worker that DIES mid-job (real Postgres + real Redis + real BullMQ + a real
// SIGKILL).
//
// ── The defect ─────────────────────────────────────────────────────────────
// The claim guard (`claimJob` / `claimIngestJob`) made a stalled RE-DELIVERY a
// no-op, which is right for a worker that is still alive and wrong for one
// that is gone. MEASURED on this tree with the worker SIGKILLed mid-job:
//   · `generation_jobs` stayed 'running', `finished_at` null, forever
//   · the parent `generation_requests` never went terminal
//   · BullMQ re-delivered once, the claim refused, the re-delivery returned
//     cleanly and BullMQ marked the queue job COMPLETED — queue-level health
//     all green
//   · zero callback deliveries, zero bus events, zero SSE frames
//   · `GET /v1/generate/:requestId` answered 200 in-progress forever
//   · the router's per-call reserve (0.000737 USD) was held forever
//
// ── The rule ───────────────────────────────────────────────────────────────
// Never re-run (a second LLM call charges twice and writes a second trace),
// always REPORT: fail the row with a named reason, refund the reserve, and
// push it through the ordinary job-failure path.
//
// ── Why a forked child and not a stub ──────────────────────────────────────
// The failure IS the process disappearing between the claim and the terminal
// write. A stub that returns early leaves the event loop, the lock renewal and
// the DB connection alive, so it reproduces nothing. The child claims a real
// row, blocks forever inside the provider call, and is `kill -9`ed.
//
// ⚠ ASSERTION 0 IS LOAD-BEARING. "The row is failed" is also what a run where
// the child never started would produce. Every case first proves the child
// really claimed the row (status 'running', `started_at` set) before killing
// it, so a fork that silently failed to boot cannot pass as a green repro.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  corpora,
  generationJobs,
  generationRequests,
  ingestJobs,
  ingestRequests,
  traces,
} from '../db/schema/index.js';
import {
  GENERATION_QUEUE_NAME,
  INGEST_QUEUE_NAME,
  generationJobName,
  type IngestJobData,
} from '../queue/queues.js';
import { startGenerationWorker } from './generation.worker.js';
import { reapOnce } from '../services/jobs/reaper.js';
import { waitFor } from '../test/wait-for.js';
import { createEventBus } from '../services/events/bus.js';
import { createRouter } from '../services/ai/router/router.js';
import { BudgetEnforcer } from '../services/budget/enforcer.js';
import { TraceWriter } from '../services/ai/router/trace-writer.js';
import type { CancelBus } from '../services/generation/cancel-bus.js';
import type { Db } from '../db/client.js';
import type { AppEvent } from '../services/events/types.js';
import type {
  callOpenRouter,
  OpenRouterCompletion,
} from '../services/ai/router/adapters/openrouter.js';

const ORG = 'worker-lost-org';
const PROJECT = 'worker-lost-project';
const INITIAL_BUDGET = 10;
/** The `standard` effort profile's per-call reserve — the measured leak. */
const RESERVE_PER_CALL = 0.000737;
const EMBED_DIM = 1024;

/** Small enough that a killed worker is past the window inside a test timeout. */
const CHILD_LOCK_MS = 700;
/**
 * The lost-window every case that WANTS a reap runs with.
 *
 * Small on purpose, and never slept through: each case polls Postgres until
 * POSTGRES agrees the row is past this window (see {@link pastLostWindow}), so
 * the number only sets how long that poll takes, never whether the test is
 * correct. The case that wants NO reap uses its own huge window instead — a
 * small one there would make a slow machine fail a correct no-reap.
 */
const LOST_WINDOW_MS = 400;
/**
 * The window for the "left alone INSIDE the window" case. Ten minutes: elapsed
 * time cannot cross it, so a paused container, a loaded CI box or a debugger
 * breakpoint can never turn a correct no-reap into a red assertion.
 */
const LIVE_WINDOW_MS = 600_000;

const CHILD = fileURLToPath(
  new URL('./__fixtures__/lost-worker-child.ts', import.meta.url),
);

function noopCancelBus(): CancelBus {
  return {
    start: async () => {},
    publish: async () => {},
    onCancel: () => () => {},
    stop: async () => {},
  };
}

async function seedBudget(db: Db, amountUsd: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO "budget_state" ("org", "limit_usd", "remaining_usd")
    VALUES (${ORG}, ${amountUsd}::numeric, ${amountUsd}::numeric)
    ON CONFLICT ("org") DO UPDATE
      SET "limit_usd" = ${amountUsd}::numeric,
          "remaining_usd" = ${amountUsd}::numeric
  `);
}

/**
 * Take a hold the way a worker that then DIED would have: money off
 * `remaining_usd`, with `limit_usd` untouched.
 *
 * 🔴 Needed because `BudgetEnforcer.refund` clamps the credit at `limit_usd`
 * (it must — an unclamped refund MINTS budget). A case that seeds
 * `remaining == limit` and then asserts the refund pushed remaining ABOVE the
 * limit is asserting the mint, not the refund. Model the hold first, then
 * assert the money comes BACK to where it started.
 */
async function holdUsd(db: Db, amountUsd: number): Promise<void> {
  await db.execute(sql`
    UPDATE "budget_state"
       SET "remaining_usd" = "remaining_usd" - ${amountUsd}::numeric
     WHERE "org" = ${ORG}
  `);
}

async function remainingUsd(db: Db): Promise<number> {
  const out = await db.execute(sql`
    SELECT "remaining_usd" FROM "budget_state" WHERE "org" = ${ORG} LIMIT 1
  `);
  // postgres.js hands back an ARRAY; some drivers wrap it in `{ rows }`.
  const rows = Array.isArray(out)
    ? (out as Array<Record<string, unknown>>)
    : ((out as { rows?: Array<Record<string, unknown>> }).rows ?? []);
  return Number(rows[0]?.['remaining_usd'] ?? NaN);
}

function spawnChild(mode: 'generation' | 'ingest'): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', CHILD], {
    stdio: 'ignore',
    env: {
      ...process.env,
      CHILD_MODE: mode,
      CHILD_LOCK_DURATION_MS: String(CHILD_LOCK_MS),
      CHILD_STALLED_INTERVAL_MS: '300',
    },
  });
}

/** Poll until `read()` returns a truthy value, or throw with a named reason. */
async function until<T>(
  read: () => Promise<T | null | undefined | false>,
  what: string,
  timeoutMs = 25_000,
): Promise<T> {
  return waitFor(read, what, { timeoutMs, intervalMs: 100 });
}

/**
 * 🔴 ONE CLOCK. Has POSTGRES decided this row outlived the lost-window?
 *
 * The reap's guard is `started_at < now() - interval`, evaluated by Postgres.
 * Sleeping `windowMs + 300` in node instead measures a DIFFERENT clock: the
 * two drift, and the row can still be inside the window on the server when the
 * test has already moved on (or vice versa). Asking the server the same
 * question the reap asks removes the second clock entirely, and returns as
 * soon as it is true rather than after a fixed guess.
 */
async function pastLostWindow(
  db: Db,
  table: 'generation_jobs' | 'ingest_jobs',
  id: string,
): Promise<boolean> {
  const out = await db.execute(sql`
    SELECT ("started_at" < now() - make_interval(secs => ${LOST_WINDOW_MS / 1000})) AS past
      FROM ${sql.identifier(table)}
     WHERE "id"::text = ${id}
     LIMIT 1
  `);
  const rows = Array.isArray(out)
    ? (out as Array<Record<string, unknown>>)
    : ((out as { rows?: Array<Record<string, unknown>> }).rows ?? []);
  return rows[0]?.['past'] === true;
}

describe('a worker that dies mid-job (integration)', () => {
  let db: Db;

  beforeAll(async () => {
    ({ db } = await import('../db/client.js'));
  });

  afterAll(async () => {
    const { closeDb } = await import('../db/client.js');
    await closeDb().catch(() => undefined);
  });

  // -------------------------------------------------------------------------
  // Generation, via the BullMQ re-delivery
  // -------------------------------------------------------------------------

  it('generation: the re-delivery of a SIGKILLed job fails it as worker_lost, refunds, and tells the consumer', async () => {
    await seedBudget(db, INITIAL_BUDGET);

    const requestId = (
      await db
        .insert(generationRequests)
        .values({
          org: ORG,
          project: PROJECT,
          status: 'queued',
          totalJobs: 1,
          effort: 'standard',
          estimatedCostUsd: String(RESERVE_PER_CALL),
          actualCostUsd: '0',
          startedAt: new Date(),
        })
        .returning({ id: generationRequests.id })
    )[0]!.id;

    const jobId = (
      await db
        .insert(generationJobs)
        .values({
          generationRequestId: requestId,
          org: ORG,
          project: PROJECT,
          unitKey: 'lost-unit',
          status: 'queued',
          attempts: 0,
          effort: 'standard',
          specOverride: {
            promptTemplate: 'generate {{thing}}',
            effortLevel: 'standard' as const,
            model: 'mock/model',
            validators: [],
            effortProfile: { estimatedCostUsdPerCall: RESERVE_PER_CALL },
          },
          input: { __renderedPrompt: 'generate a thing' },
          estimatedCostUsd: String(RESERVE_PER_CALL),
          metadata: { reservePerCallUsd: RESERVE_PER_CALL },
        })
        .returning({ id: generationJobs.id })
    )[0]!.id;

    const redis = new Redis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });
    const queue = new Queue(GENERATION_QUEUE_NAME, { connection: redis });
    const child = spawnChild('generation');

    // The SURVIVING worker. Its adapter counts calls: this test's central
    // claim is that the LLM is called exactly ONCE — by the child, before it
    // died — and never again by the re-delivery.
    let survivorCalls = 0;
    const survivorAdapter = (async (opts): Promise<OpenRouterCompletion> => {
      survivorCalls += 1;
      return {
        contentText: 'should never happen',
        finishReason: 'stop',
        model: opts.model,
        usage: {
          promptTokens: 1,
          completionTokens: 1,
          costUsd: 0.001,
          costSource: 'openrouter',
        },
      };
    }) as typeof callOpenRouter;

    const events: AppEvent[] = [];
    const bus = createEventBus();
    bus.onAny((e) => events.push(e));
    let survivor: Awaited<ReturnType<typeof startGenerationWorker>> | null = null;

    try {
      await queue.add(
        generationJobName(ORG, undefined),
        {
          jobId,
          generationRequestId: requestId,
          org: ORG,
          project: PROJECT,
          unitKey: 'lost-unit',
        },
        { attempts: 1, removeOnComplete: false, removeOnFail: false },
      );

      // ── 0. THE CHILD REALLY CLAIMED IT. Without this the case would also
      // pass on a run where the fork never booted — nothing would ever have
      // been running, and "not running any more" is trivially true.
      const claimed = await until(async () => {
        const rows = await db
          .select({ status: generationJobs.status, startedAt: generationJobs.startedAt })
          .from(generationJobs)
          .where(eq(generationJobs.id, jobId))
          .limit(1);
        return rows[0]?.status === 'running' && rows[0]?.startedAt ? rows[0] : null;
      }, 'the child worker to claim the job');
      expect(claimed.status).toBe('running');

      // The reserve is really held before the kill — otherwise the refund
      // assertion below would be asserting that nothing came back.
      //
      // ⚠ POLLED, not read once. The claim (step 6) commits BEFORE the router
      // takes its reserve (step 7), so a single read right after 'running'
      // appears races the hold and reads the full budget. That race made this
      // line flaky in the full integration run while passing in isolation.
      const heldRemaining = await until(async () => {
        const r = await remainingUsd(db);
        return r < INITIAL_BUDGET ? r : null;
      }, 'the child worker to take its budget reserve');
      expect(INITIAL_BUDGET - heldRemaining).toBeCloseTo(RESERVE_PER_CALL, 6);

      // ── The kill. No cleanup, no terminal write, no lock release.
      child.kill('SIGKILL');
      // Wait for POSTGRES to agree the row is past the window — not for a
      // node-side sleep of `window + 300`, which is a second clock and was a
      // measured source of flakes in the full integration run.
      await waitFor(() => pastLostWindow(db, 'generation_jobs', jobId), 'the row to outlive the lost-window', {
        timeoutMs: 10_000,
        intervalMs: 50,
      });

      // Now bring up a survivor. BullMQ's stalled checker re-delivers the
      // orphaned job to it; the claim refuses (the row is 'running'), and the
      // lost-worker branch takes over.
      survivor = await startGenerationWorker({
        connection: redis,
        db,
        bus,
        router: createRouter({
          budget: new BudgetEnforcer(db),
          traceWriter: new TraceWriter(db),
          adapter: survivorAdapter,
        }),
        runtime: { lockDuration: 700, stalledInterval: 300, maxStalledCount: 1 },
        concurrency: 1,
        lostWindowMs: LOST_WINDOW_MS,
        cancelBus: noopCancelBus(),
      });

      // ⚠ WAIT FOR THE WHOLE REAP, NOT ITS FIRST WRITE.
      //
      // `reapLostGenerationJob` is a SEQUENCE of separate commits, not one
      // transaction: `settle` flips the JOB row to 'failed' → the bus event
      // fires → `updateParentCounters` bumps and settles the PARENT →
      // the reserve is refunded (the last `await` in the function). A poll
      // that stops at "the job row is failed" therefore returns while the
      // reap is still running, and every single read after it races a write
      // that has not happened yet.
      //
      // MEASURED: CI run 34334619291 (first time this file ran on a GitHub
      // 2-core runner) failed on `expect(parent.status).toBe('failed')` with
      // 'queued' — the value the parent was INSERTed with, because
      // `updateParentCounters` had not committed. Not a threshold to widen:
      // the poll was simply watching the wrong row. It is green locally
      // because the gap is sub-millisecond on an idle 16-core box.
      //
      // So poll to the LAST observable effect. Getting the refund back proves
      // everything upstream of it already landed, and it cannot pass
      // vacuously: the assertion above proved the money was held first.
      const { job: settled, parent } = await until(async () => {
        const rows = await db
          .select({
            status: generationJobs.status,
            error: generationJobs.error,
            metadata: generationJobs.metadata,
            finishedAt: generationJobs.finishedAt,
          })
          .from(generationJobs)
          .where(eq(generationJobs.id, jobId))
          .limit(1);
        const job = rows[0];
        if (job?.status !== 'failed') return null;
        const parentRows = await db
          .select()
          .from(generationRequests)
          .where(eq(generationRequests.id, requestId))
          .limit(1);
        const req = parentRows[0];
        if (req?.status !== 'failed' || !req.finishedAt) return null;
        // Coarse on purpose: this decides WHEN to look, not whether the
        // number is right. Assertion 4 below still checks it to 6 places, so
        // a wrong refund fails as a numeric diff rather than as a timeout.
        // `!(… <= …)` and not `> `: a missing row reads NaN, and NaN fails
        // every comparison — the negated form keeps waiting instead of
        // treating "no budget row at all" as success.
        const remaining = await remainingUsd(db);
        if (!(Math.abs(remaining - INITIAL_BUDGET) <= 1e-4)) return null;
        return { job, parent: req };
      }, 'the lost job to be failed, its parent settled and its reserve refunded');

      // 1. A NAMED failure, not a mystery.
      expect(settled.error).toBe('worker_lost');
      expect(settled.metadata).toMatchObject({ errorCode: 'WORKER_LOST' });
      expect(settled.finishedAt).toBeInstanceOf(Date);

      // 2. NEVER re-run. The survivor's adapter was never entered, and there
      // is no trace row (the child died before writing one).
      expect(survivorCalls).toBe(0);
      const traceRows = await db
        .select({ id: traces.id })
        .from(traces)
        .where(eq(traces.generationJobId, jobId));
      expect(traceRows).toHaveLength(0);

      // 3. The parent is terminal and the consumer is told.
      expect(parent.status).toBe('failed');
      expect(parent.failedJobs).toBe(1);
      expect(parent.finishedAt).toBeInstanceOf(Date);
      expect(events.filter((e) => e.type === 'generation.job.failed')).toHaveLength(1);
      expect(events.filter((e) => e.type === 'generation.request.completed')).toHaveLength(1);

      // 4. The money came back — `remaining_usd` is exactly where it started.
      expect(await remainingUsd(db)).toBeCloseTo(INITIAL_BUDGET, 6);

      // 5. A SECOND sweep changes nothing: the guarded transition matches no
      // row now, so no second refund and no second event.
      const eventsBefore = events.length;
      await reapOnce({ db, bus, config: { windowMs: LOST_WINDOW_MS } });
      expect(events).toHaveLength(eventsBefore);
      expect(await remainingUsd(db)).toBeCloseTo(INITIAL_BUDGET, 6);
      const parentAfter = (
        await db
          .select({ failedJobs: generationRequests.failedJobs })
          .from(generationRequests)
          .where(eq(generationRequests.id, requestId))
          .limit(1)
      )[0]!;
      expect(parentAfter.failedJobs).toBe(1);
    } finally {
      child.kill('SIGKILL');
      await survivor?.stop().catch(() => undefined);
      await queue.close().catch(() => undefined);
      await redis.quit().catch(() => undefined);
    }
  }, 60_000);

  // -------------------------------------------------------------------------
  // Generation, with NO re-delivery at all
  // -------------------------------------------------------------------------

  it('generation: the reaper recovers a lost job BullMQ will never re-deliver', async () => {
    // Redis flushed, the queue drained, the job evicted by `removeOnComplete`,
    // the pod replaced — in all of those there is no second delivery to hang
    // the recovery off, and the row would sit at 'running' forever. Nothing
    // here touches a queue at all.
    await seedBudget(db, INITIAL_BUDGET);
    // The dead worker's hold. Without it there is nothing stranded to give
    // back, and the refund would have to push `remaining_usd` past the org's
    // own limit — which the enforcer clamps, correctly.
    await holdUsd(db, RESERVE_PER_CALL);
    const requestId = (
      await db
        .insert(generationRequests)
        .values({
          org: ORG,
          project: PROJECT,
          status: 'running',
          totalJobs: 1,
          effort: 'standard',
          estimatedCostUsd: String(RESERVE_PER_CALL),
          actualCostUsd: '0',
          startedAt: new Date(),
        })
        .returning({ id: generationRequests.id })
    )[0]!.id;
    const jobId = (
      await db
        .insert(generationJobs)
        .values({
          generationRequestId: requestId,
          org: ORG,
          project: PROJECT,
          unitKey: 'orphan-unit',
          status: 'running',
          attempts: 1,
          effort: 'standard',
          input: { __renderedPrompt: 'x' },
          estimatedCostUsd: String(RESERVE_PER_CALL),
          metadata: { reservePerCallUsd: RESERVE_PER_CALL },
          startedAt: new Date(Date.now() - 60_000),
        })
        .returning({ id: generationJobs.id })
    )[0]!.id;

    const events: AppEvent[] = [];
    const bus = createEventBus();
    bus.onAny((e) => events.push(e));

    const result = await reapOnce({ db, bus, config: { windowMs: LOST_WINDOW_MS } });
    expect(result.generationJobs).toContain(jobId);

    const row = (
      await db.select().from(generationJobs).where(eq(generationJobs.id, jobId)).limit(1)
    )[0]!;
    expect(row.status).toBe('failed');
    expect(row.error).toBe('worker_lost');
    const parent = (
      await db
        .select()
        .from(generationRequests)
        .where(eq(generationRequests.id, requestId))
        .limit(1)
    )[0]!;
    expect(parent.status).toBe('failed');
    expect(events.filter((e) => e.type === 'generation.job.failed')).toHaveLength(1);
    // The stranded hold came back — exactly to where the org started.
    expect(await remainingUsd(db)).toBeCloseTo(INITIAL_BUDGET, 6);

    // Idempotent: a second sweep finds nothing and refunds nothing.
    const second = await reapOnce({ db, bus, config: { windowMs: LOST_WINDOW_MS } });
    expect(second.generationJobs).not.toContain(jobId);
    expect(await remainingUsd(db)).toBeCloseTo(INITIAL_BUDGET, 6);
  }, 30_000);

  it('generation: a job still INSIDE the window is left alone', async () => {
    // The other half of the rule. A live worker legitimately owns a row that
    // has only just been claimed; reaping it would be the double-run defect
    // turned inside out — the consumer told a running job failed.
    const requestId = (
      await db
        .insert(generationRequests)
        .values({
          org: ORG,
          project: PROJECT,
          status: 'running',
          totalJobs: 1,
          effort: 'standard',
          estimatedCostUsd: '0',
          actualCostUsd: '0',
          startedAt: new Date(),
        })
        .returning({ id: generationRequests.id })
    )[0]!.id;
    const jobId = (
      await db
        .insert(generationJobs)
        .values({
          generationRequestId: requestId,
          org: ORG,
          project: PROJECT,
          unitKey: 'live-unit',
          status: 'running',
          attempts: 1,
          effort: 'standard',
          input: {},
          startedAt: new Date(),
        })
        .returning({ id: generationJobs.id })
    )[0]!.id;

    // A window elapsed time CANNOT cross, so "still running" is proving the
    // guard, not proving the machine was fast.
    await reapOnce({ db, config: { windowMs: LIVE_WINDOW_MS } });

    const row = (
      await db
        .select({ status: generationJobs.status })
        .from(generationJobs)
        .where(eq(generationJobs.id, jobId))
        .limit(1)
    )[0]!;
    expect(row.status).toBe('running');
  }, 30_000);

  // -------------------------------------------------------------------------
  // Ingest
  // -------------------------------------------------------------------------

  it('ingest: the re-delivery of a SIGKILLed job fails it as worker_lost and settles the batch', async () => {
    const corpusId = (
      await db
        .insert(corpora)
        .values({
          org: ORG,
          project: PROJECT,
          name: 'lost-corpus',
          embeddingModel: 'mock/embed',
          embeddingDim: EMBED_DIM,
        })
        .returning({ id: corpora.id })
    )[0]!.id;
    const ingestId = (
      await db
        .insert(ingestRequests)
        .values({
          org: ORG,
          project: PROJECT,
          corpus: 'lost-corpus',
          corpusId,
          status: 'queued',
          totalDocs: 1,
          startedAt: new Date(),
        })
        .returning({ id: ingestRequests.id })
    )[0]!.id;
    const jobRowId = (
      await db
        .insert(ingestJobs)
        .values({ org: ORG, project: PROJECT, ingestId, externalId: null, status: 'queued' })
        .returning({ id: ingestJobs.id })
    )[0]!.id;

    const redis = new Redis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });
    const queue = new Queue(INGEST_QUEUE_NAME, { connection: redis });
    const child = spawnChild('ingest');
    let survivor: { stop: () => Promise<void> } | null = null;

    try {
      const data: IngestJobData = {
        ingestId,
        jobId: jobRowId,
        corpusId,
        org: ORG,
        project: PROJECT,
        externalId: null,
        text: 'The quick brown fox jumps over the lazy dog. '.repeat(20),
      };
      await queue.add(`${INGEST_QUEUE_NAME}:${ORG}`, data, {
        attempts: 1,
        removeOnComplete: false,
        removeOnFail: false,
      });

      // 0. The child really claimed it — see the header.
      await until(async () => {
        const rows = await db
          .select({ status: ingestJobs.status, startedAt: ingestJobs.startedAt })
          .from(ingestJobs)
          .where(eq(ingestJobs.id, jobRowId))
          .limit(1);
        return rows[0]?.status === 'running' && rows[0]?.startedAt ? rows[0] : null;
      }, 'the child ingest worker to claim the job');

      child.kill('SIGKILL');
      await waitFor(() => pastLostWindow(db, 'ingest_jobs', jobRowId), 'the ingest row to outlive the lost-window', {
        timeoutMs: 10_000,
        intervalMs: 50,
      });

      const { startIngestWorker } = await import('./ingest.worker.js');
      let survivorEmbeds = 0;
      survivor = await startIngestWorker({
        connection: redis,
        db,
        embedder: (async (opts: { model: string; input: string[] }) => {
          survivorEmbeds += 1;
          return {
            embeddings: opts.input.map(() => Array.from({ length: EMBED_DIM }, () => 0.01)),
            usage: { inputTokens: 1, estimatedCostUsd: 0 },
            model: opts.model,
          };
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
        runtime: { lockDuration: 700, stalledInterval: 300, maxStalledCount: 1 },
        concurrency: 1,
        lostWindowMs: LOST_WINDOW_MS,
      });

      const settled = await until(async () => {
        const rows = await db
          .select({ status: ingestJobs.status, error: ingestJobs.error })
          .from(ingestJobs)
          .where(eq(ingestJobs.id, jobRowId))
          .limit(1);
        return rows[0]?.status === 'failed' ? rows[0] : null;
      }, 'the lost ingest job to be failed');

      expect(settled.error).toBe('worker_lost');
      // NEVER re-embedded: that is what would duplicate the document.
      expect(survivorEmbeds).toBe(0);

      // ⚠ POLLED, not read once. The job row flips to 'failed' BEFORE the
      // batch rollup lands, so a single read right after the job settles races
      // the parent write and sees 'running'. Measured: 2 of 5 isolated runs.
      const batch = await waitFor(
        async () => {
          const rows = await db
            .select()
            .from(ingestRequests)
            .where(eq(ingestRequests.id, ingestId))
            .limit(1);
          return rows[0]?.status === 'failed' ? rows[0] : null;
        },
        'the ingest batch to settle as failed',
        { timeoutMs: 10_000, intervalMs: 50 },
      );
      expect(batch.failedDocs).toBe(1);
      expect(batch.status).toBe('failed');

      // A second sweep changes nothing.
      await reapOnce({ db, config: { windowMs: LOST_WINDOW_MS } });
      const batchAfter = (
        await db
          .select({ failedDocs: ingestRequests.failedDocs })
          .from(ingestRequests)
          .where(eq(ingestRequests.id, ingestId))
          .limit(1)
      )[0]!;
      expect(batchAfter.failedDocs).toBe(1);
    } finally {
      child.kill('SIGKILL');
      await survivor?.stop().catch(() => undefined);
      await queue.close().catch(() => undefined);
      await redis.quit().catch(() => undefined);
    }
  }, 60_000);
});
