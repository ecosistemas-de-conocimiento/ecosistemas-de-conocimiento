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

describe('Q5 — a one-word name at a sentence start is redacted, whatever `identifica` says', () => {
  it('"Lucrecia llegó tarde." → ready, redacted, at the default of one round', async () => {
    const r = await gate('Lucrecia llegó tarde.', [[], [persona('Lucrecia', false)]])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('[Persona A] llegó tarde.')
  })

  it('a speaker label "LUCRECIA:" is redacted, every spelling with one label', async () => {
    const r = await gate('LUCRECIA: bueno pues sí. Luego Lucrecia se fue.', [
      [],
      [persona('LUCRECIA', false)],
    ])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('[Persona A]: bueno pues sí. Luego [Persona A] se fue.')
    expect(r.report.pseudonyms).toBe(1)
  })

  it('uses the document allocator: a first name alone is not merged into a full name', async () => {
    const r = await gate('Vino Lucrecia Gómez. Lucrecia llegó tarde.', [
      [persona('Lucrecia Gómez')],
      [persona('Lucrecia', false)],
    ])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('Vino [Persona A]. [Persona B] llegó tarde.')
  })

  it('a one-word title at a line start is redacted too (accepted by the owner)', async () => {
    const r = await gate('Doctor: ya está.', [[], [persona('Doctor', false)]])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('[Persona A]: ya está.')
  })

  it('a lower-case single word marked false still passes untouched (Q4 accepted risk)', async () => {
    const r = await gate('Me trajo chela ayer.', [[], [persona('chela', false)]])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('Me trajo chela ayer.')
  })

  it('"Don [Persona A]" at a sentence start, marked false, passes (Q1 title, not one word)', async () => {
    const r = await gate('Don Fermín llegó.', [[persona('Fermín')], [persona('Don [Persona A]', false)]])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('Don [Persona A] llegó.')
  })

  it('"El doctor llegó" marked false still passes untouched (Q4)', async () => {
    const r = await gate('El doctor llegó.', [[], [persona('El doctor', false)]])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('El doctor llegó.')
  })

  it('"Llegó Chacho Melgarejo" marked false still holds', async () => {
    const r = await gate('Llegó Chacho Melgarejo.', [[], [persona('Chacho Melgarejo', false)]])
    expect(r.status).toBe('hold')
  })

  it('🔴 beside another leftover the document still holds, and the name is highlighted', async () => {
    const r = await gate('Lucrecia llegó. Vino Chacho.', [
      [],
      [persona('Lucrecia', false), persona('Chacho')],
    ])
    expect(r.status).toBe('hold')
    if (r.status !== 'hold') return
    const marked = (r.survivors ?? []).map((s) => r.redactedText?.slice(s.start, s.end))
    expect(marked).toEqual(['Lucrecia', 'Chacho'])
  })

  it('with opt-in rounds it is redacted with the other leftovers', async () => {
    const r = await runAnonymisationGate(
      { contentKind: 'testimonio', text: 'Lucrecia llegó. Vino Chacho.' },
      {
        detector: scripted([[], [persona('Lucrecia', false), persona('Chacho')], []]),
        verifyRounds: 3,
      },
    )
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('[Persona A] llegó. Vino [Persona B].')
  })
})

const lugar = (texto: string, identifica?: unknown): H =>
  identifica === undefined ? { texto, tipo: 'lugar' } : { texto, tipo: 'lugar', identifica }

describe('🔴 final audit 2026-10-21 — B1: a Q5 redaction that changes nothing holds', () => {
  it.each([
    ['José llegó tarde.', 'José', '[Persona A] llegó tarde.'],
    ['JOSÉ: bueno.', 'JOSÉ', '[Persona A]: bueno.'],
  ])('decomposed (NFD) "%s" is redacted', async (text, name, want) => {
    const r = await gate(text.normalize('NFD'), [[], [persona(name, false)]])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe(want)
  })

  it('decomposed text found by stage 3 is redacted too', async () => {
    const r = await gate('Vino José. Luego JOSÉ habló.'.normalize('NFD'), [[persona('José')], []])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('Vino [Persona A]. Luego [Persona A] habló.')
  })

  it('a one-word name the redaction cannot reach holds instead of passing', async () => {
    // A typo glued to the name: whole-word matching leaves it, so it must hold.
    const r = await gate('Lucreciaa llegó tarde.', [[], [persona('Lucreciaa', false)]])
    expect(r.status).toBe('ready')
    const glued = await gate('Lucreciaa llegó tarde.', [[], [persona('Lucrecia', false)]])
    expect(glued.status).toBe('hold')
  })
})

