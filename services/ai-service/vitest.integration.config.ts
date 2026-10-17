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
    // vitest's default, written down so nobody flips it: a run that finds no
    // test file must exit non-zero. CI's exit-code gate depends on it.
    passWithNoTests: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Container LIFETIME (start once, stop once). Must not live in
    // `setupFiles`: vitest re-executes those per test FILE, which starts a
    // fresh container per file and — because each start removes any container
    // of the same name — kills the one the previous file is still using.
    globalSetup: ['./src/test/integration-global-setup.ts'],
    setupFiles: ['./src/test/integration-setup.ts'],
    fileParallelism: false,
    pool: 'forks',
    // vitest 5 removed `poolOptions`. `maxWorkers: 1` alone: files run serially,
    // each in its OWN process.
    //
    // 🔴 Do NOT add `isolate: false` to "restore" `singleFork`. MEASURED:
    // one shared module registry makes the ESM cache hand
    // suite two suite one's already-initialised state, and 2 of 3 files failed on a
    // WRONG DATABASE guard — appearing as 27-81 SKIPPED of 86, because a suite that
    // dies at boot never registers its tests.
    //
    // The hazard the comment above describes is PARALLELISM, and `fileParallelism:
    // false` prevents that on its own — the single fork was never what made it safe.
    // ✅ RUN under vitest 5.0.0 in THIS package (
    // node 26.7.0): `npm run test:integration` exits 0, with identical counts on
    // 3 consecutive runs. The counts themselves are not written down here — they
    // move with every file added, and a stale number in a comment reads as a
    // gate while gating nothing. What matters is the SHAPE: every skip is
    // accounted for. The only skips are `real-embedder-eval`, gated by
    // `describe.skipIf(!isRealEmbedderEvalEnabled())` — and that file REGISTERS
    // its tests, which is how a deliberate gate is told apart from a file that
    // died at boot: a dead file registers ZERO. Count assertions, don't read the
    // summary line.
    //
    // Verified by breaking it on purpose — all three exit 1, none reported green:
    //   - a non-`_test` database name: refused in `globalSetup`, whole run aborts
    //     before any file loads.
    //   - a `_test`-NAMED database on a FOREIGN server: refused by the ownership
    //     check; the foreign database was re-inspected afterwards and was
    //     UNMODIFIED (no migration, no truncate).
    //   - a throw injected into `integration-setup.ts` (the per-worker path):
    //     EVERY file reported as FAILED, and `Tests no tests`.
    //
    // 🔴 THAT LAST ONE IS THE LOAD-BEARING RESULT. vitest 5 reports a per-worker
    // setup death as FAILED, not as skipped, so that false-green
    // signature (27-81 SKIPPED of 86, exit 0) does NOT occur in this package.
    //
    // Container lifetime measured too, by polling `docker ps` through a run:
    // exactly ONE pg and ONE redis container id for the whole run — one per FILE
    // would mean `globalSetup` had drifted into `setupFiles` — alive from the
    // 2nd second to the last file, with none surviving teardown.
    maxWorkers: 1,
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
