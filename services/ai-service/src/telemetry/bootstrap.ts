// Side-effect module: starts OpenTelemetry (or does nothing) BEFORE anything
// else in the process is imported.
//
// 🔴 `src/index.ts` imports this FIRST, and the order is load-bearing. ES
// module bodies evaluate in import order, and the top-level `await` below
// blocks that evaluation, so the SDK — and therefore the module patching every
// auto-instrumentation depends on — is in place before `./config/env.js`,
// `./server.js` and the workers pull in `ioredis`, `pino` and `fastify`.
// Move this import down the list and the instrumentations silently attach to
// nothing: no error, no spans, no way to tell from the outside.
import { startTelemetry } from './otel.js';

const started = await startTelemetry();

if (started) {
  // Deliberately `console`, not the app logger: the logger does not exist yet
  // (it is created inside `buildServer`), and an operator who set the endpoint
  // needs one line confirming the process agreed.
  console.log(`[otel] tracing enabled → ${started.endpoint}`);
}
