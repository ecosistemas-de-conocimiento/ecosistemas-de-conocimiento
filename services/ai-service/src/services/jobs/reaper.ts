// Periodic sweep for jobs whose worker died.
//
// ---------------------------------------------------------------------------
// Why a sweep as well as the redelivery path
// ---------------------------------------------------------------------------
//
// When a worker dies, BullMQ usually redelivers the job once its lock expires,
// and the worker's claim-failure branch reaps it there — that is the fast path
// and it needs no timer. But the redelivery is not guaranteed: Redis can be
// flushed, the queue drained, the job evicted by `removeOnComplete`, or the
// whole pod replaced before the stalled checker ever runs. In every one of
// those cases the row would stay 'running' forever with no second delivery to
// hang the recovery off.
//
// So the DB is the backstop, exactly as it is for callback deliveries: a plain
// periodic scan for rows that are `running` past the window, applying the SAME
// guarded transition. The row's status is the coordination — a row already
// reaped by the redelivery path simply no longer matches.
//
// Scheduling shape is deliberately copied from
// `src/services/callbacks/sweeper.ts`: an unref'd timer chained on completion
// (never an interval, which would stack sweeps on a slow one), a boot sweep
// deferred one tick, and a `stop()` that waits for the in-flight sweep.

import { db as defaultDb, type Db } from '../../db/client.js';
import { reaperConfigFromEnv, type ReaperConfig } from './lost.js';
import {
  reapLostGenerationJobs,
  type ReapDeps,
} from '../../workers/generation.worker.js';
import { reapLostIngestJobs } from '../../workers/ingest.worker.js';

export interface ReaperDeps {
  db?: Db;
  bus?: ReapDeps['bus'];
  budget?: ReapDeps['budget'];
  config?: Partial<ReaperConfig>;
  logger?: { warn: (o: unknown, m?: string) => void };
}

export interface ReapSweepResult {
  generationJobs: string[];
  ingestJobs: string[];
}

/** One sweep across both job tables. Safe to run concurrently with itself. */
export async function reapOnce(deps: ReaperDeps = {}): Promise<ReapSweepResult> {
  const db = deps.db ?? defaultDb;
  const cfg = { ...reaperConfigFromEnv(), ...deps.config };
  const shared = {
    db,
    windowMs: cfg.windowMs,
    batchSize: cfg.batchSize,
    ...(deps.bus ? { bus: deps.bus } : {}),
    ...(deps.budget ? { budget: deps.budget } : {}),
  };
  // Sequential, not `Promise.all`: the two sweeps share one Postgres pool and
  // a reap fans out into counter bumps, events and callback enqueues. Nothing
  // here is latency-sensitive.
  const generation = await reapLostGenerationJobs(shared);
  const ingest = await reapLostIngestJobs({
    db,
    windowMs: cfg.windowMs,
    batchSize: cfg.batchSize,
  });
  if (generation.length > 0 || ingest.length > 0) {
    console.warn(
      `job reaper: reaped ${generation.length} generation job(s) and ` +
        `${ingest.length} ingest job(s) whose worker was lost ` +
        `(window ${cfg.windowMs} ms).`,
    );
  }
  return { generationJobs: generation, ingestJobs: ingest };
}

export interface ReaperHandle {
  stop: () => Promise<void>;
  /** Exposed for tests / ops: run one sweep right now. */
  reapNow: () => Promise<ReapSweepResult>;
}

export function startJobReaper(deps: ReaperDeps = {}): ReaperHandle {
  const cfg = { ...reaperConfigFromEnv(), ...deps.config };
  let stopped = false;
  let inFlight: Promise<unknown> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const runOnce = async (): Promise<ReapSweepResult> => {
    try {
      return await reapOnce(deps);
    } catch (err) {
      deps.logger?.warn({ err }, 'job reaper: sweep failed; will retry next interval');
      return { generationJobs: [], ingestJobs: [] };
    }
  };

  const tick = (): void => {
    if (stopped) return;
    inFlight = runOnce().finally(() => {
      if (stopped) return;
      timer = setTimeout(tick, cfg.intervalMs);
      timer.unref?.();
    });
  };

  // Boot sweep: the rows it recovers were stranded by a process that is
  // already gone, so there is nothing to wait for.
  timer = setTimeout(tick, 0);
  timer.unref?.();

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight.catch(() => undefined);
    },
    reapNow: () => reapOnce(deps),
  };
}
