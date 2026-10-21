/**
 * REGRESSIONS FROM THE 2026-10-21 ADVERSARIAL AUDIT of the verify-rounds branch.
 *
 * Each input below is one the audit ran against the gate and saw end in the
 * wrong answer. The detector is scripted per call (call 1 = stage 3, call 2.. =
 * verify rounds) and goes through the REAL `parseFindings`, so `identifica`,
 * case folding and the hallucination filter behave exactly as in production.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  aiServiceDetector,
  DETECT_SYSTEM_PROMPT,
  DetectorFailure,
  locateSpan,
  parseFindings,
  type SyncGenerator,
} from './detector'
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
const lugar = (texto: string): H => ({ texto, tipo: 'lugar' })

function gate(text: string, perCall: H[][], opts: { roster?: string[]; rounds?: number } = {}) {
  return runAnonymisationGate(
    { contentKind: 'testimonio', text, ...(opts.roster ? { roster: opts.roster } : {}) },
    { detector: scripted(perCall), ...(opts.rounds ? { verifyRounds: opts.rounds } : {}) },
  )
}

// Blank = unset: every test here runs the DEFAULT unless it passes `rounds`.
beforeEach(() => {
  vi.stubEnv(ANONYMISE_VERIFY_ROUNDS_VAR, '')
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('🔴 `identifica: false` never lets a name through', () => {
  const text = 'Llegó el Chacho Melgarejo con la carta.'

  it('verify does NOT honour it: a name it marks non-identifying holds', async () => {
    const r = await gate(text, [[], [persona('Chacho Melgarejo', false)]])
    expect(r.status).toBe('hold')
    if (r.status !== 'hold') return
    expect(r.stage).toBe('verify')
  })

  it('…and with opt-in rounds it is redacted, not ignored', async () => {
    const r = await gate(text, [[], [persona('Chacho Melgarejo', false)], []], { rounds: 3 })
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).not.toContain('Melgarejo')
  })

  it('stage 3 redacts a span with a proper noun even when marked non-identifying', async () => {
    const r = await gate(text, [[persona('el Chacho Melgarejo', false)], []])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('Llegó [Persona A] con la carta.')
  })

  it('stage 3 redacts a non-identifying span that holds a placeholder', async () => {
    const r = await gate(
      'Vino la maestra Imelda Ruiz.',
      [[persona('la maestra [Persona A]', false)], []],
      { roster: ['Imelda Ruiz'] },
    )
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).not.toContain('maestra')
  })

  it('stage 3 redacts even a bare title marked non-identifying (over-redaction accepted)', async () => {
    const r = await gate('El doctor dijo que no.', [[persona('El doctor', false)], []])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('[Persona A] dijo que no.')
  })

  it('🔴 fail-closed: verify reporting a bare title, even as non-identifying, holds', async () => {
    const r = await gate('El doctor dijo que no.', [[], [persona('El doctor', false)]])
    expect(r.status).toBe('hold')
  })

  it('a missing `identifica` is identifying, even for a lower-case span', async () => {
    const r = await gate('Me trajo la chela ayer.', [[persona('la chela')], []])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('Me trajo [Persona A] ayer.')
  })

  it('`identifica: "false"` (a string) is identifying', async () => {
    const r = await gate('Vino Lucrecia.', [[persona('Lucrecia', 'false')], []])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('Vino [Persona A].')
  })

  it('parseFindings leaves `identifying` unset when the model omits it', () => {
    const [f] = parseFindings('{"hallazgos":[{"texto":"Ana","tipo":"persona"}]}', 'Ana vino.')
    expect(f?.identifying).toBeUndefined()
  })

  it.each([0, null, 'false', 'no', true])(
    'parseFindings treats `identifica: %j` as identifying',
    (value) => {
      const raw = JSON.stringify({ hallazgos: [{ texto: 'Ana', tipo: 'persona', identifica: value }] })
      const [f] = parseFindings(raw, 'Ana vino.')
      expect(f?.identifying).toBeUndefined()
    },
  )

  it('parseFindings records a literal `false`', () => {
    const raw = '{"hallazgos":[{"texto":"Ana","tipo":"persona","identifica":false}]}'
    expect(parseFindings(raw, 'Ana vino.')[0]?.identifying).toBe(false)
  })

  it.each([0, null])('`identifica: %j` at stage 3 is redacted', async (value) => {
    const r = await gate('Vino Lucrecia.', [[persona('Lucrecia', value)], []])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('Vino [Persona A].')
  })
})

describe('🔴 a role or cargo next to a placeholder is judged by verify, not exempted', () => {
  it('the prompt asks for "la maestra [Persona A]" as a finding, and still not a bare title', () => {
    expect(DETECT_SYSTEM_PROMPT).toContain('"la maestra [Persona A]"')
    expect(DETECT_SYSTEM_PROMPT).not.toContain('"Don\n  [Persona F]"')
    expect(DETECT_SYSTEM_PROMPT).not.toMatch(/Don\s+\[Persona F\]/)
    expect(DETECT_SYSTEM_PROMPT).toContain('el doctor dijo')
    expect(DETECT_SYSTEM_PROMPT).toContain('"colonia [Domicilio L]"')
  })

  const cases: Array<{ name: string; text: string; stage3: H[]; leftover: string; roster?: string[]; clean: string }> = [
    {
      name: 'la maestra [Persona A]',
      text: 'En Xoxocotla la maestra Imelda nos ayudó.',
      stage3: [persona('Imelda')],
      leftover: 'la maestra [Persona A]',
      clean: 'En Xoxocotla [Persona A] nos ayudó.',
    },
    {
      name: 'El delegado [Persona A]',
      text: 'El delegado Abundio Cázares firmó.',
      stage3: [persona('Abundio Cázares')],
      leftover: 'El delegado [Persona A]',
      clean: '[Persona A] firmó.',
    },
    {
      name: 'roster: La maestra [Persona A]',
      text: 'La maestra Imelda Ruiz llegó.',
      stage3: [],
      leftover: 'La maestra [Persona A]',
      roster: ['Imelda Ruiz'],
      clean: '[Persona A] llegó.',
    },
  ]

  it.each(cases)('$name holds at the default of one round', async (c) => {
    const r = await gate(c.text, [c.stage3, [persona(c.leftover)]], { roster: c.roster })
    expect(r.status).toBe('hold')
    if (r.status !== 'hold') return
    expect(r.stage).toBe('verify')
  })

  it.each(cases)('$name is absorbed into the placeholder with opt-in rounds', async (c) => {
    const r = await gate(c.text, [c.stage3, [persona(c.leftover)], []], {
      roster: c.roster,
      rounds: 3,
    })
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe(c.clean)
    expect(r.report.pseudonyms).toBe(1)
  })
})

describe('🔴 locateSpan never matches inside a placeholder', () => {
  it('finds the text’s own "domi", not the "Domi" in [Domicilio A]', () => {
    expect(locateSpan('Vivo en [Domicilio A]. La domi me trajo.', 'Domi')).toBe('domi')
  })

  it('returns null when the only match is inside a placeholder', () => {
    expect(locateSpan('Vivo en [Domicilio A].', 'Domi')).toBeNull()
    expect(locateSpan('Vino [Persona A].', 'persona')).toBeNull()
  })

  it('a nickname that folds onto a placeholder still holds the document', async () => {
    const text = 'Vivo en la colonia Las Flores. La domi me trajo.'
    const r = await gate(text, [[lugar('colonia Las Flores')], [persona('Domi')]])
    expect(r.status).toBe('hold')
  })

  it('…and is redacted with opt-in rounds', async () => {
    const text = 'Vivo en la colonia Las Flores. La domi me trajo.'
    const r = await gate(text, [[lugar('colonia Las Flores')], [persona('Domi')], []], { rounds: 3 })
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('Vivo en la [Domicilio A]. La [Persona A] me trajo.')
  })
})

describe('🔴 a verify error that never got an answer is retryable', () => {
  function failingVerify(err: Error): PersonDetector {
    let n = 0
    return {
      name: 'failing',
      async detect() {
        if (n++ === 0) return []
        throw err
      },
    }
  }

  it('infrastructure failure in verify → hold, retryable', async () => {
    const r = await runAnonymisationGate(
      { contentKind: 'testimonio', text: 'Ana llegó.' },
      { detector: failingVerify(new DetectorFailure('transporte', 'x', true)) },
    )
    expect(r.status).toBe('hold')
    if (r.status !== 'hold') return
    expect(r.stage).toBe('verify')
    expect(r.retryable).toBe(true)
  })

  it('an answer that would not parse in verify → hold, NOT retryable', async () => {
    const r = await runAnonymisationGate(
      { contentKind: 'testimonio', text: 'Ana llegó.' },
      { detector: failingVerify(new DetectorFailure('json-invalido', 'x')) },
    )
    expect(r.status).toBe('hold')
    if (r.status !== 'hold') return
    expect(r.retryable).toBeUndefined()
  })
})

describe('🔴 a leftover fragment too weak to redact globally holds instead', () => {
  it('"[Persona A] de [Persona B]" does not turn every "de" into a placeholder', async () => {
    // Same-length names keep A and B in the order given (longest-first is stable).
    const text = 'Ana de Eva vino. Pasa de largo.'
    const r = await gate(
      text,
      [[persona('Ana'), persona('Eva')], [persona('[Persona A] de [Persona B]')], []],
      { rounds: 3 },
    )
    expect(r.status).toBe('hold')
    if (r.status !== 'hold') return
    expect(r.redactedText).toContain('Pasa de largo.')
  })

  it('a short fragment such as a house number holds rather than redacting it everywhere', async () => {
    const text = 'Vivo en la colonia Las Flores 45 y tengo 45 años.'
    const r = await gate(
      text,
      // `otro` has no placeholder family, so the 45 is a FRAGMENT, not an absorption.
      [[lugar('colonia Las Flores')], [{ texto: '[Domicilio A] 45', tipo: 'otro' }], []],
      { rounds: 3 },
    )
    expect(r.status).toBe('hold')
  })

  it('a fragment with a proper noun is still redacted', async () => {
    const text = 'Vivo en Tlapa, Ana lo sabe.'
    const r = await gate(text, [[lugar('Tlapa')], [persona('Domicilio A], Ana')], []], { rounds: 3 })
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('Vivo en [Domicilio A], [Persona A] lo sabe.')
  })
})

/**
 * 🔴 RE-AUDIT 2026-10-21: STAGE 3 REDACTS EVERY FINDING, like main. An earlier
 * version kept a span marked `identifica: false` unless it held a capitalised
 * word outside a sentence start; that let lower-case nicknames, names at a
 * sentence start and ALL-CAPS speaker labels through. Verify is silent in every
 * case below, so stage 3 is the only thing standing between the name and a
 * `ready` text.
 */
