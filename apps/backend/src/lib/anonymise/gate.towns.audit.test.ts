/**
 * 🔴 THE AUDIT OF THE TOWN EXEMPTION AT STAGE 3 (2026-10-23), ONE ROW PER PROBE.
 *
 * Every row ran against the first version of the stage-3 town exemption; the
 * rows marked LEAK shipped a street, a ranch, an employer or a prison in clear.
 * The model answers the SAME thing at stage 3 and at verify, so a row covers
 * both: they share `isTownLevelPlace`. Faked at the fetch boundary, under the
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

/** The same answer at stage 3 and at every verify call. */
async function gateOut(text: string, answers: H[]): Promise<string> {
  const r = await runAnonymisationGate(
    { contentKind: 'testimonio', text },
    { detector: aiServiceDetector({ client: scriptedClient([answers, answers, answers]) }) },
  )
  return r.status === 'ready' ? r.redactedText : `HOLD ${r.redactedText ?? ''}`
}

beforeEach(() => {
  vi.stubEnv(ANONYMISE_VERIFY_ROUNDS_VAR, '')
})
afterEach(() => {
  vi.unstubAllEnvs()
})

const l = (texto: string): H => ({ texto, tipo: 'lugar' })
const d = (texto: string): H => ({ texto, tipo: 'domicilio' })

/** [text, model answers, a word that must NOT be in the output in clear]. */
const MUST_NOT_SHOW: Array<[string, H[], string]> = [
  // LEAK — rule 6, a number or address word right after.
  ['Vivo en Morelos 45, en Xochitepec.', [l('Morelos')], 'Morelos'],
  ['Vivo en Insurgentes 45.', [l('Insurgentes')], 'Insurgentes'],
  ['Vivo en Hidalgo número 45.', [l('Hidalgo'), l('número 45')], 'Hidalgo'],
  ['Vivo en Insurgentes, número 45, colonia Centro.', [l('Insurgentes'), l('número 45'), l('colonia Centro')], 'Insurgentes'],
  ['Vivo en Hidalgo esquina con Morelos.', [l('Hidalgo'), l('Morelos')], 'Hidalgo'],
  ['Llegué a vivir en Hidalgo, frente a la iglesia.', [l('Hidalgo')], 'Hidalgo'],
  ['Vivo en Hidalgo #12.', [l('Hidalgo')], 'Hidalgo'],
  // LEAK — the model typed it `domicilio`.
  ['Vivo en Hidalgo 12.', [d('Hidalgo')], 'Hidalgo'],
  ['Vivo en Insurgentes.', [d('Insurgentes')], 'Insurgentes'],
  ['Vivo en Insurgentes Sur, Ciudad de México.', [d('Insurgentes Sur')], 'Insurgentes'],
  // LEAK — rule 7, several pieces or several proper words, no anchor.
  ['Vivo en Insurgentes, Cuernavaca.', [l('Insurgentes, Cuernavaca')], 'Insurgentes'],
  ['Vivo en Hidalgo, Xochitepec, Morelos.', [l('Hidalgo, Xochitepec, Morelos')], 'Hidalgo'],
  ['Vivo en Priv Hidalgo.', [l('Priv Hidalgo')], 'Priv'],
  ['Vivo en Cda Morelos.', [l('Cda Morelos')], 'Cda'],
  ['Vivo en Calz Tlalpan.', [l('Calz Tlalpan')], 'Calz'],
  ['Vivo en Frac Las Palmas.', [l('Frac Las Palmas')], 'Frac'],
  ['Vivo en Rcho El Mezquite.', [l('Rcho El Mezquite')], 'Rcho'],
  ['Vivo en Hacienda San José.', [l('Hacienda San José')], 'Hacienda'],
  ['Vivo en Ranchito El Huizache.', [l('Ranchito El Huizache')], 'Huizache'],
  ['Vivo en Granja Tres Hermanos.', [l('Granja Tres Hermanos')], 'Granja'],
  ['Vivo en Tres Cruces.', [l('Tres Cruces')], 'Cruces'],
  ['Vivo en Jiutepec Civac.', [l('Jiutepec Civac')], 'Civac'],
  ['Estoy en Penal de Atlacholoaya.', [l('Penal de Atlacholoaya')], 'Atlacholoaya'],
  ['Estoy en Cereso Atlacholoaya.', [l('Cereso Atlacholoaya')], 'Atlacholoaya'],
  // LEAK — head nouns without their accent (folded lookups).
  ['Vivo en Callejon Hidalgo.', [l('Callejon Hidalgo')], 'Callejon'],
  ['Vivo en Prolongacion Morelos.', [l('Prolongacion Morelos')], 'Prolongacion'],
  ['Vivo en Seccion Cuarta.', [l('Seccion Cuarta')], 'Seccion'],
  // LEAK — work is not residence.
  ['Trabajo en Coppel.', [l('Coppel')], 'Coppel'],
  ['Trabajo en Pemex.', [l('Pemex')], 'Pemex'],
  // Already redacted before the audit: kept as regressions.
  ['Vivo en Fracc Las Palmas.', [l('Fracc Las Palmas')], 'Palmas'],
  ['Vivo en Paraje Tres Cruces.', [l('Paraje Tres Cruces')], 'Cruces'],
  ['Vivo en PARAJE Tres Cruces.', [l('PARAJE Tres Cruces')], 'Cruces'],
  ['Vivo en Xochitepec Rancho El Mezquite.', [l('Xochitepec Rancho El Mezquite')], 'Mezquite'],
  ['Vivo en Barrio Alto.', [l('Barrio Alto')], 'Alto'],
  ['Vivo en Mz 4 Lt 7.', [l('Mz 4 Lt 7')], 'Mz'],
  ['Vivo en Manzana Cuatro.', [l('Manzana Cuatro')], 'Cuatro'],
  ['Vivo en Xochitepec, en Las Flores.', [l('Las Flores')], 'Flores'],
  ['Vivo en Xochitepec, en Flores Magón.', [l('Flores Magón')], 'Magón'],
  ['Vivo en Xochitepec, en Emiliano Zapata.', [l('Emiliano Zapata')], 'Zapata'],
  ['Vivo en Xochitepec, en Tlaltenango.', [l('Tlaltenango')], 'Tlaltenango'],
  ['Trabajo en Bimbo desde 2010.', [{ texto: 'en Bimbo', tipo: 'otro' }], 'Bimbo'],
  ['Pienso en Tlapa.', [l('en Tlapa')], 'Tlapa'],
  ['Es hija de Tlapa.', [l('de Tlapa')], 'Tlapa'],
  ['Vivo en Soledad.', [l('Soledad')], 'Soledad'],
  ['Vivo en Dolores Hidalgo.', [l('Dolores Hidalgo')], 'Dolores'],
  ['Soy de Guadalupe.', [l('de Guadalupe')], 'Guadalupe'],
  ['Vivo en Xochitepec. La tienda Xochitepec es mía.', [l('Xochitepec')], 'Xochitepec'],
  ['Vivo en Xochitepec. Doña XOCHITEPEC me ayuda.', [l('Xochitepec')], 'XOCHITEPEC'],
  ['Vivo en Xochitepec. Le dije a xochitépec que viniera.', [l('Xochitepec')], 'xochitépec'],
  ['Vivo en Xochitepec y me escribe Xochitepec López.', [l('Xochitepec'), { texto: 'Xochitepec López', tipo: 'persona' }], 'Xochitepec López'],
  ['Vivo en Hidalgo y Morelos.', [l('Hidalgo y Morelos')], 'Hidalgo'],
  ['Vivo en el Centro.', [l('el Centro')], 'Centro'],
  ['Vivo en Centro.', [l('Centro')], 'Centro'],
  ['Vivo en Unidad Habitacional Tlatelolco.', [l('Tlatelolco')], 'Tlatelolco'],
]

