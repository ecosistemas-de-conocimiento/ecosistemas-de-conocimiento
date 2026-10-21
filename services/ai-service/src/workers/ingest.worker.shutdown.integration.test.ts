// COOPERATIVE SHUTDOWN, INGEST SIDE — the whole app, in a child process, sent a
// real SIGTERM mid-embed (real Postgres + Redis + BullMQ + HTTP).
//
// Sibling of `shutdown.integration.test.ts`, which covers the generation queue.
// Read that file's header for the rule and for why the whole app has to run in
// a child; this one only records what was different about ingest.
//
// ── The defect ─────────────────────────────────────────────────────────────
// `startIngestWorker.stop()` was `await worker.pause(true)` then
// `await worker.close()`, and its comment claimed the pause stopped new
// fetches. Both halves were wrong:
//
//   · MEASURED on the generation queue against a real Redis: `pause()` only
//     flags the fetch LOOP. A fetch already blocked inside Redis still returns
//     its job and the worker runs it. Only `close()` disconnects the blocking
//     connection and actually stops new work.
//   · the awaited `close()` then waited on the active jobs with NO BOUND, and
//     nothing aborted the in-flight embed. An ingest job is one batch embed of
//     a whole document, which routinely outruns the platform's 10 s stop
//     timeout — so the SIGKILL landed mid-embed and left `ingest_jobs` at
//     'running', the batch never terminal, no `ingest.failed` callback, until
//     the reaper called it `worker_lost` minutes later. A ROUTINE REDEPLOY
//     produced the crash signature.
//
// ── Why the embed has to be slow ───────────────────────────────────────────
// The embed is the only step of an ingest job long enough for a grace window
// to expire inside: chunking is CPU-bound milliseconds and the document+chunk
// write is one local transaction. The TEST-ONLY fake provider
// (`test-support/fake-provider/`) serves the embeddings here with an
// `embeddingDelayMs` that makes the real embedder's HTTP call take measurable,
// ABORTABLE time — the counterpart of `streamTokensPerSec` in the generation
// shutdown test. With no delay the
// job would be finished before SIGTERM landed and this file would assert
// nothing.
//
// 🔴 ASSERTION 0 IS LOAD-BEARING. "The job row is terminal with error
// 'shutdown'" is also what a run where the child never booted would produce —
// nothing, which a sloppy `expect(row?.status).not.toBe('running')` PASSES on a
// null row. So the test first proves the child really claimed the row and is
// sitting inside the embed.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

import { documents, ingestJobs, ingestRequests } from '../db/schema/index.js';
import { INGEST_QUEUE_NAME, type IngestJobData } from '../queue/queues.js';
import { waitFor } from '../test/wait-for.js';
import { startFakeProvider } from '../../test-support/fake-provider/server.mjs';
import type { Db } from '../db/client.js';

const ORG = 'tenant-b';
const PROJECT = 'tenant-b';
const TOKEN = 'dev-key-tenant-b';
/** 32+ chars, so the callback is SIGNED and its row lands 'pending'. */
const CALLBACK_SECRET = 'ingest-shutdown-secret-0123456789abcdef';

/**
 * 🔴 SHORT ON PURPOSE, AND THE ONLY REASON THIS FITS A TEST TIMEOUT. The
 * production default is 30 s; the mock embed below takes 20 s. Two seconds
 * guarantees the grace EXPIRES with the embed still running, which is the
 * branch under test — the drain-happily branch needs no proof.
 */
const GRACE_MS = 2_000;

/** How long the mock embedder pretends to take. Must dwarf `GRACE_MS`. */
const EMBED_DELAY_MS = 20_000;

/** `SHUTDOWN_SETTLE_MS` in `services/jobs/shutdown.ts`, plus room to exit. */
const EXIT_BUDGET_MS = GRACE_MS + 5_000;

const ENTRY = fileURLToPath(new URL('../index.ts', import.meta.url));

/** An ephemeral port, claimed and released. `PORT=0` is rejected by Zod. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') return reject(new Error('no port'));
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

interface Child {
  proc: ChildProcess;
  port: number;
  log: () => string;
  awaitLog: (re: RegExp, what: string, timeoutMs?: number) => Promise<void>;
  exited: Promise<number | null>;
}

/** The slow embedder every child ingest talks to. Closed in `afterAll`. */
const fake = await startFakeProvider({ embeddingDelayMs: EMBED_DELAY_MS });

