// Boot all in-process workers. Called from `src/index.ts` after the Fastify
// server starts listening.
//
// M3: generation worker. M4: + ingest worker (chunks + embeds documents).

import { startGenerationWorker, type WorkerDeps } from './generation.worker.js';
import { startIngestWorker, type IngestWorkerDeps } from './ingest.worker.js';

export type { WorkerDeps } from './generation.worker.js';
export type { IngestWorkerDeps } from './ingest.worker.js';

interface StopHandle {
  stop: () => Promise<void>;
}

export async function startWorkers(
  deps: WorkerDeps & IngestWorkerDeps = {},
): Promise<{ stop: () => Promise<void> }> {
  const handles: StopHandle[] = [];

  const gen = await startGenerationWorker(deps);
  handles.push({ stop: gen.stop });

  const ingest = await startIngestWorker({
    ...(deps.db ? { db: deps.db } : {}),
    ...(deps.embedder ? { embedder: deps.embedder } : {}),
  });
  handles.push({ stop: ingest.stop });

  return {
    stop: async () => {
      await Promise.allSettled(handles.map((h) => h.stop()));
    },
  };
}
