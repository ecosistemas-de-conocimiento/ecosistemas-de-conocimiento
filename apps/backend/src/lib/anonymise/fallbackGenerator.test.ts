/**
 * Spark first, ai-service when the Spark is unavailable. Fakes only: no network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hostedSync = vi.fn()
vi.mock('@/lib/aiClient', () => ({
  getAppAIClient: () => ({ generate: { sync: hostedSync } }),
}))

import { aiServiceDetector, DetectorFailure, type SyncGenerator } from './detector'
import {
  _resetFallbackBreakerForTests,
  cooldownMsFromEnv,
  fallbackModeFromEnv,
  fallbackReason,
  withHostedFallback,
} from './fallbackGenerator'
import { OpenAICompatHttpError, RequestAbortedError } from './openaiCompatGenerator'

const REQ = {
  unit: { unitKey: 'k', unitType: 'anonymise-detect', input: { userPrompt: 'Me acompañó Teodulfo.' } },
}

function gen(impl: () => Promise<{ text: string }>): SyncGenerator & { calls: () => number } {
  const fn = vi.fn(impl)
  return { generate: { sync: fn }, calls: () => fn.mock.calls.length }
}

const ok = (text: string) => async () => ({ text })
const fail = (err: unknown) => async () => {
  throw err
}

function setup(sparkImpl: () => Promise<{ text: string }>, cooldownMs = 60_000) {
  let t = 1_000
  const spark = gen(sparkImpl)
  const hosted = gen(ok('hosted'))
  const warns: string[] = []
  const errors: string[] = []
  const wrapped = withHostedFallback(spark, async () => hosted, {
    cooldownMs,
    now: () => t,
    warn: (l) => warns.push(l),
    error: (l) => errors.push(l),
  })
  return { spark, hosted, wrapped, warns, errors, advance: (ms: number) => (t += ms) }
}

beforeEach(() => _resetFallbackBreakerForTests())

describe('withHostedFallback', () => {
  it('uses the Spark when it answers', async () => {
    const s = setup(ok('spark'))
    await expect(s.wrapped.generate.sync(REQ)).resolves.toEqual({ text: 'spark' })
    expect(s.hosted.calls()).toBe(0)
    expect(s.warns).toEqual([])
  })

  it.each([
    ['network error', new TypeError('fetch failed'), 'network'],
    ['ECONNREFUSED', Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), 'network-ECONNREFUSED'],
    ['DNS failure', Object.assign(new Error('x'), { code: 'ENOTFOUND' }), 'network-ENOTFOUND'],
    ['timeout', new RequestAbortedError(90_000), 'timeout'],
    ['HTTP 500', new OpenAICompatHttpError(500, 0), 'http-500'],
    ['HTTP 503', new OpenAICompatHttpError(503, 0), 'http-503'],
    ['HTTP 429', new OpenAICompatHttpError(429, 0), 'http-429'],
  ])('falls back on %s and logs the reason, never the text', async (_label, err, reason) => {
    const s = setup(fail(err))
    await expect(s.wrapped.generate.sync(REQ, { timeoutMs: 5 })).resolves.toEqual({ text: 'hosted' })
    expect(s.hosted.calls()).toBe(1)
    expect(s.warns).toHaveLength(1)
    expect(s.warns[0]).toContain(`(${reason})`)
    expect(s.warns[0]).not.toContain('Teodulfo')
  })

  it.each([400, 401, 403, 404])('does NOT fall back on HTTP %i: throws and logs at ERROR', async (status) => {
    const s = setup(fail(new OpenAICompatHttpError(status, 0)))
    await expect(s.wrapped.generate.sync(REQ)).rejects.toMatchObject({ status })
    expect(s.hosted.calls()).toBe(0)
    expect(s.errors[0]).toContain(`HTTP ${status}`)
    // ...and does not open the breaker.
    await s.wrapped.generate.sync(REQ).catch(() => {})
    expect(s.spark.calls()).toBe(2)
  })

  it('does not fall back on an unusable reply', async () => {
    const s = setup(fail(new Error('anonymise-detect backend returned no message content')))
    await expect(s.wrapped.generate.sync(REQ)).rejects.toThrow('no message content')
    expect(s.hosted.calls()).toBe(0)
  })

  it('cooldown skips the Spark, then re-probes it', async () => {
    let sparkUp = false
    const s = setup(async () => {
      if (!sparkUp) throw new TypeError('fetch failed')
      return { text: 'spark' }
    }, 60_000)

    await s.wrapped.generate.sync(REQ) // trips the breaker
    expect(s.spark.calls()).toBe(1)

    s.advance(59_000)
    await expect(s.wrapped.generate.sync(REQ)).resolves.toEqual({ text: 'hosted' })
    expect(s.spark.calls()).toBe(1) // skipped
    expect(s.warns[1]).toContain('cooldown')

    sparkUp = true
    s.advance(2_000)
    await expect(s.wrapped.generate.sync(REQ)).resolves.toEqual({ text: 'spark' })
    expect(s.spark.calls()).toBe(2) // re-probed
    expect(s.hosted.calls()).toBe(2)
  })

  it('a failed re-probe opens the breaker again', async () => {
    const s = setup(fail(new OpenAICompatHttpError(502, 0)), 10_000)
    await s.wrapped.generate.sync(REQ)
    s.advance(10_001)
    await s.wrapped.generate.sync(REQ)
    await s.wrapped.generate.sync(REQ)
    expect(s.spark.calls()).toBe(2)
    expect(s.hosted.calls()).toBe(3)
  })

  it('a hosted failure propagates (aiRetry decides what is retried)', async () => {
    const spark = gen(fail(new TypeError('fetch failed')))
    const hosted = gen(fail(Object.assign(new Error('rate'), { status: 429 })))
    const w = withHostedFallback(spark, async () => hosted, { cooldownMs: 1_000, warn: () => {} })
    await expect(w.generate.sync(REQ)).rejects.toMatchObject({ status: 429 })
  })
})

describe('env', () => {
  it('ANONYMISE_DETECT_FALLBACK defaults to hosted, accepts none, rejects typos', () => {
    expect(fallbackModeFromEnv({})).toBe('hosted')
    expect(fallbackModeFromEnv({ ANONYMISE_DETECT_FALLBACK: ' ' })).toBe('hosted')
    expect(fallbackModeFromEnv({ ANONYMISE_DETECT_FALLBACK: 'none' })).toBe('none')
    expect(() => fallbackModeFromEnv({ ANONYMISE_DETECT_FALLBACK: 'off' })).toThrow()
  })

  it('ANONYMISE_DETECT_FALLBACK_COOLDOWN_S defaults to 60 s', () => {
    expect(cooldownMsFromEnv({})).toBe(60_000)
    expect(cooldownMsFromEnv({ ANONYMISE_DETECT_FALLBACK_COOLDOWN_S: '5' })).toBe(5_000)
    expect(cooldownMsFromEnv({ ANONYMISE_DETECT_FALLBACK_COOLDOWN_S: 'x' })).toBe(60_000)
  })

  it('fallbackReason ignores non-errors', () => {
    expect(fallbackReason(null)).toBeNull()
    expect(fallbackReason('fetch failed')).toBeNull()
  })
})

describe('aiServiceDetector with the Spark configured', () => {
  beforeEach(() => {
    vi.stubEnv('ANONYMISE_DETECT_URL', 'http://spark.test')
    vi.stubEnv('ANONYMISE_DETECT_MODEL', 'qwen3-30b')
    vi.stubEnv('ANONYMISE_DETECT_MIN_GAP_MS', '0')
    vi.spyOn(console, 'info').mockImplementation(() => {})
    hostedSync.mockReset()
    hostedSync.mockResolvedValue({ text: JSON.stringify({ hallazgos: [{ texto: 'Teodulfo', tipo: 'persona' }] }) })
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('default (hosted): a dead Spark falls back to ai-service and the gate row says +fallback', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    vi.stubGlobal('fetch', fetchMock)

    const detector = aiServiceDetector({ retry: { attempts: 2, sleep: async () => {} } })
    expect(detector.name).toBe('openai-compat:qwen3-30b+fallback')
    const found = await detector.detect({ text: 'Me acompañó Teodulfo.', contentKind: 'testimonio' })

    expect(found).toEqual([{ text: 'Teodulfo', type: 'persona' }])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(hostedSync).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls.flat().join('\n')).not.toContain('Teodulfo')
  })

  it('a hosted 5xx after fallback is retried on the hosted path only, not Spark × hosted', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    vi.stubGlobal('fetch', fetchMock)
    hostedSync.mockReset()
    hostedSync
      .mockRejectedValueOnce(Object.assign(new Error('x'), { status: 503 }))
      .mockResolvedValue({ text: '{"hallazgos":[]}' })

    await aiServiceDetector({ retry: { attempts: 4, sleep: async () => {} } }).detect({
      text: 'Hola.',
      contentKind: 'conversacion',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(hostedSync).toHaveBeenCalledTimes(2)
  })

  it('a Spark 401 does not fall back: DetectorFailure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 401 })))
    const err = await aiServiceDetector({ retry: { attempts: 2, sleep: async () => {} } })
      .detect({ text: 'Me acompañó Teodulfo.', contentKind: 'testimonio' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DetectorFailure)
    expect(hostedSync).not.toHaveBeenCalled()
  })

  it('ANONYMISE_DETECT_FALLBACK=none fails closed and never calls ai-service', async () => {
    vi.stubEnv('ANONYMISE_DETECT_FALLBACK', 'none')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
    )
    const detector = aiServiceDetector({ retry: { attempts: 2, sleep: async () => {} } })
    expect(detector.name).toBe('openai-compat:qwen3-30b')
    const err = await detector
      .detect({ text: 'Me acompañó Teodulfo.', contentKind: 'testimonio' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DetectorFailure)
    expect(hostedSync).not.toHaveBeenCalled()
  })
})
