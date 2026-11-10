// Server-only auth helpers. Lives under `$lib/server/` so SvelteKit refuses
// to bundle it into any client-reachable module — the backend bearer tokens
// stay server-side by construction.
//
// Each user has a real account in the backend (Payload `users` collection).
// The backend issues a JWT on `/api/users/login`; this app caches it under the
// `chat_auth` httpOnly cookie and round-trips it as an Authorization header on
// proxied calls.

import { env } from '$env/dynamic/private';
import { currentClientIp, forwardClientIp } from './clientIp';
import { loginBlocked, recordLoginFailure } from './loginRateLimit';

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
  /**
   * Active memberships of active ecosistemas, `[{ organization, slug, role }]`
   * — added by the backend's `users.afterMe` hook. Read it through `$lib/roles`
   * (`isStudent`, `isInvestigador`, `canAdminOrg`). Presentation only.
   */
  memberships?: import('$lib/roles').SessionMembership[];
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
      headers: forwardClientIp(new Headers({ Authorization: `JWT ${token}` })),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { user?: BackendUser | null };
    return body.user ?? null;
  } catch {
    return null;
  }
}

// ─── Failure vocabulary ────────────────────────────────────────────────────
//
// 🔴 Nothing the BACKEND writes may reach the sign-in or sign-up screen. Payload
// answers in English ("The email or password provided is incorrect."), and a
// thrown fetch answers with our plumbing ("fetch failed"). Both are useless to
// the person typing, and the second one names our internals.
//
// So the network layer classifies the failure into one of these codes, keeps
// the backend's own words in `detail` FOR THE SERVER LOG ONLY, and the routes
// render `AUTH_ERROR_COPY[code]`. The set is deliberately fine-grained: a wrong
// password, a locked account and an unreachable backend need three different
// sentences, because they need three different actions from the user.

export type AuthFailure =
  /** Email/password pair rejected by the backend. */
  | 'invalid-credentials'
  /** Payload locked the account after too many failed attempts. */
  | 'account-locked'
  /** Too many failed sign-ins from this IP, here or at the backend. */
  | 'rate-limited'
  /** The backend never answered — down, restarting, or no network. */
  | 'unreachable'
  /** The backend answered 5xx. */
  | 'server'
  /** The request body was not readable JSON. */
  | 'bad-request'
  /** Email or password left empty. */
  | 'missing-fields'
  /** Sign-in failed for a reason we could not classify. */
  | 'login-failed';

/**
 * The only auth copy the user ever sees. Spanish, `tú`, and every line says
 * what happened AND what to do next — a message that leaves someone with no
 * next move is the same as no message.
 */
export const AUTH_ERROR_COPY: Record<AuthFailure, string> = {
  'invalid-credentials':
    'El correo o la contraseña no coinciden. Revísalos e inténtalo de nuevo.',
  'account-locked':
    'Bloqueamos la cuenta un rato por varios intentos fallidos. Espera unos minutos y vuelve a intentarlo.',
  'rate-limited':
    'Hubo demasiados intentos fallidos desde esta conexión. Espera un rato y vuelve a intentarlo.',
  unreachable:
    'No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo en un momento.',
  server:
    'El servidor tuvo un problema. Inténtalo de nuevo en un momento; si sigue igual, avisa a quien administra la instalación.',
  'bad-request': 'No pudimos leer lo que enviaste. Recarga la página e inténtalo de nuevo.',
  'missing-fields': 'Escribe tu correo y tu contraseña.',
  'login-failed': 'No pudimos iniciar tu sesión. Inténtalo de nuevo en un momento.',
};

/** Spanish copy for a failure code. Never falls through to a raw string. */
export function authErrorMessage(failure: AuthFailure): string {
  return AUTH_ERROR_COPY[failure] ?? AUTH_ERROR_COPY['login-failed'];
}

export interface LoginResult {
  ok: boolean;
  token?: string;
  user?: BackendUser;
  /** Machine code. Maps to Spanish copy; never rendered as-is. */
  failure?: AuthFailure;
  /** The backend's / runtime's own words. FOR LOGS ONLY — never rendered. */
  detail?: string;
}

interface PayloadErrorBody {
  errors?: {
    message?: string;
    data?: { errors?: { message?: string; path?: string }[] };
  }[];
  message?: string;
}

/**
 * Every human-readable string Payload put in an error body: the top-level
 * message plus the per-field ones a `ValidationError` nests under `data`.
 * The field-level message is the specific one ("A user with the given email is
 * already registered."), so classification needs both.
 */
