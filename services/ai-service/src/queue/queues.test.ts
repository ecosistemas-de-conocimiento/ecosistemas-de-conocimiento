import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../config/config.js';
import { createRedisConnection } from './connection.js';
import { createTestRuntime } from '../testing/runtime.js';
import type { Runtime } from '../runtime.js';
import type { GenerationJobData } from '../types/generation.js';
import {
  GENERATION_QUEUE_NAME,
  __getMockJobs,
  generationJobName,
  orgPriorityBucket,
} from './queues.js';

const baseData: GenerationJobData = {
  jobId: 'job-1',
  generationRequestId: 'req-1',
  org: 'acme',
  project: 'proj-1',
  unitKey: 'u1',
};

// One isolated runtime per test, built by the same constructor production uses.
// This replaces `_resetQueuesForTests()`: there is no module-scope state left to
// reset, so a leaked queue between files is no longer expressible.
let runtime: Runtime;
const getGenerationQueue = () => runtime.queues.generation;
const getGenerationFlowProducer = () => runtime.queues.flow;

beforeEach(() => {
  runtime = createTestRuntime();
});

afterEach(async () => {
  await runtime.close();
});

describe('queue construction', () => {
  // 🔴 THE INVARIANT THE OLD SINGLETON TEST WAS REALLY PINNING. It read
  // "getGenerationQueue returns the same instance across calls"; what matters
  // is that a runtime builds each queue ONCE — a fresh BullMQ `Queue` per
  // access would open a Redis connection per enqueue.
  it('a runtime hands back the same generation queue across reads', () => {
    const a = runtime.queues.generation;
    const b = runtime.queues.generation;
    expect(a).toBe(b);
  });

  it('a runtime hands back the same flow producer across reads', () => {
    const a = runtime.queues.flow;
    const b = runtime.queues.flow;
    expect(a).toBe(b);
  });
});

describe('mock queue (test mode)', () => {
  it('queue.add stashes the job in __mockJobs', async () => {
    const q = getGenerationQueue();
    const job = await q.add(generationJobName('acme', 'ixd'), baseData);
    const stashed = __getMockJobs(q);
    expect(stashed).toHaveLength(1);
    expect(stashed[0]?.id).toBe(job.id);
    expect(stashed[0]?.name).toBe('generation:acme:ixd');
    expect(stashed[0]?.data).toEqual(baseData);
  });

  it('queue.remove returns 1 for an existing job, 0 for an unknown one', async () => {
    const q = getGenerationQueue();
    const job = await q.add(generationJobName('acme'), baseData);
    const jobId = job.id;
    if (!jobId) throw new Error('expected mock job to have an id');
    expect(await q.remove(jobId)).toBe(1);
    expect(await q.remove(jobId)).toBe(0);
    expect(await q.remove('does-not-exist')).toBe(0);
  });
});

describe('flow producer (test mode)', () => {
  it('expands parent/child into the same mock queue __mockJobs', async () => {
    const q = getGenerationQueue();
    const flow = getGenerationFlowProducer();

    const childData: GenerationJobData = { ...baseData, unitKey: 'child' };
    const parentData: GenerationJobData = { ...baseData, unitKey: 'parent' };

    const node = await flow.add({
      name: generationJobName('acme', 'parent'),
      queueName: GENERATION_QUEUE_NAME,
      data: parentData,
      children: [
        {
          name: generationJobName('acme', 'child'),
          queueName: GENERATION_QUEUE_NAME,
          data: childData,
        },
      ],
    });

    const stashed = __getMockJobs(q);
    expect(stashed).toHaveLength(2);
    const names = stashed.map((j) => j.name).sort();
    expect(names).toEqual(['generation:acme:child', 'generation:acme:parent']);
    expect(node.children).toHaveLength(1);
    expect(node.job.name).toBe('generation:acme:parent');
  });
});

describe('generationJobName', () => {
  it('formats with unitType', () => {
    expect(generationJobName('acme', 'ixd')).toBe('generation:acme:ixd');
  });

  it('falls back to "untyped" when unitType is omitted', () => {
    expect(generationJobName('acme')).toBe('generation:acme:untyped');
  });
});

describe('orgPriorityBucket', () => {
  it('returns a value in [1, 10]', () => {
    for (const org of ['acme', 'globex', 'initech', 'a', '']) {
      const b = orgPriorityBucket(org);
      expect(b).toBeGreaterThanOrEqual(1);
      expect(b).toBeLessThanOrEqual(10);
    }
  });

  it('is stable across calls for the same input', () => {
    expect(orgPriorityBucket('acme')).toBe(orgPriorityBucket('acme'));
    expect(orgPriorityBucket('globex')).toBe(orgPriorityBucket('globex'));
  });
});

