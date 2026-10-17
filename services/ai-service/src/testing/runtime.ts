// TEST-ONLY. Excluded from `tsconfig.build.json`; nothing under `src/` outside
// `*.test.ts` may import this file.
//
// The in-service MOCK_* providers were removed. The fake model
// provider tests use lives OUTSIDE `src/`, in `test-support/fake-provider/`.

import { loadConfig, type Config } from '../config/config.js';
import { createRuntime, type Runtime } from '../runtime.js';
import { resetSharedProviderResilience } from '../services/ai/router/resilience.js';

export interface TestRuntimeOptions {
  config?: Partial<Config>;
  /** Force real BullMQ queues (the integration lane, which has a Redis). */
  mockQueues?: boolean;
  redis?: Runtime['redis'];
}

/**
 * An isolated Runtime for one test file. Replaces the old
 * `_resetQueuesForTests()` / `resetCancelBusForTests()` dance: instead of
 * clearing module-scope state between cases, each test owns its own value.
 *
 * 🔴 ALSO DROPS THE PROCESS-WIDE CIRCUIT BREAKER. `getSharedProviderResilience`
 * (`services/ai/router/resilience.ts`) memoises ONE breaker per process, on
 * purpose — a breaker built per call counts to five alone and never opens. It
 * has no other reset caller, so its accumulated failure count is whatever the
 * last test that provoked a provider error left behind. Within a file that is
 * still shared, but a test that builds a runtime now starts from a CLOSED
 * breaker rather than inheriting an open one from an earlier case. Across
 * files, isolation comes from vitest's per-file module registry — see the
 * warning in `vitest.config.ts` about `isolate: false`.
 */
export function createTestRuntime(opts: TestRuntimeOptions = {}): Runtime {
  resetSharedProviderResilience();
  const config: Config = { ...loadConfig(), ...opts.config };
  return createRuntime(config, {
    ...(opts.mockQueues === undefined ? {} : { mockQueues: opts.mockQueues }),
    ...(opts.redis ? { redis: opts.redis } : {}),
  });
}
