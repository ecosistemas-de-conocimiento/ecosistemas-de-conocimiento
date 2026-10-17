import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Two test layers, both in plain Node:
//   - src/core: backend-agnostic unit tests (no compile step needed).
//   - src/svelte: SSR tests. vitest transforms modules through vite's SSR
//     pipeline under `environment: 'node'`, so the svelte plugin compiles each
//     component to its server render form and `render()` from 'svelte/server'
//     exercises the real template output — no DOM required. Interactive
//     behavior stays validated via the consumers' Playwright suites.
export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: {
      // The .svelte sources import the package's own public entry
      // (`@edc/chat-engine/core`); tests run from source, so resolve
      // it to src/core directly instead of a built dist/.
      '@edc/chat-engine/core': path.resolve(dirname, 'src/core/index.ts'),
    },
  },
  test: {
    include: ['src/core/**/*.test.ts', 'src/svelte/**/*.test.ts'],
    environment: 'node',
  },
});