describe('🔴 stage 3 redacts a finding marked `identifica: false`', () => {
  const cases: Array<[string, string, string]> = [
    ['lowercase nickname', 'Me trajo la güera ayer.', 'la güera'],
    ['lowercase full name (speech-to-text)', 'y luego llegó el chacho melgarejo con la carta', 'el chacho melgarejo'],
    ['single name mid-sentence', 'Vino Lucrecia.', 'Lucrecia'],
    ['sentence start', 'Lucrecia llegó tarde. Nadie dijo nada.', 'Lucrecia'],
    ['after a colon', 'Le dijo: Lucrecia, ven acá.', 'Lucrecia'],
    ['ALL-CAPS speaker label', 'Entrevista\nLUCRECIA: bueno pues sí.', 'LUCRECIA'],
    ['dialogue dash at line start', 'Gritó.\n—Lucrecia, ven.', 'Lucrecia'],
    ['after a quote mid-sentence', 'Le gritó "Lucrecia, ven".', 'Lucrecia'],
    ['after colon and quote', 'Le dijo: "Lucrecia, ven".', 'Lucrecia'],
    ['after ¿', 'Oye. ¿Lucrecia vino?', 'Lucrecia'],
    ['after an ellipsis', 'Pues… Lucrecia no vino.', 'Lucrecia'],
    ['ALL CAPS mid-sentence', 'LLEGÓ EL CHACHO MELGAREJO.', 'EL CHACHO MELGAREJO'],
    ['ALL CAPS single word at start', 'CHACHO LLEGÓ.', 'CHACHO'],
    ['accented initial at start', 'Ángel vino solo.', 'Ángel'],
    ['two words at start', 'Chacho Melgarejo llegó.', 'Chacho Melgarejo'],
    ['lowercase surname only', 'Vino el de los melgarejo.', 'los melgarejo'],
    ['nickname with article at start', 'El Chino llegó.', 'El Chino'],
    ['lowercase alias', 'Llegó el chino con la carta.', 'el chino'],
    ['after a semicolon', 'Vino tarde; Lucrecia no.', 'Lucrecia'],
    ['inside parentheses', 'Vino (Lucrecia) tarde.', 'Lucrecia'],
    ['model lowercases a capitalised span', 'Llegó el Chacho con la carta.', 'el chacho'],
  ]

  it.each(cases)('%s', async (_label, text, span) => {
    const r = await gate(text, [[persona(span, false)], []])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText.toLowerCase()).not.toContain(span.toLowerCase())
    expect(r.redactedText).toContain('[Persona A]')
  })

  it('a digit-bearing place marked non-identifying is redacted', async () => {
    const r = await gate('Vive en la casa 45.', [[{ texto: 'casa 45', tipo: 'lugar', identifica: false }], []])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('Vive en la [Domicilio A].')
  })
})