describe('🔴 final audit 2026-10-21 — B2: only a `persona` can be a bare title', () => {
  it.each([
    ['Vivo en la calle hidalgo desde niña.', lugar('calle hidalgo', false)],
    ['Vivo en la col. portales desde niña.', lugar('col. portales', false)],
    ['Mi número es cinco cinco uno dos tres cuatro.', { texto: 'cinco cinco uno dos tres cuatro', tipo: 'contacto', identifica: false }],
    ['Vivo en manzana cuatro lote doce.', lugar('manzana cuatro lote doce', false)],
    ['Su clave es equis ye zeta.', { texto: 'equis ye zeta', tipo: 'identificador', identifica: false }],
  ] as Array<[string, H]>)('"%s" holds', async (text, finding) => {
    const r = await gate(text, [[], [finding]])
    expect(r.status).toBe('hold')
  })
})

describe('🔴 final audit 2026-10-21 — glued names are words', () => {
  it('a digit ends a word: "lucrecia88" loses the name', async () => {
    const r = await gate('Me escribió lucrecia88 ayer.', [[persona('lucrecia')], []])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('Me escribió [Persona A]88 ayer.')
  })

  it('a lower-to-upper change ends a word: "MaríaLópez" loses "López"', async () => {
    const r = await gate('Firmó MaríaLópez ayer.', [[persona('López')], []])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('Firmó María[Persona A] ayer.')
  })

  it('…and still leaves "Mañana" and "anabel" alone for "ana"', async () => {
    const r = await gate('Mañana viene anabel. Ana no.', [[persona('Ana')], []])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('Mañana viene anabel. [Persona A] no.')
  })
})

describe('🔴 final audit 2026-10-21 — surviving mutants', () => {
  it('X7: a finding is never written inside a placeholder stage 2 made', async () => {
    const r = await gate('C.P. 06700. Domicilio conocido de Ana.', [[persona('Domicilio')], []])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('[Domicilio A]. [Persona A] conocido de Ana.')
  })

  it('X12: one unsafe leftover holds the round, even beside a safe one', async () => {
    const r = await runAnonymisationGate(
      { contentKind: 'testimonio', text: 'Vino Ana de Rosa. Vino Chacho.' },
      {
        detector: scripted([
          [persona('Ana'), persona('Rosa')],
          [persona('[Persona B] de [Persona A]'), persona('Chacho')],
          [],
        ]),
        verifyRounds: 3,
      },
    )
    expect(r.status).toBe('hold')
  })

  it('X28: a two-letter capitalised fragment is too weak to redact globally', async () => {
    const r = await runAnonymisationGate(
      { contentKind: 'testimonio', text: 'ANA Lu EVA vinieron. Lu también.' },
      {
        detector: scripted([[persona('ANA'), persona('EVA')], [persona('[Persona A] Lu [Persona B]')], []]),
        verifyRounds: 3,
      },
    )
    expect(r.status).toBe('hold')
  })
})

describe('final audit 2026-10-21 — more surviving mutants', () => {
  it('X10: a round whose redaction changes nothing holds', async () => {
    const r = await runAnonymisationGate(
      { contentKind: 'testimonio', text: 'Vino Lucreciaa ayer.' },
      { detector: scripted([[], [persona('Lucrecia')], []]), verifyRounds: 3 },
    )
    expect(r.status).toBe('hold')
  })

  it('X16: a colon does not start a sentence', async () => {
    const r = await gate('Dijo: El doctor vino.', [[], [persona('El doctor', false)]])
    expect(r.status).toBe('hold')
  })

  it('X17: an ellipsis does', async () => {
    const r = await gate('Ya… El doctor vino.', [[], [persona('El doctor', false)]])
    expect(r.status).toBe('ready')
  })

  it('X18: the hold counts every highlighted occurrence', async () => {
    const r = await gate('Vino Chacho. Luego Chacho se fue.', [[], [persona('Chacho')]])
    expect(r.status).toBe('hold')
    if (r.status !== 'hold') return
    expect(r.reason).toContain('Quedaron 2 datos')
    expect(r.report.stages.at(-1)?.note).toContain('Quedaron 2 datos')
  })
})

describe('final audit 2026-10-21 — accent marks NFC cannot compose', () => {
  // "a" + U+030B has no precomposed form, so it survives the gate's NFC step.
  const MARK = '̋'

  it('a trailing mark is part of the name it sits on', async () => {
    const r = await gate(`Vino Ana${MARK} ayer.`, [[persona('Ana')], []])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('Vino [Persona A] ayer.')
  })

  it('a mark before a capital does not hide the case break', async () => {
    const r = await gate(`Firmó Ana${MARK}López ayer.`, [[persona('López')], []])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe(`Firmó Ana${MARK}[Persona A] ayer.`)
  })

  it('upper to upper is not a break: "ANABEL" keeps its "ANA"', async () => {
    const r = await gate('ANABEL vino. Ana no.', [[persona('Ana')], []])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('ANABEL vino. [Persona A] no.')
  })
})
