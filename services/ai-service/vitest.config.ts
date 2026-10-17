import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // 🔴 Do NOT add `isolate: false`, however loudly vitest's footer advertises
    // it as the faster option. This suite's per-file isolation is not a
    // preference, it is the ONLY thing keeping process-wide state from leaking
    // between files. The concrete one: `getSharedProviderResilience()`
    // (`src/services/ai/router/resilience.ts`) memoises a SINGLE circuit
    // breaker in a module-scope `let`, deliberately — a per-call breaker counts
    // to five alone and never opens. `pool: 'forks'` + `isolate: true`
    // (vitest's defaults, relied on here) give each file a fresh module
    // registry and therefore a fresh breaker. Turn isolation off and one file's
    // provoked provider failures carry into the next file's first request, as
    // an OPEN breaker and a `provider_unavailable` that has nothing to do with
    // the test that reports it. `createTestRuntime()` calls
    // `resetSharedProviderResilience()` for the same reason WITHIN a file.
    // The same warning is on `vitest.integration.config.ts`.
    isolate: true,
    // vitest's default, written down so nobody flips it: a run that finds no
    // test file must exit non-zero. CI's exit-code gate depends on it.
    passWithNoTests: false,
    // Service sources only. The typed client (`@edc/ai-client`) used to be
    // nested under this package and was included here; it now lives at the
    // repo-root `packages/ai-client` and owns its own vitest run.
    //
    // ⚠ Keep that run wired up. When the client's tests were nested here they
    // sat OUTSIDE this glob for a long time and never executed — not in CI, not
    // locally. One of them asserted an export that a published build was
    // missing, which silently degraded a consumer's RAG for days behind a
    // generic "AI unavailable". A test outside the glob is documentation, not
    // a gate.
    include: ['src/**/*.test.ts'],
    // Most unit tests (router, validators, registry) need no DB/Redis.
    // Integration tests that hit real Postgres+Redis live in
    // `**/*.integration.test.ts` and run via `pnpm run test:integration`
    // (vitest.integration.config.ts). Exclude them here so `pnpm test` keeps
    // its zero-dependency contract.
    exclude: ['**/*.integration.test.ts', '**/node_modules/**', '**/dist/**'],
    // ⚠ `testTimeout` stays at vitest's strict 5 s default ON PURPOSE. A test
    // that needs longer than that is telling you something, and raising the
    // limit would only hide it.
    //
    // `hookTimeout` is the one that gets a real budget. The expensive work in
    // this suite is one-time SETUP, not the tests: importing `src/server.ts`
    // pulls in the whole route + service module graph (~3 s of transform on a
    // cold worker) and the two docker-backed suites pull a Postgres container
    // up. That used to be paid inside the first TEST of each file, which is
    // why `pnpm -r test` produced a different failure on every run, always at
    // almost exactly 5000 ms — see `TESTING.md`. The setup now lives in
    // `beforeAll` (`src/test/server-harness.ts`), so it needs headroom on the
    // hook clock for a machine running six workspaces at once.
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://localhost:5432/ai_service_test',
      REDIS_URL: 'redis://localhost:6379',
      API_KEYS: '{"test-key":{"org":"test-org","project":"test-project"}}',
      LOG_LEVEL: 'silent',
    },
  },
});
