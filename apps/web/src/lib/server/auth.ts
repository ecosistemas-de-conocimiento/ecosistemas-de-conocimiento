// Server-only auth helpers. Lives under `$lib/server/` so SvelteKit refuses
// to bundle it into any client-reachable module — the backend bearer tokens
// stay server-side by construction.
//
// Each user has a real account in the backend (Payload `users` collection).
// The backend issues a JWT on `/api/users/login`; this app caches it under the
// `chat_auth` httpOnly cookie and round-trips it as an Authorization header on
// proxied calls.

import { env } from '$env/dynamic/private';

export const SESSION_COOKIE = 'chat_auth';
// Match Payload's default 2h JWT lifetime. The the backend response carries
// `exp` (unix seconds) but we keep the cookie alive a little longer so the
// browser doesn't drop it before the JWT itself expires.
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days; the backend will reject if JWT itself expires sooner.

export function backendUrl(): string {
  // The one place the backend's address is defaulted. Every environment other
  // than a bare host-side `pnpm dev` sets BACKEND_URL — docker to the
  // service-name form, deployed envs to the app's https host — so this literal
  // is the host-dev default only. See `.env.example`.
  const url = env.BACKEND_URL ?? 'http://localhost:3002';
  return url.replace(/\/$/, '');
}

export interface BackendUser {
  id: number | string;
  email: string;
  displayName?: string | null;
}

/**
 * Verify a session token against the backend `/api/users/me`. Returns the
 * user record on success, null on any failure (expired token, network error,
 * 401, malformed body).
 */
export async function fetchMe(token: string | undefined): Promise<BackendUser | null> {
  if (!token) return null;
  try {
    const res = await fetch(`${backendUrl()}/api/users/me`, {
      headers: { Authorization: `JWT ${token}` },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { user?: BackendUser | null };
    return body.user ?? null;
  } catch {
    return null;
  }
}

export interface LoginResult {
  ok: boolean;
  token?: string;
  user?: BackendUser;
  error?: string;
}

export async function loginWithBackend(
  email: string,
  password: string,
): Promise<LoginResult> {
  try {
    const res = await fetch(`${backendUrl()}/api/users/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      token?: string;
      user?: BackendUser;
      errors?: { message: string }[];
      message?: string;
    };
    if (!res.ok || !body.token || !body.user) {
      const msg = body.errors?.[0]?.message ?? body.message ?? `HTTP ${res.status}`;
      return { ok: false, error: msg };
    }
    return { ok: true, token: body.token, user: body.user };
  } catch (err) {
    return { ok: false, error: `Network: ${(err as Error).message}` };
  }
}

export async function registerWithBackend(
  email: string,
  password: string,
  displayName: string,
): Promise<LoginResult> {
  try {
    const res = await fetch(`${backendUrl()}/api/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, displayName }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      doc?: BackendUser;
      errors?: { message: string }[];
      message?: string;
    };
    if (!res.ok || !body.doc) {
      const msg = body.errors?.[0]?.message ?? body.message ?? `HTTP ${res.status}`;
      return { ok: false, error: msg };
    }
  } catch (err) {
    return { ok: false, error: `Network: ${(err as Error).message}` };
  }
  // Payload's create-user route returns the user but no JWT — follow with login
  // so the caller gets a session in one round-trip.
  return loginWithBackend(email, password);
}

/**
 * Proxy a fetch through to the backend with the user's JWT attached. Used
 * by SvelteKit server routes that delegate to Payload REST.
 */
export async function backendFetch(
  token: string | undefined,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  if (token) headers.set('Authorization', `JWT ${token}`);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(`${backendUrl()}${path}`, { ...init, headers });
}
