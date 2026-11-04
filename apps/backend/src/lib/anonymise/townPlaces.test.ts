/**
 * 🔴 TOWNS NEVER HOLD; ADDRESSES AND PEOPLE STILL DO (owner, 2026-10-21, #12).
 *
 * Measured on dev the same day: 31 of 38 verify holds had place findings only.
 * Every gate test here uses a fixed-answer detector whose SECOND call (verify)
 * returns the finding — the shape of the live holds. No model is called.
 */
import { describe, expect, it } from 'vitest'

import { runAnonymisationGate } from './gate'
import { isTownLevelPlace } from './townPlaces'
import type { DetectorFinding, PersonDetector } from './types'

/** Stage 3 finds nothing; stage 4 (verify) finds `late`. */
function verifyFinds(late: DetectorFinding[]): PersonDetector {
  let calls = 0
  return {
    name: 'verify-finds',
    async detect({ text }) {
      calls += 1
      return calls === 1 ? [] : late.filter((f) => text.includes(f.text))
    },
  }
}

const gate = (text: string, late: DetectorFinding[]) =>
  runAnonymisationGate({ contentKind: 'testimonio', text }, { detector: verifyFinds(late) })

describe('🔴 a town, municipality, state or city found by verify does NOT hold', () => {
  it.each([
    ['Vivo en Xoxocotla, Morelos.', [{ text: 'Xoxocotla', type: 'lugar' }, { text: 'Morelos', type: 'lugar' }]],
    ['Vivo en Xoxocotla, Morelos.', [{ text: 'Xoxocotla, Morelos', type: 'lugar' }]],
    ['Nací en el pueblo de San Juan Chamula, Chiapas, y luego viví en Tuxtla.', [{ text: 'San Juan Chamula', type: 'lugar' }, { text: 'Tuxtla', type: 'lugar' }, { text: 'Chiapas', type: 'lugar' }]],
    ['Vivo en el municipio de Tlaltizapán.', [{ text: 'municipio de Tlaltizapán', type: 'lugar' }]],
    ['Vivo en el municipio de Tlaltizapán.', [{ text: 'Tlaltizapán', type: 'lugar' }]],
    ['Vivimos en la Ciudad de México desde hace años.', [{ text: 'Ciudad de México', type: 'lugar' }]],
    ['Somos de Guerrero.', [{ text: 'Guerrero', type: 'lugar' }]],
    ['Yo soy de Cuautla.', [{ text: 'Cuautla', type: 'lugar' }]],
    ['Mi familia es originaria de Tepoztlán, Morelos.', [{ text: 'Tepoztlán', type: 'lugar' }, { text: 'Morelos', type: 'lugar' }]],
    ['Vivo en la Alcaldía Iztapalapa.', [{ text: 'Alcaldía Iztapalapa', type: 'lugar' }]],
    ['Vivo en Cuernavaca.', [{ text: 'Cuernavaca', type: 'lugar' }]],
    ['Nací en Oaxaca.', [{ text: 'Oaxaca', type: 'lugar' }]],
    // Two proper words need a town word before (rule 7, re-audit 2026-10-23).
    ['Vivo en el municipio de Gómez Farías, Jalisco.', [{ text: 'Gómez Farías', type: 'lugar' }]],
    ['Vivo en Ciudad Juárez.', [{ text: 'Ciudad Juárez', type: 'lugar' }]],
  ] as Array<[string, DetectorFinding[]]>)('%s → ready, town shown', async (text, late) => {
    const result = await gate(text, late)
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).toBe(text)
  })
})

