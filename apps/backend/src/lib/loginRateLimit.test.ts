/**
 * 🔴 ONE IP CANNOT KEEP SOMEONE ELSE'S ACCOUNT LOCKED (audit 2026-11-10, A-11).
 *
 * The hooks on their own, with a request double. `loginRateLimit.pg.test.ts`
 * drives the same hooks through Payload's real REST login.
 */
import { AuthenticationError, LockedAuth, ValidationError, type PayloadRequest } from 'payload'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  LoginEmailTooLong,
  LoginRateLimited,
  MAX_LOGIN_EMAIL_LENGTH,
  refundLoginSuccess,
  reserveLoginAttempt,
  settleLoginFailure,
} from './loginRateLimit'
import { LOGIN_FAIL_WINDOW_MS, rateLimits, resetRateLimits, useDefaultRateLimitStore } from './rateLimit'

const ATTACKER = '203.0.113.7'
const VICTIM = 'victim@example.invalid'

function request(xff?: string): PayloadRequest {
  return {
    headers: new Headers(xff ? { 'x-forwarded-for': xff } : {}),
    context: {},
    payload: { logger: { warn() {} } },
  } as unknown as PayloadRequest
}

/** The guard alone. Returns the request, or 'refused'. */
async function reserve(xff: string, email: string): Promise<PayloadRequest | 'refused'> {
  const req = request(xff)
  try {
    await reserveLoginAttempt({ operation: 'login', args: { data: { email } }, req, context: req.context } as never)
  } catch (err) {
    if (err instanceof LoginRateLimited) {
      await settleLoginFailure({ error: err, context: req.context, req } as never)
      return 'refused'
    }
    throw err
  }
  return req
}

/**
 * One login attempt: the guard, then what Payload would do — throw `error`
 * through `afterError`, or (no error) succeed through `afterOperation`.
 */
async function attempt(xff: string, error?: Error, email = VICTIM): Promise<'refused' | 'reached'> {
  const req = await reserve(xff, email)
  if (req === 'refused') return 'refused'
  if (error) await settleLoginFailure({ error, context: req.context, req } as never)
  else await refundLoginSuccess({ operation: 'login', req, result: {} } as never)
  return 'reached'
}

const wrongPassword = () => new AuthenticationError()

beforeEach(() => {
  useDefaultRateLimitStore()
  resetRateLimits()
  process.env.IDENTITY_RATELIMIT_LOGIN_FAIL_IP_EMAIL_MAX = '3'
  process.env.IDENTITY_RATELIMIT_LOGIN_FAIL_IP_MAX = '10'
})

afterEach(() => {
  delete process.env.IDENTITY_RATELIMIT_LOGIN_FAIL_IP_EMAIL_MAX
  delete process.env.IDENTITY_RATELIMIT_LOGIN_FAIL_IP_EMAIL_WINDOW_S
  delete process.env.IDENTITY_RATELIMIT_LOGIN_FAIL_IP_MAX
  vi.useRealTimers()
})

