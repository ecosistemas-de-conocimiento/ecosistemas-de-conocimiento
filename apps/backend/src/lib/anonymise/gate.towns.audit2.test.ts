/**
 * 🔴 RE-AUDIT OF THE TOWN EXEMPTION (2026-10-23, second pass), ONE ROW PER LEAK.
 *
 * Each row shipped in clear on eab137c. Every row runs TWICE: once with the
 * same answer at stage 3 and verify ("both": must be redacted), once with
 * stage 3 silent and verify alone finding it ("verify only": must HOLD), so
 * the two stages cannot drift apart. Faked at the fetch boundary, under the
 * real `AIClient`, `aiServiceDetector` and gate.
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

/** [text, the model's `lugar` span, a word that must not be shown]. */
const LEAKS: Array<[string, string, string]> = [
  // 1 — a head noun (abbreviated, institution, property) is never a town,
  //     state or no state.
  ['Estoy en Cereso Atlacholoaya, Morelos.', 'Cereso Atlacholoaya', 'Atlacholoaya'],
  ['Vivo en Cereso Atlacholoaya, Morelos.', 'Cereso Atlacholoaya', 'Atlacholoaya'],
  ['Vivo en Priv Hidalgo, Morelos.', 'Priv Hidalgo', 'Priv'],
  ['Vivo en Priv. Hidalgo, Morelos.', 'Hidalgo', 'Hidalgo'],
  ['Vivo en Cda Morelos, Morelos.', 'Cda Morelos', 'Cda'],
  ['Vivo en Calz Tlalpan, CDMX.', 'Calz Tlalpan', 'Tlalpan'],
  ['Vivo en Hacienda San José, Morelos.', 'Hacienda San José', 'Hacienda'],
  ['Vivo en Carr. Federal.', 'Federal', 'Federal'],
  ['Vivo en Prol. Morelos.', 'Morelos', 'Morelos'],
  ['Vivo en Reclusorio Norte, CDMX.', 'Reclusorio Norte', 'Reclusorio'],
  ['Vivo en Penal Atlacholoaya, Morelos.', 'Penal Atlacholoaya', 'Penal'],
  ['Vivo en Granja Tres Hermanos, Morelos.', 'Granja Tres Hermanos', 'Granja'],
  ['Vivo en Ranchito El Huizache, Morelos.', 'Ranchito El Huizache', 'Ranchito'],
  ['Vivo en Quinta Las Rosas, Morelos.', 'Quinta Las Rosas', 'Quinta'],
  // 2 — something street-like in the next few words.
  ['Vivo en Hidalgo, a dos cuadras del mercado.', 'Hidalgo', 'Hidalgo'],
  ['Vivo en Hidalgo, casi esquina con Morelos.', 'Hidalgo', 'Hidalgo'],
  ['Vivo en Hidalgo, casi en la esquina con Morelos.', 'Hidalgo', 'Hidalgo'],
  ['Vivo en Hidalgo cuadra 3.', 'Hidalgo', 'Hidalgo'],
  ['Vivo en Hidalgo, en el 45.', 'Hidalgo', 'Hidalgo'],
  ['Vivo en Hidalgo, Morelos 45.', 'Hidalgo', 'Hidalgo'],
  ['Vivo en Hidalgo. Número 45.', 'Hidalgo', 'Hidalgo'],
  ['Vivo en Tlatelolco dpto 4.', 'Tlatelolco', 'Tlatelolco'],
  ['Vivo en Tlatelolco edif. Chihuahua.', 'Tlatelolco', 'Tlatelolco'],
  ['Vivo en Tlatelolco int. 4.', 'Tlatelolco', 'Tlatelolco'],
  ['Vivo en Tlatelolco torre B.', 'Tlatelolco', 'Tlatelolco'],
  ['Vivo en Hidalgo #A.', 'Hidalgo', 'Hidalgo'],
  // 3 — number markers and spelled-out numbers.
  ['Vivo en Hidalgo n. 45.', 'Hidalgo', 'Hidalgo'],
  ['Vivo en Hidalgo, N° 45.', 'Hidalgo', 'Hidalgo'],
  ['Vivo en Hidalgo, Nº 45.', 'Hidalgo', 'Hidalgo'],
  ['Vivo en Hidalgo s/n.', 'Hidalgo', 'Hidalgo'],
  ['Vivo en Hidalgo S/N.', 'Hidalgo', 'Hidalgo'],
  ['Vivo en Hidalgo cuarenta y cinco.', 'Hidalgo', 'Hidalgo'],
  ['Vivo en Hidalgo, cuarenta y cinco.', 'Hidalgo', 'Hidalgo'],
  ['Vivo en Hidalgo cinco.', 'Hidalgo', 'Hidalgo'],
  ['Vivo en Hidalgo y el nº cinco.', 'Hidalgo', 'Hidalgo'],
  // 4 — several words, or a state paired with a state: a state after is no
  //     anchor; only a town word before is.
  ['Vivo en Insurgentes Sur, CDMX.', 'Insurgentes Sur', 'Insurgentes'],
  ['Vivo en Insurgentes Sur, CDMX.', 'Insurgentes Sur, CDMX', 'Insurgentes'],
  ['Vivo en Insurgentes Sur, Ciudad de México.', 'Insurgentes Sur', 'Insurgentes'],
  ['Vivo en Santa Úrsula, CDMX.', 'Santa Úrsula', 'Úrsula'],
  ['Vivo en Tres Cruces, Morelos.', 'Tres Cruces', 'Cruces'],
  ['Vivo en Gómez Farías, Jalisco.', 'Gómez Farías', 'Farías'],
  ['Vivo en Hidalgo, Morelos.', 'Hidalgo, Morelos', 'Hidalgo'],
  // 5 — mutants: accent folding (M5), "#" alone (M11).
  ['Vivo en Hidalgo numero 45.', 'Hidalgo', 'Hidalgo'],
  ['Vivo en Hidalgo, prolongacion norte.', 'Hidalgo', 'Hidalgo'],
  ['Vivo en Tepito, seccion norte.', 'Tepito', 'Tepito'],
]