describe('🔴 colonias, streets, numbers, C.P., ranchos, parajes, homes and people STILL hold', () => {
  it.each([
    ['colonia Portales', 'Vivo en la colonia Portales desde niña.', { text: 'colonia Portales', type: 'lugar' }],
    ['the bare name after "colonia"', 'Vivo en la colonia Portales desde niña.', { text: 'Portales', type: 'lugar' }],
    ['the street name after "calle"', 'Vivo en calle Morelos, en Xoxocotla.', { text: 'Morelos', type: 'lugar' }],
    ['a house number', 'Es el número 45 de la cerrada.', { text: 'número 45', type: 'lugar' }],
    ['a rancho', 'Vivimos en el rancho Los Pinos.', { text: 'rancho Los Pinos', type: 'lugar' }],
    ['a paraje', 'Sembramos en el paraje Tres Cruces.', { text: 'paraje Tres Cruces', type: 'lugar' }],
    ['a home description', 'Vivo en la casa de la reja verde.', { text: 'la casa de la reja verde', type: 'lugar' }],
    ['a way to the house', 'Vivo enfrente de la tienda de doña Mari.', { text: 'enfrente de la tienda de doña Mari', type: 'lugar' }],
    ['a barrio with a name', 'Vivo en el barrio de San Juan.', { text: 'barrio de San Juan', type: 'lugar' }],
    ['a workplace that points at someone', 'Trabaja en la Clínica del Valle.', { text: 'Clínica del Valle', type: 'lugar' }],
    ["a person's name", 'Me ayudó Rosa Martínez con los papeles.', { text: 'Rosa Martínez', type: 'persona' }],
    ['an employer after "trabajo en" (audit 2026-10-23)', 'Trabajo en Coppel.', { text: 'Coppel', type: 'lugar' }],
    ['a town after "trabajo en" (work is not residence)', 'Trabajo en el municipio de Tlaltizapán.', { text: 'municipio de Tlaltizapán', type: 'lugar' }],
    ['a two-word town without a state (fail-closed, accepted)', 'Vivo en Gómez Farías.', { text: 'Gómez Farías', type: 'lugar' }],
    ['a two-word town with only a state (fail-closed, accepted)', 'Vivo en Gómez Farías, Jalisco.', { text: 'Gómez Farías', type: 'lugar' }],
    ['the same, the state inside the span', 'Vivo en Gómez Farías, Jalisco.', { text: 'Gómez Farías, Jalisco', type: 'lugar' }],
    ['a year right after a town (rule 6 reads digits; fail-closed, accepted)', 'Vivimos en la Ciudad de México desde 1990.', { text: 'Ciudad de México', type: 'lugar' }],
    ["a person's name the model mislabelled `lugar`", 'Mi tía Soledad me cuidó.', { text: 'Soledad', type: 'lugar' }],
    ['a name at the start of a sentence, mislabelled', 'Dolores me dijo que sí.', { text: 'Dolores', type: 'lugar' }],
  ] as Array<[string, string, DetectorFinding]>)('%s → hold', async (_case, text, finding) => {
    const result = await gate(text, [finding])
    expect(result.status).toBe('hold')
    if (result.status !== 'hold') return
    expect(result.stage).toBe('verify')
  })

  // 🔴 The auditor's measured passes against the first version (2026-10-21).
  // Each of these shipped in clear; each must HOLD.
  it.each([
    ['la hija de Soledad', 'Me cuidó la hija de Soledad.', 'Soledad'],
    ['le dije a Soledad', 'Le dije a Soledad que no.', 'Soledad'],
    ['Juan y Soledad', 'Llegaron Juan y Soledad.', 'Soledad'],
    ['compramos en Doña Chela', 'Siempre compramos en Doña Chela.', 'Doña Chela'],
    ['compramos en Chela, after doña', 'Siempre compramos con doña Chela en Chela.', 'Chela'],
    ['estudié en la Benito Juárez', 'Estudié en la Benito Juárez.', 'Benito Juárez'],
    ['en el Siglo XXI', 'Me operaron en el Siglo XXI.', 'Siglo XXI'],
    ['en La Raza', 'Me atendieron en La Raza.', 'La Raza'],
    ['en Los Pinos', 'Vivimos en Los Pinos.', 'Los Pinos'],
    ['en Santa Úrsula', 'Vivimos en Santa Úrsula.', 'Santa Úrsula'],
    ['en el Pedregal de Santo Domingo', 'Crecí en el Pedregal de Santo Domingo.', 'Pedregal de Santo Domingo'],
    ['la casa está por Los Encinos', 'La casa está por Los Encinos.', 'Los Encinos'],
    ['a town word after an address word', 'Vivo en la colonia de Cuautla.', 'Cuautla'],
    ['an IMSS clinic', 'Me atendieron en el IMSS de Cuautla.', 'IMSS de Cuautla'],
    ['a bare comma that is not a state', 'Fuimos Juan, Soledad y yo.', 'Soledad'],
  ])('%s → hold', async (_case, text, finding) => {
    const result = await gate(text, [{ text: finding, type: 'lugar' }])
    expect(result.status).toBe('hold')
  })

  // 🔴 The re-audit's measured passes (2026-10-21): a PERSON the detector
  // typed `lugar`. Each must HOLD.
  it.each([
    ['vivo en Martínez', 'Vivo en Martínez desde hace años.', 'Martínez'],
    ['trabajo en Gutiérrez', 'Trabajo en Gutiérrez todos los días.', 'Gutiérrez'],
    ['me quedé en Zapata', 'Me quedé en Zapata una semana.', 'Zapata'],
    ['vine desde Rosa', 'Vine desde Rosa con los niños.', 'Rosa'],
    ['llegamos hasta Toño', 'Llegamos hasta Toño por la tarde.', 'Toño'],
    ['estaba en Pedro', 'Estaba en Pedro cuando pasó.', 'Pedro'],
    ['estoy en Lupita', 'Estoy en Lupita por ahora.', 'Lupita'],
    ['soy de Hernández', 'Yo soy de Hernández.', 'Hernández'],
    ['es de Ramírez', 'La tierra es de Ramírez.', 'Ramírez'],
    ['pienso en Soledad', 'Siempre pienso en Soledad.', 'Soledad'],
    ['confío en Pedro', 'Yo confío en Pedro.', 'Pedro'],
    ['eso es de Soledad', 'Eso es de Soledad.', 'Soledad'],
    ['la comunidad de Pedro Pérez', 'Vivo en la comunidad de Pedro Pérez.', 'Pedro Pérez'],
    ['the same, whole phrase', 'Vivo en la comunidad de Pedro Pérez.', 'comunidad de Pedro Pérez'],
    ['a bare "Juárez"', 'Vivo en Juárez desde niño.', 'Juárez'],
    ['a "Nombre Apellido" pair', 'Vivo en Rosa Torres.', 'Rosa Torres'],
    ['llegamos a Tepoztlán ("a" is not a locative)', 'Llegamos a Tepoztlán.', 'Tepoztlán'],
  ])('%s → hold', async (_case, text, finding) => {
    const result = await gate(text, [{ text: finding, type: 'lugar' }])
    expect(result.status).toBe('hold')
  })

  it('a town beside a held address does not save the address', async () => {
    const text = 'Vivo en Xoxocotla, Morelos. Mi casa está en la colonia Portales.'
    const result = await gate(text, [
      { text: 'Xoxocotla', type: 'lugar' },
      { text: 'colonia Portales', type: 'lugar' },
    ])
    expect(result.status).toBe('hold')
    if (result.status !== 'hold') return
    // Only the colonia is highlighted for the reviewer.
    expect(result.survivors).toHaveLength(1)
  })

  it('a town name used once as a place and once after "calle" holds', async () => {
    const result = await gate('Vivo en Morelos, en la calle Morelos.', [{ text: 'Morelos', type: 'lugar' }])
    expect(result.status).toBe('hold')
  })
})

