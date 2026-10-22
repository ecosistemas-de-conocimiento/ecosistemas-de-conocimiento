/**
 * THE OWNER'S RULINGS OF 2026-10-21 on titles, spellings and bare titles.
 *
 *   Q1  Leftover titles are accepted: "la maestra [Persona A]" may be published.
 *   Q2  Stage 3 redacts every spelling of a found name, whole words only.
 *   Q4  A bare title verify marks `identifica: false` does not hold the text.
 *
 * (Q3, the narrower stage 2, is tested in `deterministic.test.ts`.)
 *
 * Same harness as `gate.audit.test.ts`: call 1 = stage 3, call 2.. = verify,
 * every answer through the REAL `parseFindings`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DETECT_SYSTEM_PROMPT, parseFindings } from './detector'
import { ANONYMISE_VERIFY_ROUNDS_VAR, runAnonymisationGate } from './gate'
import type { PersonDetector } from './types'

type H = { texto: string; tipo: string; identifica?: unknown }

function scripted(perCall: H[][]): PersonDetector {
  let n = 0
  return {
    name: 'scripted',
    async detect({ text }) {
      const hallazgos = perCall[n++] ?? []
      return parseFindings(JSON.stringify({ hallazgos }), text)
    },
  }
}

const persona = (texto: string, identifica?: unknown): H =>
  identifica === undefined ? { texto, tipo: 'persona' } : { texto, tipo: 'persona', identifica }

function gate(text: string, perCall: H[][]) {
  return runAnonymisationGate({ contentKind: 'testimonio', text }, { detector: scripted(perCall) })
}

beforeEach(() => {
  vi.stubEnv(ANONYMISE_VERIFY_ROUNDS_VAR, '')
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Q1 — a title left beside a person placeholder is accepted', () => {
  const flat = DETECT_SYSTEM_PROMPT.replace(/\s+/g, ' ')

  it('the prompt no longer asks for "la maestra [Persona A]" as a finding', () => {
    expect(flat).not.toMatch(/el hallazgo es "la maestra \[Persona A\]"/)
    // …it lists it under what is NOT a finding, before the address section.
    expect(flat).toMatch(/No es un hallazgo:.*"la maestra \[Persona A\]".*Domicilios/)
    // A name or surname glued to a placeholder still is one.
    expect(flat).toContain('"[Persona A] López"')
  })

  it.each([
    ['En Xoxocotla la maestra Imelda nos ayudó.', 'Imelda', 'la maestra [Persona A]'],
    ['El delegado Abundio Cázares firmó.', 'Abundio Cázares', 'El delegado [Persona A]'],
  ])('verify does not hold on "%s" when the title is marked non-identifying', async (text, name, left) => {
    const r = await gate(text, [[persona(name)], [persona(left, false)]])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe(text.replace(name, '[Persona A]'))
  })
})

describe('Q2 — stage 3 redacts every spelling of a found name', () => {
  it('"Lucrecia" also takes "LUCRECIA" and "lucrecia", with ONE label', async () => {
    const r = await gate('Lucrecia vino. LUCRECIA: ya. Le dije a lucrecia.', [
      [persona('Lucrecia')],
      [],
    ])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('[Persona A] vino. [Persona A]: ya. Le dije a [Persona A].')
    expect(r.report.pseudonyms).toBe(1)
  })

  it('accents are folded: "Ángel" also takes "ANGEL"', async () => {
    const r = await gate('Ángel llegó. ANGEL se fue.', [[persona('Ángel')], []])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('[Persona A] llegó. [Persona A] se fue.')
  })

  it('🔴 whole words only: "Ana" leaves "mañana" and "Anabel" alone', async () => {
    const r = await gate('Ana vino mañana con Anabel.', [[persona('Ana'), persona('Anabel')], []])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('[Persona B] vino mañana con [Persona A].')
  })

  it('🔴 an exact match inside a longer word is not a redaction either', async () => {
    const r = await gate('Ana vino con Anabel.', [[persona('Ana')], []])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('[Persona A] vino con Anabel.')
  })
})

describe('Q4 — a bare title verify marks non-identifying does not hold the text', () => {
  it.each([
    'El doctor dijo que no.',
    'Llegó la maestra y se fue.',
    // ⚠ Accepted by the owner: a lower-case nickname can pass as a bare title.
    'Me trajo la güera ayer.',
  ])('"%s" → ready', async (text) => {
    const span = text.match(/El doctor|la maestra|la güera/)?.[0] as string
    const r = await gate(text, [[], [persona(span, false)]])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe(text)
  })

  it.each([
    ['Llegó el Chacho Melgarejo con la carta.', 'Chacho Melgarejo', false],
    ['Vino Lucrecia ayer.', 'Lucrecia', false],
    // Sentence start covers the first word only.
    ['Lucrecia Gómez vino.', 'Lucrecia Gómez', false],
    ['Vivía en el cuarto 12 de la vecindad.', 'el cuarto 12', false],
    // Not marked non-identifying: the lower-case span still holds.
    ['Llegó la maestra y se fue.', 'la maestra', undefined],
    ['Llegó la maestra y se fue.', 'la maestra', true],
    // A capitalised title mid-sentence looks exactly like a nickname: it holds.
    ['Llegó Don [Persona A] tarde.', 'Don [Persona A]', false],
  ])('"%s" with "%s" (identifica %s) still holds', async (text, span, identifica) => {
    const r = await gate(text, [[], [persona(span, identifica)]])
    expect(r.status).toBe('hold')
    if (r.status !== 'hold') return
    expect(r.stage).toBe('verify')
  })

  it('a capital after a full stop or a line break is a sentence start', async () => {
    for (const text of ['Ya. El doctor dijo que no.', 'Ya\nEl doctor dijo que no.', '¿El doctor? No.']) {
      const r = await gate(text, [[], [persona('El doctor', false)]])
      expect(r.status, text).toBe('ready')
    }
  })

  it('…but not after a comma', async () => {
    const r = await gate('Ya, El doctor dijo que no.', [[], [persona('El doctor', false)]])
    expect(r.status).toBe('hold')
  })

  it('🔴 any occurrence mid-sentence counts, even if another starts a sentence', async () => {
    const r = await gate('Chacho vino. Le dije a Chacho.', [[], [persona('Chacho', false)]])
    expect(r.status).toBe('hold')
  })

  it('stage 3 still redacts a bare title marked non-identifying', async () => {
    const r = await gate('El doctor dijo que no.', [[persona('El doctor', false)], []])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('[Persona A] dijo que no.')
  })
})
