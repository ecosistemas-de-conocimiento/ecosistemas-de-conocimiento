// Render the sign-in form on the initial HTML so it works even without JS.
// Parent layout disables SSR for the chat UI; the auth pages opt back in.
export const ssr = true;
export const prerender = false;
