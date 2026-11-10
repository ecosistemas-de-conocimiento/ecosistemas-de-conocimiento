/**
 * P-05 (audit 2026-11-10): `detectorFallback = none` with NO
 * `ANONYMISE_DETECT_URL` must not reach the hosted detector either. The
 * document is held; nothing goes to ai-service. Fake `aiClient`, no network.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

const hostedCalls: unknown[] = []
vi.mock('@/lib/aiClient', () => ({
  getAppAIClient: () => ({
    generate: {
      sync: async (req: unknown) => {
        hostedCalls.push(req)
        return { content: '{"hallazgos":[]}', text: '{"hallazgos":[]}' }
      },
    },
  }),
}))

const { aiServiceDetector, DetectorFailure } = await import('./detector')
const { runAnonymisationGate } = await import('./gate')

afterEach(() => {
  vi.unstubAllEnvs()
  hostedCalls.length = 0
})

describe('aiServiceDetector — 🔴 `none` without a Spark (P-05)', () => {
  it('throws a non-infrastructure DetectorFailure and never calls ai-service', async () => {
    vi.stubEnv('ANONYMISE_DETECT_URL', '')
    vi.stubEnv('ANONYMISE_DETECT_FALLBACK', 'none')
    const detector = aiServiceDetector()
    const err = await detector.detect({ text: 'Me acompañó Teodulfo Ramírez.', contentKind: 'testimonio' }).catch((e) => e)
    expect(err).toBeInstanceOf(DetectorFailure)
    expect((err as InstanceType<typeof DetectorFailure>).infrastructure).toBe(false)
    expect(hostedCalls).toHaveLength(0)
    expect(detector.name).toBe('none')
  })

  it('the gate HOLDS the document (not retryable), with no text', async () => {
    vi.stubEnv('ANONYMISE_DETECT_URL', '')
    vi.stubEnv('ANONYMISE_DETECT_FALLBACK', 'none')
    const result = await runAnonymisationGate(
      { contentKind: 'testimonio', text: 'Me acompañó Teodulfo Ramírez.' },
      { detector: aiServiceDetector() },
    )
    if (result.status !== 'hold') throw new Error('expected hold')
    expect(result.stage).toBe('content')
    expect(result.retryable).toBeUndefined()
    expect(result.redactedText).toBeUndefined()
    expect(hostedCalls).toHaveLength(0)
  })

  it('with `hosted` (or unset), ai-service is still the detector', async () => {
    vi.stubEnv('ANONYMISE_DETECT_URL', '')
    vi.stubEnv('ANONYMISE_DETECT_FALLBACK', 'hosted')
    await aiServiceDetector()
      .detect({ text: 'Hola.', contentKind: 'conversacion' })
      .catch(() => {})
    expect(hostedCalls.length).toBeGreaterThan(0)
  })
})
