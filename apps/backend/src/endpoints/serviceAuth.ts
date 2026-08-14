/**
 * `X-Service-Token` authentication for every service-to-service endpoint.
 * Today that is `/v1/identity/resolve` alone.
 *
 * It lives in ONE file on purpose, even at one caller. Two endpoints comparing
 * a shared secret two slightly different ways is how one of them ends up with
 * an early-exit compare or a missing rate limit — and the weaker one is the one
 * that gets attacked. Add a service-to-service endpoint → call
 * {@link authenticateServiceRequest}. Do not re-implement the compare.
 *
 * A shared secret per consumer, sent as `X-Service-Token`, never a cookie.
 * These endpoints send no CORS headers, so a browser cannot use them
 * cross-origin even if a secret leaked into front-end code.
 *
 * ⚠ `X-Service-Token` IS NOT A USER CREDENTIAL. It authenticates a SERVICE to
 * the whole resolve surface. Anything that reaches a browser is a full
 * compromise of that surface.
 *
 * COMPARISON IS CONSTANT TIME. Both sides are SHA-256'd — always 32 bytes, so
 * `timingSafeEqual` never sees a length mismatch and no length is leaked — and
 * EVERY configured consumer is checked with no early exit, so response time
 * does not reveal which consumer matched or how much of a secret was correct.
 *
 * BRUTE FORCE is capped per client IP, counting REJECTED attempts only
 * (`serviceAuthFailurePerIp`, 20/min). A correctly configured consumer never
 * touches that bucket however much traffic it sends, so a real service cannot
 * be locked out by its own volume — only by getting the secret wrong.
 * ⚠ In-process counters: they do not hold across replicas. See lib/rateLimit.ts.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { PayloadRequest } from 'payload'

import { rateLimits } from '../lib/rateLimit'
import { clientIp, errorResponse, guardRateLimit } from './http'

export const SERVICE_TOKEN_HEADER = 'x-service-token'

// --- SERVICE_TOKENS parsing (cached on the raw env string) --------------------

let cachedRaw: string | null = null
let cachedEntries: ReadonlyArray<readonly [string, string]> = []
let warnedEmpty = false
let warnedMalformed = false

function serviceTokenEntries(): ReadonlyArray<readonly [string, string]> {
  const raw = (process.env.SERVICE_TOKENS ?? '').trim()
  if (raw === cachedRaw) return cachedEntries

  cachedRaw = raw
  cachedEntries = []

  if (raw.length === 0) {
    warnEmpty()
    return cachedEntries
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    if (!warnedMalformed) {
      warnedMalformed = true
      console.error(
        '[identity/serviceAuth] SERVICE_TOKENS is not valid JSON. Expected {"<consumer-slug>":"<secret>"}. All service-to-service calls will be rejected.',
      )
    }
    return cachedEntries
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    if (!warnedMalformed) {
      warnedMalformed = true
      console.error('[identity/serviceAuth] SERVICE_TOKENS must be a JSON object of slug -> secret.')
    }
    return cachedEntries
  }

  cachedEntries = Object.entries(parsed as Record<string, unknown>)
    .filter(
      (entry): entry is [string, string] =>
        // A blank slug would authenticate to a consumer with no name, and every
        // per-consumer rate-limit bucket would collapse into one. A blank
        // secret would let an empty header authenticate. Drop both.
        entry[0].trim().length > 0 && typeof entry[1] === 'string' && entry[1].length > 0,
    )
    .map(([slug, secret]) => [slug.trim(), secret] as const)

  // Covers `{}`, `{ }`, and a map whose every entry was dropped above — all of
  // which reject every call, and all of which used to do so in total silence.
  if (cachedEntries.length === 0) warnEmpty()

  return cachedEntries
}

function warnEmpty(): void {
  if (warnedEmpty) return
  warnedEmpty = true
  console.warn(
    '[identity/serviceAuth] SERVICE_TOKENS is empty or has no usable entries — every ' +
      'service-to-service call (/v1/identity/resolve) will be rejected. ' +
      'Expected {"<consumer-slug>":"<secret>"} with non-empty slugs and secrets.',
  )
}

/** Constant-time string equality via fixed-width digests. */
function constantTimeEquals(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest()
  const digestB = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(digestA, digestB)
}

/**
 * Returns the matching consumer slug, or `null`.
 * Iterates ALL entries with no early exit — timing must not depend on which
 * consumer's secret was presented.
 */
export function authenticateService(presented: string): string | null {
  const entries = serviceTokenEntries()
  let matched: string | null = null
  for (const [slug, secret] of entries) {
    if (constantTimeEquals(presented, secret)) {
      matched = slug
    }
  }
  return matched
}

export type ServiceAuthResult =
  | { ok: true; consumer: string }
  | { ok: false; response: Response }

/**
 * Authenticate a service-to-service request.
 *
 * Order matters and is deliberate:
 *   1. Compare the secret (cheap, constant time, no database).
 *   2. On FAILURE, count it against the per-IP brute-force bucket. If that
 *      bucket is exhausted the answer becomes 429 instead of 401 — a lockout,
 *      not just a rejection.
 *   3. On SUCCESS, the caller applies its own per-consumer limit.
 *
 * Failures are counted rather than gating every request, so a legitimate
 * consumer's traffic can never be starved by an attacker sharing its IP —
 * only wrong guesses accumulate.
 */
export async function authenticateServiceRequest(req: PayloadRequest): Promise<ServiceAuthResult> {
  const presented = req.headers.get(SERVICE_TOKEN_HEADER)?.trim()
  const consumer = presented ? authenticateService(presented) : null

  if (consumer) return { ok: true, consumer }

  const limited = await guardRateLimit(req, [
    {
      scope: 'service-auth:fail:ip',
      key: `service-auth:fail:ip:${clientIp(req)}`,
      limit: rateLimits.serviceAuthFailurePerIp(),
    },
  ])
  if (limited) return { ok: false, response: limited }

  if (!presented) {
    return { ok: false, response: errorResponse(401, 'Missing X-Service-Token header.') }
  }

  req.payload?.logger?.warn('[identity/serviceAuth] rejected an unrecognised X-Service-Token')
  return { ok: false, response: errorResponse(401, 'Invalid service token.') }
}
