// Smoke-test vitest config — kept separate from the unit + integration
// configs so the unit `include` filter (`src/**/*.test.ts`) does not need to
// be widened to pick up `scripts/smoke.spec.ts`.
//
// The smoke spec is gated by `describe.skipIf(...)` on AI_SERVICE_URL +
// AI_SERVICE_SMOKE_TOKEN being set, so running this config with no env
// produces a clean "skipped" report. With env, it exercises a live deploy
// over real HTTP.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/smoke.spec.ts'],
    // Real network + a real LLM call inside step 4 — be generous.
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
