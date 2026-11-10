/**
 * LIMITS ON FAILED LOGINS, for `POST /api/users/login` (A-11).
 *
 * Payload's own lockout is per ACCOUNT: 5 failures lock it for 10 minutes
 * (quoted, `payload/dist/collections/config/defaults.js`, Payload 3.88). That
 * stays. Alone it lets anyone who knows an address keep that account locked.
 * Two buckets sit in front of it — `rateLimits` has the numbers:
 *   - per (IP, email), BELOW the lockout, so one IP cannot lock that account,
 *     and people behind the same NAT signing in to other accounts are untouched;
 *   - per IP across every email, far higher: it throttles password spraying.
 *
 * RESERVE, THEN REFUND. `beforeOperation` counts the attempt in both buckets
 * BEFORE the password check, and refuses with 429 when either is spent: a
 * refused request never reaches the check, so it cannot move `loginAttempts`.
 * Counting after the check instead let 200 concurrent wrong passwords from one
 * IP all reach it against a limit of 15 (measured by the 2026-11-10 review).
 * The slot is given back when the attempt turns out not to be a guess:
 *   - `afterOperation` (login succeeded) refunds it, so a room signing in
 *     together is not throttled by itself;
 *   - `afterError` keeps it for a wrong password or a locked account, and
 *     refunds anything else (a missing field, a server error).
 *
 * ⚠ The IP is `clientIp(req)`: the rightmost trusted `X-Forwarded-For` entry.
 * Calls from the web BFF carry the browser's IP there (A-08); see `clientIp`
 * for why a direct caller cannot choose its own bucket.
 *
 * ⚠ Only the REST route reaches `afterError`. A failed `payload.login` on the
 * local API (seeds, tests) stays counted, whatever the error; a successful one
 * is refunded.
 *
 * Not here, by decision: a per-EMAIL limit across IPs. It is new functionality
 * (etapa 2).
 */

import {
  APIError,
  AuthenticationError,
  LockedAuth,
  type CollectionAfterErrorHook,
  type CollectionAfterOperationHook,
  type CollectionBeforeOperationHook,
  type RequestContext,
} from 'payload'

import { clientIp } from '../endpoints/http'
import { LOGIN_FAIL_WINDOW_MS, rateLimits, reserveRateLimits, type RateLimitRule } from './rateLimit'

/** Where `beforeOperation` leaves the reservation's `release`, on `req.context`. */
const CONTEXT_KEY = 'loginRateLimitRelease'

/** Trimmed and lowercased, as Payload does before it looks the user up. */
export function normaliseLoginEmail(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : ''
}

function loginRules(ip: string, email: string): RateLimitRule[] {
  return [
    {
      // The key holds the email; the scope, which reaches logs, does not.
      // `|` cannot appear in an IP, so no (IP, email) pair aliases another.
      scope: 'login:fail:ip-email',
      key: `login:fail:ip-email:${ip}|${email}`,
      limit: rateLimits.loginFailPerIpEmail(),
      windowMs: rateLimits.loginFailPerIpEmailWindowMs(),
    },
    {
      scope: 'login:fail:ip',
      key: `login:fail:ip:${ip}`,
      limit: rateLimits.loginFailPerIp(),
      windowMs: LOGIN_FAIL_WINDOW_MS,
    },
  ]
}

/** Our own 429. Thrown before a slot is held, so `afterError` finds nothing to settle. */
export class LoginRateLimited extends APIError {
  constructor(public readonly retryAfterSeconds: number) {
    super(`Too many failed sign-ins. Retry in ${retryAfterSeconds}s.`, 429, undefined, true)
  }
}

/** The held reservation, taken off the context so it is settled once. */
function takeRelease(context: RequestContext | undefined): (() => Promise<void>) | null {
  const release = context?.[CONTEXT_KEY]
  if (!context || typeof release !== 'function') return null
  delete context[CONTEXT_KEY]
  return release as () => Promise<void>
}

export const reserveLoginAttempt: CollectionBeforeOperationHook = async ({ args, operation, req }) => {
  if (operation !== 'login') return
  const email = normaliseLoginEmail((args as { data?: { email?: unknown } }).data?.email)
  const reservation = await reserveRateLimits(loginRules(clientIp(req), email))
  if (reservation.allowed) {
    req.context[CONTEXT_KEY] = reservation.release
    return
  }

  const retryAfterSeconds = reservation.decision?.retryAfterSeconds ?? LOGIN_FAIL_WINDOW_MS / 1000
  req.payload?.logger?.warn(`[identity/rateLimit] 429 on scope "${reservation.rule?.scope ?? 'login'}"`)
  // `routeError` merges these into the error response.
  req.responseHeaders = new Headers({
    'Retry-After': String(retryAfterSeconds),
    'Cache-Control': 'no-store',
  })
  throw new LoginRateLimited(retryAfterSeconds)
}

export const settleLoginFailure: CollectionAfterErrorHook = async ({ context, error }) => {
  const release = takeRelease(context)
  if (!release) return
  // A wrong password (or an unknown email) is `AuthenticationError`; the attempt
  // that trips the lock, and every one against a locked account, is `LockedAuth`.
  // Those were guesses and stay counted.
  if (error instanceof AuthenticationError || error instanceof LockedAuth) return
  await release()
}

export const refundLoginSuccess: CollectionAfterOperationHook = async ({ operation, req, result }) => {
  if (operation === 'login') await takeRelease(req.context)?.()
  return result
}

/** Spread into the `users` collection's `hooks`. */
export const loginRateLimitHooks = {
  beforeOperation: [reserveLoginAttempt],
  afterOperation: [refundLoginSuccess],
  afterError: [settleLoginFailure],
}
