/**
 * 🔴 THE BACKOFF THAT DID NOT EXIST.
 *
 * ai-service refuses `/v1` past 100 requests per minute. A 285-document seed hit
 * that wall and nothing in this backend waited — every refusal threw straight
 * through and left a row in a non-terminal state.
 *
 * What these tests pin down, in the order it matters:
 *   · a 429 is retried, and ONLY a 429;
 *   · the wait is the one the SERVER asked for, not a guess;
 *   · jitter is added, because the failure was N callers refused in the same
 *     second and a retry without a smear reproduces the burst one window later;
 *   · both ceilings hold — attempt count AND total sleep — so a request a human
 *     is waiting on cannot be parked indefinitely;
 *   · give-up RE-THROWS. The caller is the only thing that knows which row to
 *     write the failure onto, so a swallow here recreates the invisible-row bug.
 *
 * ⚠ `sleep` is injected in every test. A suite that actually waited would take
 * minutes and would be timing-flaky besides.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AI_RETRY_MAX_ATTEMPTS_VAR,
  AI_RETRY_TOTAL_WAIT_MS_VAR,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_TOTAL_WAIT_MS,
  JITTER_FRACTION,
  MAX_SINGLE_WAIT_MS,
  isRateLimited,
  maxAttempts,
  requestedWaitMs,
  totalWaitBudgetMs,
  waitWithJitter,
  withRateLimitRetry,
} from './aiRetry'

/** Shaped like `@edc/ai-client`'s `RateLimitError` without importing the class. */
function rateLimited(retryAfterSeconds = 5) {
  return Object.assign(new Error(`Rate limit exceeded. Retry after ~${retryAfterSeconds}s`), {
    status: 429,
    name: 'RateLimitError',
    retryAfterMs: retryAfterSeconds * 1000,
  })
}

/** Records what was slept instead of sleeping. */
function fakeSleep() {
  const slept: number[] = []
  return {
    slept,
    sleep: async (ms: number) => {
      slept.push(ms)
    },
  }
}

const NO_JITTER = () => 0

afterEach(() => {
  delete process.env[AI_RETRY_MAX_ATTEMPTS_VAR]
  delete process.env[AI_RETRY_TOTAL_WAIT_MS_VAR]
})

describe('isRateLimited — 🔴 the ONE error worth waiting on', () => {
  it('recognises a 429 by status, so a plain fake client works', () => {
    expect(isRateLimited(rateLimited())).toBe(true)
    expect(isRateLimited({ status: 429 })).toBe(true)
  })

  it('🔴 refuses every error that will not fix itself', () => {
    // Retrying any of these wastes the caller's time; a 500 is worse, because
    // the work may have half-happened and repeating it could duplicate an ingest.
    for (const err of [
      Object.assign(new Error('auth'), { status: 401 }),
      Object.assign(new Error('budget'), { status: 402 }),
      Object.assign(new Error('bad'), { status: 400 }),
      Object.assign(new Error('gone'), { status: 404 }),
      Object.assign(new Error('boom'), { status: 500 }),
      new Error('socket hang up'),
      null,
      undefined,
    ]) {
      expect(isRateLimited(err)).toBe(false)
    }
  })
})

describe('the wait comes from the server', () => {
  it('uses `retryAfterMs`', () => {
    expect(requestedWaitMs(rateLimited(7))).toBe(7_000)
  })

  it('falls back to one window when the error carries no timing', () => {
    expect(requestedWaitMs({ status: 429 })).toBe(MAX_SINGLE_WAIT_MS)
  })

  it('clamps a single wait so one absurd answer cannot burn the whole budget', () => {
    expect(requestedWaitMs(rateLimited(3600))).toBe(MAX_SINGLE_WAIT_MS)
  })

  it('🔴 adds jitter proportional to the wait', () => {
    // N documents refused in the same second are told the same number. Without
    // a per-waiter smear they all wake together and re-stampede the window that
    // just opened — the retry becomes the original burst, one minute later.
    expect(waitWithJitter(rateLimited(20), () => 0)).toBe(20_000)
    expect(waitWithJitter(rateLimited(20), () => 1)).toBe(20_000 + 20_000 * JITTER_FRACTION)
    expect(waitWithJitter(rateLimited(20), () => 0.5)).toBeGreaterThan(20_000)
  })

  it('caps the jitter so it never dominates the wait', () => {
    // 60s * 0.25 = 15s, above MAX_JITTER_MS.
    expect(waitWithJitter(rateLimited(60), () => 1)).toBe(60_000 + 5_000)
  })
})

