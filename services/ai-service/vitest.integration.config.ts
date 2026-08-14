// Integration test config — separate from the default `vitest.config.ts` so
// `pnpm test` keeps running the cheap, no-DB unit suite while `pnpm run
// test:integration` exercises the real-Postgres surface.
//
// What's different from the unit config:
//   - `include` matches `**/*.integration.test.ts` only.
//   - `testTimeout` bumps to 30 s — real DB ops + migration runner.
//   - `setupFiles` points at `./src/test/integration-setup.ts`, which asserts
//     Postgres reachability, runs migrations, and installs `beforeEach`
//     truncate.
//   - `env.DATABASE_URL` is left blank here — `integration-setup.ts` does the
//     env rebind so process.env mutations stay near the assertion that
//     depends on them.
//   - `fileParallelism: false` + a single fork: ALL integration files share
//     ONE Postgres and a GLOBAL `beforeEach` truncate. Running files in
//     parallel lets one file's truncate wipe another file's mid-test rows
//     (e.g. the cost-rollup test's request row vanishing under the generate
//     test's truncate). Serial execution makes the shared-DB suite correct.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    setupFiles: ['./src/test/integration-setup.ts'],
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      // DATABASE_URL / REDIS_URL are set in the setup file from TEST_*. We
      // populate API_KEYS here with a default that individual tests can
      // override BEFORE `buildServer()` import.
      API_KEYS:
        '{"dev-key-app":{"org":"demo","project":"demo","role":"app"},"dev-key-admin":{"org":"demo","project":"demo","role":"admin"}}',
    },
  },
});