function backendMessages(body: PayloadErrorBody): string {
  const parts: string[] = [];
  if (body.message) parts.push(body.message);
  for (const e of body.errors ?? []) {
    if (e.message) parts.push(e.message);
    for (const f of e.data?.errors ?? []) if (f.message) parts.push(f.message);
  }
  return parts.join(' | ');
}

export async function loginWithBackend(
  email: string,
  password: string,
): Promise<LoginResult> {
  try {
    const res = await fetch(`${backendUrl()}/api/users/login`, {
      method: 'POST',
      headers: forwardClientIp(new Headers({ 'Content-Type': 'application/json' })),
      body: JSON.stringify({ email, password }),
    });
    const body = (await res.json().catch(() => ({}))) as PayloadErrorBody & {
      token?: string;
      user?: BackendUser;
    };
    if (!res.ok || !body.token || !body.user) {
      const detail = backendMessages(body) || `HTTP ${res.status}`;
      // Payload answers 401 for BOTH a wrong password and a locked account,
      // and only the sentence tells them apart — but "wait a few minutes" and
      // "check your password" are opposite instructions, so we branch on it.
      const failure: AuthFailure =
        res.status >= 500
          ? 'server'
          : res.status === 429
            ? 'rate-limited'
            : /locked/i.test(detail)
            ? 'account-locked'
            : res.status === 401 || res.status === 400
              ? 'invalid-credentials'
              : 'login-failed';
      return { ok: false, failure, detail };
    }
    return { ok: true, token: body.token, user: body.user };
  } catch (err) {
    // A thrown fetch means we never reached the backend at all.
    return { ok: false, failure: 'unreachable', detail: (err as Error).message };
  }
}

/** What `signIn` needs from SvelteKit's `cookies` — kept narrow for tests. */
interface CookieSetter {
  set(name: string, value: string, opts: { path: string } & Record<string, unknown>): void;
}

export type SignInResult =
  | { ok: true; user: BackendUser }
  | { ok: false; status: 400 | 401 | 429 | 503; error: string };

/**
 * The ONE sign-in path: validate, log in against the backend, set the session
 * cookie. Shared by the JSON endpoint (`/api/auth/login`, the JS path) and the
 * `/sign-in` form action (the pre-hydration / no-JS path), so both behave the
 * same. 🔴 Never log `email` or `password` here — only the failure code and
 * the backend's own `detail`.
 */
export async function signIn(
  rawEmail: unknown,
  rawPassword: unknown,
  cookies: CookieSetter,
  secure: boolean,
): Promise<SignInResult> {
  const email = typeof rawEmail === 'string' ? rawEmail.trim() : '';
  const password = typeof rawPassword === 'string' ? rawPassword : '';
  if (!email || !password) {
    return { ok: false, status: 400, error: authErrorMessage('missing-fields') };
  }

  // 🔴 Per IP, failures only (A-11): `loginRateLimit.ts` has the numbers. A
  // spent IP never reaches the backend, so it cannot move anyone's lockout.
  const ip = currentClientIp() ?? 'unknown';
  if (loginBlocked(ip)) {
    console.warn('[auth] login refused: too many failed sign-ins from this IP');
    return { ok: false, status: 429, error: authErrorMessage('rate-limited') };
  }

  const result = await loginWithBackend(email, password);
  if (!result.ok || !result.token || !result.user) {
    const failure = result.failure ?? 'login-failed';
    if (failure === 'invalid-credentials' || failure === 'account-locked') recordLoginFailure(ip);
    // 🔴 The split: the technical detail goes to the LOG, the Spanish sentence
    // goes to the screen. `detail` holds Payload's English or a raw
    // `fetch failed`; neither is ever put in the response body.
    console.warn(`[auth] login failed (${failure}): ${result.detail ?? 'sin detalle'}`);
    // An unreachable or broken backend is not the user's fault, so it must not
    // answer 401 — that reads as "wrong password" to every caller.
    const status =
      failure === 'unreachable' || failure === 'server' ? 503 : failure === 'rate-limited' ? 429 : 401;
    return { ok: false, status, error: authErrorMessage(failure) };
  }

  cookies.set(SESSION_COOKIE, result.token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: SESSION_TTL_SECONDS,
  });
  return { ok: true, user: result.user };
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
  // The browser's IP rides along, so the backend's per-IP limits see one
  // bucket per browser, not one for the whole web (A-08). See `clientIp.ts`.
  const headers = forwardClientIp(new Headers(init.headers ?? {}));
  if (token) headers.set('Authorization', `JWT ${token}`);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(`${backendUrl()}${path}`, { ...init, headers });
}
