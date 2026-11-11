import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  RATE_LIMIT_WINDOW_MS,
  checkRateLimits,
  createInProcessRateLimitStore,
  rateLimits,
  reserveRateLimits,
  resetRateLimits,
  setRateLimitStore,
  useDefaultRateLimitStore,
  type RateLimitDecision,
  type RateLimitStore,
} from './rateLimit'

const rule = (key: string, limit: number) => ({ scope: 'test', key, limit })

async function hitTimes(key: string, limit: number, times: number): Promise<boolean[]> {
  const results: boolean[] = []
  for (let i = 0; i < times; i += 1) {
    results.push((await checkRateLimits([rule(key, limit)])).allowed)
  }
  return results
}

describe('in-process sliding-window limiter', () => {
  beforeEach(() => {
    useDefaultRateLimitStore()
    resetRateLimits()
  })

  afterEach(() => {
    vi.useRealTimers()
    useDefaultRateLimitStore()
  })

  it('allows exactly `limit` requests, then denies', async () => {
    expect(await hitTimes('a', 3, 5)).toEqual([true, true, true, false, false])
  })

  it('keeps buckets independent', async () => {
    await hitTimes('a', 2, 2)
    expect((await checkRateLimits([rule('b', 2)])).allowed).toBe(true)
  })

  it('returns a Retry-After of at least 1s, never longer than the window', async () => {
    await hitTimes('a', 1, 1)
    const verdict = await checkRateLimits([rule('a', 1)])
    expect(verdict.allowed).toBe(false)
    expect(verdict.decision?.retryAfterSeconds).toBeGreaterThanOrEqual(1)
    expect(verdict.decision?.retryAfterSeconds).toBeLessThanOrEqual(RATE_LIMIT_WINDOW_MS / 1000)
  })

  it('lets the window slide — the budget comes back, it does not reset in a block', async () => {
    vi.useFakeTimers()
    // Two hits 30s apart, on a limit of 2.
    expect((await checkRateLimits([rule('a', 2)])).allowed).toBe(true)
    vi.advanceTimersByTime(30_000)
    expect((await checkRateLimits([rule('a', 2)])).allowed).toBe(true)
    expect((await checkRateLimits([rule('a', 2)])).allowed).toBe(false)

    // 31s later the FIRST hit has aged out and exactly one slot is free.
    vi.advanceTimersByTime(31_000)
    expect((await checkRateLimits([rule('a', 2)])).allowed).toBe(true)
    expect((await checkRateLimits([rule('a', 2)])).allowed).toBe(false)
  })

  it('does not push the reset time out when a blocked client keeps hammering', async () => {
    vi.useFakeTimers()
    await hitTimes('a', 1, 1)
    const first = await checkRateLimits([rule('a', 1)])

    vi.advanceTimersByTime(10_000)
    for (let i = 0; i < 50; i += 1) await checkRateLimits([rule('a', 1)])
    const later = await checkRateLimits([rule('a', 1)])

    // Same absolute reset instant — denied attempts are not counted, so an
    // abuser cannot extend their own lockout indefinitely.
    expect(later.decision?.resetAt).toBe(first.decision?.resetAt)
  })

  it('reports remaining budget on the way down', async () => {
    const one = await checkRateLimits([rule('a', 3)])
    const two = await checkRateLimits([rule('a', 3)])
    expect(one.decision).toBeNull() // allowed verdicts carry no decision
    expect(two.decision).toBeNull()
    // …but the store itself counts: the 4th call is refused.
    await checkRateLimits([rule('a', 3)])
    expect((await checkRateLimits([rule('a', 3)])).allowed).toBe(false)
  })
})