// ── REGRESSION GUARD: the unit suite must never dial Redis ──────────────────
// `connection.ts` sets `lazyConnect: true`. Without it `new Redis()` connects at
// MODULE SCOPE, and a large fraction of this suite's files import it
// transitively. With no
// Redis in the `build` / `test` CI jobs, every one of those clients reconnects
// forever and ioredis `console.error`s each failure. Vitest ships each console
// call to the main process over RPC, the retries fire on a timer AFTER the last
// test, and a call still in flight at worker teardown kills the run with
//   EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending
// — exit 1 with every test green, which fails CI's exit-code gate and blocks
// `deploy-dev`. Measured: 5 such runs in 150; 0 in 150 with
// the option, and 37 Redis TCP dials per suite run became 0.
//
// This test asserts the OBSERVABLE consequence, not the option: importing the
// module must leave the client in ioredis's pre-connect state.
describe('shared Redis connection — lazy', () => {
  it('has not dialled Redis merely by being constructed', () => {
    // Phase 2 made this strictly stronger: `connection.ts` no longer builds a
    // client at MODULE scope at all, so importing it dials nothing whatever the
    // options say. `lazyConnect` still has to hold for the client a runtime
    // does build — `/health/ready` holds one in every environment.
    const client = createRedisConnection(loadConfig());
    expect(client.status).toBe('wait');
    client.disconnect();
  });
});

// ---------------------------------------------------------------------------
// Shared worker runtime
//
// 🔴 The number this locks is the one that caused a MEASURED double-run: both
// workers passed only `connection` + `concurrency`, so BullMQ's 30 s default
// `lockDuration` applied to jobs whose LLM call alone may take 120 s. A stalled
// event loop then handed the same job to a second worker.
//
// ⚠ These assertions are PURE — `workerRuntimeOptions()` must not touch Redis.
// The unit lane runs with no Redis service; anything in this module that dials
// at import breaks the `build` and `test` CI jobs.
// ---------------------------------------------------------------------------

