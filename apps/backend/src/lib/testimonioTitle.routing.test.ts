/**
 * 🔴 Title generation goes through the gate detector's backend choice: the
 * self-hosted box (`ANONYMISE_DETECT_URL`) first, the hosted model only when
 * `ANONYMISE_DETECT_FALLBACK` allows it, and NEVER for a held row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { hostedSync, getAppAIClient } = vi.hoisted(() => {
  const hostedSync = vi.fn(async (_req?: unknown, _opts?: unknown) => ({ text: 'Una madre pide intérprete en la escuela' }))
  const getAppAIClient = vi.fn((_org?: unknown) => ({ generate: { sync: hostedSync } }))
  return { hostedSync, getAppAIClient }
})
vi.mock('./aiClient', () => ({ getAppAIClient }))
vi.mock('@/lib/aiClient', () => ({ getAppAIClient }))

import { _resetFallbackBreakerForTests } from './anonymise/fallbackGenerator'
import { scheduleTestimonioTitle, titleClientFromEnv } from './testimonioTitle'

const REQ = {
  unit: { unitKey: 'k', unitType: 't', input: { userPrompt: 'hola' }, systemPrompt: 's' },
}

const sparkOk = vi.fn(async () =>
  new Response(JSON.stringify({ choices: [{ message: { content: 'Desde la caja propia' } }] }), { status: 200 }),
)
const sparkDown = vi.fn(async () => new Response('', { status: 503 }))

const SPARK = { ANONYMISE_DETECT_URL: 'http://spark.local:8000', ANONYMISE_DETECT_MODEL: 'qwen' }

beforeEach(() => {
  _resetFallbackBreakerForTests()
  hostedSync.mockClear()
  getAppAIClient.mockClear()
  sparkOk.mockClear()
  sparkDown.mockClear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('titleClientFromEnv', () => {
  it('no self-hosted URL, default fallback: the hosted model', async () => {
    const c = titleClientFromEnv({ organizationId: 7, source: 'redacted', env: {} })
    expect(c).not.toBeNull()
    await c!.generate.sync(REQ)
    expect(getAppAIClient).toHaveBeenCalledWith(7)
  })

  it('🔴 no self-hosted URL and FALLBACK=none: no client, no hosted call', () => {
    expect(titleClientFromEnv({ organizationId: 7, source: 'redacted', env: { ANONYMISE_DETECT_FALLBACK: 'none' } })).toBeNull()
    expect(getAppAIClient).not.toHaveBeenCalled()
  })

  it('🔴 a bad FALLBACK value fails closed (no hosted)', () => {
    expect(titleClientFromEnv({ organizationId: 7, source: 'redacted', env: { ANONYMISE_DETECT_FALLBACK: 'maybe' } })).toBeNull()
  })

  it('self-hosted URL: the Spark answers, the hosted model is never asked', async () => {
    const c = titleClientFromEnv({ organizationId: 7, source: 'redacted', env: SPARK, fetch: sparkOk as never })
    expect((await c!.generate.sync(REQ)).text).toBe('Desde la caja propia')
    expect(sparkOk).toHaveBeenCalledOnce()
    expect(getAppAIClient).not.toHaveBeenCalled()
  })

  it('Spark down, default fallback, cleared row: falls back to hosted', async () => {
    const c = titleClientFromEnv({ organizationId: 7, source: 'redacted', env: SPARK, fetch: sparkDown as never })
    await c!.generate.sync(REQ)
    expect(hostedSync).toHaveBeenCalledOnce()
  })

  it('🔴 Spark down, FALLBACK=none: throws, no hosted call', async () => {
    const c = titleClientFromEnv({
      organizationId: 7,
      source: 'redacted',
      env: { ...SPARK, ANONYMISE_DETECT_FALLBACK: 'none' },
      fetch: sparkDown as never,
    })
    await expect(c!.generate.sync(REQ)).rejects.toThrow()
    expect(getAppAIClient).not.toHaveBeenCalled()
  })

  it('🔴 HELD row, Spark down, default fallback: still never hosted', async () => {
    const c = titleClientFromEnv({ organizationId: 7, source: 'held', env: SPARK, fetch: sparkDown as never })
    await expect(c!.generate.sync(REQ)).rejects.toThrow()
    expect(getAppAIClient).not.toHaveBeenCalled()
  })

  it('🔴 HELD row, no Spark configured: no client at all', () => {
    expect(titleClientFromEnv({ organizationId: 7, source: 'held', env: {} })).toBeNull()
  })
})

describe('scheduleTestimonioTitle — production wiring', () => {
  it('🔴 a held row with no Spark sends nothing to the hosted model and writes nothing', async () => {
    const saved = { ...process.env }
    delete process.env.ANONYMISE_DETECT_URL
    delete process.env.ANONYMISE_DETECT_FALLBACK
    const payload = { find: vi.fn(async () => ({ docs: [] })), db: { drizzle: { execute: vi.fn() } } }
    try {
      expect(
        scheduleTestimonioTitle({
          contentKind: 'testimonio',
          docId: 1,
          organizationId: 7,
          redactedText: 'Fui con Ofelia al centro de salud.',
          source: 'held',
          payload,
        }),
      ).toBe(true)
      await new Promise((r) => setTimeout(r, 20))
    } finally {
      process.env = saved
    }
    expect(getAppAIClient).not.toHaveBeenCalled()
    expect(payload.db.drizzle.execute).not.toHaveBeenCalled()
  })
})

describe('🔴 testimonioTitles switched off (lib/features.ts)', () => {
  it('no model call and no write', async () => {
    const { invalidateFeatures } = await import('./features')
    invalidateFeatures()
    const payload = {
      find: vi.fn(async () => ({ docs: [] })),
      findByID: vi.fn(async () => ({ id: 7, features: { testimonioTitles: false } })),
      db: { drizzle: { execute: vi.fn() } },
    }
    expect(
      scheduleTestimonioTitle({
        contentKind: 'testimonio',
        docId: 1,
        organizationId: 7,
        redactedText: 'Fui con [Persona A] al centro de salud.',
        payload,
      }),
    ).toBe(true)
    await new Promise((r) => setTimeout(r, 20))
    expect(payload.findByID).toHaveBeenCalled()
    expect(getAppAIClient).not.toHaveBeenCalled()
    expect(payload.find).not.toHaveBeenCalled()
    expect(payload.db.drizzle.execute).not.toHaveBeenCalled()
    invalidateFeatures()
  })
})