// ⚠ These two cover bugs found in adversarial review after the first
// implementation. Both were cases where a comment asserted a safety property
// the code did not have, which is worse than an undocumented gap.
describe('key-flood resistance', () => {
  beforeEach(() => {
    useDefaultRateLimitStore()
    resetRateLimits()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does NOT hand an actively-blocked key a fresh budget when the map overflows', async () => {
    // The bug: denied hits did not refresh "last touched", so a blocked bucket
    // looked idle, sorted FIRST for eviction, and came back empty. Spraying
    // keys bought an abuser a clean slate.
    //
    // ⚠ Fake timers are load-bearing here, not a speed-up. A 60k-key flood
    // runs in ~70ms of real time, so the over-cap sweep (min 1s apart) would
    // never fire and this test would pass without evicting anything — green
    // for the wrong reason. Time is advanced explicitly so eviction really
    // happens, and so `lastSeen` values are distinct enough to order.
    vi.useFakeTimers()

    const victim = rule('victim', 2)
    expect((await checkRateLimits([victim])).allowed).toBe(true)
    expect((await checkRateLimits([victim])).allowed).toBe(true)
    const firstDenial = await checkRateLimits([victim])
    expect(firstDenial.allowed).toBe(false)
    const originalResetAt = firstDenial.decision?.resetAt

    // Push past MAX_TRACKED_KEYS (50 000), with the victim hammering
    // throughout as a real abuser would. ~600ms total: enough to spread
    // `lastSeen`, not enough to age the victim's hits out of the 60s window.
    //
    // The victim is asserted on EVERY retry, not just at the end. Checking
    // only the final state hides the bug: once evicted, the victim's next
    // request is allowed and immediately starts refilling its bucket, so by
    // the end of the loop it looks denied again — green, having been handed
    // exactly the free budget this test exists to catch.
    for (let i = 0; i < 60_000; i += 1) {
      await checkRateLimits([rule(`flood-${i}`, 5)])
      if (i % 1_000 === 0) {
        vi.advanceTimersByTime(10)
        const retry = await checkRateLimits([victim])
        expect(retry.allowed).toBe(false)
      }
    }

    // Now let the over-cap sweep run: it evicts the least-recently-touched
    // keys, which are the early flood keys — NOT the victim.
    vi.advanceTimersByTime(1_200)
    await checkRateLimits([rule('trigger-sweep', 5)])

    const afterSweep = await checkRateLimits([victim])
    expect(afterSweep.allowed).toBe(false)
    // Same window, not a fresh one: proof the bucket survived rather than
    // being evicted and rebuilt.
    expect(afterSweep.decision?.resetAt).toBe(originalResetAt)
  }, 120_000)

  it('stays fast when the key map is at its cap', async () => {
    for (let i = 0; i < 55_000; i += 1) await checkRateLimits([rule(`k-${i}`, 5)])

    // Each request used to trigger a full scan + sort of the whole map once
    // the cap was reached, which capped the whole process at ~100 req/s.
    const started = performance.now()
    for (let i = 0; i < 200; i += 1) await checkRateLimits([rule(`new-${i}`, 5)])
    const perRequestMs = (performance.now() - started) / 200

    expect(perRequestMs).toBeLessThan(1)
  }, 60_000)
})

describe('reserve and release', () => {
  beforeEach(() => {
    useDefaultRateLimitStore()
    resetRateLimits()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('counts up front, so concurrent callers cannot all pass', async () => {
    const verdicts = await Promise.all(
      Array.from({ length: 20 }, () => reserveRateLimits([rule('burst', 3)])),
    )
    expect(verdicts.filter((v) => v.allowed)).toHaveLength(3)
  })

  it('release gives the slot back, once', async () => {
    const held = await reserveRateLimits([rule('r', 1)])
    expect((await reserveRateLimits([rule('r', 1)])).allowed).toBe(false)
    await held.release()
    await held.release()
    expect((await reserveRateLimits([rule('r', 1)])).allowed).toBe(true)
    expect((await reserveRateLimits([rule('r', 1)])).allowed).toBe(false)
  })

  it('a release that empties a bucket deletes its key, so refunds leave nothing behind', async () => {
    const store = createInProcessRateLimitStore()
    const keys = (store as unknown as { buckets: Map<string, unknown> }).buckets
    store.hit('emptied', 3, 60_000)
    store.hit('kept', 3, 60_000)
    store.hit('kept', 3, 60_000)
    store.release('emptied')
    store.release('kept')
    expect([...keys.keys()]).toEqual(['kept'])
  })

  it('a release gives back ITS OWN hit, not the newest one (interleaved)', async () => {
    // A reserves at 0 s, B at 10 s, A fails and refunds at 20 s. Only B's hit
    // counts, until 70 s. Refunding the newest kept A's 0 s hit instead, which
    // left the window at 60 s: B's slot came back 10 s early.
    vi.useFakeTimers()
    const minute = { scope: 'test', key: 'mix', limit: 2, windowMs: 60_000 }
    const a = await reserveRateLimits([minute])
    vi.advanceTimersByTime(10_000)
    const b = await reserveRateLimits([minute])
    expect(b.allowed).toBe(true)
    vi.advanceTimersByTime(10_000)
    await a.release()
    vi.advanceTimersByTime(45_000)
    expect((await reserveRateLimits([minute])).allowed).toBe(true)
    expect((await reserveRateLimits([minute])).allowed).toBe(false)
    vi.advanceTimersByTime(6_000)
    expect((await reserveRateLimits([minute])).allowed).toBe(true)
  })

  it('a denial counts nothing, not even in the rules before it', async () => {
    await reserveRateLimits([rule('second', 1)])
    const verdict = await reserveRateLimits([rule('first', 1), rule('second', 1)])
    expect(verdict.allowed).toBe(false)
    expect(verdict.rule?.key).toBe('second')
    expect((await reserveRateLimits([rule('first', 1)])).allowed).toBe(true)
  })

  it('keeps a long-window key past the 10-minute idle sweep', async () => {
    // The bug this guards: idle keys were dropped after 10 minutes whatever
    // their window, so an hour-long failure bucket forgot an attacker who
    // simply paused for the lockout.
    vi.useFakeTimers()
    const hour = { scope: 'test', key: 'slow', limit: 2, windowMs: 60 * 60_000 }
    await checkRateLimits([hour])
    await checkRateLimits([hour])
    vi.advanceTimersByTime(20 * 60_000)
    await checkRateLimits([rule('other', 1)]) // runs the sweep
    expect((await checkRateLimits([hour])).allowed).toBe(false)
    vi.advanceTimersByTime(41 * 60_000)
    expect((await checkRateLimits([hour])).allowed).toBe(true)
  })

  it('FAILS CLOSED when the store throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    setRateLimitStore({
      hit: () => {
        throw new Error('store is down')
      },
      release: () => {},
      reset: () => {},
    })
    expect((await reserveRateLimits([rule('k', 100)])).allowed).toBe(false)
    useDefaultRateLimitStore()
  })

  it('a release that throws keeps the slot counted, and does not throw', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    setRateLimitStore({
      hit: (_key, limit) => ({ allowed: true, limit, remaining: 0, resetAt: 0, retryAfterSeconds: 0 }),
      release: () => {
        throw new Error('store is down')
      },
      reset: () => {},
    })
    const held = await reserveRateLimits([rule('k', 100)])
    await expect(held.release()).resolves.toBeUndefined()
    useDefaultRateLimitStore()
  })
})