describe('🔴 re-audit: redacted when stage 3 finds it', () => {
  for (const [text, span, word] of LEAKS) {
    it(`${JSON.stringify(text)} / ${JSON.stringify(span)} → no "${word}"`, async () => {
      const r = await run(text, [[l(span)], [l(span)]])
      const out = r.status === 'ready' ? r.redactedText : `HOLD ${r.redactedText ?? ''}`
      expect(out).not.toContain(word)
    })
  }
})

describe('🔴 re-audit: HOLDS when only verify finds it', () => {
  for (const [text, span] of LEAKS) {
    it(`${JSON.stringify(text)} / ${JSON.stringify(span)} → hold`, async () => {
      const r = await run(text, [[], [l(span)]])
      expect(r.status).toBe('hold')
    })
  }
})

describe('still shown: one bare word (Q8), a town word before, a state alone', () => {
  for (const [text, span] of [
    ['Vivo en Tepito.', 'Tepito'],
    ['Vivo en Xochitepec con mis dos hijos.', 'Xochitepec'],
    ['Vivo en Xoxocotla, Morelos.', 'Xoxocotla, Morelos'],
    ['Vivo en Xoxocotla, Morelos.', 'Xoxocotla'],
    ['Vivo en el municipio de Gómez Farías.', 'Gómez Farías'],
    ['Vivo en el pueblo de Tres Cruces.', 'Tres Cruces'],
    ['Vivo en la Ciudad de México.', 'Ciudad de México'],
    ['Vivo en Baja California Sur.', 'Baja California Sur'],
  ] as Array<[string, string]>) {
    it(`${JSON.stringify(text)} / ${JSON.stringify(span)} → unchanged, at both stages`, async () => {
      const both = await run(text, [[l(span)], [l(span)]])
      expect(both.status === 'ready' && both.redactedText).toBe(text)
      const late = await run(text, [[], [l(span)]])
      expect(late.status === 'ready' && late.redactedText).toBe(text)
    })
  }
})
