import { defineConfig } from 'vitest/config';

// Core-only unit tests. The svelte/ layer is validated via the consumer's
// build + Playwright (it needs a DOM/Svelte runtime); here we exercise the
// backend-agnostic core in plain Node.
export default defineConfig({
  test: {
    include: ['src/core/**/*.test.ts'],
    environment: 'node',
  },
});