/**
 * Each input here would come out DIFFERENT if `safeFragment` let the weak piece
 * through, so a weakened check turns the test red instead of being masked by
 * the "nothing changed, hold" rule.
 */
describe('🔴 every weak-fragment check holds on its own', () => {
  it('a lower-case fragment of 3+ letters holds (the capital check)', async () => {
    const r = await gate(
      'Ana con Eva vino. Vino con todo.',
      [[persona('Ana'), persona('Eva')], [persona('[Persona A] con [Persona B]')], []],
      { rounds: 3 },
    )
    expect(r.status).toBe('hold')
    if (r.status !== 'hold') return
    expect(r.redactedText).toContain('Vino con todo.')
  })

  it('a capitalised fragment under 3 letters holds (the length check)', async () => {
    const r = await gate(
      'ANA Y EVA vinieron. Y luego nada.',
      [[persona('ANA'), persona('EVA')], [persona('[Persona A] Y [Persona B]')], []],
      { rounds: 3 },
    )
    expect(r.status).toBe('hold')
    if (r.status !== 'hold') return
    expect(r.redactedText).toContain('Y luego nada.')
  })

  it('one weak fragment beside a strong one holds the whole leftover (hold, not filter)', async () => {
    const r = await gate(
      'Ana de Eva López vino.',
      [[persona('Ana'), persona('Eva')], [persona('[Persona A] de [Persona B] López')], []],
      { rounds: 3 },
    )
    expect(r.status).toBe('hold')
    if (r.status !== 'hold') return
    expect(r.stage).toBe('verify')
  })
})

