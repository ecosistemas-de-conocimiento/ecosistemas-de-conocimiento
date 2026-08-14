/**
 * Small HTTP helpers shared by the custom endpoints.
 *
 * Error bodies follow Payload's REST convention (`{ errors: [{ message }] }`)
 * so consumers can use one error parser for both built-in and custom routes.
 *
 * RATE LIMITING lives in `src/lib/rateLimit.ts`; `guardRateLimit` below is the
 * HTTP glue. `/token`, `/me` and `/resolve` are limited.
 * `/.well-known/jwks.json` deliberately is NOT — see the note in `jwks.ts`.
 * ⚠ The counters are IN-PROCESS, so the published limits hold PER REPLICA. The
 * store is a seam (`RateLimitStore`) precisely so a shared backend can be
 * dropped in later without touching any endpoint. Volumetric DoS remains the
 * reverse proxy's job; this protects credential issuance.
 */

import type { PayloadRequest } from 'payload'

import {
  RATE_LIMIT_WINDOW_MS,
  checkRateLimits,
  type RateLimitDecision,
  type RateLimitRule,
} from '../lib/rateLimit'

export function jsonResponse(
  body: unknown,
  init?: { status?: number; headers?: Record<string, string> },
): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(init?.headers ?? {}),
    },
  })
}

export function errorResponse(status: number, message: string, extra?: Record<string, unknown>): Response {
  return jsonResponse({ errors: [{ message }], ...(extra ?? {}) }, { status })
}

/**
 * The subset of the `users` doc these endpoints read.
 *
 * Kept local so this file does not depend on generated `payload-types.ts`,
 * which does not exist until `payload generate:types` has run — and a route
 * that cannot compile before a codegen step is a route that breaks CI on a
 * clean checkout.
 *
 * ⚠ `displayName` is the ONLY name field. See `collections/Users.ts` for why.
 */
export interface IdentityUserDoc {
  id: number | string
  email: string
  displayName?: string | null
  avatarUrl?: string | null
  locale?: string | null
  isPlatformAdmin?: boolean | null
  isActive?: boolean | null
  createdAt?: string | null
  updatedAt?: string | null
  collection?: string
}

/**
 * The authenticated Payload user, or `null`.
 *
 * Auth is performed upstream by Payload's REST layer (cookie or
 * `Authorization: JWT <payload-token>`), so this is a narrowing guard, not an
 * auth check of its own. Users flagged `isActive: false` are treated as
 * unauthenticated here regardless of a valid session.
 */
export function getAuthenticatedUser(req: PayloadRequest): IdentityUserDoc | null {
  const user = req.user as unknown as IdentityUserDoc | null
  if (!user || typeof user.email !== 'string' || user.email.length === 0) return null
  if (user.isActive === false) return null
  return user
}

/**
 * Whitelisted, wire-safe projection of a user doc.
 *
 * Explicitly constructed rather than filtered, so no future field on the
 * collection (password, salt, hash, resetPasswordToken, resetPasswordExpiration,
 * loginAttempts, lockUntil, apiKey, …) can leak by accident.
 */
export function publicUserProfile(user: IdentityUserDoc): {
  email: string
  name: string | null
  avatarUrl: string | null
  locale: string | null
  isPlatformAdmin: boolean
  isActive: boolean
  createdAt: string | null
  updatedAt: string | null
} {
  return {
    email: user.email,
    name: displayName(user),
    avatarUrl: user.avatarUrl ?? null,
    locale: user.locale ?? null,
    isPlatformAdmin: user.isPlatformAdmin === true,
    isActive: user.isActive !== false,
    createdAt: user.createdAt ?? null,
    updatedAt: user.updatedAt ?? null,
  }
  // `id` is intentionally omitted: internal ids do not cross a service
  // boundary; email is the identifier.
}

/** The user's display name, or `null` when they never set one. */
export function displayName(user: IdentityUserDoc): string | null {
  const name = typeof user.displayName === 'string' ? user.displayName.trim() : ''
  return name.length > 0 ? name : null
}