describe('failed logins per (IP, email)', () => {
  it('refuses that pair once it has spent its failures, before the password check', async () => {
    for (let i = 0; i < 3; i += 1) expect(await attempt(ATTACKER, wrongPassword())).toBe('reached')
    expect(await attempt(ATTACKER)).toBe('refused')
  })

  it('a concurrent burst reaches the password check at most `limit` times', async () => {
    // The bug this guards: the guard only looked, and the count came after the
    // check, so every concurrent request passed the look.
    let checked = 0
    await Promise.all(
      Array.from({ length: 50 }, async () => {
        const req = await reserve(ATTACKER, VICTIM)
        if (req === 'refused') return
        checked += 1
        await new Promise((r) => setTimeout(r, 20)) // the password check
        await settleLoginFailure({ error: wrongPassword(), context: req.context, req } as never)
      }),
    )
    expect(checked).toBe(3)
  })

  it('keys on the normalised email, so case and spaces buy no fresh budget', async () => {
    for (const email of [VICTIM, ' VICTIM@example.invalid', 'Victim@Example.Invalid ']) {
      await attempt(ATTACKER, wrongPassword(), email)
    }
    expect(await attempt(ATTACKER, undefined, 'VICTIM@EXAMPLE.INVALID')).toBe('refused')
  })

  it('a spent pair does not block another email from the same IP (a shared NAT)', async () => {
    for (let i = 0; i < 3; i += 1) await attempt(ATTACKER, wrongPassword())
    expect(await attempt(ATTACKER, undefined, 'colleague@example.invalid')).toBe('reached')
  })

  it('counts a locked account as a failure (the attempt that trips the lock is one)', async () => {
    for (let i = 0; i < 3; i += 1) await attempt(ATTACKER, new LockedAuth())
    expect(await attempt(ATTACKER)).toBe('refused')
  })

  it('refunds successes, so a room signing in together is not throttled', async () => {
    for (let i = 0; i < 50; i += 1) expect(await attempt('198.51.100.1')).toBe('reached')
  })

  it('refunds other errors (a missing field is not a guess)', async () => {
    const invalid = new ValidationError({ errors: [{ path: 'email', message: 'required' }] })
    for (let i = 0; i < 10; i += 1) expect(await attempt('198.51.100.1', invalid)).toBe('reached')
  })

  it('refunds once, however often it is settled', async () => {
    for (let i = 0; i < 2; i += 1) await attempt(ATTACKER, wrongPassword())
    const req = await reserve(ATTACKER, VICTIM)
    if (req === 'refused') throw new Error('unexpected refusal')
    const context = { ...req.context }
    await refundLoginSuccess({ operation: 'login', req, result: {} } as never)
    req.context = context
    await refundLoginSuccess({ operation: 'login', req, result: {} } as never)
    // 2 failures stand; a double refund would have freed a fourth try.
    expect(await attempt(ATTACKER, wrongPassword())).toBe('reached')
    expect(await attempt(ATTACKER)).toBe('refused')
  })

  it('keeps IPs apart', async () => {
    for (let i = 0; i < 3; i += 1) await attempt(ATTACKER, wrongPassword())
    expect(await attempt('198.51.100.1')).toBe('reached')
  })

  it('keys on the rightmost X-Forwarded-For entry, so a forged left entry buys no fresh budget', async () => {
    for (let i = 0; i < 3; i += 1) await attempt(`10.0.0.${i}, ${ATTACKER}`, wrongPassword())
    expect(await attempt(`192.0.2.99, ${ATTACKER}`)).toBe('refused')
  })

  it('answers 429 with Retry-After', async () => {
    for (let i = 0; i < 3; i += 1) await attempt(ATTACKER, wrongPassword())
    const req = request(ATTACKER)
    const thrown = await Promise.resolve(
      reserveLoginAttempt({ operation: 'login', args: { data: { email: VICTIM } }, req, context: req.context } as never),
    ).catch((err: unknown) => err)
    expect(thrown).toBeInstanceOf(LoginRateLimited)
    expect((thrown as LoginRateLimited).status).toBe(429)
    expect(Number(req.responseHeaders?.get('Retry-After'))).toBeGreaterThan(0)
  })

  it('opens again once its window has passed', async () => {
    vi.useFakeTimers()
    for (let i = 0; i < 3; i += 1) await attempt(ATTACKER, wrongPassword())
    vi.advanceTimersByTime(rateLimits.loginFailPerIpEmailWindowMs() + 1000)
    expect(await attempt(ATTACKER)).toBe('reached')
  })

  it('ignores every operation but login', async () => {
    for (let i = 0; i < 3; i += 1) await attempt(ATTACKER, wrongPassword())
    const req = request(ATTACKER)
    await expect(
      reserveLoginAttempt({ operation: 'read', args: {}, req, context: req.context } as never),
    ).resolves.toBeUndefined()
  })
})

describe('failed logins per IP, across every email', () => {
  const sprayed = (i: number) => `user${i}@example.invalid`

  it('caps spraying from one IP, and the refusal counts nothing', async () => {
    for (let i = 0; i < 10; i += 1) expect(await attempt(ATTACKER, wrongPassword(), sprayed(i))).toBe('reached')
    expect(await attempt(ATTACKER, wrongPassword(), sprayed(10))).toBe('refused')
    // The refused try did not spend the fresh email's own bucket.
    process.env.IDENTITY_RATELIMIT_LOGIN_FAIL_IP_MAX = '100'
    for (let i = 0; i < 3; i += 1) expect(await attempt(ATTACKER, wrongPassword(), sprayed(10))).toBe('reached')
  })

  it('holds under a concurrent burst across many emails', async () => {
    let checked = 0
    await Promise.all(
      Array.from({ length: 60 }, async (_, i) => {
        const req = await reserve(ATTACKER, sprayed(i))
        if (req === 'refused') return
        checked += 1
        await new Promise((r) => setTimeout(r, 20))
        await settleLoginFailure({ error: wrongPassword(), context: req.context, req } as never)
      }),
    )
    expect(checked).toBe(10)
  })

  it('opens again once the hour has passed', async () => {
    vi.useFakeTimers()
    for (let i = 0; i < 10; i += 1) await attempt(ATTACKER, wrongPassword(), sprayed(i))
    vi.advanceTimersByTime(LOGIN_FAIL_WINDOW_MS + 1000)
    expect(await attempt(ATTACKER, undefined, sprayed(99))).toBe('reached')
  })
})