async function bootApp(): Promise<Child> {
  const port = await freePort();
  const proc = spawn(process.execPath, ['--import', 'tsx', ENTRY], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // 🔴 NOT 'test'. `createRuntime` swaps in IN-MEMORY queues when
      // `NODE_ENV === 'test'` (src/runtime.ts), and `integration-setup.ts`
      // forces that value into the env this child inherits. With mock queues
      // there is no BullMQ worker to close and nothing to shut down — the test
      // would pass against no implementation at all.
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      PORT: String(port),
      HOST: '127.0.0.1',
      SHUTDOWN_GRACE_MS: String(GRACE_MS),
      // Embeddings from the fake provider, made slow enough that the grace
      // window certainly expires inside the embed call. The real adapter's
      // `fetch` honours the abort signal, so the abort at the end of the grace
      // window is what ends it.
      ...fake.env,
      // The callback sink is on loopback, which the SSRF guard rejects by
      // default. This is the switch that exists for exactly this case.
      CALLBACK_ALLOW_PRIVATE: '1',
      API_KEYS: JSON.stringify({
        [TOKEN]: {
          org: ORG,
          project: PROJECT,
          role: 'app',
          callbackSecret: CALLBACK_SECRET,
        },
      }),
    },
  });

  let buf = '';
  proc.stdout?.on('data', (d: Buffer) => (buf += d.toString()));
  proc.stderr?.on('data', (d: Buffer) => (buf += d.toString()));

  const exited = new Promise<number | null>((resolve) => {
    proc.on('exit', (code) => resolve(code));
  });

  const awaitLog = async (re: RegExp, what: string, timeoutMs = 30_000) => {
    await waitFor(async () => (re.test(buf) ? true : null), `${what} in the child's log`, {
      timeoutMs,
      intervalMs: 50,
    });
  };

  // The last line `main()` prints. Waiting on the HTTP port instead would
  // return one step too early: the listener binds BEFORE `startWorkers`.
  await awaitLog(/workers started ok/, 'the boot to finish');

  return { proc, port, log: () => buf, awaitLog, exited };
}

async function post(
  port: number,
  path: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          authorization: `Bearer ${TOKEN}`,
        },
      },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, json: out ? JSON.parse(out) : null }),
        );
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

async function until<T>(
  read: () => Promise<T | null | undefined | false>,
  what: string,
  timeoutMs = 30_000,
): Promise<T> {
  return waitFor(read, what, { timeoutMs, intervalMs: 25 });
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  return Array.isArray(result)
    ? (result as Array<Record<string, unknown>>)
    : ((result as { rows?: Array<Record<string, unknown>> }).rows ?? []);
}

