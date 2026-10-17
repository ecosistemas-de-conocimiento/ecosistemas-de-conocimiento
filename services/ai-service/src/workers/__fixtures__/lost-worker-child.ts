// A worker process that is MEANT to be SIGKILLed mid-job.
//
// The lost-worker defect cannot be reproduced inside the test process: the
// failure IS the process disappearing between the claim and the terminal
// write, and a `vi.fn()` that returns early leaves the event loop, the BullMQ
// lock renewal and the DB connection all alive. So the repro forks a real
// worker, lets it claim a real row, and `kill -9`s it.
//
// The processor blocks forever on the LLM / embedder call, which is AFTER the
// row is claimed and (for generation) AFTER the router has taken its budget
// reserve — exactly the window a production SIGKILL lands in.
//
// Started by `src/workers/worker-lost.integration.test.ts` via `tsx`, with the
// tenant coordinates and the queue's connection details in the environment.
// It prints nothing and never exits on its own.

import { Redis } from 'ioredis';

import { createRouter } from '../../services/ai/router/router.js';
import { BudgetEnforcer } from '../../services/budget/enforcer.js';
import { TraceWriter } from '../../services/ai/router/trace-writer.js';
import { startGenerationWorker } from '../generation.worker.js';
import { startIngestWorker } from '../ingest.worker.js';
import type { CancelBus } from '../../services/generation/cancel-bus.js';
import type { callOpenRouter } from '../../services/ai/router/adapters/openrouter.js';
import type { callOpenRouterEmbedding } from '../../services/ai/embeddings/openrouter.js';

/** Never resolves. The process is killed while this is pending. */
const hang = (): Promise<never> => new Promise<never>(() => {});

/** The real bus would open two more Redis connections; this test is not about it. */
function noopCancelBus(): CancelBus {
  return {
    start: async () => {},
    publish: async () => {},
    onCancel: () => () => {},
    stop: async () => {},
  };
}

const runtime = {
  lockDuration: Number(process.env.CHILD_LOCK_DURATION_MS ?? 700),
  stalledInterval: Number(process.env.CHILD_STALLED_INTERVAL_MS ?? 300),
  maxStalledCount: 1,
};

const { db } = await import('../../db/client.js');

// The workers take their BullMQ connection as a value now (it used to be the
// module-scope `redisConnection`). This child is its own process, so it builds
// its own — same URL the parent test hands it in the environment.
const connection = new Redis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

if (process.env.CHILD_MODE === 'ingest') {
  await startIngestWorker({
    connection,
    db,
    embedder: (async () => hang()) as unknown as typeof callOpenRouterEmbedding,
    runtime,
    concurrency: 1,
  });
} else {
  await startGenerationWorker({
    connection,
    db,
    router: createRouter({
      budget: new BudgetEnforcer(db),
      traceWriter: new TraceWriter(db),
      adapter: (async () => hang()) as unknown as typeof callOpenRouter,
    }),
    runtime,
    concurrency: 1,
    cancelBus: noopCancelBus(),
  });
}

// Hold the process open. Nothing here ever completes a job.
setInterval(() => {}, 1_000);
