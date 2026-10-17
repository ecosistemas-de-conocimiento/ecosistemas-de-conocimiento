// 🔴 FIRST IMPORT, DELIBERATELY. `./telemetry/bootstrap.js` starts (or, with
// `OTEL_EXPORTER_OTLP_ENDPOINT` unset, does not start) the OpenTelemetry SDK
// with a top-level `await`. ES module bodies evaluate in import order, so this
// is the only position from which the SDK can patch `ioredis`, `pino` and
// `fastify` before the imports below pull them in. Sorting it into
// alphabetical order with the rest silently produces a running exporter with
// no auto-instrumentation attached.
import './telemetry/bootstrap.js';

import { loadConfig } from './config/config.js';
import {
  validateCallbackSecrets,
  validateProductionReadiness,
  warnIfCallbackGuardRelaxed,
  warnOnExpiringApiKeys,
} from './config/env.js';
import { closeDb } from './db/client.js';
import { createRuntime } from './runtime.js';
import { buildServer } from './server.js';
import { shutdownGraceMs } from './services/jobs/shutdown.js';
import { getTelemetryHandle } from './telemetry/otel.js';
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
  // Warn (don't crash) when the callback SSRF guard has been relaxed for a local
  // docker network — the switch is legitimate in the local stack and a defect
  // anywhere it is deployed, so make it visible in the boot log.
  warnIfCallbackGuardRelaxed();
  // Warn (don't crash) about API keys that have expired or expire within a
  // week. An expired key is rejected per-request in `requireAuth`; taking the
  // whole service down for every other tenant would be the worse failure.
  warnOnExpiringApiKeys();

  // 🔴 THE ONLY `loadConfig()` ON THE PRODUCTION PATH, AND THE ONLY
  // `createRuntime()`. Everything below is handed the value; nothing under
  // `src/` reaches for a module-scope client or queue. See `src/runtime.ts`.
  const config = loadConfig();
  const runtime = createRuntime(config);

  const app = await buildServer(runtime);

  let workers: { stop: () => Promise<void> } | null = null;

  // ── COOPERATIVE SHUTDOWN ────────────────────────────────────────────────
  //
  // `workers.stop()` is NOT a plain `worker.close()` any more. It stops the
  // fetch, gives the in-flight jobs `SHUTDOWN_GRACE_MS` to finish, and then
  // aborts the survivors so each ends as a NAMED terminal job with its partial
  // cost billed, its parent rolled up and its callback fired — instead of
  // being SIGKILLed at `running` for the reaper to find later. The mechanism
  // and the reasoning live in `services/jobs/shutdown.ts`.
  //
  // ── WHAT THE GRACE BOUNDS ────────────────────────────────────────────────
  //
  // THREE things, and it is worth spelling out because for a while it bounded
  // only the first and the docstrings said otherwise:
  //
  //   1. BullMQ GENERATION jobs — `startGenerationWorker`'s in-flight map.
  //   2. BullMQ INGEST jobs — the same seam in `startIngestWorker`.
  //   3. HTTP generations on `/v1/generate/sync` and `/v1/generate/stream`, via
  //      `runtime.abortShutdown()` below. MEASURED before that existed: a
  //      SIGTERM during a stream with a 2 s grace let the response complete
  //      normally 25 s later, because `app.close()` waits for in-flight
  //      requests and it runs AFTER the grace has elapsed.
  //
  // THE HONEST EXIT BOUND is `SHUTDOWN_GRACE_MS + SHUTDOWN_SETTLE_MS` (5 s).
  // It is not "the process exits in the grace": past the grace every survivor
  // gets a bounded settle window to write its terminal row, and the final
  // `await worker.close()` is itself raced against the grace so a provider that
  // ignores its AbortSignal cannot extend the promise.
  //
  // 🔴 THE PLATFORM'S STOP TIMEOUT MUST EXCEED THAT SUM, not just the grace, or
  // the SIGKILL lands mid-settle and none of the above happens. Docker's
  // default is 10 s and an image cannot raise its own. See the Dockerfile's
  // `STOPSIGNAL` block and `stop_grace_period` in docker-compose.yml.
  //
  // ⚠ WORKERS BEFORE `app.close()`, deliberately. An in-flight job settling
  // during the grace still needs the database and Redis; closing the HTTP
  // server first would only stop accepting new requests, which the platform
  // has already stopped routing by the time it signals.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    // A second SIGTERM (an impatient operator, or a platform that re-sends)
    // must not start a second drain: the two would race on `app.close()` and
    // on the same job rows, and the first `process.exit(0)` would cut the
    // other's rollup off half-written.
    if (shuttingDown) {
      app.log.warn({ signal }, 'shutdown already in progress; ignoring');
      return;
    }
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    // ⚠ ARMED HERE, NOT AFTER `workers.stop()`. `stop()` consumes the whole
    // grace itself (and then a settle window on top), so arming the HTTP
    // deadline behind it would make the HTTP bound `grace + settle + grace`.
    // Both halves of the shutdown are timed from the SIGNAL, in parallel.
    const graceMs = shutdownGraceMs();
    const httpGrace = setTimeout(() => {
      app.log.warn(
        { graceMs },
        'shutdown grace expired; aborting in-flight HTTP generations',
      );
      runtime.abortShutdown();
    }, graceMs);
    // The timer must never be the reason the loop stays alive — if everything
    // else has drained we want to exit, not sit out the rest of the window.
    httpGrace.unref?.();
    try {
      if (workers) await workers.stop().catch(() => undefined);
      // By the time this runs the grace has usually already expired inside
      // `workers.stop()`, so any in-flight HTTP generation has been aborted and
      // `close()` returns promptly. On an HTTP-only pod (no in-flight jobs)
      // `stop()` returns at once and the timer above is what bounds this.
      await app.close();
      await Promise.allSettled([closeDb(), runtime.close()]);
      // Flush whatever the batch span processor is still holding, so the last
      // requests before a redeploy are not the ones missing from the trace.
      // `null` (telemetry off) is the normal case and costs nothing.
      await getTelemetryHandle()?.shutdown();
    } finally {
      clearTimeout(httpGrace);
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.PORT, host: config.HOST });

  // In-process worker boot. Decisions §8: same Node process, same image.
  // Fail-fast: let startup errors propagate so the process exits non-zero
  // and the orchestrator restarts the container, instead of serving HTTP with no
  // worker draining the queue.
  //
  // `app.log` is passed explicitly so worker and sweeper lines land in the
  // same pino stream, at the same level, as request lines. This used to be a
  // bare `startWorkers()`, which left the callback sweeper with no logger at
  // all — including for its own 'sweep failed' error. The components now
  // fall back to `rootLogger` if this argument is ever dropped again, so
  // this line is a formatting improvement, not the thing holding the
  // guarantee up. See `src/logger.ts`.
  workers = await startWorkers(runtime, { logger: app.log });
  app.log.info('workers started ok');
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
