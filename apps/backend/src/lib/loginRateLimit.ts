/**
 * PER-IP LIMIT ON FAILED LOGINS, for `POST /api/users/login`.
 *
 * Payload's own lockout is per ACCOUNT: 5 failures lock it for 10 minutes
 * (quoted, `payload/dist/collections/config/defaults.js`, Payload 3.88). That
 * stays. Alone it lets anyone who knows an address keep that account locked
 * forever with 5 tries every 10 minutes. This bucket caps how many failures
 * one client IP may spend, across every account, per hour — see
 * `rateLimits.loginFailPerIp` for the number.
 *
 * Two hooks, because only failures count:
 *   - `beforeOperation` ASKS the bucket (without counting) and refuses with 429
 *     once it is spent. A spent IP never reaches the password check, so it can
 *     no longer move anyone's `loginAttempts`.
 *   - `afterError` COUNTS a wrong password or a locked account. A success
 *     counts nothing, so a room signing in together is not throttled by itself.
 *
 * ⚠ The IP is `clientIp(req)`: the rightmost trusted `X-Forwarded-For` entry.
 * Calls from the web BFF carry the browser's IP there (A-08); see `clientIp`
 * for why a direct caller cannot choose its own bucket.
 *
 * ⚠ Only the REST route reaches `afterError`. Payload's local API (`payload.login`
 * in seeds and tests) is checked but never counted, which is what those want.
 *
 * Not here, by decision: a per-EMAIL limit. It is new functionality (etapa 2).
 */

import {
  APIError,
  AuthenticationError,
  LockedAuth,
  type CollectionAfterErrorHook,
  type CollectionBeforeOperationHook,
} from 'payload'

import { clientIp } from '../endpoints/http'
import {
  LOGIN_FAIL_WINDOW_MS,
  checkRateLimits,
  peekRateLimit,
  rateLimits,
  type RateLimitRule,
} from './rateLimit'

/** Where `beforeOperation` leaves the IP for `afterError`, on `req.context`. */
const CONTEXT_KEY = 'loginRateLimitIp'

function failureRule(ip: string): RateLimitRule {
  return {
    scope: 'login:fail:ip',
    key: `login:fail:ip:${ip}`,
    limit: rateLimits.loginFailPerIp(),
    windowMs: LOGIN_FAIL_WINDOW_MS,
  }
}

/** Our own 429. Told apart from a real failure so it is never counted as one. */
export class LoginRateLimited extends APIError {
  constructor(public readonly retryAfterSeconds: number) {
    super(`Too many failed sign-ins. Retry in ${retryAfterSeconds}s.`, 429, undefined, true)
  }
}

export const guardLoginByIp: CollectionBeforeOperationHook = async ({ operation, req }) => {
  if (operation !== 'login') return
  const ip = clientIp(req)
  req.context[CONTEXT_KEY] = ip

  const verdict = await peekRateLimit(failureRule(ip))
  if (verdict.allowed) return

  const retryAfterSeconds = verdict.decision?.retryAfterSeconds ?? LOGIN_FAIL_WINDOW_MS / 1000
  req.payload?.logger?.warn('[identity/rateLimit] 429 on scope "login:fail:ip"')
  // `routeError` merges these into the error response.
  req.responseHeaders = new Headers({
    'Retry-After': String(retryAfterSeconds),
    'Cache-Control': 'no-store',
  })
  throw new LoginRateLimited(retryAfterSeconds)
}

export const countLoginFailure: CollectionAfterErrorHook = async ({ context, error }) => {
  const ip = context?.[CONTEXT_KEY]
  if (typeof ip !== 'string') return
  // A wrong password is `AuthenticationError`; the attempt that trips the lock,
  // and every one against a locked account, is `LockedAuth`.
  if (!(error instanceof AuthenticationError || error instanceof LockedAuth)) return
  await checkRateLimits([failureRule(ip)])
}

/** Spread into the `users` collection's `hooks`. */
export const loginRateLimitHooks = {
  beforeOperation: [guardLoginByIp],
  afterError: [countLoginFailure],
}
