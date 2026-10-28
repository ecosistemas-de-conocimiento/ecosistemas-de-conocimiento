/**
 * A byline through the WHOLE gate, under owner ruling R60 (2026-10-28):
 * "don't redact authors". A `documento`'s own byline authors stay visible,
 * in the byline and in the body, roster or not. Everyone else stays
 * redacted, with the labels the gate gives them today. An ambiguous byline,
 * or a key in the middle of a sentence, is redacted as before.
 *
 * Synthetic names only. staticDetector only — no inference, no spend.
 */

import { describe, expect, it } from 'vitest'

import { staticDetector } from './detector'
import { runAnonymisationGate } from './gate'
import type { GateContentKind } from './types'

async function gate(
  text: string,
  persons: string[] = [],
  extra: { roster?: string[]; contentKind?: GateContentKind } = {},
): Promise<string> {
  const result = await runAnonymisationGate(
    { contentKind: extra.contentKind ?? 'documento', text, ...(extra.roster ? { roster: extra.roster } : {}) },
    { detector: staticDetector(persons.map((p) => ({ text: p, type: 'persona' as const }))) },
  )
  expect(result.status).toBe('ready')
  return result.status === 'ready' ? result.redactedText : ''
}

const absent = (text: string, words: string[]) => {
  for (const w of words) expect(text, `"${w}" left in: ${text}`).not.toMatch(new RegExp(`(?<![\\p{L}])${w}(?![\\p{L}])`, 'u'))
}