describe('multiple rules', () => {
  beforeEach(() => {
    useDefaultRateLimitStore()
    resetRateLimits()
  })

  it('denies on the FIRST exhausted rule and names it', async () => {
    const rules = [
      { scope: 'user', key: 'u1', limit: 2 },
      { scope: 'ip', key: 'i1', limit: 10 },
    ]
    await checkRateLimits(rules)
    await checkRateLimits(rules)
    const verdict = await checkRateLimits(rules)
    expect(verdict.allowed).toBe(false)
    expect(verdict.rule?.scope).toBe('user')
  })

  it('applies the second rule as a floor across different first-rule keys', async () => {
    // Three different users, one shared IP with a budget of 4.
    const forUser = (u: string) => [
      { scope: 'user', key: `u:${u}`, limit: 10 },
      { scope: 'ip', key: 'ip:shared', limit: 4 },
    ]
    expect((await checkRateLimits(forUser('a'))).allowed).toBe(true)
    expect((await checkRateLimits(forUser('b'))).allowed).toBe(true)
    expect((await checkRateLimits(forUser('c'))).allowed).toBe(true)
    expect((await checkRateLimits(forUser('d'))).allowed).toBe(true)
    const verdict = await checkRateLimits(forUser('e'))
    expect(verdict.allowed).toBe(false)
    expect(verdict.rule?.scope).toBe('ip')
  })
})