describe('isTownLevelPlace — the two rules', () => {
  const text = 'Vivo en Xoxocotla, Morelos.'
  it('ignores only `lugar`', () => {
    expect(isTownLevelPlace({ text: 'Xoxocotla', type: 'lugar' }, text)).toBe(true)
    expect(isTownLevelPlace({ text: 'Xoxocotla', type: 'persona' }, text)).toBe(false)
    expect(isTownLevelPlace({ text: 'Xoxocotla', type: 'otro' }, text)).toBe(false)
  })
  it('refuses lower-case words, digits and periods', () => {
    expect(isTownLevelPlace({ text: 'la barranca', type: 'lugar' }, 'Vivo en la barranca.')).toBe(false)
    expect(isTownLevelPlace({ text: 'Morelos 45', type: 'lugar' }, 'Vivo en Morelos 45.')).toBe(false)
    expect(isTownLevelPlace({ text: 'Col. Centro', type: 'lugar' }, 'Vivo en Col. Centro.')).toBe(false)
  })
  it('🔴 never ignores "calle Morelos 45" or a C.P. (stage 2 removes the C.P. in code)', async () => {
    expect(isTownLevelPlace({ text: 'calle Morelos 45', type: 'lugar' }, 'Vivo en calle Morelos 45.')).toBe(false)
    expect(isTownLevelPlace({ text: 'C.P. 62790', type: 'lugar' }, 'Vivo en C.P. 62790.')).toBe(false)
    // The street is the model's (owner, Q3): found only at verify, it holds.
    const result = await gate('Vivo en calle Morelos 45, C.P. 62790, en Xoxocotla.', [
      { text: 'calle Morelos 45', type: 'lugar' },
    ])
    expect(result.status).toBe('hold')
    if (result.status !== 'hold') return
    expect(result.redactedText).not.toContain('62790')
    expect(result.redactedText).toContain('Xoxocotla')
  })
  it('⚠ documents residual risk 2: an uncommon name after "vivo en" still passes', () => {
    expect(isTownLevelPlace({ text: 'Xiadani', type: 'lugar' }, 'Vivo en Xiadani.')).toBe(true)
  })
  it('refuses a finding that does not occur in the text', () => {
    expect(isTownLevelPlace({ text: 'Tlapa', type: 'lugar' }, text)).toBe(false)
  })
})

