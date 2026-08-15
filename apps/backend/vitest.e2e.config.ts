import { defineConfig } from 'vitest/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * THE END-TO-END SUITE. A SEPARATE CONFIG ON PURPOSE.
 *
 * ⚠ `vitest.config.ts` (the unit suite) includes `src/**` only, and this one
 * includes `e2e/**` only. They cannot overlap, which is the point: `pnpm --filter
 * @edc/backend test` must stay fast, hermetic and green on a laptop with nothing
 * running. Everything slow, networked and stateful lives here.
 *
 * ⚠ SINGLE FORK, NO PARALLELISM. Every file provisions organizations, users and
 * memberships in ONE shared Postgres, and the identity endpoints are rate-limited
 * per user (30/min on `/token`, 60/min on `/me`). Running files concurrently
 * would make those limits — and the ordering of a publish state machine — a
 * source of flakes rather than signal.
 *
 * ⚠ LONG TIMEOUTS BELONG HERE. Transcription runs at roughly real time and an
 * ingest round-trip crosses two services and a webhook.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(dirname, 'src'),
    },
  },
  test: {
    environment: 'node',
    include: ['e2e/**/*.e2e.ts'],
    exclude: ['node_modules/**', '.next/**'],
    // Generous by default; the audio spec asks for more still.
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    // A failure here is a bug report about the live stack, so print every name.
    reporters: ['verbose'],
  },
})