describe('what one IP can put in the store (re-audit 2026-11-10, N3/N4)', () => {
  /** The installed in-process store's own map, read through its private field. */
  const trackedKeys = (): string[] => {
    const store = (globalThis as Record<symbol, unknown>)[Symbol.for('edc.backend.rateLimit.store')]
    return [...(store as { buckets: Map<string, unknown> }).buckets.keys()]
  }

  it(`refuses an email over ${MAX_LOGIN_EMAIL_LENGTH} characters before any key is built`, async () => {
    const req = request(ATTACKER)
    const long = `${'a'.repeat(MAX_LOGIN_EMAIL_LENGTH - 'b@example.invalid'.length + 1)}b@example.invalid`
    await expect(
      reserveLoginAttempt({ operation: 'login', args: { data: { email: long } }, req, context: req.context } as never),
    ).rejects.toBeInstanceOf(LoginEmailTooLong)
    expect(trackedKeys()).toEqual([])
    // One shorter is an ordinary attempt.
    expect(await attempt(ATTACKER, wrongPassword(), long.slice(1))).toBe('reached')
  })

  it('keys a hash of the email, never the email itself', async () => {
    await attempt(ATTACKER, wrongPassword(), VICTIM)
    const keys = trackedKeys()
    expect(keys).toHaveLength(2)
    for (const key of keys) {
      expect(key).not.toContain('victim')
      expect(key.length).toBeLessThan(100)
    }
  })

  it('a request the per-IP ceiling refuses keys nothing on its email', async () => {
    for (let i = 0; i < 10; i += 1) await attempt(ATTACKER, wrongPassword(), `user${i}@example.invalid`)
    const before = trackedKeys()
    for (let i = 10; i < 50; i += 1) {
      expect(await attempt(ATTACKER, wrongPassword(), `user${i}@example.invalid`)).toBe('refused')
    }
    expect(trackedKeys()).toEqual(before)
  })

  it('a refunded attempt leaves no key behind', async () => {
    for (let i = 0; i < 20; i += 1) expect(await attempt(ATTACKER, undefined, `user${i}@example.invalid`)).toBe('reached')
    expect(trackedKeys()).toEqual([])
  })

  it("one IP cannot evict another IP's live (IP, email) bucket within its 100/h budget", async () => {
    // The re-audit's repro: IP-B's 56,000 refused requests on distinct emails
    // pushed the store past its 50,000-key cap, evicting IP-A's spent bucket.
    delete process.env.IDENTITY_RATELIMIT_LOGIN_FAIL_IP_MAX
    vi.useFakeTimers()
    for (let i = 0; i < 3; i += 1) await attempt(ATTACKER, wrongPassword())
    expect(await attempt(ATTACKER)).toBe('refused')
    vi.advanceTimersByTime(1_000) // so IP-A's bucket is the least recently touched
    for (let i = 0; i < 56_000; i += 1) await attempt('198.51.100.2', wrongPassword(), `x${i}@flood.invalid`)
    vi.advanceTimersByTime(1_100) // past the over-cap sweep's 1 s gap
    await attempt('198.51.100.2', wrongPassword(), 'trigger@flood.invalid')
    expect(await attempt(ATTACKER)).toBe('refused')
    // IP-A's two keys, IP-B's per-IP key and its 100 (IP, email) keys.
    expect(trackedKeys().length).toBeLessThanOrEqual(2 + 1 + 100)
  }, 120_000)
})

describe('defaults', () => {
  it('4 per (IP, email) per hour, 100 per IP per hour', () => {
    delete process.env.IDENTITY_RATELIMIT_LOGIN_FAIL_IP_EMAIL_MAX
    delete process.env.IDENTITY_RATELIMIT_LOGIN_FAIL_IP_MAX
    expect(rateLimits.loginFailPerIpEmail()).toBe(4)
    expect(rateLimits.loginFailPerIpEmailWindowMs()).toBe(3_600_000)
    expect(rateLimits.loginFailPerIp()).toBe(100)
  })

  it('the window is env-tunable', () => {
    process.env.IDENTITY_RATELIMIT_LOGIN_FAIL_IP_EMAIL_WINDOW_S = '600'
    expect(rateLimits.loginFailPerIpEmailWindowMs()).toBe(600_000)
  })
})
