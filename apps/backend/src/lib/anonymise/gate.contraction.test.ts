/**
 * 🔴 MEASURED 2026-10-28 on the Spark (scripts/measurements/q24): the model
 * reported "el centro de salud de San Gregorio" for the text "del centro de
 * salud de San Gregorio", and the place stayed in clear. The model drops the
 * "d" of the contraction "del" (de + el) when it copies the span, so the
 * literal does not match.
 */
import { AIClient } from '@edc/ai-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { aiServiceDetector, type SyncGenerator } from './detector'
import { ANONYMISE_VERIFY_ROUNDS_VAR, runAnonymisationGate } from './gate'

type H = { texto: string; tipo: string; identifica?: boolean }

function scriptedClient(perCall: H[][]): SyncGenerator {
  let n = 0
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({ text: JSON.stringify({ hallazgos: perCall[n++] ?? [] }), modelUsed: 'fake', provider: 'fake', costUsd: 0, traceId: 't' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as unknown as typeof fetch
  return new AIClient({ baseUrl: 'http://ai.test', apiKey: 'k', fetch: fetchImpl }) as unknown as SyncGenerator
}

const run = (text: string, perCall: H[][]) =>
  runAnonymisationGate({ contentKind: 'documento', text }, { detector: aiServiceDetector({ client: scriptedClient(perCall) }) })

beforeEach(() => vi.stubEnv(ANONYMISE_VERIFY_ROUNDS_VAR, ''))
afterEach(() => vi.unstubAllEnvs())

describe('a span copied as "el …" where the text says "del …"', () => {
  it('🔴 does not leave the place in clear', async () => {
    const text = 'La única trabajadora social del centro de salud de San Gregorio también participó.'
    const r = await run(text, [[{ texto: 'el centro de salud de San Gregorio', tipo: 'lugar', identifica: true }], []])
    const out = r.status === 'ready' ? r.redactedText : ''
    expect({ status: r.status, out }).toMatchObject({ status: 'ready' })
    expect(out).not.toContain('San Gregorio')
    expect(out).toBe('La única trabajadora social del [Domicilio A] también participó.')
  })

  it('also after "al", and beside a literal "el …" occurrence, one label for both', async () => {
    const text = 'Fui al centro de salud de San Gregorio. Luego el centro de salud de San Gregorio cerró.'
    const r = await run(text, [[{ texto: 'el centro de salud de San Gregorio', tipo: 'lugar' }], []])
    expect(r.status === 'ready' && r.redactedText).toBe('Fui al [Domicilio A]. Luego [Domicilio A] cerró.')
  })

  it('a person copied as "el …" from "del …" is redacted too', async () => {
    const text = 'La casa del Chacho Melgarejo quedó sola.'
    const r = await run(text, [[{ texto: 'el Chacho Melgarejo', tipo: 'persona' }], []])
    expect(r.status === 'ready' && r.redactedText).not.toContain('Melgarejo')
  })

  it('takes the rest only right after "del" or "al", never on its own', async () => {
    const text = 'Hay un centro de salud de San Gregorio y otro en Tlaltizapán.'
    const r = await run(text, [[{ texto: 'el centro de salud de San Gregorio', tipo: 'lugar' }], []])
    expect(r.status === 'ready' && r.redactedText).toBe(text)
  })
})
