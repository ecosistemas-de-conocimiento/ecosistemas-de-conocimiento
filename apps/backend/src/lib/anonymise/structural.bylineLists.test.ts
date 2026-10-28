/**
 * Byline audit (2026-10-28), stage 1 alone. Four findings against the byline fix:
 *
 *   1. LEAK — authors split by ";" or "|" kept every name after the first.
 *   2. DAMAGE — an institution in a byline was handed to `person`, so the gate
 *      spread its words as name parts ("México" → "[Persona A]" everywhere).
 *   3. LEAK — a mid-line byline kept every author after the first comma.
 *   4. LEAK — "Ma." and "Pbro." ended the byline at their dot.
 */

import { describe, expect, it } from 'vitest'

import { LABEL_AUTOR, structuralPass } from './structural'

const NAME_WORDS = ['Ana', 'Ruiz', 'Luis', 'Gómez', 'Eva', 'Paz', 'Isabel', 'Elena', 'Juan']
const noNameLeft = (text: string) => {
  for (const w of NAME_WORDS) expect(text).not.toContain(w)
}
const countOf = (removed: Array<{ label: string; count: number }>, label: string) =>
  removed.find((r) => r.label === label)?.count ?? 0

/** A `person` spy: records each name and hands out A, B, C… */
function spy() {
  const seen: string[] = []
  const person = (name: string) => {
    seen.push(name)
    return `[Persona ${String.fromCharCode(64 + seen.length)}]`
  }
  return { seen, person }
}

describe('structuralPass — every author, whatever the separator (finding 1)', () => {
  it('redacts the name after ";"', () => {
    const out = structuralPass('Autores: Ana Ruiz; Luis Gómez')
    noNameLeft(out.text)
    expect(out.text).toBe('Autores: [Dato omitido]; [Dato omitido]')
    expect(countOf(out.removed, LABEL_AUTOR)).toBe(2)
  })

  it('redacts the name after "|"', () => {
    const out = structuralPass('Autores: Ana Ruiz | Luis Gómez')
    noNameLeft(out.text)
    expect(out.text).toBe('Autores: [Dato omitido] | [Dato omitido]')
  })

  it.each([
    ['Ana Ruiz, Luis Gómez', ', '],
    ['Ana Ruiz; Luis Gómez', '; '],
    ['Ana Ruiz | Luis Gómez', ' | '],
    ['Ana Ruiz y Luis Gómez', ' y '],
    ['Ana Ruiz e Isabel Gómez', ' e '],
    ['Ana Ruiz & Luis Gómez', ' & '],
    ['Ana Ruiz / Luis Gómez', ' / '],
  ])('labels two people in "%s"', (value, sep) => {
    const { seen, person } = spy()
    const out = structuralPass(`Autores: ${value}\nEl texto.`, { person })
    noNameLeft(out.text)
    expect(out.text).toBe(`Autores: [Persona A]${sep}[Persona B]\nEl texto.`)
    expect(seen).toHaveLength(2)
  })

  it('keeps a surname-first list one label per person', () => {
    const { seen, person } = spy()
    const out = structuralPass('Autores: Ruiz, Ana; Gómez, Luis', { person })
    noNameLeft(out.text)
    expect(out.text).toBe('Autores: [Persona A]; [Persona B]')
    expect(seen).toEqual(['Ruiz, Ana', 'Gómez, Luis'])
  })

  it('takes a surname-first list split by "|"', () => {
    const out = structuralPass('Autores: Ruiz, Ana | Gómez, Luis')
    noNameLeft(out.text)
  })

  it('⚠ still stops at a "|" or ";" that starts another field', () => {
    expect(structuralPass('Autora: Ana Ruiz | Lugar: el salón').text).toBe('Autora: [Dato omitido] | Lugar: el salón')
    expect(structuralPass('Autora: Ana Ruiz; Fecha: marzo').text).toBe('Autora: [Dato omitido]; Fecha: marzo')
  })
})

describe('structuralPass — a mid-line byline keeps no author (finding 3)', () => {
  it('redacts every author in a comma list', () => {
    const out = structuralPass('Notas de clase. Autores: Ana Ruiz, Luis Gómez y Eva Paz, en Puebla.')
    noNameLeft(out.text)
    expect(out.text).toBe('Notas de clase. Autores: [Dato omitido], [Dato omitido] y [Dato omitido], en Puebla.')
    expect(countOf(out.removed, LABEL_AUTOR)).toBe(3)
  })

  it('redacts every author after ";" mid-line', () => {
    const out = structuralPass('Notas de clase. Autores: Ana Ruiz; Luis Gómez. El texto.')
    noNameLeft(out.text)
    expect(out.text).toBe('Notas de clase. Autores: [Dato omitido]; [Dato omitido]. El texto.')
  })

  it('⚠ leaves prose without a byline key alone', () => {
    const prose = 'Llegaron Ana Ruiz, Luis Gómez y Eva Paz a la reunión.'
    expect(structuralPass(prose).text).toBe(prose)
    const lower = 'Lo dice el autor: según Ana, Luis y Eva, la obra es colectiva.'
    expect(structuralPass(lower).text).toBe(lower)
  })

  it('⚠ keeps the year after a mid-line byline', () => {
    expect(structuralPass('Notas. Autor: Juan Pérez, 2026.').text).toBe('Notas. Autor: [Dato omitido], 2026.')
  })
})

describe('structuralPass — "Ma." and "Pbro." (finding 4)', () => {
  it.each(['Autora: Ma. Elena Ruiz', 'Autor: Pbro. Juan Gómez'])('redacts "%s" whole', (line) => {
    const out = structuralPass(line)
    noNameLeft(out.text)
    expect(out.text).toMatch(/^Autora?: \[Dato omitido\]$/)
  })

  it('redacts them whole mid-line too', () => {
    const out = structuralPass('Notas. Autora: Ma. Elena Ruiz, 2026.')
    noNameLeft(out.text)
    expect(out.text).toBe('Notas. Autora: [Dato omitido], 2026.')
  })
})

describe('structuralPass — an institution is redacted, never handed to `person` (finding 2)', () => {
  it.each([
    'Universidad Nacional Autónoma de México',
    'Secretaría de Educación y Cultura',
    'Centro de Estudios Rurales',
    'Comité de Ética',
    'Colectivo Tierra Viva',
    'CIDE',
    // more than four capitalised words: an organisation, not a person
    'Asamblea Popular Pueblos Unidos Oaxaca',
  ])('"Autor: %s"', (org) => {
    const { seen, person } = spy()
    const out = structuralPass(`Autor: ${org}`, { person })
    expect(out.text).toBe('Autor: [Dato omitido]')
    expect(seen).toEqual([])
    expect(countOf(out.removed, LABEL_AUTOR)).toBe(1)
  })

  it('splits a person from an institution in one list', () => {
    const { seen, person } = spy()
    const out = structuralPass('Autores: Ana Ruiz, Centro de Estudios Rurales', { person })
    expect(out.text).toBe('Autores: [Persona A], [Dato omitido]')
    expect(seen).toEqual(['Ana Ruiz'])
  })

  it('still hands a four-word person name to `person`', () => {
    const { seen, person } = spy()
    structuralPass('Autora: María Fernanda López García', { person })
    expect(seen).toEqual(['María Fernanda López García'])
  })

  it('hands `person` only the name, not the words after it', () => {
    const { seen, person } = spy()
    const out = structuralPass('Autor: Juan Pérez coordinador del Proyecto Agua', { person })
    expect(out.text).toBe('Autor: [Persona A]')
    expect(seen).toEqual(['Juan Pérez'])
  })
})
