// Load `src/server.ts` ONCE per test file, in `beforeAll`.
//
// 🔴 The bug this exists to kill
//
// Every route test used to build its Fastify app like this:
//
//     async function makeApp() {
//       const { buildServer } = await import('../server.js');   // ← 3 s, once
//       return buildServer();                                    // ← ~40 ms
//     }
//
// The dynamic import is what keeps env validation running against the test env,
// so it has to stay lazy. But `server.js` drags in the whole route + service
// module graph, and vitest transforms that graph on first import — around 3 s
// on a cold worker. Because the import sat inside `makeApp()`, the FIRST TEST
// IN THE FILE paid all 3 s, against vitest's 5 s per-test timeout.
//
// That left roughly 1.5 s of headroom. `pnpm -r test` runs six workspaces at
// once; on a loaded 16-core box the transform stretches past 5 s and vitest
// fails the test for LATENESS, not for being wrong. A different test failed on
// every run, always at almost exactly 5000 ms, and the whole suite was made
// sequential as a stopgap (see `TESTING.md`).
//
// Hoisting the import into `beforeAll` fixes the cause rather than the symptom:
// the cost is paid once per FILE instead of once per test, and it is paid on
// the hook clock — which `vitest.config.ts` gives a realistic budget — instead
// of on the per-test clock, which stays at a strict 5 s so a genuinely slow
// TEST is still caught.
//
// `buildServer()` itself stays per-test. It is cheap, and several suites depend
// on a fresh instance (`@fastify/rate-limit` keeps its counters on the Fastify
// instance, and several files mutate module-level stubs between tests).

import type { FastifyInstance } from 'fastify';
import { beforeAll } from 'vitest';

/**
 * Call at the TOP LEVEL of a test file. Registers a `beforeAll` that imports
 * `../server.js`, and returns a `makeApp()` you can call from any test body.
 *
 * ⚠ Must be called at top level, not inside a test — it registers a hook.
 */
export function useBuildServer(): () => Promise<FastifyInstance> {
  let buildServer: (() => Promise<FastifyInstance>) | undefined;

  beforeAll(async () => {
    ({ buildServer } = await import('../server.js'));
  });

  return () => {
    if (!buildServer) {
      throw new Error(
        'useBuildServer(): server.js has not loaded. Call useBuildServer() at the ' +
          'top level of the test file so its beforeAll hook is registered.',
      );
    }
    return buildServer();
  };
}

/**
 * For files that deliberately `vi.resetModules()` before each build (so they
 * get a fresh in-memory rate-limit store, for example). Resetting the registry
 * means the import cannot be shared, so instead we simply WARM it in
 * `beforeAll` — the expensive transform then happens off the per-test clock and
 * later re-imports only re-evaluate.
 */
export function warmServerModule(): void {
  beforeAll(async () => {
    await import('../server.js');
  });
}
