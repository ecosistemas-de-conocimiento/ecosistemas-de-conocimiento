/**
 * 🔴 AUDIT 2026-10-28 ITEM 3: a span that differs from the text only in
 * whitespace, hyphen or apostrophe spelling.
 *
 * The model reported "Nicéfora Tlapalcoyotl" for a text that wraps the name
 * across a line ("Nicéfora\nTlapalcoyotl", a PDF line break) or holds a double
 * space. `locateSpan` could not place it, the hallucination filter dropped it,
 * and the gate returned `ready` with the name still in the text. Verify had the
 * same blind spot.
 *
 * Now: the span is located whitespace-, hyphen- and apostrophe-blind, and a
 * span that still cannot be located is a HOLD, never a silent drop.
 *
 * Synthetic names only.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { locateSpan, parseFindings } from './detector'
import { ANONYMISE_VERIFY_ROUNDS_VAR, runAnonymisationGate } from './gate'
import type { DetectorFinding, PersonDetector } from './types'

type H = { texto: string; tipo: string }

/** Scripted per call (1 = stage 3, 2.. = verify), through the REAL `parseFindings`. */
function scripted(perCall: H[][]): PersonDetector {
  let n = 0
  return {
    name: 'scripted',
    async detect({ text }) {
      return parseFindings(JSON.stringify({ hallazgos: perCall[n++] ?? [] }), text)
    },
  }
}

/** A detector that hands its findings over RAW, without `parseFindings`. */
function raw(perCall: DetectorFinding[][]): PersonDetector {
  let n = 0
  return { name: 'raw', async detect() { return perCall[n++] ?? [] } }
}

const persona = (texto: string): H => ({ texto, tipo: 'persona' })

function gate(text: string, detector: PersonDetector, rounds?: number) {
  return runAnonymisationGate(
    { contentKind: 'testimonio', text },
    { detector, ...(rounds ? { verifyRounds: rounds } : {}) },
  )
}

beforeEach(() => {
  vi.stubEnv(ANONYMISE_VERIFY_ROUNDS_VAR, '')
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('🔴 locateSpan is whitespace-, hyphen- and apostrophe-blind', () => {
  it('finds a name wrapped across a line, and gives back the text’s own spelling', () => {
    expect(locateSpan('Vino Nicéfora\nTlapalcoyotl ayer.', 'Nicéfora Tlapalcoyotl')).toBe(
      'Nicéfora\nTlapalcoyotl',
    )
  })

  it('finds a double space, a tab, a CRLF and a no-break space', () => {
    expect(locateSpan('Vino Nicéfora  Tlapalcoyotl.', 'Nicéfora Tlapalcoyotl')).toBe('Nicéfora  Tlapalcoyotl')
    expect(locateSpan('Vino Nicéfora\tTlapalcoyotl.', 'Nicéfora Tlapalcoyotl')).toBe('Nicéfora\tTlapalcoyotl')
    expect(locateSpan('Vino Nicéfora\r\nTlapalcoyotl.', 'Nicéfora Tlapalcoyotl')).toBe('Nicéfora\r\nTlapalcoyotl')
    expect(locateSpan('Vino Nicéfora Tlapalcoyotl.', 'Nicéfora Tlapalcoyotl')).toBe('Nicéfora Tlapalcoyotl')
  })

  it('works the other way: the span has the line break, the text a single space', () => {
    expect(locateSpan('Vino Nicéfora Tlapalcoyotl.', 'Nicéfora\n Tlapalcoyotl')).toBe('Nicéfora Tlapalcoyotl')
  })

  it('combines with case and accent folding', () => {
    expect(locateSpan('Vino NICEFORA\n\nTLAPALCOYOTL.', 'Nicéfora Tlapalcoyotl')).toBe('NICEFORA\n\nTLAPALCOYOTL')
  })

  it('matches every hyphen spelling, and a hyphen wrapped at a line end', () => {
    for (const dash of ['‐', '‑', '–', '—', '−']) {
      expect(locateSpan(`Vino Brindis${dash}Ocampo.`, 'Brindis-Ocampo')).toBe(`Brindis${dash}Ocampo`)
    }
    expect(locateSpan('Vino Brindis-\nOcampo.', 'Brindis-Ocampo')).toBe('Brindis-\nOcampo')
    expect(locateSpan('Vino Brindis - Ocampo.', 'Brindis-Ocampo')).toBe('Brindis - Ocampo')
  })

  it('ignores a soft hyphen, also one at a line wrap', () => {
    expect(locateSpan('Vino Tlapal­coyotl.', 'Tlapalcoyotl')).toBe('Tlapal­coyotl')
    expect(locateSpan('Vino Tlapal­\ncoyotl.', 'Tlapalcoyotl')).toBe('Tlapal­\ncoyotl')
  })

  it('matches every apostrophe spelling', () => {
    for (const ap of ['’', '‘', 'ʼ', '`']) {
      expect(locateSpan(`Vino Ximena O${ap}Garibay.`, "Ximena O'Garibay")).toBe(`Ximena O${ap}Garibay`)
    }
  })

  it('still never matches across punctuation, nor inside a placeholder', () => {
    expect(locateSpan('Vino Nicéfora, Tlapalcoyotl.', 'Nicéfora Tlapalcoyotl')).toBeNull()
    expect(locateSpan('Vivo en [Domicilio A].', 'Domicilio  A')).toBeNull()
  })

  it('stays linear on a 2M-character single line', () => {
    const text = 'ab '.repeat(700_000)
    expect(text.length).toBeGreaterThan(2_000_000)
    const started = performance.now()
    expect(locateSpan(text, 'ab ab ab ab ab ab ab abc')).toBeNull()
    expect(locateSpan(text, 'ab  ab\nab')).toBe('ab ab ab')
    const spaces = 'a' + ' '.repeat(2_000_000) + 'b'
    expect(locateSpan(spaces, 'a b')).toBe(spaces)
    expect(locateSpan(spaces, 'a c')).toBeNull()
    // measured 2026-10-28 on the dev laptop: ~1.7 s alone, 6.6 s under the full
    // parallel suite. A quadratic match on 2M characters would take hours, so
    // the bound only needs to tell the two apart.
    expect(performance.now() - started).toBeLessThan(30_000)
  }, 60_000)
})

describe('🔴 the gate redacts a name the model spelled with different whitespace', () => {
  const text = 'Ayer vino Nicéfora\nTlapalcoyotl a la junta.'

  it('stage 3: a line break inside the name is redacted, not dropped', async () => {
    const r = await gate(text, scripted([[persona('Nicéfora Tlapalcoyotl')], []]))
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).not.toContain('Tlapalcoyotl')
    expect(r.redactedText).toContain('[Persona A]')
  })

  it('stage 3: a double space and a curly apostrophe too', async () => {
    const r = await gate(
      'Hablaron Ximena  O’Garibay y Brindis‐Ocampo.',
      scripted([[persona("Ximena O'Garibay"), persona('Brindis-Ocampo')], []]),
    )
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).not.toMatch(/Garibay|Ocampo/)
  })

  it('verify: a name it reports with different whitespace is a leftover, not "nothing found"', async () => {
    const r = await gate(text, scripted([[], [persona('Nicéfora Tlapalcoyotl')]]))
    expect(r.status).toBe('hold')
    if (r.status !== 'hold') return
    expect(r.stage).toBe('verify')
  })

  it('verify with rounds: the leftover is redacted and the next round verifies', async () => {
    const r = await gate(text, scripted([[], [persona('Nicéfora Tlapalcoyotl')], []]), 2)
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).not.toContain('Tlapalcoyotl')
  })
})