describe('🔴 audit 2026-10-23: never shown, at stage 3 or at verify', () => {
  for (const [text, answers, word] of MUST_NOT_SHOW) {
    it(`${JSON.stringify(text)} with ${JSON.stringify(answers)} → no "${word}"`, async () => {
      const out = await gateOut(text, answers)
      expect(out).not.toContain(word)
    })
  }
})

// ⚠ ONE bare capitalised word after "vivo en" / "vengo de", typed `lugar`, with
// nothing street-like after it, is shown. The owner is deciding this rule
// (2026-10-23); these pin today's behaviour, not a ruling.
describe('one bare word after a residence or origin verb: shown (owner deciding)', () => {
  for (const [text, answers] of [
    ['Vivo en Tepito.', [l('Tepito')]],
    ['Vivo en Insurgentes.', [l('Insurgentes')]],
    ['Vengo de Xiadani.', [l('de Xiadani')]],
  ] as Array<[string, H[]]>) {
    it(`${JSON.stringify(text)} → unchanged`, async () => {
      expect(await gateOut(text, answers)).toBe(text)
    })
  }
})

describe('towns with an anchor stay shown', () => {
  for (const [text, answers] of [
    ['Vivo en Xochitepec con mi familia.', [l('Xochitepec')]],
    ['Vivo en Xochitepec desde 2010.', [l('Xochitepec')]],
    ['Vivo en Gómez Farías, Jalisco.', [l('Gómez Farías')]],
    ['Vivo en Gómez Farías, Jalisco.', [l('Gómez Farías, Jalisco')]],
    ['Nací en San Juan Chamula, Chiapas.', [l('San Juan Chamula, Chiapas')]],
    ['Vivo en el municipio de Gómez Farías.', [l('Gómez Farías')]],
    ['Vivo en Ciudad Juárez.', [l('Ciudad Juárez')]],
    ['Vivo en Baja California Sur.', [l('Baja California Sur')]],
    ['Vivo en Queretaro.', [l('Queretaro')]],
  ] as Array<[string, H[]]>) {
    it(`${JSON.stringify(text)} with ${JSON.stringify(answers)} → unchanged`, async () => {
      expect(await gateOut(text, answers)).toBe(text)
    })
  }
})