describe('isTownLevelPlace — the span the model returns (2026-10-23)', () => {
  const text = 'Yo vivo en Xochitepec con mi familia.'
  it('🔴 reads the span as given: a lead in it is not cut', () => {
    expect(isTownLevelPlace({ text: 'Xochitepec', type: 'lugar' }, text)).toBe(true)
    expect(isTownLevelPlace({ text: 'Xochitepec', type: 'lugar' }, 'Soy de Xochitepec.')).toBe(true)
    expect(isTownLevelPlace({ text: 'en Xochitepec', type: 'lugar' }, text)).toBe(false)
    expect(isTownLevelPlace({ text: 'vivo en Xochitepec', type: 'lugar' }, text)).toBe(false)
    expect(isTownLevelPlace({ text: 'de Xochitepec', type: 'lugar' }, 'Soy de Xochitepec.')).toBe(false)
    expect(isTownLevelPlace({ text: 'soy de Xochitepec', type: 'lugar' }, 'Soy de Xochitepec.')).toBe(false)
  })
  it('🔴 the lead is not a pass: the town after it still needs its own context', () => {
    expect(isTownLevelPlace({ text: 'Yo vivo en Xochitepec', type: 'lugar' }, text)).toBe(false)
    expect(isTownLevelPlace({ text: 'en Xiadani', type: 'lugar' }, 'Pienso en Xiadani.')).toBe(false)
    expect(isTownLevelPlace({ text: 'de Soledad', type: 'lugar' }, 'Es la hija de Soledad.')).toBe(false)
    expect(isTownLevelPlace({ text: 'de Xiadani', type: 'lugar' }, 'Es la hija de Xiadani.')).toBe(false)
    expect(isTownLevelPlace({ text: 'en Santa Úrsula', type: 'lugar' }, 'Vivo en Santa Úrsula.')).toBe(false)
    expect(isTownLevelPlace({ text: 'en Xochitepec', type: 'otro' }, text)).toBe(false)
  })
  it('🔴 streets, colonias, ranchos and parajes, with or without the lead, are not towns', () => {
    for (const [span, t] of [
      ['calle Hidalgo 12', 'Vivo en calle Hidalgo 12.'],
      ['en calle Hidalgo 12', 'Vivo en calle Hidalgo 12.'],
      ['colonia Las Flores', 'Vivo en la colonia Las Flores.'],
      ['Las Flores', 'Vivo en la colonia Las Flores.'],
      ['en la colonia Las Flores', 'Vivo en la colonia Las Flores.'],
      ['rancho El Mezquite', 'Vivo en el rancho El Mezquite.'],
      ['El Mezquite', 'Vivo en el rancho El Mezquite.'],
      ['paraje Tres Cruces', 'Trabajo en el paraje Tres Cruces.'],
      ['Tres Cruces', 'Trabajo en el paraje Tres Cruces.'],
      ['en el paraje Tres Cruces', 'Trabajo en el paraje Tres Cruces.'],
    ] as const) {
      expect(isTownLevelPlace({ text: span, type: 'lugar' }, t), span).toBe(false)
    }
  })
  it('a town word before a many-word town anchors it', () => {
    const t = 'Vivo en el municipio de Real de Catorce.'
    expect(isTownLevelPlace({ text: 'Real de Catorce', type: 'lugar' }, t)).toBe(true)
    expect(isTownLevelPlace({ text: 'vivo en Real de Catorce', type: 'lugar' }, t)).toBe(false)
  })
  it('🔴 work is not residence: "trabajo en" is no town context', () => {
    expect(isTownLevelPlace({ text: 'Coppel', type: 'lugar' }, 'Trabajo en Coppel.')).toBe(false)
    expect(isTownLevelPlace({ text: 'trabajo en Coppel', type: 'lugar' }, 'Trabajo en Coppel.')).toBe(false)
  })
  it('🔴 a finding typed `domicilio` is never a town', () => {
    expect(isTownLevelPlace({ text: 'Xochitepec', type: 'lugar', typedAddress: true }, text)).toBe(false)
  })
  it('🔴 every spelling counts: a caps or glued occurrence out of a town context is not a town', () => {
    expect(isTownLevelPlace({ text: 'Xiadani', type: 'lugar' }, 'Vivo en Xiadani. XIADANI me dijo.')).toBe(false)
    expect(isTownLevelPlace({ text: 'Xiadani', type: 'lugar' }, 'Vivo en Xiadani. Xiadanita me dijo.')).toBe(false)
    expect(isTownLevelPlace({ text: 'Xochitepec', type: 'lugar' }, 'Vivo en XOCHITEPEC.')).toBe(true)
  })
})
