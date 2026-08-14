import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  // vitePreprocess gives us `lang="ts"` support inside .svelte files when
  // svelte-package compiles the `./svelte` library output.
  preprocess: vitePreprocess(),
};

export default config;