describe('cooperative shutdown on SIGTERM — ingest worker (integration)', () => {
  let db: Db;
  let sink: http.Server;
  let sinkPort: number;
  let child: Child | null = null;

  beforeAll(async () => {
    ({ db } = await import('../db/client.js'));
    // A real callback target, so the delivery is a delivery and not a guard
    // rejection. What is asserted is the ROW, which `enqueueCallback` writes
    // synchronously — the POST is fire-and-forget.
    sink = http.createServer((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    sinkPort = await new Promise<number>((resolve) => {
      sink.listen(0, '127.0.0.1', () => {
        const a = sink.address();
        resolve(typeof a === 'object' && a ? a.port : 0);
      });
    });
  });

  afterAll(async () => {
    child?.proc.kill('SIGKILL');
    await new Promise<void>((r) => sink.close(() => r()));
    await fake.close();
    // 🔴 LEAVE THE QUEUE AS WE FOUND IT — same reason as the generation
    // shutdown file. This case deliberately leaves a job in Redis ("queued
    // after the fetch stopped, never claimed" is the assertion), and the
    // `beforeEach` truncate empties POSTGRES, not Redis. A leftover job that
    // outlives the file gets claimed by the next file's workers: it cost
    // `generation.worker.stalled.integration.test.ts` its ASSERTION 0 once
    // already, with the file green on its own and red in the suite.
    const leftovers = new Queue(INGEST_QUEUE_NAME, {
      connection: new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null }),
    });
    await leftovers.obliterate({ force: true }).catch(() => undefined);
    await leftovers.close();
    await (leftovers.opts.connection as Redis).quit().catch(() => undefined);
    const { closeDb } = await import('../db/client.js');
    await closeDb().catch(() => undefined);
  });

  it(
    'aborts the in-flight embed past the grace window, settles the ingest job as `shutdown`, and exits 0',
    async () => {
      // Ingest is charged against the org's cap (AIS-7) and the enforcer is
      // fail-closed on a missing row.
      await db.execute(sql`
        INSERT INTO "budget_state" ("org", "limit_usd", "remaining_usd")
        VALUES (${ORG}, 1, 1)
      `);
      child = await bootApp();

      // ── Enqueue a real ingest over HTTP ──────────────────────────────────
      const externalId = `shutdown-doc-${Date.now()}`;
      const res = await post(child.port, '/v1/ingest', {
        corpus: 'shutdown-corpus',
        callbackUrl: `http://127.0.0.1:${sinkPort}/cb`,
        documents: [
          {
            id: externalId,
            text: 'A document long enough to be worth embedding. '.repeat(40),
          },
        ],
      });
      expect(res.status, `POST /v1/ingest failed: ${JSON.stringify(res.json)}`).toBe(202);
      const { ingestId, corpusId } = res.json as { ingestId: string; corpusId: string };

      // ── ASSERTION 0: the child really claimed the row and is embedding ────
      // `claimIngestJob` flips 'queued' → 'running' BEFORE the corpus load, and
      // the only thing after it that takes measurable time is the 20 s mock
      // embed. So a 'running' row with a `started_at` is proof the child is
      // inside the embed, which is the state the whole fix is about.
      const running = await until(async () => {
        const rows = await db
          .select({ id: ingestJobs.id, status: ingestJobs.status, startedAt: ingestJobs.startedAt })
          .from(ingestJobs)
          .where(eq(ingestJobs.ingestId, ingestId));
        const r = rows[0];
        return r && r.status === 'running' && r.startedAt ? r : null;
      }, 'the child to claim the ingest job and start embedding');
      expect(running.status).toBe('running');

      // ── A SECOND ingest job, queued AFTER the signal ──────────────────────
      // Its rows are seeded now (a DB write is not a claim); the QUEUE entry
      // goes in only once the child says it has stopped fetching. If the worker
      // were still taking work, concurrency is 3 — it would claim this one
      // immediately and the row would leave 'queued'. This is the assertion
      // that distinguishes `close()` from the `pause(true)` this replaced.
      const laterIngestId = (
        await db
          .insert(ingestRequests)
          .values({
            org: ORG,
            project: PROJECT,
            corpus: 'shutdown-corpus',
            corpusId,
            status: 'queued',
            totalDocs: 1,
            startedAt: new Date(),
          })
          .returning({ id: ingestRequests.id })
      )[0]!.id;
      const laterJobId = (
        await db
          .insert(ingestJobs)
          .values({
            org: ORG,
            project: PROJECT,
            ingestId: laterIngestId,
            externalId: 'after-the-signal',
            status: 'queued',
          })
          .returning({ id: ingestJobs.id })
      )[0]!.id;

      // ── SIGTERM ──────────────────────────────────────────────────────────
      const t0 = Date.now();
      child.proc.kill('SIGTERM');

      // The drain line is printed by `stop()` AFTER `worker.close()` has been
      // STARTED (not awaited). Waiting on it, rather than sleeping a guessed
      // number of milliseconds, is what makes "queued after the fetch stopped"
      // a fact instead of a race.
      await child.awaitLog(
        /ingest worker: draining 1 in-flight job/,
        'the ingest worker to stop fetching',
        10_000,
      );

      const queue = new Queue<IngestJobData>(INGEST_QUEUE_NAME, {
        connection: new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null }),
      });
      await queue.add(`${INGEST_QUEUE_NAME}:${ORG}`, {
        ingestId: laterIngestId,
        jobId: laterJobId,
        corpusId,
        org: ORG,
        project: PROJECT,
        externalId: 'after-the-signal',
        text: 'never runs',
      });

      // ── the row settles TERMINALLY, and we time how long that took ────────
      const settled = await until(async () => {
        const rows = await db
          .select({
            status: ingestJobs.status,
            error: ingestJobs.error,
            finishedAt: ingestJobs.finishedAt,
          })
          .from(ingestJobs)
          .where(eq(ingestJobs.ingestId, ingestId));
        const r = rows[0];
        return r && (r.status === 'completed' || r.status === 'failed') ? r : null;
      }, 'the aborted ingest job to settle terminally', EXIT_BUDGET_MS + 3_000);
      const settleMs = Date.now() - t0;

      // 🔴 `shutdown`, NOT `worker_lost`, and NOT still 'running'. A redeploy
      // must not read as a crash, and the reaper must have nothing to find.
      expect(settled.status).toBe('failed');
      expect(settled.error).toBe('shutdown');
      expect(settled.error).not.toBe('worker_lost');
      expect(settled.finishedAt).toBeTruthy();
      // It settled inside the promised window, not minutes later via the reaper.
      expect(settleMs).toBeLessThan(EXIT_BUDGET_MS);
      // …and it did NOT settle instantly: the grace window was actually waited
      // out rather than skipped, which a `close(true)` would have done.
      expect(settleMs).toBeGreaterThanOrEqual(GRACE_MS);
      console.log(
        `[ingest shutdown] SIGTERM → row settled in ${settleMs} ms (grace ${GRACE_MS} ms)`,
      );

      // ── the process exits, 0, inside the promised budget ──────────────────
      const code = await Promise.race([
        child.exited,
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), EXIT_BUDGET_MS + 3_000)),
      ]);
      const exitMs = Date.now() - t0;
      expect(code, `child did not exit; log:\n${child.log().slice(-4000)}`).toBe(0);
      expect(exitMs).toBeLessThan(EXIT_BUDGET_MS);
      expect(exitMs).toBeGreaterThanOrEqual(GRACE_MS);
      console.log(`[ingest shutdown] SIGTERM → process exit(0) in ${exitMs} ms`);

      // ── NOTHING was written for the aborted document ──────────────────────
      // The embed is pre-insert by design, so an abort inside it must leave the
      // corpus untouched — no half-indexed document, no orphan chunks.
      const docRows = await db
        .select({ id: documents.id })
        .from(documents)
        .where(eq(documents.ingestId, ingestId));
      expect(docRows).toHaveLength(0);

      // ── …and the embed's budget hold went back to the org ─────────────────
      const budgetRow = rowsOf(
        await db.execute(sql`SELECT "remaining_usd" FROM "budget_state" WHERE "org" = ${ORG}`),
      )[0];
      expect(Number(budgetRow?.['remaining_usd'])).toBeCloseTo(1, 9);

      // ── the batch is terminal, so the consumer's poll ends ────────────────
      const batch = (
        await db
          .select({
            status: ingestRequests.status,
            failedDocs: ingestRequests.failedDocs,
            finishedAt: ingestRequests.finishedAt,
          })
          .from(ingestRequests)
          .where(eq(ingestRequests.id, ingestId))
      )[0]!;
      expect(batch.status).toBe('failed');
      expect(batch.failedDocs).toBe(1);
      expect(batch.finishedAt).toBeTruthy();

      // ── the callback was written before the process left ──────────────────
      const cbs = rowsOf(
        await db.execute(sql`
          SELECT "event" FROM "callback_deliveries" WHERE "source_id" = ${ingestId}
        `),
      ).map((r) => r['event']);
      expect(cbs).toContain('ingest.failed');

      // ── NO NEW JOB WAS CLAIMED AFTER THE SIGNAL ───────────────────────────
      const later = (
        await db
          .select({ status: ingestJobs.status, startedAt: ingestJobs.startedAt })
          .from(ingestJobs)
          .where(eq(ingestJobs.id, laterJobId))
      )[0]!;
      expect(later.status).toBe('queued');
      expect(later.startedAt).toBeNull();

      await queue.close();
      await (queue.opts.connection as Redis).quit().catch(() => undefined);
    },
    120_000,
  );
});
