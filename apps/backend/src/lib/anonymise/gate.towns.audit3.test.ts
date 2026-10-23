/**
 * 🔴 THIRD AUDIT OF THE TOWN RULE (2026-10-23), ONE ROW PER LEAK, THREE MODES.
 *
 *   both        stage 3 and verify give the same answer → must be redacted
 *   verify only stage 3 silent, verify finds it        → must HOLD
 *   split       stage 3 redacts a neighbour (the number), verify then finds
 *               the place beside the new placeholder   → must HOLD
 *
 * These rules decide verify's hold too, so they matter whatever happens to the
 * stage-3 exemption. Faked at the fetch boundary, under the real `AIClient`,
 * `aiServiceDetector` and gate.
 */

import { AIClient } from '@edc/ai-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { aiServiceDetector, type SyncGenerator } from './detector'
import { ANONYMISE_VERIFY_ROUNDS_VAR, runAnonymisationGate } from './gate'

type H = { texto: string; tipo: string }

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

const l = (texto: string): H => ({ texto, tipo: 'lugar' })

/** [text, the place the model marks `lugar`]. The place must never ship. */
const LEAKS: Array<[string, string]> = [
  // 1 — "s/n" with punctuation round it.
  ['Vivo en Hidalgo s/n;', 'Hidalgo'],
  ['Vivo en Hidalgo (s/n).', 'Hidalgo'],
  ['Vivo en Hidalgo "s/n".', 'Hidalgo'],
  ['Vivo en Hidalgo s.n.', 'Hidalgo'],
  ['Vivo en Hidalgo sn.', 'Hidalgo'],
  ['Vivo en Hidalgo s/n, Xochitepec.', 'Hidalgo'],
  ['Vivo en Hidalgo S/N, Morelos.', 'Hidalgo'],
  // 2 — corner marks.
  ['Vivo en Hidalgo esq Morelos.', 'Hidalgo'],
  ['Vivo en Hidalgo esq. Morelos.', 'Hidalgo'],
  ['Vivo en Hidalgo c/ Morelos.', 'Hidalgo'],
  ['Vivo en Hidalgo y Morelos, esq.', 'Hidalgo'],
  // 3 — spelled-out numbers.
  ['Vivo en Hidalgo seiscientos.', 'Hidalgo'],
  ['Vivo en Hidalgo setecientos.', 'Hidalgo'],
  ['Vivo en Hidalgo ochocientos.', 'Hidalgo'],
  ['Vivo en Hidalgo novecientos.', 'Hidalgo'],
  ['Vivo en Hidalgo mil.', 'Hidalgo'],
  ['Vivo en Hidalgo cero.', 'Hidalgo'],
  ['Vivo en Hidalgo, el cinco.', 'Hidalgo'],
  ['Vivo en Hidalgo, la cuatro.', 'Hidalgo'],
  ['Vivo en Hidalgo, en el cinco.', 'Hidalgo'],
  ['Vivo en Hidalgo y el uno.', 'Hidalgo'],
  ['Vivo en Hidalgo cuarentaicinco.', 'Hidalgo'],
  ['Vivo en Hidalgo cuarenta-y-cinco.', 'Hidalgo'],
  // 4 — a state named after a state-named street, in any form.
  ['Vivo en Hidalgo, Estado de Morelos.', 'Hidalgo'],
  ['Vivo en Hidalgo, estado de Morelos.', 'Hidalgo'],
  ['Vivo en Hidalgo, Edo. de Morelos.', 'Hidalgo'],
  ['Vivo en Hidalgo, Mor.', 'Hidalgo'],
  ['Vivo en Hidalgo (Morelos).', 'Hidalgo'],
  ['Vivo en Hidalgo; Morelos.', 'Hidalgo'],
  ['Vivo en Hidalgo Morelos.', 'Hidalgo'],
  ['Vivo en Hidalgo - Morelos.', 'Hidalgo'],
  ['Vivo en Hidalgo, Morelos.', 'Hidalgo'],
  ['Vivo en Hidalgo, Cuernavaca, Morelos.', 'Hidalgo'],
  ['Vivo en Morelos, Edo. Méx.', 'Morelos'],
  // 5 — a placeholder already in the window.
  ['Vivo en Insurgentes con mi familia, C.P. 62790.', 'Insurgentes'],
  ['Vivo en Insurgentes con mi familia, tel 7771234567.', 'Insurgentes'],
  // 6 — past ";" or a sentence end, the next two words.
  ['Vivo en Hidalgo; el 45.', 'Hidalgo'],
  ['Vivo en Hidalgo. El 45.', 'Hidalgo'],
  ['Vivo en Hidalgo! ¡El 45!', 'Hidalgo'],
  // 7 — house-reference phrases anywhere in the window.
  ['Vivo en Hidalgo, casi junto al mercado.', 'Hidalgo'],
  ['Vivo en Hidalgo, justo atrás de la iglesia.', 'Hidalgo'],
  ['Vivo en Hidalgo, a un lado de la iglesia.', 'Hidalgo'],
  ['Vivo en Hidalgo, casi enfrente de la escuela.', 'Hidalgo'],
  ['Vivo en Hidalgo, muy cerca del mercado.', 'Hidalgo'],
  // 8 — more short address forms.
  ['Vivo en Hidalgo Mza B.', 'Hidalgo'],
  ['Vivo en Hidalgo, Mza. B.', 'Hidalgo'],
  ['Vivo en Hidalgo Mzna B.', 'Hidalgo'],
  ['Vivo en Hidalgo, Ext. B.', 'Hidalgo'],
  ['Vivo en Hidalgo Bis.', 'Hidalgo'],
  ['Vivo en Hidalgo, Bis.', 'Hidalgo'],
  ['Vivo en Hidalgo, letra B.', 'Hidalgo'],
  ['Vivo en Hidalgo, local B.', 'Hidalgo'],
  ['Vivo en Hidalgo, Fte. a la iglesia.', 'Hidalgo'],
  // 9 — numerals, ordinals, English street words, a wider window.
  ['Vivo en Hidalgo II.', 'Hidalgo'],
  ['Vivo en Hidalgo XII.', 'Hidalgo'],
  ['Vivo en Hidalgo III, Morelos.', 'Hidalgo'],
  ['Vivo en Tepito II.', 'Tepito'],
  ['Vivo en Tepito Segunda.', 'Tepito'],
  ['Vivo en Hidalgo, Primera.', 'Hidalgo'],
  ['Vivo en Hidalgo, la segunda casa.', 'Hidalgo'],
  ['Vivo en Hidalgo St', 'Hidalgo'],
  ['Vivo en Hidalgo St.', 'Hidalgo'],
  ['Vivo en Hidalgo Ave.', 'Hidalgo'],
  ['Vivo en Hidalgo Rd.', 'Hidalgo'],
  ['Vivo en Hidalgo Street.', 'Hidalgo'],
  ['Vivo en Hidalgo con mi mamá y hijos en el 45.', 'Hidalgo'],
  ['Vivo en Hidalgo con mi mamá y mis hijos, número 45.', 'Hidalgo'],
  // 10/11 — survivors: rule 2 reads three words before; head nouns there.
  ['Mi casa está en Tepito.', 'Tepito'],
  ['Mi domicilio: vivo en Tepito.', 'Tepito'],
  ['El penal está en Atlacholoaya.', 'Atlacholoaya'],
  ['El cereso está en Atlacholoaya.', 'Atlacholoaya'],
  ['El reclusorio está en Tepito.', 'Tepito'],
  ['La quinta está en Tepito.', 'Tepito'],
  ['La priv está en Tepito.', 'Tepito'],
  ['La calz está en Tepito.', 'Tepito'],
  ['La carr está en Tepito.', 'Tepito'],
  ['La hacienda está en Tepito.', 'Tepito'],
  ['Una abreviatura no corta: vivo en Hidalgo, Ote. del pueblo, 45.', 'Hidalgo'],
  ['Vivo en Xochitepec, Tlaltenango.', 'Xochitepec, Tlaltenango'],
  // Mutation survivors (second run): each rule on its own, no state pair.
  ['Vivo en Tepito c/ Aldama.', 'Tepito'],
  ['Vivo en Tepito esq Aldama.', 'Tepito'],
  ['Vivo en Tepito, en la manzana B.', 'Tepito'],
  ['Vivo en Tepito con mi familia, en la privada.', 'Tepito'],
  ['Vivo en Tepito, casa azul.', 'Tepito'],
  ['Vivo en Tepito y el nº cinco.', 'Tepito'],
  ['Vivo en Morelos, Edo de Mex con mi familia.', 'Morelos'],
]