describe('the shared-store seam', () => {
  afterEach(() => {
    useDefaultRateLimitStore()
    vi.restoreAllMocks()
  })

  it('accepts an ASYNC store — what a networked backend would be', async () => {
    const seen: string[] = []
    const asyncStore: RateLimitStore = {
      async hit(key, limit): Promise<RateLimitDecision> {
        seen.push(key)
        return {
          allowed: seen.length <= 1,
          limit,
          remaining: 0,
          resetAt: Date.now() + 1000,
          retryAfterSeconds: 1,
        }
      },
      release: () => {},
      reset: () => {
        seen.length = 0
      },
    }
    setRateLimitStore(asyncStore)

    expect((await checkRateLimits([rule('k', 1)])).allowed).toBe(true)
    expect((await checkRateLimits([rule('k', 1)])).allowed).toBe(false)
    expect(seen).toEqual(['k', 'k'])
  })

  it('FAILS CLOSED when the store throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    setRateLimitStore({
      hit: () => {
        throw new Error('store is down')
      },
      release: () => {},
      reset: () => {},
    })

    const verdict = await checkRateLimits([rule('k', 100)])
    expect(verdict.allowed).toBe(false)
    expect(verdict.decision?.retryAfterSeconds).toBeGreaterThan(0)
  })

  it('FAILS CLOSED when an async store rejects', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    setRateLimitStore({
      hit: () => Promise.reject(new Error('timeout')),
      release: () => {},
      reset: () => {},
    })
    expect((await checkRateLimits([rule('k', 100)])).allowed).toBe(false)
  })

  it('reaches DUPLICATE module instances — Next bundles this file more than once', async () => {
    // ⚠ REGRESSION TEST FOR A SILENT, MEASURED BUG.
    //
    // Next 16 evaluates this module separately for `instrumentation.ts` and for
    // the route handlers. A dev-server probe logged FOUR distinct instances in
    // one process: a boot hook installed a store on one instance, and every
    // request went through another that still held the in-process default. The
    // store connected, logged "installed", and served zero requests. Nothing
    // failed. That is why the installed store lives in a `Symbol.for` slot on
    // `globalThis` (per process) instead of a module-level `let` (per instance).
    //
    // `vi.resetModules()` reproduces the duplication: two genuinely separate
    // instances of this module, in one process, exactly as Next produces.
    vi.resetModules()
    const instanceA = await import('./rateLimit')
    vi.resetModules()
    const instanceB = await import('./rateLimit')
    expect(instanceA).not.toBe(instanceB) // really two instances, not a cached one

    const seen: string[] = []
    instanceA.setRateLimitStore({
      hit: (key, limit) => {
        seen.push(key)
        return { allowed: true, limit, remaining: 0, resetAt: 0, retryAfterSeconds: 0 }
      },
      release: () => {},
      reset: () => {
        seen.length = 0
      },
    })

    // Installed on A, must be used by B.
    await instanceB.checkRateLimits([rule('cross-instance', 5)])
    expect(seen).toEqual(['cross-instance'])

    instanceA.useDefaultRateLimitStore()
    vi.resetModules()
  })

  it('treats a third-party store’s malformed denial as a denial, not a pass', async () => {
    // A store that says `allowed: false` but returns a decision missing its
    // numbers must still deny. `guardRateLimit` used to read "denied with no
    // decision" as permission — the one fail-open line in the feature.
    setRateLimitStore({
      hit: () => ({
        allowed: false,
        limit: 0,
        remaining: 0,
        resetAt: 0,
        retryAfterSeconds: 0,
      }),
      release: () => {},
      reset: () => {},
    })
    const verdict = await checkRateLimits([rule('k', 10)])
    expect(verdict.allowed).toBe(false)
  })
})

describe('configured limits', () => {
  const KEYS = [
    'IDENTITY_RATELIMIT_TOKEN_USER_MAX',
    'IDENTITY_RATELIMIT_TOKEN_IP_MAX',
    'IDENTITY_RATELIMIT_ME_USER_MAX',
    'IDENTITY_RATELIMIT_ME_IP_MAX',
    'IDENTITY_RATELIMIT_RESOLVE_CONSUMER_MAX',
    'IDENTITY_RATELIMIT_SERVICE_AUTH_FAIL_IP_MAX',
    'IDENTITY_RATELIMIT_LOGIN_FAIL_IP_MAX',
    'IDENTITY_RATELIMIT_LOGIN_FAIL_IP_EMAIL_MAX',
    'IDENTITY_RATELIMIT_LOGIN_FAIL_IP_EMAIL_WINDOW_S',
  ] as const

  afterEach(() => {
    for (const key of KEYS) delete process.env[key]
  })

  it('has the documented defaults', () => {
    expect(rateLimits.tokenPerUser()).toBe(30)
    expect(rateLimits.tokenPerIp()).toBe(120)
    expect(rateLimits.mePerUser()).toBe(60)
    expect(rateLimits.mePerIp()).toBe(240)
    expect(rateLimits.resolvePerConsumer()).toBe(600)
    expect(rateLimits.serviceAuthFailurePerIp()).toBe(20)
    expect(rateLimits.loginFailPerIp()).toBe(100)
    expect(rateLimits.loginFailPerIpEmail()).toBe(4)
    expect(rateLimits.loginFailPerIpEmailWindowMs()).toBe(3_600_000)
  })

  it('is env-tunable, so ops can raise a ceiling without a code deploy', () => {
    process.env.IDENTITY_RATELIMIT_TOKEN_USER_MAX = '5'
    expect(rateLimits.tokenPerUser()).toBe(5)
  })

  it('ignores junk and zero rather than disabling a limit', () => {
    process.env.IDENTITY_RATELIMIT_TOKEN_USER_MAX = 'lots'
    expect(rateLimits.tokenPerUser()).toBe(30)
    process.env.IDENTITY_RATELIMIT_TOKEN_USER_MAX = '0'
    expect(rateLimits.tokenPerUser()).toBe(30)
    process.env.IDENTITY_RATELIMIT_TOKEN_USER_MAX = '-1'
    expect(rateLimits.tokenPerUser()).toBe(30)
  })
})
