// COOPERATIVE SHUTDOWN — the whole app, in a child process, sent a real
// SIGTERM mid-generation (real Postgres + Redis + BullMQ + HTTP).
//
// ── The defect ─────────────────────────────────────────────────────────────
// `src/index.ts` handled SIGTERM by calling `worker.close()`, which stops the
// fetch and then WAITS for the active jobs with no bound. A generation that
// takes longer than the platform's stop timeout — Docker and Coolify both wait
// 10 SECONDS and then SIGKILL — therefore died mid-flight, leaving:
//   · `generation_jobs` at 'running', `finished_at` null
//   · the parent `generation_requests` never terminal
//   · no callback, no bus event: the consumer told nothing
//   · the reserve held, until the lost-worker reaper found it minutes later
// A ROUTINE REDEPLOY produced the crash signature (`worker_lost`).
//
// ── The rule (Rodrigo) ─────────────────────────────────────────
// Stop taking new jobs at once; give the in-flight ones `SHUTDOWN_GRACE_MS`;
// abort the survivors through the same AbortController `/cancel` uses so each
// settles as a NAMED terminal job (`shutdown`, distinct from `worker_lost`)
// with partial cost billed, parent rolled up and callback fired; then close.
//
// ── Why the whole app in a child, and not `startGenerationWorker` in-process ─
// ⚠ The unit under test is the SIGNAL HANDLER and everything hanging off it.
// In-process there is no PID to signal — installing a second SIGTERM handler
// on the vitest worker would test the function, not the wiring, and the wiring
// (does `index.ts` reach `workers.stop()` before `app.close()`? does the
// process actually EXIT, and with what code? does anything hang?) is where the
// bug lived. So: boot `src/index.ts`, drive it over HTTP, `kill('SIGTERM')`.
//
// 🔴 ASSERTION 0 IS LOAD-BEARING, same as in `worker-lost.integration.test.ts`.
// "The job row is terminal with error 'shutdown'" is also what a run where the
// child never booted would eventually produce (it would produce nothing, and a
// sloppy poll would time out — but a sloppy `expect(row?.status).not.toBe(
// 'running')` would PASS on a null row). Every case first proves the child
// really claimed the job and is mid-generation.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

import { generationJobs, generationRequests } from '../db/schema/index.js';
import { GENERATION_QUEUE_NAME, generationJobName } from '../queue/queues.js';
import { waitFor } from '../test/wait-for.js';
import { startFakeProvider } from '../../test-support/fake-provider/server.mjs';
import type { Db } from '../db/client.js';

const ORG = 'tenant-b';
const PROJECT = 'tenant-b';
const TOKEN = 'dev-key-tenant-b';
/** 32+ chars, so the callback is SIGNED and its row lands 'pending'. */
const CALLBACK_SECRET = 'shutdown-test-secret-0123456789abcdef';

/**
 * 🔴 SHORT ON PURPOSE, AND THE ONLY REASON THIS FITS A TEST TIMEOUT. The
 * production default is 30 s; the generation below runs ~20 s. Two seconds
 * guarantees the grace EXPIRES with the job still running, which is the branch
 * under test — the drain-happily branch is the one that needs no proof.
 */
const GRACE_MS = 2_000;

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

/**
 * How many clients Redis currently has. The leak check at the end compares
 * this against the pre-spawn baseline — the test's own connections are the
 * constant, the child's are what must be gone.
 */
async function connectedClients(redis: Redis): Promise<number> {
  const info = await redis.info('clients');
  return Number(/connected_clients:(\d+)/.exec(info)?.[1] ?? NaN);
}

interface Child {
  proc: ChildProcess;
  port: number;
  /** Everything the child has written to stdout+stderr so far. */
  log: () => string;
  /** Resolve once `re` appears in the child's output. */
  awaitLog: (re: RegExp, what: string, timeoutMs?: number) => Promise<void>;
  /** Resolves with the exit code. */
  exited: Promise<number | null>;
}

