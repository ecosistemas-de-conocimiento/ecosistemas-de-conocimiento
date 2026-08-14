import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // Builds a Node server (run with `node build`), served on PORT (3000 in
    // the production image).
    adapter: adapter({ out: 'build' }),
  },
};

export default config;
