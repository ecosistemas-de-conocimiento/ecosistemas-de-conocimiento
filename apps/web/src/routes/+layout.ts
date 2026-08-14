// Disable SSR for the whole app — the chat is fully client-interactive
// (localStorage state, no SEO surface). Skipping SSR avoids hydration
// mismatches between server (empty default state) and client (populated
// from localStorage).
export const ssr = false;
export const prerender = false;