describe('workerRuntimeOptions', () => {
  // 🔴 ASSERT THE LITERAL, NOT THE FORMULA. This test used to read
  // `expect(lockDuration).toBeGreaterThanOrEqual(env.LLM_REQUEST_TIMEOUT_MS *
  // WORKER_LOCK_TIMEOUT_MULTIPLIER)` with the multiplier IMPORTED from the
  // implementation — so it restated the code instead of pinning a number.
  // MEASURED: with the multiplier sabotaged 2 → 1 AND the floor 60000 → 1, the
  // whole file stayed 12/12 green. A test that recomputes the value it is
  // checking cannot fail. The two cases below name 240_000 and 60_000 outright.
  it('lock window is 240_000 ms at the default LLM timeout (not BullMQ’s 30 s)', async () => {
    const { workerRuntimeOptions } = await import('./queues.js');
    const { env } = await import('../config/env.js');

    // Stated first so a failure blames the env default, not the multiplier.
    expect(env.LLM_REQUEST_TIMEOUT_MS).toBe(120_000);

    const opts = workerRuntimeOptions();
    // 120 s LLM timeout × 2 (initial call + one validator retry).
    expect(opts.lockDuration).toBe(240_000);
    // The BullMQ default, restated so a regression to it is named, not implied.
    expect(opts.lockDuration).toBeGreaterThan(30_000);
    expect(opts.stalledInterval).toBeGreaterThan(0);
    expect(opts.maxStalledCount).toBeGreaterThanOrEqual(1);
  });

  it('WORKER_LOCK_DURATION_MS overrides the derivation outright, floor included', async () => {
    // The knob has to beat BOTH halves of the derivation — the multiplier AND
    // the 60 s floor. An operator who sets 5 s has measured their jobs; a floor
    // silently re-imposed on top would ignore the value they set.
    //
    // `resetModules` + a fresh import is the only way to re-parse `env`: it is
    // a module-scope Zod parse of `process.env`, evaluated once per module
    // registry. The var is restored in `finally` so the rest of the file (and
    // any file sharing this worker) sees the default derivation again.
    const previous = process.env.WORKER_LOCK_DURATION_MS;
    try {
      vi.resetModules();
      process.env.WORKER_LOCK_DURATION_MS = '5000';
      const { workerRuntimeOptions, WORKER_LOCK_DURATION_FLOOR_MS } = await import(
        './queues.js'
      );
      const opts = workerRuntimeOptions();
      expect(opts.lockDuration).toBe(5_000);
      expect(opts.lockDuration).toBeLessThan(WORKER_LOCK_DURATION_FLOOR_MS);
    } finally {
      if (previous === undefined) delete process.env.WORKER_LOCK_DURATION_MS;
      else process.env.WORKER_LOCK_DURATION_MS = previous;
      vi.resetModules();
    }
  });

  it('unset ⇒ the derivation still decides (the knob is opt-in, not a new default)', async () => {
    const previous = process.env.WORKER_LOCK_DURATION_MS;
    try {
      vi.resetModules();
      delete process.env.WORKER_LOCK_DURATION_MS;
      const {
        workerRuntimeOptions,
        WORKER_LOCK_TIMEOUT_MULTIPLIER,
        WORKER_LOCK_DURATION_FLOOR_MS,
      } = await import('./queues.js');
      const { env } = await import('../config/env.js');
      const opts = workerRuntimeOptions();
      expect(opts.lockDuration).toBe(
        Math.max(
          env.LLM_REQUEST_TIMEOUT_MS * WORKER_LOCK_TIMEOUT_MULTIPLIER,
          WORKER_LOCK_DURATION_FLOOR_MS,
        ),
      );
    } finally {
      if (previous !== undefined) process.env.WORKER_LOCK_DURATION_MS = previous;
      vi.resetModules();
    }
  });

  it('floors the lock window at 60_000 ms when the LLM timeout is tiny', async () => {
    // A deployment with a 1 s LLM timeout would otherwise get a 2 s lock —
    // shorter than BullMQ's own stalled scan, i.e. a permanent stall. The
    // floor is the thing under test, so the env has to change: re-import the
    // module tree with a stubbed timeout, then put it back.
    vi.resetModules();
    vi.stubEnv('LLM_REQUEST_TIMEOUT_MS', '1000');
    try {
      const { workerRuntimeOptions } = await import('./queues.js');
      const { env } = await import('../config/env.js');
      expect(env.LLM_REQUEST_TIMEOUT_MS).toBe(1_000); // the stub really took
      expect(workerRuntimeOptions().lockDuration).toBe(60_000);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  // `LLM_ASYNC_REQUEST_TIMEOUT_MS` lets an async unit run longer than a sync
  // call. The lock window has to follow the LONGER of the two deadlines, or a
  // healthy-but-long unit outlives its lock and the stalled checker re-runs it
  // (the measured double-run documented above). Literals, not the formula.
  it('derives the lock from the async deadline when it is the longer one', async () => {
    vi.resetModules();
    vi.stubEnv('LLM_ASYNC_REQUEST_TIMEOUT_MS', '600000');
    try {
      const { workerRuntimeOptions } = await import('./queues.js');
      const { env } = await import('../config/env.js');
      expect(env.LLM_REQUEST_TIMEOUT_MS).toBe(120_000);
      // 600 s async deadline × 2 (initial call + one validator retry).
      expect(workerRuntimeOptions().lockDuration).toBe(1_200_000);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it('keeps the sync deadline when the async one is shorter', async () => {
    vi.resetModules();
    vi.stubEnv('LLM_ASYNC_REQUEST_TIMEOUT_MS', '30000');
    try {
      const { workerRuntimeOptions } = await import('./queues.js');
      expect(workerRuntimeOptions().lockDuration).toBe(240_000);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it('lets a caller override any field (the test seam the stall repro uses)', async () => {
    const { workerRuntimeOptions } = await import('./queues.js');
    const opts = workerRuntimeOptions({ lockDuration: 700, stalledInterval: 300 });
    expect(opts.lockDuration).toBe(700);
    expect(opts.stalledInterval).toBe(300);
    expect(opts.maxStalledCount).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Worker lifecycle logging
//
// 🔴 A stalled job is the ONLY in-band signal that a second worker is about to
// pick up work someone else may still be running. Before this hook the event
// was swallowed: the measured double-run left no line in the logs at all, and
// BullMQ's own "Missing lock for job" error arrives only after the DB writes.
// The helper shipped with ZERO tests, so a silent regression to that state —
// a listener wired to the wrong event name, a dropped call — was invisible.
// ---------------------------------------------------------------------------

describe('attachWorkerLifecycleLogging', () => {
  /** Minimal stand-in for a BullMQ Worker: records listeners, replays them. */
  function fakeWorker() {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    return {
      worker: {
        on(event: string, listener: (...args: never[]) => void) {
          listeners.set(event, listener as (...args: unknown[]) => void);
          return this;
        },
      },
      emit(event: string, ...args: unknown[]) {
        const l = listeners.get(event);
        if (!l) throw new Error(`no listener registered for '${event}'`);
        l(...args);
      },
      events: () => [...listeners.keys()].sort(),
    };
  }

  it('logs a warning naming the job when a stalled event fires', async () => {
    const { attachWorkerLifecycleLogging } = await import('./queues.js');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const f = fakeWorker();
      attachWorkerLifecycleLogging(
        f.worker as Parameters<typeof attachWorkerLifecycleLogging>[0],
        'generation worker',
      );
      expect(f.events()).toEqual(['error', 'stalled']);

      f.emit('stalled', 'job-42', 'active');

      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0]![0]);
      expect(line).toContain('generation worker');
      expect(line).toContain('job-42');
      expect(line).toContain('STALLED');
      // The previous state is part of the signal — it says the job was taken
      // off an ACTIVE worker, not merely re-queued from wait.
      expect(line).toContain('active');
    } finally {
      warn.mockRestore();
    }
  });

  it('logs an error carrying the message when a worker error event fires', async () => {
    const { attachWorkerLifecycleLogging } = await import('./queues.js');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const f = fakeWorker();
      attachWorkerLifecycleLogging(
        f.worker as Parameters<typeof attachWorkerLifecycleLogging>[0],
        'ingest worker',
      );

      f.emit('error', new Error('redis connection lost'));

      expect(error).toHaveBeenCalledTimes(1);
      const line = String(error.mock.calls[0]![0]);
      expect(line).toContain('ingest worker');
      expect(line).toContain('redis connection lost');
    } finally {
      error.mockRestore();
    }
  });
});
