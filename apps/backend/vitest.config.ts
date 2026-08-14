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
  },
})