/** First value for a query param, from Payload's parsed `searchParams`. */
export function queryParam(req: PayloadRequest, name: string): string | null {
  const value = req.searchParams?.get(name)
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

// --- client IP, for the per-IP rate-limit buckets -----------------------------

let warnedAboutHops = false

/**
 * How many proxies sit between a real client and this process.
 *
 * ⚠ SETTING THIS TOO HIGH IS A SILENT, TOTAL BYPASS of every per-IP bucket.
 * With one real proxy but `hops=2`, the index lands on the entry the CLIENT
 * supplied, so a caller picks its own bucket key: unlimited fresh budgets, and
 * a way to poison someone else's bucket by naming their IP. Junk and values
 * below 1 fall back to 1, so only a plausible wrong number is dangerous —
 * which is exactly why it is logged once at first use rather than left silent.
 */
function trustedProxyHops(): number {
  const raw = process.env.IDENTITY_TRUSTED_PROXY_HOPS
  if (typeof raw !== 'string' || raw.trim() === '') return 1
  const parsed = Number.parseInt(raw.trim(), 10)
  if (!Number.isFinite(parsed) || parsed < 1) return 1

  if (parsed > 1 && !warnedAboutHops) {
    warnedAboutHops = true
    console.warn(
      `[identity/http] IDENTITY_TRUSTED_PROXY_HOPS=${parsed}. Rate-limit buckets will trust the ` +
        `${parsed}th X-Forwarded-For entry from the right. This is correct ONLY if exactly ${parsed} ` +
        'trusted proxies really sit in front of this app. If fewer do, clients choose their own ' +
        'bucket and every per-IP limit is bypassable.',
    )
  }
  return parsed
}

/**
 * The caller's IP address, for rate-limit bucketing ONLY. Never an auth input.
 *
 * ⚠ `X-Forwarded-For` is a list a client can pre-seed. Proxies APPEND, so the
 * trustworthy entry is counted from the RIGHT: with one trusted proxy
 * (the usual reverse-proxy deployment) the real client
 * is the LAST entry, and anything a client injected sits harmlessly to its
 * left. Taking the leftmost entry — the common mistake — would let an attacker
 * both dodge their own bucket and burn someone else's.
 *
 * `IDENTITY_TRUSTED_PROXY_HOPS` (default 1) says how deep to count. Raise it
 * only if a CDN is added in front of the reverse proxy.
 *
 * ⚠ IF THE APP IS DIRECTLY REACHABLE, THE PER-IP BUCKETS ARE WORTHLESS. This
 * function trusts whatever header it is given; there is no socket address to
 * fall back on. Any caller that can open a connection without going through
 * the proxy forges `X-Forwarded-For` and picks its own bucket. That is not a
 * flaw to fix here — it is a deployment precondition: the container must be
 * reachable only via that proxy. The per-USER buckets do not depend on this and
 * remain the primary control; the IP bucket is a floor.
 *
 * Locally there is usually no XFF at all, so well-behaved callers share the
 * `unknown` bucket. Note "usually": a local caller that sends the header gets
 * whatever bucket it asked for. Fine for dev, and stated so nobody mistakes
 * the local behaviour for a guarantee.
 */
export function clientIp(req: PayloadRequest): string {
  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) {
    const parts = forwarded
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
    if (parts.length > 0) {
      const index = Math.min(Math.max(parts.length - trustedProxyHops(), 0), parts.length - 1)
      const candidate = parts[index]
      if (candidate) return candidate
    }
  }

  const realIp = req.headers.get('x-real-ip')?.trim()
  if (realIp) return realIp

  return 'unknown'
}

// --- rate-limit glue ----------------------------------------------------------

/** `429` with `Retry-After`, never cached. */
export function tooManyRequests(decision: RateLimitDecision, message: string): Response {
  return jsonResponse(
    { errors: [{ message }], retryAfterSeconds: decision.retryAfterSeconds },
    {
      status: 429,
      headers: {
        'Retry-After': String(decision.retryAfterSeconds),
        'RateLimit-Limit': String(decision.limit),
        'RateLimit-Remaining': '0',
        'RateLimit-Reset': String(Math.max(0, Math.ceil((decision.resetAt - Date.now()) / 1000))),
        'Cache-Control': 'no-store',
      },
    },
  )
}

/**
 * Count this request against every rule and return a `429` if any is exhausted,
 * or `null` to continue.
 *
 * The 429 body says only that a limit was hit and for how long — never which
 * bucket, never a counter. Which limit fired is an internal detail, and telling
 * an attacker whether they tripped the per-user or the per-IP bucket tells them
 * how many accounts they have.
 */
export async function guardRateLimit(
  req: PayloadRequest,
  rules: RateLimitRule[],
): Promise<Response | null> {
  const verdict = await checkRateLimits(rules)
  if (verdict.allowed) return null

  // ⚠ FAIL CLOSED. "Denied, but no decision object" should be impossible — the
  // built-in store always returns one and `checkRateLimits` synthesises one on
  // error. But `RateLimitStore` is a published seam for a future shared store,
  // and a third-party implementation returning `{ allowed: false }` with no
  // decision must not be read as permission. Deny with a conservative default.
  const decision = verdict.decision ?? {
    allowed: false,
    limit: verdict.rule?.limit ?? 0,
    remaining: 0,
    resetAt: Date.now() + RATE_LIMIT_WINDOW_MS,
    retryAfterSeconds: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000),
  }

  req.payload?.logger?.warn(
    `[identity/rateLimit] 429 on scope "${verdict.rule?.scope ?? 'unknown'}" (limit ${decision.limit}/min)`,
  )

  return tooManyRequests(
    decision,
    `Too many requests. Retry in ${decision.retryAfterSeconds}s.`,
  )
}

/** Parse a JSON request body; returns `null` on empty/invalid JSON. */
export async function readJsonBody(req: PayloadRequest): Promise<Record<string, unknown> | null> {
  if (typeof req.json !== 'function') return null
  try {
    const parsed: unknown = await req.json()
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}
