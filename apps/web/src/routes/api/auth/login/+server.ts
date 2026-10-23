import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { dev } from '$app/environment';
import { authErrorMessage, signIn } from '$lib/server/auth';

interface Body {
  email?: unknown;
  password?: unknown;
}

export const POST: RequestHandler = async ({ request, cookies }) => {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return json({ error: authErrorMessage('bad-request') }, { status: 400 });
  }
  // Same helper as the `/sign-in` form action (the no-JS path).
  const result = await signIn(body?.email, body?.password, cookies, !dev);
  if (!result.ok) return json({ error: result.error }, { status: result.status });
  return json({ user: result.user });
};