describe('🔴 a leftover is redacted in every spelling the text uses', () => {
  it('"Lucrecia" also redacts "LUCRECIA", with the same label', async () => {
    const r = await gate('Vino Lucrecia. LUCRECIA lo dijo.', [[], [persona('Lucrecia')], []], { rounds: 3 })
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('Vino [Persona A]. [Persona A] lo dijo.')
  })

  it('accents are folded too: "Angel" also redacts "ÁNGEL"', async () => {
    const r = await gate('Vino Angel. ÁNGEL lo dijo.', [[], [persona('Angel')], []], { rounds: 3 })
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('Vino [Persona A]. [Persona A] lo dijo.')
  })

  it('a folded twin inside a longer word is left alone', async () => {
    const r = await gate('Vino Ana. Mañana anabel vuelve.', [[], [persona('Ana')], []], { rounds: 3 })
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('Vino [Persona A]. Mañana anabel vuelve.')
  })

  it('an absorbed leftover takes its other spellings with it', async () => {
    const r = await gate(
      'Vino María López. Luego María LÓPEZ habló.',
      [[persona('María')], [persona('[Persona A] López')], []],
      { rounds: 3 },
    )
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('Vino [Persona A]. Luego [Persona A] habló.')
  })
})

/**
 * 🔴 A PLACEHOLDER CUT IN TWO BY A CHUNK EDGE IS STILL A PLACEHOLDER. The
 * chunker splits on words, so a chunk can end "…a [Domicilio " and the next
 * begin "A] y ya…". Re-audit 2026-10-21 (also on main): "Domi" matched inside
 * the cut "[Domicilio", was returned as found, and the gate then saw it only
 * inside `[Domicilio A]`, called it covered, and shipped "la domi".
 */
describe('🔴 locateSpan and a placeholder cut at a chunk edge', () => {
  // The chunker cuts only at whitespace, so a cut placeholder is "[Domicilio"
  // at a chunk's end and "A]" at the next one's start, never mid-word.
  it('skips a match inside a trailing cut placeholder', () => {
    expect(locateSpan('la domi me trajo a [Domicilio ', 'Domi')).toBe('domi')
    expect(locateSpan('me trajo a [Domicilio', 'Domi')).toBeNull()
    expect(locateSpan('vino con [Persona', 'Persona')).toBeNull()
    expect(locateSpan('no lo sé [Dato', 'dato')).toBeNull()
  })

  it('skips a match inside a leading cut placeholder', () => {
    expect(locateSpan('omitido] y nada', 'omitido')).toBeNull()
    expect(locateSpan('AB] y la Ab', 'AB')).toBe('Ab')
  })

  it('a bracket that is not one of ours stays text', () => {
    expect(locateSpan('vino [Domi', 'Domi')).toBe('Domi')
    expect(locateSpan('nota [ver Ana', 'Ana')).toBe('Ana')
    expect(locateSpan('Ana] y nada', 'Ana')).toBe('Ana')
  })

  it('through the chunked detector, the document holds', async () => {
    const client: SyncGenerator = {
      generate: {
        async sync(req) {
          const t = req.unit.input.userPrompt
          let hallazgos: H[] = []
          if (t.includes('Flores')) hallazgos = [lugar('Flores')]
          else if (t.includes('domi') && t.includes('[Domicilio')) hallazgos = [persona('Domi')]
          return { text: JSON.stringify({ hallazgos }) }
        },
      },
    }
    const detector = aiServiceDetector({ client, chunkWords: 6, concurrency: 1, retry: { attempts: 1 } })
    const r = await runAnonymisationGate(
      { contentKind: 'testimonio', text: 'la domi me trajo a Flores y ya nos quedamos ahí' },
      { detector },
    )
    expect(r.status).toBe('hold')
    if (r.status !== 'hold') return
    expect(r.stage).toBe('verify')
  })
})