/** [text, stage 3's answer, verify's answer]: stage 3 takes the number first. */
const SPLIT: Array<[string, string, string]> = [
  ['Vivo en Hidalgo, en el 45.', '45', 'Hidalgo'],
  ['Vivo en Hidalgo, en el 45.', 'el 45', 'Hidalgo'],
  ['Vivo en Hidalgo, número 45.', 'número 45', 'Hidalgo'],
  ['Vivo en Hidalgo 45.', '45', 'Hidalgo'],
  ['Vivo en Hidalgo, cuadra 3.', 'cuadra 3', 'Hidalgo'],
  ['Vivo en Hidalgo con mi familia, en el 45.', 'el 45', 'Hidalgo'],
  ['Vivo en Hidalgo s/n.', 's/n', 'Hidalgo'],
  ['Vivo en Hidalgo, casi esquina con Morelos.', 'Morelos', 'Hidalgo'],
  ['Vivo en Tlatelolco, torre B.', 'torre B', 'Tlatelolco'],
  ['Vivo en Tlatelolco, en la torre B.', 'torre B', 'Tlatelolco'],
  ['Vivo en Hidalgo, Morelos 45.', 'Morelos 45', 'Hidalgo'],
  ['Vivo en Hidalgo y Morelos 45.', 'Morelos 45', 'Hidalgo'],
]