/** The slow provider every child generation talks to. Closed in `afterAll`. */
const fake = await startFakeProvider({
  bodyTokens: 200,
  streamTokensPerSec: 10,
  streamFirstDelayMs: 100,
});

async function bootApp(): Promise<Child> {
  const port = await freePort();
  const proc = spawn(process.execPath, ['--import', 'tsx', ENTRY], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // 🔴 NOT 'test'. `createRuntime` swaps in IN-MEMORY queues when
      // `NODE_ENV === 'test'` (src/runtime.ts), and `integration-setup.ts`
      // forces that value into the env this child inherits. With mock queues
      // there is no BullMQ worker to pause and nothing to shut down — the test
      // would pass against no implementation at all.
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      PORT: String(port),
      HOST: '127.0.0.1',
      SHUTDOWN_GRACE_MS: String(GRACE_MS),
      // A generation slow enough that the grace window certainly expires
      // inside it: 200 tokens at 10/s ≈ 20 s, served by the TEST-ONLY fake
      // provider over real HTTP. The real streaming adapter turns the abort
      // into `OpenRouterAbortError` carrying the partial completion — which is
      // where the partial COST comes from.
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

async function post(port: number, path: string, body: unknown): Promise<{ status: number; json: unknown }> {
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

interface StreamFrame {
  frame: Record<string, unknown>;
  /** ms since the request was issued — the timing the grace claim is about. */
  at: number;
}

/**
 * POST to the SSE streaming route and keep the socket open, handing back the
 * frames as they arrive.
 *
 * ⚠ `/v1/generate/stream` is `text/event-stream`, not NDJSON: each frame is a
 * `data: <json>` line followed by a BLANK line, and the handler opens with a
 * `: ok` comment line. A parser that splits on newlines and JSON-parses every
 * line silently yields zero frames here — which reads exactly like "the server
 * sent nothing".)
 *
 * Deliberately NOT `fetch`: we need the raw socket to stay open across a
 * SIGTERM sent to the SERVER, and we need to know when the response ENDED as
 * distinct from when the last frame arrived — "the client was told" and "the
 * client was hung up on" are the two outcomes this test has to tell apart.
 */
function postStream(
  port: number,
  path: string,
  body: unknown,
): {
  frames: StreamFrame[];
  /** Resolves when the response stream ends, with ms since the request. */
  ended: Promise<number>;
  status: Promise<number>;
  /** Drop OUR end of the socket. See the note at the call site. */
  destroy: () => void;
} {
  const payload = JSON.stringify(body);
  const frames: StreamFrame[] = [];
  const t0 = Date.now();
  let resolveEnd: (ms: number) => void;
  let resolveStatus: (n: number) => void;
  const ended = new Promise<number>((r) => (resolveEnd = r));
  const status = new Promise<number>((r) => (resolveStatus = r));

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
      resolveStatus(res.statusCode ?? 0);
      let buf = '';
      res.on('data', (c: Buffer) => {
        buf += c.toString();
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line || line.startsWith(':')) continue; // blank, or the `: ok` preamble
          if (!line.startsWith('data:')) continue;
          try {
            frames.push({
              frame: JSON.parse(line.slice('data:'.length).trim()) as Record<string, unknown>,
              at: Date.now() - t0,
            });
          } catch {
            /* a partial line is not a frame */
          }
        }
      });
      res.on('end', () => resolveEnd(Date.now() - t0));
      res.on('close', () => resolveEnd(Date.now() - t0));
    },
  );
  req.on('error', () => {
    resolveStatus(0);
    resolveEnd(Date.now() - t0);
  });
  req.end(payload);
  return { frames, ended, status, destroy: () => {
      req.socket?.destroy();
      req.destroy();
    } };
}

async function until<T>(read: () => Promise<T | null | undefined | false>, what: string, timeoutMs = 30_000): Promise<T> {
  return waitFor(read, what, { timeoutMs, intervalMs: 50 });
}

