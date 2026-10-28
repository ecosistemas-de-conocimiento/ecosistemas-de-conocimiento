/**
 * OWNER'S RULINGS RELAYED 2026-10-23.
 *
 *   Q10 A, "the model decides": stage 3 redacts EVERY finding the model
 *   reports, towns included, exactly as before the town work. The town rule
 *   (`townPlaces.ts`) is used where it always was: verify's hold decision and
 *   the place-hold re-run. Towns stay visible because the PROMPT says they are
 *   not personal data.
 *
 *   Titles: no word list; the prompt asks the model to include an honorific or
 *   role title directly before a name in the name's span.
 *
 * Faked at the fetch boundary, under the real `AIClient`, `aiServiceDetector`
 * and gate.
 */

import { AIClient } from '@edc/ai-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { aiServiceDetector, DETECT_SYSTEM_PROMPT, parseFindings, type SyncGenerator } from './detector'
import { ANONYMISE_VERIFY_ROUNDS_VAR, runAnonymisationGate } from './gate'

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

describe('Q10 A: stage 3 redacts every finding, towns included', () => {
  it('a town the model reports at stage 3 is redacted', async () => {
    const r = await run('Yo vivo en Xochitepec con mi familia.', [[{ texto: 'Xochitepec', tipo: 'lugar' }], []])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('Yo vivo en [Domicilio A] con mi familia.')
  })

  it('a town the model does NOT report stays visible', async () => {
    const text = 'Vivo en Xochitepec, Morelos, y soy de Tlapa, Guerrero.'
    const r = await run(text, [[], []])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe(text)
  })

  it('verify still lets a town through (the town rule decides the hold)', async () => {
    const text = 'Yo vivo en Xochitepec con mi familia.'
    const r = await run(text, [[], [{ texto: 'Xochitepec', tipo: 'lugar' }]])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe(text)
  })

  it('verify still holds on a town the model typed `domicilio`', async () => {
    const r = await run('Yo vivo en Xochitepec.', [[], [{ texto: 'Xochitepec', tipo: 'domicilio' }]])
    expect(r.status).toBe('hold')
  })
})

describe('the prompt: towns are not personal data; addresses and institutions are', () => {
  const flat = DETECT_SYSTEM_PROMPT.replace(/\s+/g, ' ')

  it('says towns, municipalities, ejidos and states are not personal data', () => {
    expect(flat).toContain(
      'Los pueblos, municipios, alcaldías, ciudades, comunidades, localidades, ejidos, congregaciones y estados NO son datos personales y NO se reportan',
    )
    expect(flat).toContain('En "Vivo en Xochitepec, Morelos" no hay ningún hallazgo.')
    // One town paragraph, not two (audit of 9edaa22).
    expect(flat).not.toContain('NUNCA marques estados')
    expect(flat.match(/no hay (ningún )?hallazgo/g)).toHaveLength(1)
  })

  it('says a street or colonia named after a town or state IS reported', () => {
    expect(flat).toContain(
      'Una calle o colonia con nombre de pueblo o estado SÍ se marca: "calle Morelos 12", "colonia Xochitepec", "Hidalgo 12".',
    )
  })

  it('still asks for streets, numbers, colonias, ranchos, parajes, haciendas and institutions', () => {
    expect(flat).toContain('- Calles, avenidas, andadores, cerradas, privadas y sus números.')
    expect(flat).toContain('- Colonias, barrios, fraccionamientos, unidades habitacionales, manzana y lote.')
    expect(flat).toContain('- Ranchos, parajes y haciendas con nombre')
    expect(flat).toContain(
      '- Una institución CON NOMBRE, o junto a un pueblo, donde está, vive, trabaja o estudia una persona: "el Cereso", "el hospital de Xochitepec", "la escuela Benito Juárez".',
    )
    expect(flat).toContain('En "estoy en Atlacholoaya, en el Cereso" el hallazgo es "el Cereso".')
    // Reconciled with `genericPlaces.ts`, which drops an unnamed one.
    expect(flat).toContain('Un "el hospital" o "la escuela" solo, sin nombre ni pueblo, no se reporta.')
  })

  it('asks for a title before a name inside the name, and keeps a bare title out', () => {
    expect(flat).toContain('Un tratamiento o cargo que antecede al nombre es parte del nombre')
    expect(flat).toContain('"Don Fernando Vázquez"')
    expect(flat).toContain('en "la maestra Lucrecia" es "la maestra Lucrecia"')
    expect(flat).toContain('en "el delegado Abundio Cázares" es "el delegado Abundio Cázares"')
    expect(flat).toContain('- Un tratamiento o cargo SOLO, sin nombre ni apodo junto a él')
  })
})

describe('titles: the model returns the title with the name', () => {
  it('replaces the whole span, title included, one label per person', async () => {
    const text = 'Me ayudó Don Fernando Vázquez. La maestra Lucrecia y el delegado Abundio Cázares vinieron.'
    const r = await run(text, [
      [
        { texto: 'Don Fernando Vázquez', tipo: 'persona' },
        { texto: 'la maestra Lucrecia', tipo: 'persona' },
        { texto: 'el delegado Abundio Cázares', tipo: 'persona' },
      ],
      [],
    ])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    // Letters follow span length (longest first, `applyFindings`), not reading order.
    expect(r.redactedText).toMatch(/^Me ayudó \[Persona [ABC]\]\. \[Persona [ABC]\] y \[Persona [ABC]\] vinieron\.$/)
    expect(r.report.pseudonyms).toBe(3)
  })

  it('locates a span starting with a lower-case article, case- and accent-blind', () => {
    const source = 'La maestra Lucrecia llegó. EL DELEGADO ABUNDIO CAZARES también.'
    expect(parseFindings(JSON.stringify({ hallazgos: [{ texto: 'la maestra Lucrecia', tipo: 'persona' }] }), source))
      .toEqual([{ text: 'La maestra Lucrecia', type: 'persona' }])
    expect(parseFindings(JSON.stringify({ hallazgos: [{ texto: 'el delegado Abundio Cázares', tipo: 'persona' }] }), source))
      .toEqual([{ text: 'EL DELEGADO ABUNDIO CAZARES', type: 'persona' }])
  })

  it('Q4: a bare title marked non-identifying stays out at verify', async () => {
    const text = 'El doctor dijo que no.'
    const r = await run(text, [[], [{ texto: 'El doctor', tipo: 'persona', identifica: false }]])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe(text)
  })

  it('Q5 at stage 3: a one-word name is redacted (verify: gate.q10b.test.ts)', async () => {
    const r = await run('Lucrecia llegó tarde.', [[{ texto: 'Lucrecia', tipo: 'persona' }], []])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('[Persona A] llegó tarde.')
  })
})