describe('🔴 third audit: both stages find it → redacted', () => {
  for (const [text, place] of LEAKS) {
    it(`${JSON.stringify(text)} / ${place}`, async () => {
      const r = await run(text, [[l(place)], [l(place)]])
      if (r.status === 'ready') expect(r.redactedText).not.toContain(place)
    })
  }
})

describe('🔴 third audit: only verify finds it → hold', () => {
  for (const [text, place] of LEAKS) {
    it(`${JSON.stringify(text)} / ${place}`, async () => {
      const r = await run(text, [[], [l(place)]])
      expect(r.status).toBe('hold')
    })
  }
})

describe('🔴 third audit: stage 3 takes the number, verify the place → hold', () => {
  for (const [text, first, place] of SPLIT) {
    it(`${JSON.stringify(text)} / ${first} then ${place}`, async () => {
      const r = await run(text, [[l(first)], [l(place)]])
      expect(r.status).toBe('hold')
    })
  }
})

describe('still shown (Q8, and towns with a state or a town word)', () => {
  for (const [text, place] of [
    ['Vivo en Tepito.', 'Tepito'],
    ['Vivo en Hidalgo.', 'Hidalgo'],
    ['Vivo en Xoxocotla, Morelos.', 'Xoxocotla'],
    ['Vivo en Xoxocotla, Estado de Morelos.', 'Xoxocotla'],
    ['Vivo en Xochitepec con mi familia. Somos muchos y tenemos 3 hijos.', 'Xochitepec'],
    ['Vivo en Xochitepec con [Persona A] y mis hijos.', 'Xochitepec'],
    ['Vivo en el municipio de Tres Cruces.', 'Tres Cruces'],
    // ";" ends a sentence: the "3" is past the two words read after it.
    ['Vivo en Xochitepec con mi familia; somos muchos y tenemos 3 hijos.', 'Xochitepec'],
    // A state abbreviation counts only with its dot: "son" is a verb.
    ['Vivo en Hidalgo y son buenos vecinos.', 'Hidalgo'],
  ] as Array<[string, string]>) {
    it(`${JSON.stringify(text)} / ${place} → unchanged, both and verify only`, async () => {
      const both = await run(text, [[l(place)], [l(place)]])
      expect(both.status === 'ready' && both.redactedText).toBe(text)
      const late = await run(text, [[], [l(place)]])
      expect(late.status === 'ready' && late.redactedText).toBe(text)
    })
  }
})
