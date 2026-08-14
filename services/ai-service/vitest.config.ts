import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
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
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://localhost:5432/ai_service_test',
      REDIS_URL: 'redis://localhost:6379',
      API_KEYS: '{"test-key":{"org":"test-org","project":"test-project"}}',
      LOG_LEVEL: 'silent',
    },
  },
});
