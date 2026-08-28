import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { dev } from '$app/environment';
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  authErrorMessage,
  registerWithBackend,
} from '$lib/server/auth';

interface Body {
  email?: string;
  password?: string;
  displayName?: string;
}

export const POST: RequestHandler = async ({ request, cookies }) => {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return json({ error: authErrorMessage('bad-request') }, { status: 400 });
  }
  const email = (body.email ?? '').trim();
  const password = body.password ?? '';
  const displayName =
    (body.displayName ?? '').trim() || email.split('@')[0] || email;

  if (!email || !password) {
    return json({ error: authErrorMessage('missing-fields') }, { status: 400 });
  }
  if (password.length < 8) {
    return json({ error: authErrorMessage('password-too-short') }, { status: 400 });
  }

  const result = await registerWithBackend(email, password, displayName);
  if (!result.ok || !result.token || !result.user) {
    const failure = result.failure ?? 'register-failed';
    // Same split as the login route: Payload's English (or a raw `fetch
    // failed`) is logged, never returned.
    console.warn(`[auth] register failed (${failure}): ${result.detail ?? 'sin detalle'}`);
    const status = failure === 'unreachable' || failure === 'server' ? 503 : 400;
    return json({ error: authErrorMessage(failure) }, { status });
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
