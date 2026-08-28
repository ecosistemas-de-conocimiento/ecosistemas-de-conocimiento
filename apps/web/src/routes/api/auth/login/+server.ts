import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { dev } from '$app/environment';
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  authErrorMessage,
  loginWithBackend,
} from '$lib/server/auth';

interface Body {
  email?: string;
  password?: string;
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
  if (!email || !password) {
    return json({ error: authErrorMessage('missing-fields') }, { status: 400 });
  }

  const result = await loginWithBackend(email, password);
  if (!result.ok || !result.token || !result.user) {
    const failure = result.failure ?? 'login-failed';
    // 🔴 The split: the technical detail goes to the LOG, the Spanish sentence
    // goes to the screen. `detail` holds Payload's English or a raw
    // `fetch failed`; neither is ever put in the response body.
    console.warn(`[auth] login failed (${failure}): ${result.detail ?? 'sin detalle'}`);
    // An unreachable or broken backend is not the user's fault, so it must not
    // answer 401 — that reads as "wrong password" to every caller.
    const status = failure === 'unreachable' || failure === 'server' ? 503 : 401;
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
