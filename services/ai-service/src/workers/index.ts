// Boot all in-process workers. Called from `src/index.ts` after the Fastify
// server starts listening.
//
// M3: generation worker. M4: + ingest worker (chunks + embeds documents).

import { startGenerationWorker, type WorkerDeps } from './generation.worker.js';
import { startIngestWorker, type IngestWorkerDeps } from './ingest.worker.js';
import { rootLogger, type FleetLogger } from '../logger.js';
import {
  startCallbackSweeper,
  sweeperEnabled,
  type SweepDeps,
} from '../services/callbacks/sweeper.js';
import {
  startJobReaper,
  type ReaperDeps,
} from '../services/jobs/reaper.js';
import { reaperEnabled } from '../services/jobs/lost.js';
import type { Runtime } from '../runtime.js';

export type { WorkerDeps } from './generation.worker.js';
export type { IngestWorkerDeps } from './ingest.worker.js';

interface StopHandle {
  stop: () => Promise<void>;
}

export async function startWorkers(
  runtime: Runtime,
  deps: WorkerDeps &
    IngestWorkerDeps & {
      /**
       * The process logger, normally Fastify's `app.log` from `index.ts`.
       * Falls back to `rootLogger` so a caller that forgets it (which is
       * exactly what happened — `startWorkers()` was called bare) loses
       * request-scoped bindings, not visibility.
       */
      logger?: FleetLogger;
      sweeper?: SweepDeps;
      reaper?: ReaperDeps;
    } = {},
): Promise<{ stop: () => Promise<void> }> {
  const handles: StopHandle[] = [];
  const log = deps.logger ?? rootLogger;

  const gen = await startGenerationWorker({
    connection: runtime.redis,
    cancelBus: runtime.cancelBus,
    ...deps,
  });
  handles.push({ stop: gen.stop });

  const ingest = await startIngestWorker({
    connection: runtime.redis,
    ...(deps.db ? { db: deps.db } : {}),
    ...(deps.embedder ? { embedder: deps.embedder } : {}),
  });
  handles.push({ stop: ingest.stop });

  // Callback retry sweeper. Recovers `callback_deliveries` rows whose
  // in-process retry timer died with a previous process — without it a
  // restart mid-schedule loses the delivery silently and forever. Defaults
  // ON; `CALLBACK_SWEEP_ENABLED=false` is an incident escape hatch only.
  if (sweeperEnabled()) {
    const sweeper = startCallbackSweeper({
      ...(deps.db ? { db: deps.db } : {}),
      // `component` makes the sweeper's lines filterable in Coolify without
      // grepping message text. An explicit `deps.sweeper.logger` still wins.
      logger: log.child({ component: 'callback-sweeper' }),
      ...deps.sweeper,
    });
    handles.push({ stop: sweeper.stop });
  } else {
    // An escape hatch that disables a durability mechanism must announce
    // itself. Otherwise `CALLBACK_SWEEP_ENABLED=false` left set after an
    // incident looks identical, in the log, to a sweeper that is running.
    log.warn(
      { reason: 'CALLBACK_SWEEP_ENABLED' },
      'callback sweeper: DISABLED by env — stranded callback deliveries will NOT be recovered',
    );
  }

  // Lost-worker reaper. A job whose worker was SIGKILLed leaves its row at
  // 'running' forever and its parent request never goes terminal — the
  // consumer is never told and the reserve is never released. BullMQ's
  // redelivery covers the common case inside the worker itself; this covers
  // the rows no redelivery ever arrives for. Defaults ON;
  // `WORKER_REAP_ENABLED=false` is an incident escape hatch only.
  if (reaperEnabled()) {
    const reaper = startJobReaper({
      ...(deps.db ? { db: deps.db } : {}),
      ...(deps.bus ? { bus: deps.bus } : {}),
      ...deps.reaper,
    });
    handles.push({ stop: reaper.stop });
  }

  return {
    stop: async () => {
      await Promise.allSettled(handles.map((h) => h.stop()));
    },
  };
}
