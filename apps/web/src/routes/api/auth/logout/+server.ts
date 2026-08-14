import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { SESSION_COOKIE, backendFetch } from '$lib/server/auth';

export const POST: RequestHandler = async ({ cookies, locals }) => {
  // Best-effort invalidation on the backend; ignore failure since the cookie
  // clear below is the load-bearing step from the user's POV.
  try {
    await backendFetch(locals.token, '/api/users/logout', { method: 'POST' });
  } catch {
    /* noop */
  }
  cookies.delete(SESSION_COOKIE, { path: '/' });
  return json({ ok: true });
};
