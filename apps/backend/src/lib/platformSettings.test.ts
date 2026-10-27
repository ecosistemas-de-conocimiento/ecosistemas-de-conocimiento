/**
 * 🔴 The runtime detector-fallback switch (backlog #39): env until an admin
 * saves a value, then the stored value — read by the detector and by title
 * generation, cached ≤ 60 s.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { hostedSync, getAppAIClient } = vi.hoisted(() => {
  const hostedSync = vi.fn(async () => ({ text: '{"hallazgos":[]}' }))
  const getAppAIClient = vi.fn(() => ({ generate: { sync: hostedSync } }))
  return { hostedSync, getAppAIClient }
})
vi.mock('@/lib/aiClient', () => ({ getAppAIClient }))
vi.mock('./aiClient', () => ({ getAppAIClient }))

import { _resetFallbackBreakerForTests } from './anonymise/fallbackGenerator'
import { aiServiceDetector, DetectorFailure } from './anonymise/detector'
import {
  detectorFallbackMode,
  invalidatePlatformSettings,
  registerPlatformSettings,
  storedDetectorFallback,
} from './platformSettings'

const stored = (value: unknown) => {
  const findGlobal = vi.fn(async () => ({ detectorFallback: value }))
  registerPlatformSettings({ findGlobal } as never)
  return findGlobal
}

beforeEach(() => {
  _resetFallbackBreakerForTests()
  hostedSync.mockClear()
  getAppAIClient.mockClear()
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  registerPlatformSettings(null)
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('detectorFallbackMode', () => {
  it('unregistered (scripts, tests): the env value, as before', async () => {
    expect(await detectorFallbackMode({})).toBe('hosted')
    expect(await detectorFallbackMode({ ANONYMISE_DETECT_FALLBACK: 'none' })).toBe('none')
  })

  it('nothing stored (NULL): the env value', async () => {
    stored(null)
    expect(await detectorFallbackMode({ ANONYMISE_DETECT_FALLBACK: 'none' })).toBe('none')
  })

  it('a stored value wins over env, both directions', async () => {
    stored('none')
    expect(await detectorFallbackMode({})).toBe('none')
    invalidatePlatformSettings()
    stored('hosted')
    expect(await detectorFallbackMode({ ANONYMISE_DETECT_FALLBACK: 'none' })).toBe('hosted')
  })

  it('🔴 a failed read FAILS CLOSED: none, whatever env says, never throws', async () => {
    registerPlatformSettings({ findGlobal: async () => { throw new Error('db down') } } as never)
    expect(await detectorFallbackMode({ ANONYMISE_DETECT_FALLBACK: 'none' })).toBe('none')
    expect(await detectorFallbackMode({ ANONYMISE_DETECT_FALLBACK: 'hosted' })).toBe('none')
    expect(await detectorFallbackMode({})).toBe('none')
  })

  it('a failed read is not cached: the next read retries the store', async () => {
    const findGlobal = vi
      .fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValue({ detectorFallback: 'hosted' })
    registerPlatformSettings({ findGlobal } as never)
    expect(await detectorFallbackMode({})).toBe('none')
    expect(await detectorFallbackMode({})).toBe('hosted')
  })

  it('a bad env value still throws when nothing is stored (→ HOLD)', async () => {
    await expect(detectorFallbackMode({ ANONYMISE_DETECT_FALLBACK: 'maybe' })).rejects.toThrow()
  })

  it('caches for 30 s (≤ 60 s), then re-reads; invalidate clears it', async () => {
    const findGlobal = stored('none')
    let t = 1_000_000
    const now = () => t
    await storedDetectorFallback(now)
    t += 29_000
    await storedDetectorFallback(now)
    expect(findGlobal).toHaveBeenCalledTimes(1)
    t += 2_000
    await storedDetectorFallback(now)
    expect(findGlobal).toHaveBeenCalledTimes(2)
    invalidatePlatformSettings()
    await storedDetectorFallback(now)
    expect(findGlobal).toHaveBeenCalledTimes(3)
  })
})

describe('🔴 the gate detector honours the stored switch', () => {
  const sparkDown = () =>
    vi.fn(async () => {
      throw new TypeError('fetch failed')
    })

  beforeEach(() => {
    vi.stubEnv('ANONYMISE_DETECT_URL', 'http://spark.test')
    vi.stubEnv('ANONYMISE_DETECT_MODEL', 'm')
    vi.stubEnv('ANONYMISE_DETECT_MIN_GAP_MS', '0')
  })

  it('stored `none`, env default `hosted`: a dead Spark fails closed, no hosted call', async () => {
    vi.stubEnv('ANONYMISE_DETECT_FALLBACK', '')
    stored('none')
    vi.stubGlobal('fetch', sparkDown())
    const err = await aiServiceDetector({ retry: { attempts: 1, sleep: async () => {} } })
      .detect({ text: 'Me acompañó Teodulfo.', contentKind: 'testimonio' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DetectorFailure)
    expect(getAppAIClient).not.toHaveBeenCalled()
  })

  it('stored `hosted`, env `none`: a dead Spark falls back to ai-service', async () => {
    vi.stubEnv('ANONYMISE_DETECT_FALLBACK', 'none')
    stored('hosted')
    vi.stubGlobal('fetch', sparkDown())
    await aiServiceDetector({ retry: { attempts: 1, sleep: async () => {} } }).detect({
      text: 'Me acompañó Teodulfo.',
      contentKind: 'testimonio',
    })
    expect(hostedSync).toHaveBeenCalled()
  })

  it('🔴 the gate row names the EFFECTIVE backend: stored `none` drops +fallback (env says hosted)', async () => {
    vi.stubEnv('ANONYMISE_DETECT_FALLBACK', 'hosted')
    stored('none')
    vi.stubGlobal('fetch', sparkDown())
    const detector = aiServiceDetector({ retry: { attempts: 1, sleep: async () => {} } })
    await detector.detect({ text: 'Me acompañó Teodulfo.', contentKind: 'testimonio' }).catch(() => {})
    expect(detector.name).toBe('openai-compat:m')
  })

  it('🔴 …and stored `hosted` adds it (env says none)', async () => {
    vi.stubEnv('ANONYMISE_DETECT_FALLBACK', 'none')
    stored('hosted')
    vi.stubGlobal('fetch', sparkDown())
    const detector = aiServiceDetector({ retry: { attempts: 1, sleep: async () => {} } })
    await detector.detect({ text: 'Me acompañó Teodulfo.', contentKind: 'testimonio' })
    expect(detector.name).toBe('openai-compat:m+fallback')
  })
})