describe('cooperative shutdown on SIGTERM (integration)', () => {
  let db: Db;
  let redis: Redis;
  let sink: http.Server;
  let sinkPort: number;
  let child: Child | null = null;

  beforeAll(async () => {
    ({ db } = await import('../db/client.js'));
    redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
    // A real callback target, so the delivery is a delivery and not a
    // guard rejection. What is asserted is the ROW, which `enqueueCallback`
    // writes synchronously — the POST is fire-and-forget.
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
    // 🔴 LEAVE THE QUEUE AS WE FOUND IT. The first case here DELIBERATELY
    // leaves a job in Redis — "queued after the fetch stopped, never claimed"
    // is the assertion — and the `beforeEach` truncate in
    // `integration-setup.ts` empties POSTGRES, not Redis. Every integration
    // file shares one Redis and one `generation` queue, so that job outlives
    // this file.
    //
    // MEASURED: with a second child booted in this file, that leftover gets
    // claimed and then shutdown-aborted, and
    // `generation.worker.stalled.integration.test.ts` went red on its
    // ASSERTION 0 — "the stall really happened" — because its two
    // concurrency-1 workers spent their slots on our leftover instead of on
    // the job whose adapter blocks. The file passed on its own and failed in
    // the suite, which is the worst shape a failure can have.
    const leftovers = new Queue(GENERATION_QUEUE_NAME, {
      connection: new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null }),
    });
    await leftovers.obliterate({ force: true }).catch(() => undefined);
    await leftovers.close();
    await (leftovers.opts.connection as Redis).quit().catch(() => undefined);
    await redis.quit().catch(() => undefined);
    const { closeDb } = await import('../db/client.js');
    await closeDb().catch(() => undefined);
  });

  it(
    'drains, aborts past the grace window, settles the job as `shutdown`, and exits 0',
    async () => {
      await db.execute(sql`
        INSERT INTO "budget_state" ("org", "limit_usd", "remaining_usd")
        VALUES (${ORG}, 100::numeric, 100::numeric)
        ON CONFLICT ("org") DO UPDATE
          SET "limit_usd" = 100::numeric, "remaining_usd" = 100::numeric
      `);

      const redisBaseline = await connectedClients(redis);
      child = await bootApp();

      // ── Enqueue a real generation over HTTP ──────────────────────────────
      const unitKey = `shutdown-${Date.now()}`;
      const res = await post(child.port, '/v1/generate', {
        callbackUrl: `http://127.0.0.1:${sinkPort}/cb`,
        units: [
          {
            unitKey,
            input: { name: 'Ada' },
            specOverride: { promptTemplate: 'Hello {{name}}, tell me a very long story.' },
          },
        ],
      });
      expect(res.status, `POST /v1/generate failed: ${JSON.stringify(res.json)}`).toBe(200);
      const requestId = (res.json as { requestId: string }).requestId;

      // ── ASSERTION 0: the child really picked the job up and is generating ─
      const running = await until(async () => {
        const rows = await db
          .select({ status: generationJobs.status, startedAt: generationJobs.startedAt })
          .from(generationJobs)
          .where(eq(generationJobs.generationRequestId, requestId));
        const r = rows[0];
        return r && r.status === 'running' && r.startedAt ? r : null;
      }, 'the child to claim the job and start generating');
      expect(running.status).toBe('running');

      // ── A SECOND job, queued AFTER the signal ────────────────────────────
      // Its rows are seeded now (a DB write is not a claim); the QUEUE entry
      // goes in only once the child says it has stopped fetching. If the
      // worker were still taking work, concurrency is 5 — it would claim this
      // one immediately and the row would leave 'queued'.
      const laterRequestId = (
        await db
          .insert(generationRequests)
          .values({
            org: ORG,
            project: PROJECT,
            status: 'queued',
            totalJobs: 1,
            effort: 'standard',
            estimatedCostUsd: '0.001',
            actualCostUsd: '0',
            startedAt: new Date(),
          })
          .returning({ id: generationRequests.id })
      )[0]!.id;
      const laterJobId = (
        await db
          .insert(generationJobs)
          .values({
            generationRequestId: laterRequestId,
            org: ORG,
            project: PROJECT,
            unitKey: 'after-the-signal',
            status: 'queued',
            attempts: 0,
            effort: 'standard',
            specOverride: {
              promptTemplate: 'never runs',
              effortLevel: 'standard' as const,
              model: 'mock/model',
              validators: [],
              effortProfile: { estimatedCostUsdPerCall: 0.001 },
            },
            input: { __renderedPrompt: 'never runs' },
            estimatedCostUsd: '0.001',
            metadata: { reservePerCallUsd: 0.001 },
          })
          .returning({ id: generationJobs.id })
      )[0]!.id;

      // ── SIGTERM ──────────────────────────────────────────────────────────
      const t0 = Date.now();
      child.proc.kill('SIGTERM');

      // The drain line is printed by `stop()` AFTER `worker.close()` has been
      // STARTED — not `pause(true)`, which this comment used to claim and which
      // the implementation has never called. MEASURED against a real Redis:
      // `pause()` only flags the fetch LOOP, so a fetch already blocked inside
      // Redis still returns its job and the worker runs it. `close()`
      // disconnects that blocking connection, which is the only thing that
      // actually cancels the outstanding fetch — and it is deliberately NOT
      // awaited there, because awaiting it is the unbounded wait this whole
      // sequence exists to replace. Waiting on the LINE, rather than sleeping a
      // guessed number of milliseconds, is what makes "queued after the fetch
      // stopped" a fact instead of a race.
      await child.awaitLog(/draining 1 in-flight job/, 'the worker to stop fetching', 10_000);

      const queue = new Queue(GENERATION_QUEUE_NAME, {
        connection: new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null }),
      });
      await queue.add(generationJobName(ORG, PROJECT), {
        jobId: laterJobId,
        generationRequestId: laterRequestId,
        org: ORG,
        project: PROJECT,
        unitKey: 'after-the-signal',
      });

      // ── the process exits, 0, inside the promised budget ─────────────────
      const code = await Promise.race([
        child.exited,
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), EXIT_BUDGET_MS + 3_000)),
      ]);
      const elapsed = Date.now() - t0;
      expect(code, `child did not exit; log:\n${child.log().slice(-4000)}`).toBe(0);
      expect(elapsed).toBeLessThan(EXIT_BUDGET_MS);
      // …and it did NOT exit instantly: the grace window was actually waited
      // out rather than skipped, which a `close(true)` would have done.
      expect(elapsed).toBeGreaterThanOrEqual(GRACE_MS);

      // ── the in-flight job is a NAMED terminal failure with partial cost ───
      const settled = (
        await db
          .select({
            status: generationJobs.status,
            error: generationJobs.error,
            finishedAt: generationJobs.finishedAt,
            actualCostUsd: generationJobs.actualCostUsd,
          })
          .from(generationJobs)
          .where(eq(generationJobs.generationRequestId, requestId))
      )[0]!;
      expect(settled.status).toBe('failed');
      // 🔴 `shutdown`, NOT `worker_lost`. A redeploy must not read as a crash.
      expect(settled.error).toBe('shutdown');
      expect(settled.error).not.toBe('worker_lost');
      expect(settled.finishedAt).toBeTruthy();
      expect(Number(settled.actualCostUsd)).toBeGreaterThan(0);

      // ── the trace the router wrote for the aborted stream ─────────────────
      const traceRows = await db.execute(sql`
        SELECT "status", "actual_cost_usd"
          FROM "traces"
         WHERE "org" = ${ORG} AND "metadata"->>'unitKey' = ${unitKey}
         ORDER BY "created_at" DESC
      `);
      const traces = Array.isArray(traceRows)
        ? (traceRows as Array<Record<string, unknown>>)
        : ((traceRows as { rows?: Array<Record<string, unknown>> }).rows ?? []);
      expect(traces.length).toBeGreaterThan(0);
      expect(traces[0]!['status']).toBe('aborted');
      expect(Number(traces[0]!['actual_cost_usd'])).toBeGreaterThan(0);

      // ── the parent is terminal, so the consumer's poll ends ───────────────
      const parent = (
        await db
          .select({ status: generationRequests.status, finishedAt: generationRequests.finishedAt })
          .from(generationRequests)
          .where(eq(generationRequests.id, requestId))
      )[0]!;
      expect(['failed', 'partial', 'completed', 'cancelled']).toContain(parent.status);
      expect(parent.finishedAt).toBeTruthy();

      // ── the callbacks were written before the process left ────────────────
      const cbRows = await db.execute(sql`
        SELECT "event" FROM "callback_deliveries" WHERE "source_id" = ${requestId}
      `);
      const cbs = (
        Array.isArray(cbRows)
          ? (cbRows as Array<Record<string, unknown>>)
          : ((cbRows as { rows?: Array<Record<string, unknown>> }).rows ?? [])
      ).map((r) => r['event']);
      expect(cbs).toContain('unit.failed');
      expect(cbs).toContain('request.failed');

      // ── NO NEW JOB WAS CLAIMED AFTER THE SIGNAL ───────────────────────────
      const later = (
        await db
          .select({ status: generationJobs.status, startedAt: generationJobs.startedAt })
          .from(generationJobs)
          .where(eq(generationJobs.id, laterJobId))
      )[0]!;
      expect(later.status).toBe('queued');
      expect(later.startedAt).toBeNull();

      // ── no Redis clients left behind ──────────────────────────────────────
      await until(
        async () => ((await connectedClients(redis)) <= redisBaseline + 1 ? true : null),
        'the child’s Redis connections to be gone',
        10_000,
      );

      await queue.close();
      await (queue.opts.connection as Redis).quit().catch(() => undefined);
    },
    120_000,
  );

  // ── F1: THE HTTP HALF ──────────────────────────────────────────────────────
  //
  // `SHUTDOWN_GRACE_MS` bounded the BullMQ workers and NOTHING ELSE.
  //
  // MEASURED on this tree before `Runtime.shutdownSignal` existed: a SIGTERM
  // sent 2 s into a `/v1/generate/stream` with `SHUTDOWN_GRACE_MS=2000` let the
  // response COMPLETE NORMALLY — a `done` frame, 25 s after the signal. The
  // order in `index.ts` is `workers.stop()` then `app.close()`, and Fastify's
  // `close()` waits for in-flight requests: by the time it runs the grace has
  // already been spent draining the queue, and the HTTP request gets an
  // unbounded extension nobody promised it.
  //
  // The fix composes the process-level shutdown signal into the signal the
  // route already hands the router, so the provider fetch aborts through the
  // existing `OpenRouterAbortError` path.
  //
  // 🔴 ASSERTION 0 IS LOAD-BEARING here too: this test is meaningless unless the
  // stream was genuinely mid-generation when the signal landed. A run where the
  // child never booted, or where the generation finished early, would satisfy
  // "the stream ended" trivially. So we wait for real `delta` frames first.
  it(
    'SIGTERM during /v1/generate/stream ends the stream inside the grace, and exits 0',
    async () => {
      await db.execute(sql`
        INSERT INTO "budget_state" ("org", "limit_usd", "remaining_usd")
        VALUES (${ORG}, 100::numeric, 100::numeric)
        ON CONFLICT ("org") DO UPDATE
          SET "limit_usd" = 100::numeric, "remaining_usd" = 100::numeric
      `);

      child = await bootApp();
      const unitKey = `shutdown-stream-${Date.now()}`;
      const stream = postStream(child.port, '/v1/generate/stream', {
        unit: {
          unitKey,
          input: { name: 'Ada' },
          specOverride: { promptTemplate: 'Hello {{name}}, tell me a very long story.' },
        },
      });
      expect(await stream.status).toBe(200);

      // ── ASSERTION 0: the provider is really streaming into this socket ────
      // 200 tokens at 10/s ≈ 20 s of generation, so a handful of deltas proves
      // we are well inside it with ~19 s left to run.
      await until(
        async () => (stream.frames.filter((f) => f.frame['type'] === 'delta').length >= 3 ? true : null),
        'the stream to deliver deltas',
        20_000,
      );
      const deltasBeforeSignal = stream.frames.filter((f) => f.frame['type'] === 'delta').length;
      expect(deltasBeforeSignal).toBeGreaterThanOrEqual(3);
      expect(stream.frames.some((f) => f.frame['type'] === 'done')).toBe(false);

      // ── SIGTERM ───────────────────────────────────────────────────────────
      const t0 = Date.now();
      child.proc.kill('SIGTERM');

      // ── the client is TOLD, inside the window ─────────────────────────────
      // Not "the socket eventually closed": a SIGKILL would do that too, and
      // silently. The grace expiring must produce a terminal frame on the wire.
      // The frame's CODE is deliberately not pinned — the classification arm
      // that produces it is owned by another lane and is being reworked; what
      // this test owns is that a terminal frame arrives at all, and WHEN.
      await until(
        async () =>
          stream.frames.some((f) => f.frame['type'] === 'error' || f.frame['type'] === 'done')
            ? true
            : null,
        'a terminal frame after the signal',
        GRACE_MS + 5_000,
      );
      const terminal = stream.frames.filter(
        (f) => f.frame['type'] === 'error' || f.frame['type'] === 'done',
      )[0]!;
      const sinceSignal = Date.now() - t0;
      expect(
        terminal.frame['type'],
        `the stream COMPLETED instead of being cut short — the shutdown signal is ` +
          `not composed into the request signal. frames=${JSON.stringify(stream.frames.slice(-3))}`,
      ).toBe('error');
      // grace + margin. Before the fix this was ~25 s against a 2 s grace.
      expect(sinceSignal).toBeLessThan(GRACE_MS + 5_000);
      // …and NOT instant: the grace was a window, not a hang-up on the signal.
      expect(sinceSignal).toBeGreaterThanOrEqual(GRACE_MS - 500);

      // ── the response stream is over, and the process left ─────────────────
      await stream.ended;
      // 🔴 DROP OUR SOCKET, AND MEASURE THE SERVICE RATHER THAN OUR OWN CLIENT.
      // MEASURED: leaving this keep-alive socket open costs `app.close()` 7.0 s
      // — Fastify waits for the connection to go away and Node's
      // `keepAliveTimeout` is what eventually ends it, which has nothing to do
      // with `SHUTDOWN_GRACE_MS`. That is a real property of the service and it
      // is recorded in the open items, but it is NOT what this test is about:
      // the claim under test is that the GENERATION was cut short inside the
      // window, and a client that hangs on to a finished response must not be
      // able to make that claim fail.
      stream.destroy();
      const code = await Promise.race([
        child.exited,
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), EXIT_BUDGET_MS + 3_000)),
      ]);
      const elapsed = Date.now() - t0;
      // Printed, not just asserted: the NUMBER is the finding. Before the fix
      // the same line read ~25000 ms against a 2000 ms grace.
      console.info(
        `[stream shutdown] SIGTERM → terminal frame in ${sinceSignal} ms ` +
          `(grace ${GRACE_MS} ms) → process exit(0) in ${elapsed} ms`,
      );
      expect(code, `child did not exit; log:\n${child.log().slice(-4000)}`).toBe(0);
      expect(elapsed).toBeLessThan(EXIT_BUDGET_MS);

      // ── the trace records what was actually spent ─────────────────────────
      // The tokens the provider streamed before the abort were billed, so the
      // partial cost has to be on the row — an aborted generation that records
      // 0 is the rollup undercount arriving through a different door.
      const traceRows = await db.execute(sql`
        SELECT "status", "actual_cost_usd"
          FROM "traces"
         WHERE "org" = ${ORG} AND "metadata"->>'unitKey' = ${unitKey}
         ORDER BY "created_at" DESC
      `);
      const traces = Array.isArray(traceRows)
        ? (traceRows as Array<Record<string, unknown>>)
        : ((traceRows as { rows?: Array<Record<string, unknown>> }).rows ?? []);
      expect(traces.length).toBeGreaterThan(0);
      expect(traces[0]!['status']).toBe('aborted');
      expect(Number(traces[0]!['actual_cost_usd'])).toBeGreaterThan(0);
    },
    120_000,
  );
});
