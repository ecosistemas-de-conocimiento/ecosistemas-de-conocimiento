/**
 * OWNER'S RULING, 2026-10-21 (#12), RE-STATED 2026-10-23: A TOWN STAYS VISIBLE.
 *
 * Dev, 2026-10-23: "vivo en Xochitepec" came out as "vivo en [Domicilio A]".
 * Stage 3 replaced every `lugar` finding; the town rule (`townPlaces.ts`) ran
 * only on verify's hold decision. These tests fake the model at the fetch
 * boundary, under the REAL `AIClient`, `aiServiceDetector` and gate, with the
 * answers a model plausibly gives for a town — and check that streets,
 * colonias, ranchos and parajes still go.
 */

import { AIClient } from '@edc/ai-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { aiServiceDetector, type SyncGenerator } from './detector'
import { ANONYMISE_VERIFY_ROUNDS_VAR, runAnonymisationGate } from './gate'

type H = { texto: string; tipo: string; identifica?: boolean }

/** Call 1 = stage 3, call 2.. = verify. One chunk per call at these sizes. */
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

function gate(text: string, perCall: H[][]) {
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

const TOWN_ANSWERS: H[] = [
  { texto: 'Xochitepec', tipo: 'lugar', identifica: true },
  { texto: 'Xochitepec', tipo: 'lugar', identifica: false },
  { texto: 'en Xochitepec', tipo: 'lugar', identifica: true },
  { texto: 'en Xochitepec', tipo: 'lugar', identifica: false },
  { texto: 'vivo en Xochitepec', tipo: 'lugar', identifica: true },
  { texto: 'XOCHITEPEC', tipo: 'lugar', identifica: true },
]

// 🔴 Audit 2026-10-23: the model calling it `domicilio` means a home. It is
// never exempted as a town, and it keeps an address label.
describe('a span the model typed `domicilio` is redacted as an address, town-shaped or not', () => {
  for (const answer of [
    { texto: 'Xochitepec', tipo: 'domicilio', identifica: true },
    { texto: 'Xochitepec', tipo: 'domicilio', identifica: false },
  ]) {
    it(JSON.stringify(answer), async () => {
      const r = await gate('Yo vivo en Xochitepec con mi familia.', [[answer], []])
      expect(r.status).toBe('ready')
      if (r.status !== 'ready') return
      expect(r.redactedText).toBe('Yo vivo en [Domicilio A] con mi familia.')
    })
  }
  it('"en Xochitepec" typed domicilio → the whole span', async () => {
    const r = await gate('Nací en Xochitepec y ahí crecí.', [[{ texto: 'en Xochitepec', tipo: 'domicilio' }], []])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('Nací [Domicilio A] y ahí crecí.')
  })
  it('🔴 at verify, a `domicilio` town-shaped leftover HOLDS', async () => {
    const answer = { texto: 'Insurgentes', tipo: 'domicilio' }
    const r = await gate('Vivo en Insurgentes.', [[], [answer]])
    expect(r.status).toBe('hold')
  })
  it('🔴 one chunk typing it `lugar` and another `domicilio`: domicilio wins', async () => {
    const r = await gate('Vivo en Insurgentes.', [
      [
        { texto: 'Insurgentes', tipo: 'lugar' },
        { texto: 'Insurgentes', tipo: 'domicilio' },
      ],
      [],
    ])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('Vivo en [Domicilio A].')
  })
})

describe('a bare town after a residence or origin verb is shown', () => {
  const TEXTS = [
    'Yo vivo en Xochitepec con mi familia.',
    'Nací en Xochitepec y ahí crecí.',
    'Soy de Xochitepec, Morelos.',
  ]
  for (const text of TEXTS) {
    for (const answer of TOWN_ANSWERS) {
      const shown = text.includes(answer.texto) || answer.texto === 'XOCHITEPEC'
      if (!shown) continue
      it(`${JSON.stringify(text)} with ${JSON.stringify(answer)} in stage 3 and verify → unchanged`, async () => {
        const r = await gate(text, [[answer], [answer]])
        expect(r.status).toBe('ready')
        if (r.status !== 'ready') return
        expect(r.redactedText).toBe(text)
        expect(r.report.addresses).toBe(0)
      })
    }
  }

  it('"de Xochitepec" after "soy" → unchanged', async () => {
    const text = 'Soy de Xochitepec.'
    const answer = { texto: 'de Xochitepec', tipo: 'lugar' }
    const r = await gate(text, [[answer], [answer]])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe(text)
  })

  it('the town shows while the person beside it is redacted', async () => {
    const text = 'Me llamo Xiadani y vivo en Xochitepec.'
    const r = await gate(text, [
      [
        { texto: 'Xiadani', tipo: 'persona' },
        { texto: 'Xochitepec', tipo: 'lugar' },
      ],
      [],
    ])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('Me llamo [Persona A] y vivo en Xochitepec.')
  })
})

describe('what is inside a town is still redacted', () => {
  const CASES: Array<[string, string, string]> = [
    // ⚠ Not "Xochitepec, en la calle…": a street word within five words after
    // a town redacts the town too (rule 6, re-audit 2026-10-23).
    ['Vivo en Xochitepec y mi casa está en la calle Hidalgo 12.', 'calle Hidalgo 12', 'Vivo en Xochitepec y mi casa está en la [Domicilio A].'],
    ['Vivo en Xochitepec y mi casa está en la calle Hidalgo 12.', 'en la calle Hidalgo 12', 'Vivo en Xochitepec y mi casa está [Domicilio A].'],
    ['Vivo en la colonia Las Flores.', 'colonia Las Flores', 'Vivo en la [Domicilio A].'],
    ['Vivo en la colonia Las Flores.', 'Las Flores', 'Vivo en la colonia [Domicilio A].'],
    ['Vivo en el rancho El Mezquite.', 'rancho El Mezquite', 'Vivo en el [Domicilio A].'],
    ['Vivo en el rancho El Mezquite.', 'El Mezquite', 'Vivo en el rancho [Domicilio A].'],
    ['Vivo en el rancho El Mezquite.', 'en el rancho El Mezquite', 'Vivo [Domicilio A].'],
    ['Trabajo en el paraje Tres Cruces.', 'paraje Tres Cruces', 'Trabajo en el [Domicilio A].'],
    ['Trabajo en el paraje Tres Cruces.', 'Tres Cruces', 'Trabajo en el paraje [Domicilio A].'],
  ]
  for (const [text, texto, expected] of CASES) {
    for (const tipo of ['lugar', 'domicilio']) {
      it(`${JSON.stringify(texto)} as ${tipo} in ${JSON.stringify(text)} → redacted`, async () => {
        const answers: H[] = [{ texto, tipo }]
        if (text.includes('Xochitepec')) answers.push({ texto: 'Xochitepec', tipo: 'lugar' })
        const r = await gate(text, [answers, []])
        expect(r.status).toBe('ready')
        if (r.status !== 'ready') return
        expect(r.redactedText).toBe(expected)
      })
    }
  }
})

describe('fail closed: what is not clearly a town is redacted', () => {
  const CASES: Array<[string, H, string]> = [
    // "en" without a verb of residence or movement.
    ['Pienso en Xiadani todos los días.', { texto: 'en Xiadani', tipo: 'lugar' }, 'Pienso [Domicilio A] todos los días.'],
    // A person's name after "de".
    ['Es la hija de Soledad.', { texto: 'de Soledad', tipo: 'lugar' }, 'Es la hija [Domicilio A].'],
    // A weak name (article, saint) with no state after it.
    ['Vivo en Santa Úrsula.', { texto: 'en Santa Úrsula', tipo: 'lugar' }, 'Vivo [Domicilio A].'],
    // A prefix the town rule does not read: the whole span goes.
    ['Yo vivo en Xochitepec.', { texto: 'Yo vivo en Xochitepec', tipo: 'lugar' }, '[Domicilio A].'],
    // `otro` is never a town.
    ['Vivo en Xochitepec.', { texto: 'Xochitepec', tipo: 'otro' }, 'Vivo en [Dato omitido].'],
  ]
  for (const [text, answer, expected] of CASES) {
    it(`${JSON.stringify(answer)} in ${JSON.stringify(text)} → redacted`, async () => {
      const r = await gate(text, [[answer], []])
      expect(r.status).toBe('ready')
      if (r.status !== 'ready') return
      expect(r.redactedText).toBe(expected)
    })
  }

  it('"en" after a street is not after a verb: the town there is redacted too', async () => {
    const text = 'Vivo en calle Hidalgo 12, en Xochitepec.'
    const r = await gate(text, [
      [
        { texto: 'calle Hidalgo 12', tipo: 'lugar' },
        { texto: 'Xochitepec', tipo: 'lugar' },
      ],
      [],
    ])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('Vivo en [Domicilio A], en [Domicilio B].')
  })

  it('a town spelled another way elsewhere, out of a town context, keeps it redacted', async () => {
    const text = 'Vivo en Xiadani. XIADANI me dijo que viniera.'
    const r = await gate(text, [[{ texto: 'Xiadani', tipo: 'lugar' }], []])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('Vivo en [Domicilio A]. [Domicilio A] me dijo que viniera.')
  })

  it('the same name elsewhere in a non-town context keeps it redacted everywhere', async () => {
    const text = 'Vivo en Xiadani. Le dije a Xiadani que viniera.'
    const r = await gate(text, [[{ texto: 'Xiadani', tipo: 'lugar' }], []])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).not.toContain('Xiadani')
  })
})
