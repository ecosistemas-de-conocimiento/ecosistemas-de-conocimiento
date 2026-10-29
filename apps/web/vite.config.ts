import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    // The dev-server port, declared once for both host and container. Vite has
    // no built-in PORT support, so read it here; Dockerfile.dev sets PORT
    // rather than passing `--port`, which would override this file silently.
    port: Number(process.env.PORT) || 5173,
    // In-container HMR across a bind mount: opt into polling when running the
    // docker dev image (Dockerfile.dev sets CHOKIDAR_USEPOLLING=true). No
    // effect on a host-native `pnpm dev`.
    watch: {
      usePolling: process.env.CHOKIDAR_USEPOLLING === 'true',
      // 🔴 NEVER WATCH PLAYWRIGHT'S OWN OUTPUT. `playwright.config.ts` writes
      // videos, traces and screenshots into `e2e/.artifacts` — inside this
      // package, so Vite's watcher sees them. Trace resources are `.html`,
      // which Vite cannot hot-replace, so each one it noticed triggered a FULL
      // PAGE RELOAD of the browser the test was driving. That corrupts the run
      // (and, worse, silently hid the sign-in hydration bug, because a reload
      // is exactly the manual workaround for it). Only bites when a dev server
      // and `test:e2e` run together — which is the documented headed-debug
      // workflow, so it bites at the worst moment.
      ignored: ['**/e2e/.artifacts/**', '**/e2e/.report/**'],
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          // BFF route handlers and pure helpers run under node — no DOM needed.
          name: 'node',
          environment: 'node',
          include: ['src/**/*.{test,spec}.ts'],
          exclude: ['node_modules/**', 'build/**', '.svelte-kit/**', 'src/**/*.dom.test.ts'],
        },
      },
      {
        extends: true,
        // `*.dom.test.ts`: components MOUNTED in a DOM (jsdom), for what
        // only renders on the client — `Markdown.svelte` renders '' on the
        // server because DOMPurify needs `window`. The browser condition makes
        // `svelte` resolve to its client build, so `mount` exists.
        resolve: { conditions: ['browser'] },
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['src/**/*.dom.test.ts'],
        },
      },
    ],
  },
});
