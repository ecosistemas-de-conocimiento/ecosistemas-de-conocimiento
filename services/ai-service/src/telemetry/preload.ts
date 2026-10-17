// THE PRODUCTION ENTRY POINT'S PRELUDE. Loaded via `node --import
// ./dist/telemetry/preload.js dist/index.js` — see the `start` script in
// package.json and the Dockerfile's CMD, which must agree (a test pins that).
//
// WHAT IT FIXES, AND WHY IT CANNOT BE DONE FROM INSIDE index.ts
// -------------------------------------------------------------
// `@opentelemetry/instrumentation-pino` (and `-ioredis`) work by patching the
// MODULE. Under plain ESM there is no module-load hook, so — measured on node
// 26.7.0 — they patch nothing: log lines carry NO `trace_id`, which is the
// entire reason the pino instrumentation is in the list. `otel.ts` says so out
// loud. The hook that gives ESM a load interception point has to be installed
// BEFORE the modules it will patch are loaded, and that is strictly earlier
// than any code inside `index.ts` can run:
//
//   ES module graphs are LOADED AND LINKED IN FULL before ANY of them is
//   EVALUATED. By the time `index.ts`'s first import (`./telemetry/bootstrap.js`)
//   executes its body, `pino`, `fastify` and `ioredis` are already loaded —
//   `bootstrap.ts`'s "first import, deliberately" ordering wins the EVALUATION
//   race, which is what makes the SDK's own start early enough, but no import
//   position can win a race that was already decided at LOAD time.
//
// `--import` is the only position that is earlier than the entry graph. This
// module therefore does both halves, in order: install the loader hook, then
// start the SDK, and only then does node load `dist/index.js`.
//
// GATED: NOTHING HAPPENS WITH `OTEL_EXPORTER_OTLP_ENDPOINT` UNSET.
// The `register()` call is behind the same single switch as the SDK itself, so
// the default deployment installs no loader hook, loads no
// `import-in-the-middle`, and pays no per-module resolve cost. "Telemetry off
// means nothing was started" (`otel.test.ts`) keeps its exact meaning with this
// flag present — it is asserted with the flag on the command line.
//
// ⚠ EXPECTED NOISE ON NODE 26: `DEP0205`. Node 26 deprecated `module.register()`
// in favour of `module.registerHooks()`, so a run with
// `OTEL_EXPORTER_OTLP_ENDPOINT` set prints, once, on stderr:
//
//   (node:NNN) [DEP0205] DeprecationWarning: module.register() is deprecated.
//   Use module.registerHooks() instead.
//
// It is a WARNING, not a failure: the API still works and the hook still
// installs, which is why `trace_id` still lands on log lines. It comes from
// this file's own `register()` call below, not from a dependency, and it does
// NOT appear with the endpoint unset (the call is behind the gate). Do not
// "fix" it by swapping in `registerHooks()` — that API takes SYNCHRONOUS hooks
// and `import-in-the-middle` supplies asynchronous ones; the swap is
// OpenTelemetry's to make upstream. Track it there, and expect this line in
// every node-26 boot log that has tracing on.
//
// `module.register()`, not `--experimental-loader=@opentelemetry/instrumentation/hook.mjs`:
// same hook (that file re-exports `import-in-the-middle/hook.mjs`, whose
// `initialize` export exists precisely for this API), but a stable node API, no
// ExperimentalWarning on stderr, and — the reason that matters here — it can be
// put behind an `if`. A loader flag cannot.
//
// 🔴 `index.ts` STILL IMPORTS `./telemetry/bootstrap.js` FIRST, and must keep
// doing so. `npm run dev` (tsx watch) and the test suites boot the app without
// this preload; `startTelemetry()` is idempotent, so on the production path the
// import below wins and `index.ts`'s is a no-op.

import { register } from 'node:module';

import { telemetryEnabled } from './config.js';

if (telemetryEnabled()) {
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
}

// AFTER the hook, ALWAYS. With telemetry off this resolves to a no-op start —
// the same one `index.ts` would have done — and loads no SDK.
await import('./bootstrap.js');
