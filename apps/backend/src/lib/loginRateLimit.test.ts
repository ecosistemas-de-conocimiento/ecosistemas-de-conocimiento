/**
 * 🔴 ONE IP CANNOT KEEP SOMEONE ELSE'S ACCOUNT LOCKED (audit 2026-11-10, A-11).
 *
 * The hooks on their own, with a request double. `loginRateLimit.pg.test.ts`
 * drives the same hooks through Payload's real REST login.
 */
import { AuthenticationError, LockedAuth, ValidationError, type PayloadRequest } from 'payload'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LoginRateLimited, countLoginFailure, guardLoginByIp } from './loginRateLimit'
import { LOGIN_FAIL_WINDOW_MS, resetRateLimits, useDefaultRateLimitStore } from './rateLimit'

function request(xff?: string): PayloadRequest {
  return {
    headers: new Headers(xff ? { 'x-forwarded-for': xff } : {}),
    context: {},
    payload: { logger: { warn() {} } },
  } as unknown as PayloadRequest
}

/** One login attempt: the guard, then (when given) the error Payload would throw. */
async function attempt(xff: string, error?: Error): Promise<'refused' | 'reached'> {
  const req = request(xff)
  try {
    await guardLoginByIp({ operation: 'login', req, context: req.context } as never)
  } catch (err) {
    if (err instanceof LoginRateLimited) {
      await countLoginFailure({ error: err, context: req.context, req } as never)
      return 'refused'
    }
    throw err
  }
  if (error) await countLoginFailure({ error, context: req.context, req } as never)
  return 'reached'
}

const wrongPassword = () => new AuthenticationError()

beforeEach(() => {
  useDefaultRateLimitStore()
  resetRateLimits()
  process.env.IDENTITY_RATELIMIT_LOGIN_FAIL_IP_MAX = '3'
})

afterEach(() => {
  delete process.env.IDENTITY_RATELIMIT_LOGIN_FAIL_IP_MAX
  vi.useRealTimers()
})

describe('failed logins per IP', () => {
  it('refuses an IP once it has spent its failures, before the password check', async () => {
    for (let i = 0; i < 3; i += 1) expect(await attempt('203.0.113.7', wrongPassword())).toBe('reached')
    expect(await attempt('203.0.113.7')).toBe('refused')
  })

  it('counts a locked account as a failure (the attempt that trips the lock is one)', async () => {
    for (let i = 0; i < 3; i += 1) await attempt('203.0.113.7', new LockedAuth())
    expect(await attempt('203.0.113.7')).toBe('refused')
  })

  it('does not count successes, so a room signing in together is not throttled', async () => {
    for (let i = 0; i < 50; i += 1) expect(await attempt('198.51.100.1')).toBe('reached')
  })

  it('does not count other errors (a missing field is not a guess)', async () => {
    const invalid = new ValidationError({ errors: [{ path: 'email', message: 'required' }] })
    for (let i = 0; i < 10; i += 1) expect(await attempt('198.51.100.1', invalid)).toBe('reached')
  })

  it('keeps IPs apart', async () => {
    for (let i = 0; i < 3; i += 1) await attempt('203.0.113.7', wrongPassword())
    expect(await attempt('198.51.100.1')).toBe('reached')
  })

  it('keys on the rightmost X-Forwarded-For entry, so a forged left entry buys no fresh budget', async () => {
    for (let i = 0; i < 3; i += 1) await attempt(`10.0.0.${i}, 203.0.113.7`, wrongPassword())
    expect(await attempt('192.0.2.99, 203.0.113.7')).toBe('refused')
  })

  it('answers 429 with Retry-After', async () => {
    for (let i = 0; i < 3; i += 1) await attempt('203.0.113.7', wrongPassword())
    const req = request('203.0.113.7')
    const thrown = await Promise.resolve(
      guardLoginByIp({ operation: 'login', req, context: req.context } as never),
    ).catch((err: unknown) => err)
    expect(thrown).toBeInstanceOf(LoginRateLimited)
    expect((thrown as LoginRateLimited).status).toBe(429)
    expect(Number(req.responseHeaders?.get('Retry-After'))).toBeGreaterThan(0)
  })

  it('opens again once the hour has passed', async () => {
    vi.useFakeTimers()
    for (let i = 0; i < 3; i += 1) await attempt('203.0.113.7', wrongPassword())
    vi.advanceTimersByTime(LOGIN_FAIL_WINDOW_MS + 1000)
    expect(await attempt('203.0.113.7')).toBe('reached')
  })

  it('ignores every operation but login', async () => {
    for (let i = 0; i < 3; i += 1) await attempt('203.0.113.7', wrongPassword())
    const req = request('203.0.113.7')
    await expect(
      guardLoginByIp({ operation: 'read', req, context: req.context } as never),
    ).resolves.toBeUndefined()
  })
})
