import { safeErrMessage } from '$lib/errorSummary';
import { redirect, type Handle, type HandleServerError } from '@sveltejs/kit';
import { SESSION_COOKIE, fetchMe } from '$lib/server/auth';

// Public routes that don't require an authenticated user.
//
// ⚠ `/sign-up` stays on purpose. Sign-up is closed (UX backlog #6) and that
// path is only a redirect to `/sign-in?registro=cerrado`, which shows the
// "ask an administrator" note. The people following an old sign-up link are
// signed OUT; without this entry they would be bounced to a bare `/sign-in`
// by the guard below and never see why.
//
// `/privacidad` is the privacy notice: it must be readable BEFORE anyone has
// an account or ticks a consent box (LGPDPPSO arts. 14 and 20).
const PUBLIC_PATHS = new Set(['/sign-in', '/sign-up', '/privacidad']);
// Public API endpoints (auth proxies in particular need to work without a session).
const PUBLIC_API_PREFIXES = ['/api/auth/'];

// 🔴 Health probes are unauthenticated by contract, and are short-circuited
// BEFORE any auth work happens (see `handle` below).
//
// Exact paths, not a prefix: a prefix would also exempt anything someone later
// nests under `/api/health/`, and these two routes are the whole contract.
// See the health-check contract in the repo README.
const HEALTH_PATHS = new Set(['/api/health', '/api/health/ready']);

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  return PUBLIC_API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export const handle: Handle = async ({ event, resolve }) => {
  // 🔴 Health probes bypass this hook entirely, before ANY auth work. Two
  // independent reasons, and both are load-bearing:
  //
  //  1. Monitors and container probes carry no session. Falling through to the
  //     block below answered 401 for `/api/*`, so an ABSENT `/api/health`
  //     route was indistinguishable from an auth failure — a permanent false
  //     negative that looked like a security problem and was not.
  //  2. `fetchMe` below calls the backend. Running it for `/api/health` would
  //     make LIVENESS depend on the backend, and a liveness probe that checks
  //     a dependency turns a backend blip into a restart crash-loop.
  //     Short-circuiting here is what makes "liveness checks nothing" true of
  //     the whole request path, not just of the route handler.
  if (HEALTH_PATHS.has(event.url.pathname)) return resolve(event);

  const token = event.cookies.get(SESSION_COOKIE);
  const user = await fetchMe(token);

  event.locals.user = user;
  event.locals.token = user ? token : undefined;

  // If the cookie was set but no longer validates (expired JWT, user deleted,
  // backend rotated secret), nuke it so the next request doesn't re-roundtrip.
  if (token && !user) {
    event.cookies.delete(SESSION_COOKIE, { path: '/' });
  }

  if (!user && !isPublic(event.url.pathname)) {
    // API routes should respond 401 even on GET so clients can detect the
    // expired-session case without trying to parse a redirect response.
    if (event.url.pathname.startsWith('/api/')) {
      return new Response('Unauthorized', { status: 401 });
    }
    if (event.request.method === 'GET') {
      throw redirect(303, '/sign-in');
    }
    return new Response('Unauthorized', { status: 401 });
  }

  return resolve(event);
};

// Last-resort safety net (Part 1). SvelteKit calls `handleError` ONLY for
// *uncaught* errors — never for thrown `HttpError`s (i.e. `error(...)` /
// `redirect(...)`), so the structured deny throws from `$lib/server/deny.ts`
// reach `+error.svelte` untouched and never pass through here.
//
// For anything else (an unhandled exception in a load/handler — e.g. a backend
// read that threw instead of degrading), we log its log-safe form server-side
// (`$lib/errorSummary`: a raw error can quote a backend row, P-07) and
// return a SANITISED `App.Error` body so the boundary renders a branded page
// instead of leaking a raw 500 stack trace to the user.
export const handleError: HandleServerError = ({ error, status }) => {
  console.error('[handleError] uncaught error', safeErrMessage(error));
  return {
    message: 'Something went wrong. Please try again.',
    kind: 'generic',
    module: 'app',
    reason: status === 404 ? 'not-found' : 'internal',
  } satisfies App.Error;
};
