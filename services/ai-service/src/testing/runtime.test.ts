// `createTestRuntime()` must hand a test a CLOSED circuit breaker
// (review finding 7).
//
// `getSharedProviderResilience()` memoises ONE breaker per process, on purpose
// — a breaker constructed per call counts to five alone and never opens. The
// consequence for tests: its accumulated failure count is whatever the last
// case that provoked a provider error left behind, and nothing else in the
// tree calls `resetSharedProviderResilience()`. Cross-FILE isolation comes
// from vitest's per-file module registry (see the `isolate: false` warning in
// `vitest.config.ts`); WITHIN a file, this reset is it.
//
// Sabotage: delete the `resetSharedProviderResilience()` call from
// `createTestRuntime` → the identity assertion below RED.

import { describe, expect, it } from 'vitest';

import { getSharedProviderResilience } from '../services/ai/router/resilience.js';
import { createTestRuntime } from './runtime.js';

describe('createTestRuntime', () => {
  it('drops the process-wide breaker so each runtime starts clean', async () => {
    const before = getSharedProviderResilience();
    // Same object while nothing resets it — the memoisation this pins.
    expect(getSharedProviderResilience()).toBe(before);

    const runtime = createTestRuntime();
    try {
      expect(getSharedProviderResilience()).not.toBe(before);
    } finally {
      await runtime.close();
    }
  });
});
