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
    },
  },
  test: {
    // BFF route handlers and pure helpers run under node — no DOM needed.
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['node_modules/**', 'build/**', '.svelte-kit/**'],
  },
});
