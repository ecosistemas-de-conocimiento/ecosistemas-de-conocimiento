import { defineConfig } from 'vitest/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(dirname, 'src'),
      // Mirrors the tsconfig path. Tests that touch a Next route importing
      // `@payload-config` always `vi.mock` it, so the real config (and its
      // postgres adapter) is never constructed — the alias only exists so the
      // specifier RESOLVES and vitest can substitute the mock.
      '@payload-config': path.resolve(dirname, 'src/payload.config.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['node_modules/**', '.next/**'],
    // 🔴 No janitor arms in a test unless the test asks (`vitest.setup.ts`).
    setupFiles: ['./vitest.setup.ts'],
    /**
     * ⚠ `testTimeout` IS LEFT AT THE STRICT 5 s DEFAULT, DELIBERATELY. A slow
     * TEST should still fail — that is the signal the default exists to give,
     * and raising it is how a suite quietly becomes a suite nobody trusts.
     *
     * 🔴 What must NOT be charged to one test is a slow ONE-TIME SETUP shared by
     * a whole file. `payload.config.storage.test.ts` builds the real Payload
     * config — ~3.8 s of module-graph transform, unloaded — and while it did
     * that inside a test body it failed at almost exactly 5000 ms on every busy
     * or parallel run. That single test was the only reason the root `pnpm test`
     * had to stay sequential. The build moved into a `beforeAll`; this is the
     * budget that setup gets. Note it is a HOOK budget: no test gains an
     * inch of slack from it.
     */
    hookTimeout: 30_000,
  },
})
