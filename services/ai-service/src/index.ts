import { env, validateCallbackSecrets, validateProductionReadiness } from './config/env.js';
import { closeDb } from './db/client.js';
import { closeRedis } from './queue/connection.js';
import { buildServer } from './server.js';
import { startWorkers } from './workers/index.js';

async function main() {
  // Fail loud at boot, not at first LLM call. In production a missing
  // OPENROUTER_API_KEY exits before the HTTP listener binds. See
  // `validateProductionReadiness` in `config/env.ts` and decisions §5.
  validateProductionReadiness();
  // Warn (don't crash) about app-role keys missing `callbackSecret` — without
  // it, ai-service can record but cannot sign callbacks for these keys, and
  // the receiver will reject as a signature mismatch.
  validateCallbackSecrets();

  const app = await buildServer();

  let workers: { stop: () => Promise<void> } | null = null;

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    try {
      if (workers) await workers.stop().catch(() => undefined);
      await app.close();
      await Promise.allSettled([closeDb(), closeRedis()]);
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: env.PORT, host: env.HOST });

  // In-process worker boot. Decisions §8: same Node process, same image.
  // Fail-fast: let startup errors propagate so the process exits non-zero
  // and the orchestrator restarts the container, instead of serving HTTP with no
  // worker draining the queue.
  workers = await startWorkers();
  app.log.info('workers started ok');
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
