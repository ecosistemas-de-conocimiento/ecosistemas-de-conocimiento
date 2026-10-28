/**
 * Byline audit 2 (2026-10-28): the institution check ran on the WHOLE value,
 * before it was split into authors, so a long author list read as one
 * institution and its surnames were never spread. Fail-closed now: split
 * first, then a segment skips registration only when it is an institution BY
 * ITSELF. Synthetic names only.
 *
 * Each case runs twice: stage 1 alone (what reaches `person`), and through the
 * whole gate (whether a bare surname in the body survives). staticDetector
 * only — no inference, no spend.
 */

import { describe, expect, it } from 'vitest'

import { staticDetector } from './detector'
import { runAnonymisationGate } from './gate'
import { structuralPass } from './structural'

/** A `person` spy: records each name and hands out A, B, C… */
function spy() {
  const seen: string[] = []
  const person = (name: string) => {
    seen.push(name)
    return `[Persona ${String.fromCharCode(64 + seen.length)}]`
  }
  return { seen, person }
}

async function gate(text: string): Promise<string> {
  const result = await runAnonymisationGate({ contentKind: 'documento', text }, { detector: staticDetector([]) })
  expect(result.status).toBe('ready')
  return result.status === 'ready' ? result.redactedText : ''
}

describe('byline audit 2 — split the authors before classifying (1)', () => {
  it('two three-word people joined by "y" are two people, not an institution', () => {
    const { seen, person } = spy()
    const out = structuralPass('Autores: Ana Ruiz García y Luis Gómez Paz', { person })
    expect(out.text).toBe('Autores: [Persona A] y [Persona B]')
    expect(seen).toEqual(['Ana Ruiz García', 'Luis Gómez Paz'])
  })

  it('the same list mid-line', () => {
    const { seen, person } = spy()
    const out = structuralPass('Notas. Autores: Ana Ruiz García y Luis Gómez Paz, 2026.', { person })
    expect(out.text).toBe('Notas. Autores: [Persona A] y [Persona B], 2026.')
    expect(seen).toEqual(['Ana Ruiz García', 'Luis Gómez Paz'])
  })

  it('no surname survives in the body', async () => {
    const out = await gate('Autores: Ana Ruiz García y Luis Gómez Paz\n\nRuiz y Paz firmaron.')
    for (const w of ['Ana', 'Ruiz', 'García', 'Luis', 'Gómez', 'Paz']) expect(out).not.toContain(w)
  })
})

describe('byline audit 2 — a title is not a name word (2)', () => {
  it('"Dr." does not push a four-word name over the limit', () => {
    const { seen, person } = spy()
    const out = structuralPass('Autor: Dr. Juan Carlos López García', { person })
    expect(out.text).toBe('Autor: [Persona A]')
    expect(seen).toEqual(['Dr. Juan Carlos López García'])
  })

  it.each(['Dra.', 'Lic.', 'Mtro.', 'Ma.', 'Pbro.', 'Ing.'])('nor does "%s"', (title) => {
    const { seen, person } = spy()
    structuralPass(`Autor: ${title} Juan Carlos López García`, { person })
    expect(seen).toHaveLength(1)
  })

  it('"López" does not survive in the body', async () => {
    const out = await gate('Autor: Dr. Juan Carlos López García\n\nLópez habló primero.')
    expect(out).not.toContain('López')
  })
})

describe('byline audit 2 — an institution and a person in one list (3)', () => {
  it('only the person is registered', () => {
    const { seen, person } = spy()
    const out = structuralPass('Autores: Colectivo Tierra Viva y Ana Ruiz', { person })
    expect(out.text).toBe('Autores: [Dato omitido] y [Persona A]')
    expect(seen).toEqual(['Ana Ruiz'])
  })

  it('"Ruiz" does not survive in the body', async () => {
    const out = await gate('Autores: Colectivo Tierra Viva y Ana Ruiz\n\nRuiz coordinó.')
    expect(out).not.toContain('Ruiz')
  })

  it('⚠ still keeps "Secretaría de Educación y Cultura" one institution', () => {
    const { seen, person } = spy()
    expect(structuralPass('Autor: Secretaría de Educación y Cultura', { person }).text).toBe('Autor: [Dato omitido]')
    expect(seen).toEqual([])
  })
})

describe('byline audit 2 — "Surname, Given" is always a person (4)', () => {
  it('a surname that is a head word', () => {
    const { seen, person } = spy()
    const out = structuralPass('Autor: Ciudad Ruiz, Ana', { person })
    expect(out.text).toBe('Autor: [Persona A]')
    expect(seen).toEqual(['Ciudad Ruiz, Ana'])
  })

  it('in a ";" list', () => {
    const { seen, person } = spy()
    structuralPass('Autores: Ciudad Ruiz, Ana; Gómez, Luis', { person })
    expect(seen).toEqual(['Ciudad Ruiz, Ana', 'Gómez, Luis'])
  })

  it('"Ruiz" does not survive in the body', async () => {
    const out = await gate('Autor: Ciudad Ruiz, Ana\n\nRuiz coordinó.')
    expect(out).not.toContain('Ruiz')
  })

  it('⚠ "Centro de Estudios Rurales, Puebla" is an institution and a place, not a pair', () => {
    const { seen, person } = spy()
    const out = structuralPass('Autor: Centro de Estudios Rurales, Puebla', { person })
    expect(out.text).toBe('Autor: [Dato omitido], [Persona A]')
    expect(seen).toEqual(['Puebla'])
  })
})

describe('byline audit 2 — a leading article before the head word (5)', () => {
  it('"El Colegio de México" mid-line is an institution', () => {
    const { seen, person } = spy()
    const out = structuralPass('Notas. Autor: El Colegio de México, 2026.', { person })
    expect(out.text).toBe('Notas. Autor: [Dato omitido], 2026.')
    expect(seen).toEqual([])
  })

  it('"La Red …" in a field is an institution too', () => {
    const { seen, person } = spy()
    structuralPass('Autora: La Red de Huertos Urbanos', { person })
    expect(seen).toEqual([])
  })

  it('a later "México" is not a person', async () => {
    const out = await gate('Notas. Autor: El Colegio de México, 2026.\n\nEl taller se hizo en México.')
    expect(out).toContain('se hizo en México.')
    expect(out).not.toContain('[Persona')
  })
})

describe('byline audit 2 — lower-case prose after ";" (6)', () => {
  it('is not an author', () => {
    expect(structuralPass('Autor: Ana Ruiz; el texto fue revisado').text).toBe(
      'Autor: [Dato omitido]; el texto fue revisado',
    )
  })

  it('⚠ an all-lower-case byline is still redacted whole (fail-closed)', () => {
    expect(structuralPass('Autores: ana ruiz; luis gómez').text).toBe('Autores: [Dato omitido]; [Dato omitido]')
  })
})

describe('byline audit 2 — a place after the author (7)', () => {
  it('"Juan Pérez" is registered, "Ciudad de México" is not', () => {
    const { seen, person } = spy()
    const out = structuralPass('Autor: Juan Pérez, Ciudad de México', { person })
    expect(out.text).toBe('Autor: [Persona A], [Dato omitido]')
    expect(seen).toEqual(['Juan Pérez'])
  })

  it('a later "México" is not a person', async () => {
    const out = await gate('Autor: Juan Pérez, Ciudad de México\n\nPérez vive en México.')
    expect(out).not.toContain('Pérez')
    expect(out).toContain('vive en México.')
  })
})