describe('withRateLimitRetry — the loop', () => {
  it('does not retry a call that succeeds', async () => {
    const fn = vi.fn(async () => 'ok')
    // ⚠ `sleep` MUST be passed in. Without it this asserted an array the code
    // could never touch, and passed whatever the loop did.
    const { slept, sleep } = fakeSleep()
    await expect(withRateLimitRetry(fn, { sleep })).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(slept).toEqual([])
  })

  it('🔴 retries a 429 and succeeds on the second attempt', async () => {
    let calls = 0
    const fn = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw rateLimited(12)
      return 'enqueued'
    })
    const { slept, sleep } = fakeSleep()

    await expect(withRateLimitRetry(fn, { sleep, random: NO_JITTER })).resolves.toBe('enqueued')
    expect(fn).toHaveBeenCalledTimes(2)
    // Waited exactly what the server asked, no more.
    expect(slept).toEqual([12_000])
  })

  it('🔴 does NOT retry anything else, and re-throws immediately', async () => {
    const fn = vi.fn(async () => {
      throw Object.assign(new Error('budget exhausted'), { status: 402 })
    })
    const { slept, sleep } = fakeSleep()

    await expect(withRateLimitRetry(fn, { sleep })).rejects.toThrow('budget exhausted')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(slept).toEqual([])
  })

  it('🔴 gives up after the attempt ceiling and RE-THROWS the last error', async () => {
    // The re-throw is the contract. The caller is the only thing that knows
    // which row to record the failure on; swallowing here would reproduce the
    // 99 rows that sat in `publishing` with nothing written down.
    const fn = vi.fn(async () => {
      throw rateLimited(3)
    })
    const { slept, sleep } = fakeSleep()

    await expect(
      withRateLimitRetry(fn, { sleep, random: NO_JITTER, attempts: 4 }),
    ).rejects.toMatchObject({ status: 429 })
    expect(fn).toHaveBeenCalledTimes(4)
    expect(slept).toEqual([3_000, 3_000, 3_000])
  })

  it('🔴 stops BEFORE a sleep that would overrun the total budget', async () => {
    // Stopping after the sleep would hold the request open for exactly the
    // duration the budget exists to bound.
    const fn = vi.fn(async () => {
      throw rateLimited(45)
    })
    const { slept, sleep } = fakeSleep()

    await expect(
      withRateLimitRetry(fn, { sleep, random: NO_JITTER, attempts: 10, budgetMs: 60_000 }),
    ).rejects.toMatchObject({ status: 429 })
    // One 45s sleep fits; a second would reach 90s, past the 60s budget.
    expect(slept).toEqual([45_000])
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('a zero budget means "try once, never sleep"', async () => {
    const fn = vi.fn(async () => {
      throw rateLimited(1)
    })
    const { slept, sleep } = fakeSleep()
    await expect(withRateLimitRetry(fn, { sleep, budgetMs: 0, attempts: 5 })).rejects.toThrow()
    expect(slept).toEqual([])
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('logs each wait and the give-up, so a stuck queue is traceable', async () => {
    const warn = vi.fn()
    const fn = vi.fn(async () => {
      throw rateLimited(2)
    })
    const { sleep } = fakeSleep()
    await expect(
      withRateLimitRetry(fn, { sleep, attempts: 2, log: { warn }, label: 'publish document 99' }),
    ).rejects.toThrow()
    const messages = warn.mock.calls.map((c) => String(c[1]))
    expect(messages.some((m) => m.includes('rate-limited') && m.includes('publish document 99'))).toBe(true)
    expect(messages.some((m) => m.includes('giving up'))).toBe(true)
  })
})

describe('the ceilings are configurable, and have sane defaults', () => {
  it('defaults to 4 attempts and a 120s sleep budget', () => {
    expect(maxAttempts()).toBe(DEFAULT_MAX_ATTEMPTS)
    expect(totalWaitBudgetMs()).toBe(DEFAULT_TOTAL_WAIT_MS)
  })

  it('a bulk job can raise both, because nobody is waiting on the request', () => {
    process.env[AI_RETRY_MAX_ATTEMPTS_VAR] = '12'
    process.env[AI_RETRY_TOTAL_WAIT_MS_VAR] = '600000'
    expect(maxAttempts()).toBe(12)
    expect(totalWaitBudgetMs()).toBe(600_000)
  })

  it('garbage in the env falls back to the default rather than to zero attempts', () => {
    process.env[AI_RETRY_MAX_ATTEMPTS_VAR] = 'many'
    process.env[AI_RETRY_TOTAL_WAIT_MS_VAR] = '-1'
    expect(maxAttempts()).toBe(DEFAULT_MAX_ATTEMPTS)
    expect(totalWaitBudgetMs()).toBe(DEFAULT_TOTAL_WAIT_MS)
  })

  it('🔴 a DECLARED-BUT-BLANK budget is "unset", not zero', () => {
    // `Number('')` is 0, and 0 is a legal budget — so a compose/Coolify env file
    // that declares the variable and leaves it empty would silently turn every
    // retry off and look exactly like the bug this module fixes.
    for (const blank of ['', '   ']) {
      process.env[AI_RETRY_TOTAL_WAIT_MS_VAR] = blank
      expect(totalWaitBudgetMs()).toBe(DEFAULT_TOTAL_WAIT_MS)
    }
    // An explicit zero is still honoured — it is a real choice.
    process.env[AI_RETRY_TOTAL_WAIT_MS_VAR] = '0'
    expect(totalWaitBudgetMs()).toBe(0)
  })
})

describe('withRateLimitRetry — retryTransient (fake timers, the real sleep)', () => {
  /** Shaped like `@edc/ai-client`'s errors without importing the classes. */
  const unavailable = (retryAfterMs?: number) =>
    Object.assign(new Error('Service Unavailable'), { status: 503, retryAfterMs })
  const fetchFailed = (code = 'ECONNRESET') =>
    Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error(code), { code }),
    })
  const ourTimeout = () =>
    Object.assign(new Error('timed out'), {
      name: 'RequestAbortedError',
      status: 0,
      reason: 'timeout',
    })
  const cancelled = () =>
    Object.assign(new Error('cancelled'), {
      name: 'RequestAbortedError',
      status: 0,
      reason: 'cancel',
    })

  /** Run `withRateLimitRetry` to completion under fake timers; returns the waits taken. */
  async function drive<T>(
    fn: () => Promise<T>,
    opts: Parameters<typeof withRateLimitRetry>[1] = {},
  ) {
    vi.useFakeTimers()
    try {
      const waits: number[] = []
      const p = withRateLimitRetry(fn, { random: NO_JITTER, retryTransient: true, ...opts })
      const settled = p.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      for (let i = 0; i < 20; i += 1) {
        const before = Date.now()
        await vi.advanceTimersToNextTimerAsync()
        if (Date.now() > before) waits.push(Date.now() - before)
      }
      return { ...(await settled), waits }
    } finally {
      vi.useRealTimers()
    }
  }

  it('429 → success', async () => {
    const fn = vi.fn().mockRejectedValueOnce(rateLimited(2)).mockResolvedValueOnce('ok')
    const r = await drive(fn)
    expect(r.ok && r.value).toBe('ok')
    expect(r.waits).toEqual([2_000])
  })

  it('429 on every attempt → gives up after 1 + 3 retries and re-throws', async () => {
    const err = rateLimited(1)
    const fn = vi.fn().mockRejectedValue(err)
    const r = await drive(fn)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toBe(err)
    expect(fn).toHaveBeenCalledTimes(DEFAULT_MAX_ATTEMPTS)
  })

  it('honours Retry-After on a 503 too', async () => {
    const fn = vi.fn().mockRejectedValueOnce(unavailable(7_000)).mockResolvedValueOnce('ok')
    const r = await drive(fn)
    expect(r.ok && r.value).toBe('ok')
    expect(r.waits).toEqual([7_000])
  })

  it('503 with no hint → exponential backoff: 1 s, 2 s, 4 s', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(unavailable())
      .mockRejectedValueOnce(unavailable())
      .mockRejectedValueOnce(unavailable())
      .mockResolvedValueOnce('ok')
    const r = await drive(fn)
    expect(r.ok && r.value).toBe('ok')
    expect(r.waits).toEqual([1_000, 2_000, 4_000])
  })

  it.each([
    ['ECONNRESET', fetchFailed('ECONNRESET')],
    ['ETIMEDOUT', fetchFailed('ETIMEDOUT')],
    ['a bare fetch failure', new TypeError('fetch failed')],
    ['an abort from our own timeout', ourTimeout()],
  ])('network error (%s) → retry', async (_label, err) => {
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce('ok')
    const r = await drive(fn)
    expect(r.ok && r.value).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it.each([500, 502, 504])('a %i is retried (opt-in transient)', async (status) => {
    const err = Object.assign(new Error(`status ${status}`), { status })
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce('ok')
    const r = await drive(fn)
    expect(r.ok && r.value).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it.each([400, 401, 422, 402])('a %i is not retried', async (status) => {
    const err = Object.assign(new Error(`status ${status}`), { status })
    const fn = vi.fn().mockRejectedValue(err)
    const r = await drive(fn)
    expect(!r.ok && r.error).toBe(err)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('a caller cancel is not retried', async () => {
    const fn = vi.fn().mockRejectedValue(cancelled())
    const r = await drive(fn)
    expect(r.ok).toBe(false)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('🔴 the total ceiling stops further retries', async () => {
    const err = unavailable()
    const fn = vi.fn().mockRejectedValue(err)
    // 1 s + 2 s fit in 3.5 s; the next 4 s wait would not.
    const r = await drive(fn, { budgetMs: 3_500, attempts: 10 })
    expect(!r.ok && r.error).toBe(err)
    expect(r.waits).toEqual([1_000, 2_000])
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('🔴 WITHOUT the option, 503 and network errors still throw at once', async () => {
    for (const err of [unavailable(), fetchFailed(), ourTimeout()]) {
      const fn = vi.fn().mockRejectedValue(err)
      const r = await drive(fn, { retryTransient: false })
      expect(!r.ok && r.error).toBe(err)
      expect(fn).toHaveBeenCalledTimes(1)
    }
  })
})
