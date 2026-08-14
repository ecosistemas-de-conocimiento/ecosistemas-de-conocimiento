import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { dev } from '$app/environment';
import { SESSION_COOKIE, SESSION_TTL_SECONDS, loginWithBackend } from '$lib/server/auth';

interface Body {
  email?: string;
  password?: string;
}

export const POST: RequestHandler = async ({ request, cookies }) => {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const email = (body.email ?? '').trim();
  const password = body.password ?? '';
  if (!email || !password) {
    return json({ error: 'Email and password required' }, { status: 400 });
  }

  const result = await loginWithBackend(email, password);
  if (!result.ok || !result.token || !result.user) {
    return json({ error: result.error ?? 'Login failed' }, { status: 401 });
  }

  cookies.set(SESSION_COOKIE, result.token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: !dev,
    maxAge: SESSION_TTL_SECONDS,
  });

  return json({ user: result.user });
};
