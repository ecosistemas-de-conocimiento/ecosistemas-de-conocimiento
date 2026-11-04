/**
 * AUDIT OF 2026-10-23: VERIFY HOLDS AT LEAST WHAT MAIN HOLDS.
 *
 *   · A finding the model typed `domicilio` is never dropped as a generic
 *     place ("el hospital", "la escuela"): main redacted those.
 *   · The town rule no longer cuts a lead ("de Xiadani", "vivo en Tepito"):
 *     that belonged to the reverted stage-3 skip.
 *   · `typedAddress` survives the cross-chunk merge, in either order.
 *
 * Faked at the fetch boundary, under the real `AIClient`, `aiServiceDetector`
 * and gate.
 */

import { AIClient } from '@edc/ai-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { aiServiceDetector, type SyncGenerator } from './detector'
import { ANONYMISE_VERIFY_ROUNDS_VAR, runAnonymisationGate } from './gate'
import { isGenericPlace } from './genericPlaces'

type H = { texto: string; tipo: string; identifica?: boolean }

function scriptedClient(perCall: H[][]): SyncGenerator {
  let n = 0
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        text: JSON.stringify({ hallazgos: perCall[n++] ?? [] }),
        modelUsed: 'fake',
        provider: 'fake',
        costUsd: 0,
        traceId: 't',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as unknown as typeof fetch
  return new AIClient({ baseUrl: 'http://ai.test', apiKey: 'k', fetch: fetchImpl }) as unknown as SyncGenerator
}

function run(text: string, perCall: H[][]) {
  return runAnonymisationGate(
    { contentKind: 'testimonio', text },
    { detector: aiServiceDetector({ client: scriptedClient(perCall) }) },
  )
}

beforeEach(() => {
  vi.stubEnv(ANONYMISE_VERIFY_ROUNDS_VAR, '')
})
afterEach(() => {
  vi.unstubAllEnvs()
})

/** [text, the span the model typed `domicilio`]: generic nouns main redacted. */
const GENERIC_TYPED_ADDRESS: Array<[string, string]> = [
  ['Estoy en el hospital desde mayo.', 'el hospital'],
  ['Estuve en la clínica.', 'la clínica'],
  ['Lo vi en el mercado.', 'el mercado'],
  ['Me quedé en el pueblo.', 'el pueblo'],
  ['Mi hija va a la escuela.', 'la escuela'],
  ['Vivo en el barrio.', 'barrio'],
  ['Vivo en la calle.', 'la calle'],
  ['Vivo en la casa de atrás.', 'la casa'],
  ['Vivo en la colonia.', 'la colonia'],
]

describe('🔴 a `domicilio` finding is never dropped as a generic place', () => {
  for (const [text, span] of GENERIC_TYPED_ADDRESS) {
    const answer = { texto: span, tipo: 'domicilio' }
    it(`${JSON.stringify(text)} / ${span}: stage 3 redacts it`, async () => {
      const r = await run(text, [[answer], []])
      expect(r.status).toBe('ready')
      if (r.status !== 'ready') return
      expect(r.redactedText).not.toContain(span)
      expect(r.redactedText).toContain('[Domicilio A]')
    })
    it(`${JSON.stringify(text)} / ${span}: verify holds on it`, async () => {
      const r = await run(text, [[], [answer]])
      expect(r.status).toBe('hold')
    })
  }

  it('the same spans typed `lugar` are still dropped as generic (unchanged)', () => {
    expect(isGenericPlace({ text: 'el hospital', type: 'lugar' })).toBe(true)
    expect(isGenericPlace({ text: 'el hospital', type: 'lugar', typedAddress: true })).toBe(false)
  })
})

describe('🔴 verify: the town rule reads the span as given, no lead cut', () => {
  for (const [text, span] of [
    ['Vengo de Xiadani.', 'de Xiadani'],
    ['Vivo en Tepito.', 'vivo en Tepito'],
    ['Vivo en Tepito.', 'Vivo en Tepito'],
    ['Vivo en vivo en Tepito.', 'vivo en Tepito'],
    ['Yo vivo en Xochitepec con mi familia.', 'en Xochitepec'],
  ] as Array<[string, string]>) {
    it(`${JSON.stringify(text)} / ${span} → hold`, async () => {
      const r = await run(text, [[], [{ texto: span, tipo: 'lugar' }]])
      expect(r.status).toBe('hold')
    })
  }

  it('the bare town still passes verify (Q8)', async () => {
    const text = 'Yo vivo en Xochitepec con mi familia.'
    const r = await run(text, [[], [{ texto: 'Xochitepec', tipo: 'lugar' }]])
    expect(r.status === 'ready' && r.redactedText).toBe(text)
  })
})

describe('🔴 `typedAddress` survives the cross-chunk merge', () => {
  // Two chunks, each holding "Xochitepec"; one chunk types it `lugar`, the
  // other `domicilio`. Both are `lugar` after parsing, so they merge.
  const text = `Vivo en Xochitepec. ${'palabra '.repeat(30)}\n\nVivo en Xochitepec.`
  for (const order of [
    ['lugar', 'domicilio'],
    ['domicilio', 'lugar'],
  ]) {
    it(`${order.join(' then ')} → one finding, typedAddress`, async () => {
      const client = scriptedClient(order.map((tipo) => [{ texto: 'Xochitepec', tipo }]))
      const found = await aiServiceDetector({ client, chunkWords: 20 }).detect({ text, contentKind: 'testimonio' })
      expect(found).toEqual([{ text: 'Xochitepec', type: 'lugar', typedAddress: true }])
    })
  }
})

describe('Q5 at verify: a one-word name at a sentence start is redacted, not held', () => {
  // Q5 covers a one-word capitalised span the model marked non-identifying
  // (`titleVerdict` in gate.ts): it is redacted, not passed as a bare title.
  it('verify alone finds "Lucrecia" (identifica false) → ready, redacted', async () => {
    const r = await run('Lucrecia llegó tarde.', [[], [{ texto: 'Lucrecia', tipo: 'persona', identifica: false }]])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('[Persona A] llegó tarde.')
  })

  it('verify alone finds "Lucrecia" marked identifying → hold (a leftover)', async () => {
    const r = await run('Lucrecia llegó tarde.', [[], [{ texto: 'Lucrecia', tipo: 'persona' }]])
    expect(r.status).toBe('hold')
  })
})