describe('🔴 FAIL CLOSED: a span that cannot be located holds', () => {
  const text = 'Ayer vino la maestra a la junta.'

  it('stage 3: a span not in the text is a hold, and the reason quotes no name', async () => {
    const r = await gate(text, scripted([[persona('Zacarías Huitrón')], []]))
    expect(r.status).toBe('hold')
    if (r.status !== 'hold') return
    expect(r.stage).toBe('content')
    expect(r.retryable).toBeUndefined()
    expect(r.reason).not.toContain('Huitrón')
  })

  it('verify: a span not in the redacted text is a hold', async () => {
    const r = await gate(text, scripted([[], [persona('Zacarías Huitrón')]]))
    expect(r.status).toBe('hold')
    if (r.status !== 'hold') return
    expect(r.stage).toBe('verify')
    expect(r.reason).not.toContain('Huitrón')
  })

  it('a detector that skips parseFindings is held too, at either stage', async () => {
    const stage3 = await gate(text, raw([[{ text: 'Zacarías Huitrón', type: 'persona' }], []]))
    expect(stage3.status).toBe('hold')
    const verify = await gate(text, raw([[], [{ text: 'Zacarías Huitrón', type: 'persona' }]]))
    expect(verify.status).toBe('hold')
  })

  it('a raw verify finding in another spelling is never "covered"', async () => {
    const r = await gate(
      'Ayer vino Nicéfora\nTlapalcoyotl.',
      raw([[], [{ text: 'nicefora tlapalcoyotl', type: 'persona' }]]),
    )
    expect(r.status).toBe('hold')
  })

  it('a span made only of our placeholders is not "unlocated": it names nobody', async () => {
    const r = await gate('Vino Nicéfora a la junta.', scripted([[persona('Nicéfora')], [persona('[Persona A]')]]))
    expect(r.status).toBe('ready')
  })

  it('a span found only inside a placeholder is covered, not unlocated', async () => {
    const r = await gate('Vino Nicéfora a la junta.', scripted([[persona('Nicéfora')], [persona('Persona')]]))
    expect(r.status).toBe('ready')
  })
})