describe('R60 — a document keeps its own byline authors', () => {
  it('keeps the author in the byline and in every body mention', async () => {
    const text = 'Autora: Ana Ruiz\n\nAna Ruiz coordinó el taller. Ruiz escribió el informe.'
    expect(await gate(text, ['Ana Ruiz'])).toBe(text)
  })

  it('a co-occurring student who is not the author stays redacted, with one label', async () => {
    const out = await gate('Autora: Ana Ruiz\n\nAna Ruiz entrevistó a Pedro Gómez. Gómez habló poco.', ['Ana Ruiz', 'Pedro Gómez'])
    absent(out, ['Pedro', 'Gómez'])
    expect(out).toMatch(/^Autora: Ana Ruiz\n\nAna Ruiz entrevistó a (\[Persona [A-Z]+\])\. \1 habló poco\.$/u)
  })

  it('a roster member is kept only when they are the byline author', async () => {
    const roster = ['Ana Ruiz', 'Pedro Gómez']
    const out = await gate('Autora: Ana Ruiz\n\nAna Ruiz y Pedro Gómez revisaron el texto. Pedro opinó.', [], { roster })
    expect(out.startsWith('Autora: Ana Ruiz\n\nAna Ruiz y [Persona ')).toBe(true)
    absent(out, ['Pedro', 'Gómez'])
    // No byline: the same roster member is redacted.
    absent(await gate('Ana Ruiz revisó el texto.', [], { roster }), ['Ana', 'Ruiz'])
  })

  it('keeps every author of a multi-author list', async () => {
    const text = 'Autores: Ana Ruiz, Luis Gómez y Eva Paz\n\nAna Ruiz, Luis Gómez y Eva Paz firmaron. Paz leyó.'
    expect(await gate(text, ['Ana Ruiz', 'Luis Gómez', 'Eva Paz'])).toBe(text)
  })

  it('keeps surname-first authors, and their names in natural order in the body', async () => {
    const text = 'Autores: Ruiz, Ana; Gómez, Luis\n\nAna Ruiz y Luis Gómez escribieron esto.'
    expect(await gate(text, ['Ana Ruiz', 'Luis Gómez'])).toBe(text)
  })

  it('keeps an author under "Por:" and a markdown bold key', async () => {
    const text = '- **Por:** Dra. Ana Ruiz\n\nLa doctora Ana Ruiz presenta el caso.'
    expect(await gate(text, ['Ana Ruiz'])).toBe(text)
  })

  it('keeps the author when stage 1 put a placeholder elsewhere in the source', async () => {
    const out = await gate('Autora: Ana Ruiz\nid 8f1c2b3a-1111-2222-3333-444455556666\n\nAna Ruiz firmó.', ['Ana Ruiz'])
    expect(out).toBe('Autora: Ana Ruiz\nid [Dato omitido]\n\nAna Ruiz firmó.')
  })

  it('🔴 "Autor:" in the middle of prose stays redacted', async () => {
    const out = await gate('Notas de clase. Autor: Pedro Gómez, 2026.\n\nGómez llegó.', ['Pedro Gómez'])
    absent(out, ['Pedro', 'Gómez'])
    const prose = await gate('Como dijo el autor: Pedro Gómez lo sabía.', ['Pedro Gómez'])
    absent(prose, ['Pedro', 'Gómez'])
  })

  it('🔴 a byline that does not parse as names stays redacted (fail closed)', async () => {
    for (const byline of [
      'Autora: Ana Ruiz, estudiante de tercer año',
      'Autores: Ana Ruiz y Colectivo Norte',
      'Autora: Ana Ruiz (Lupita)',
      'Autora: ANA RUIZ',
    ]) {
      const out = await gate(`${byline}\n\nAna Ruiz habló.`, ['Ana Ruiz'])
      absent(out, ['Ana', 'Ruiz'])
    }
  })

  it('🔴 a bare surname shared with a non-author stays redacted; the full name is kept', async () => {
    const out = await gate('Autora: Ana Ruiz\n\nAna Ruiz habló con Pedro Ruiz. Ruiz se fue.', ['Ana Ruiz', 'Pedro Ruiz'])
    expect(out.startsWith('Autora: Ana Ruiz\n\nAna Ruiz habló con [Persona ')).toBe(true)
    absent(out.slice('Autora: Ana Ruiz\n\nAna Ruiz'.length), ['Pedro', 'Ruiz'])
  })

  it('🔴 a longer name that contains the author\'s stays redacted', async () => {
    const out = await gate('Autora: Ana Ruiz\n\nAna Ruiz Pérez es otra estudiante.', ['Ana Ruiz Pérez'])
    expect(out).toMatch(/^Autora: Ana Ruiz\n\n\[Persona [A-Z]+\] es otra estudiante\.$/u)
  })

  it('a span holding the author and someone else stays redacted', async () => {
    const out = await gate('Autora: Ana Ruiz\n\nAna Ruiz y Pedro Gómez llegaron.', ['Ana Ruiz y Pedro Gómez'])
    absent(out.slice('Autora: Ana Ruiz'.length), ['Pedro', 'Gómez'])
  })

  it('labels for everyone else stay consistent', async () => {
    const out = await gate(
      'Autora: Ana Ruiz\n\nPedro Gómez y Eva Paz hablaron con Ana Ruiz. Gómez y Paz volvieron.',
      ['Pedro Gómez', 'Eva Paz', 'Ana Ruiz'],
    )
    const m = /^Autora: Ana Ruiz\n\n(\[Persona [A-Z]+\]) y (\[Persona [A-Z]+\]) hablaron con Ana Ruiz\. \1 y \2 volvieron\.$/u.exec(out)
    expect(m, out).not.toBeNull()
    expect(m?.[1]).not.toBe(m?.[2])
  })

  it('is idempotent: the gate over its own output returns it unchanged', async () => {
    const persons = ['Ana Ruiz', 'Pedro Gómez']
    const once = await gate('Autora: Ana Ruiz\n\nAna Ruiz entrevistó a Pedro Gómez.', persons)
    expect(await gate(once, persons)).toBe(once)
  })

  it('a testimonio is not a documento: its byline stays redacted', async () => {
    const out = await gate('Autora: Ana Ruiz\n\nAna Ruiz habló.', ['Ana Ruiz'], { contentKind: 'testimonio' })
    absent(out, ['Ana', 'Ruiz'])
  })
})
