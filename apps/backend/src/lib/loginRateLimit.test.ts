/**
 * 🔴 ONE IP CANNOT KEEP SOMEONE ELSE'S ACCOUNT LOCKED (audit 2026-11-10, A-11).
 *
 * The hooks on their own, with a request double. `loginRateLimit.pg.test.ts`
 * drives the same hooks through Payload's real REST login.
 */
import { AuthenticationError, LockedAuth, ValidationError, type PayloadRequest } from 'payload'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  LoginRateLimited,
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

describe('defaults', () => {
  it('4 per (IP, email) per 10 minutes, 100 per IP per hour', () => {
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
