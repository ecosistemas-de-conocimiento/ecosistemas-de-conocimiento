/**
 * R60 (owner, 2026-10-28) at stage 1: which bylines are CLEAN, which authors
 * they name, and that the pass stays linear. The gate-level behaviour is in
 * `gate.authorByline.test.ts`. Synthetic names only.
 */

import { describe, expect, it } from 'vitest'

import { restoreAuthors } from './authorRestore'
import { BYLINE_KEEP_MAX, parseByline, splitAuthors, structuralPass } from './structural'

const noEvidence = { stage3: [], verify: [], unlocated: [], roster: [] }

function keep(text: string): { text: string; authors: string[]; labels: string[] } {
  const authors: string[] = []
  const labels: string[] = []
  const out = structuralPass(text, {
    person: (n) => {
      labels.push(n)
      return '[Persona A]'
    },
    keepAuthor: (n) => authors.push(n),
  })
  return { text: out.text, authors, labels }
}

describe('parseByline — clean bylines name their authors', () => {
  it.each([
    ['Ana Ruiz', ['Ana Ruiz']],
    ['Ana Ruiz, Luis Gómez y Eva Paz', ['Ana Ruiz', 'Luis Gómez', 'Eva Paz']],
    ['Ana Ruiz; Luis Gómez', ['Ana Ruiz', 'Luis Gómez']],
    ['Ana Ruiz | Luis Gómez'.split(' | ')[0] as string, ['Ana Ruiz']],
    ['Ana Ruiz & Luis Gómez', ['Ana Ruiz', 'Luis Gómez']],
    ['Ana Ruiz / Luis Gómez', ['Ana Ruiz', 'Luis Gómez']],
    ['Ruiz, Ana', ['Ana Ruiz']],
    ['Ruiz, Ana María', ['Ana María Ruiz']],
    ['Ruiz Pérez, A.', ['A. Ruiz Pérez']],
    ['Ruiz, Ana; Gómez, Luis', ['Ana Ruiz', 'Luis Gómez']],
    ['Ruiz, A., Gómez, L. y Paz, E.', ['A. Ruiz', 'L. Gómez', 'E. Paz']],
    ['Dr. Ana Ruiz', ['Dr. Ana Ruiz']],
    ['Ma. Elena Ruiz y Pbro. Luis Gómez', ['Ma. Elena Ruiz', 'Pbro. Luis Gómez']],
    ['Ana de la Cruz', ['Ana de la Cruz']],
    ['Hans van der Berg', ['Hans van der Berg']],
    ['Lía d’Ávila', ['Lía d’Ávila']],
    ['Ana Ruiz (2021)', ['Ana Ruiz']],
    ['Ana Ruiz, 2026.', ['Ana Ruiz']],
    ['Ana Ruiz-Pérez y Sean O’Brien', ['Ana Ruiz-Pérez', 'Sean O’Brien']],
  ])('%s', (value, authors) => {
    expect(parseByline(value)).toEqual(authors)
  })

  it.each([
    'Ana Ruiz, estudiante de tercer año', // prose
    'el equipo de trabajo', // prose
    'Colectivo Norte', // institution
    'Ana Ruiz y Universidad Nacional', // one institution spoils the byline
    'ANA RUIZ', // all caps: may be an acronym
    'CIDE',
    'Ana Ruiz (Lupita)', // a parenthesis that is not a year
    'Ana Ruiz 2', // a digit
    'Ana Ruiz, Fecha: 2026', // another field
    'Ana Ruiz,', // an empty piece
    'Ana Uno Dos Tres Cuatro Cinco Seis', // seven name words
    `Ana ${'Ruiz '.repeat(BYLINE_KEEP_MAX)}`, // too long
    '',
  ])('fails closed on %j', (value) => {
    expect(parseByline(value)).toBeNull()
  })
})

describe('structuralPass — keepAuthor', () => {
  it('leaves a clean byline in the text and reports its authors', () => {
    const r = keep('Autores: Ana Ruiz y Luis Gómez\n\nTexto.')
    expect(r.text).toBe('Autores: Ana Ruiz y Luis Gómez\n\nTexto.')
    expect(r.authors).toEqual(['Ana Ruiz', 'Luis Gómez'])
    expect(r.labels).toEqual([])
  })

  it('reads a byline at a field start only: after "|", ";", a tab or markdown', () => {
    expect(keep('Título | Autora: Ana Ruiz | Lugar: Oaxaca').authors).toEqual(['Ana Ruiz'])
    expect(keep('> **Autora:** Ana Ruiz').authors).toEqual(['Ana Ruiz'])
    expect(keep('Por: Ana Ruiz').authors).toEqual(['Ana Ruiz'])
  })

  it('stops a byline at a sentence end, not at an initial or a title', () => {
    const r = keep('Autora: Dra. Ana M. Ruiz. El texto sigue.')
    expect(r.authors).toEqual(['Dra. Ana M. Ruiz'])
    expect(r.text).toBe('Autora: Dra. Ana M. Ruiz. El texto sigue.')
  })

  it('🔴 a mid-line key is redacted as before, never kept', () => {
    const r = keep('Notas de clase. Autor: Juan Pérez, 2026.')
    expect(r.authors).toEqual([])
    expect(r.text).toBe('Notas de clase. Autor: [Persona A], 2026.')
  })

  it('🔴 an ambiguous byline is redacted as before', () => {
    const r = keep('Autora: Ana Ruiz, estudiante\nPor: la presente se informa')
    expect(r.authors).toEqual([])
    expect(r.text).toBe('Autora: [Persona A], [Dato omitido]\nPor: la presente se informa')
  })

  it('without keepAuthor nothing changes', () => {
    expect(structuralPass('Autora: Ana Ruiz', { person: () => '[Persona A]' }).text).toBe('Autora: [Persona A]')
  })

  it('returns where each kept byline is', () => {
    const text = 'id 8f1c2b3a-1111-2222-3333-444455556666\nAutora: Ana Ruiz\nAutor: Luis Gómez'
    const r = structuralPass(text, { keepAuthor: () => {} })
    expect(r.bylines.map(([s, e]) => r.text.slice(s, e))).toEqual(['Autora: Ana Ruiz', 'Autor: Luis Gómez'])
  })

  it('a noncharacter in the input never becomes a byline', () => {
    const r = keep('\uFDD0\nAutora: Ana Ruiz')
    expect(r.text).toBe('\uFFFD\nAutora: Ana Ruiz')
    expect(r.text).not.toContain('\uFDD0')
  })

  it('is idempotent', () => {
    const once = keep('Autores: Ruiz, Ana; Gómez, Luis\nPor: Dra. Eva Paz\n15/08/2026').text
    expect(keep(once).text).toBe(once)
  })
})

describe('linear time', () => {
  const best = (fn: () => void) => {
    let t = Infinity
    for (let r = 0; r < 3; r++) {
      const t0 = performance.now()
      fn()
      t = Math.min(t, performance.now() - t0)
    }
    return t
  }
  /** One line, no newlines (a PDF extraction), a field-start byline every ~1 KB. */
  const oneLineDoc = (n: number) => {
    const para = 'El trabajo comunitario reunió a docentes y madres de familia en la escuela durante varios meses. '.repeat(9)
    return Array.from({ length: n }, (_, i) => `${para}| Autora: Ana Ruiz${i % 2 ? ' y Luis Gómez' : ''} | `).join('')
  }

  it('🔴 structuralPass with keepAuthor grows linearly on a one-line 2 MB document', () => {
    // A RATIO of two runs on the same box, so load does not decide it: 8x the
    // text must cost well under 64x (quadratic).
    const small = oneLineDoc(280)
    const big = oneLineDoc(2240)
    expect(big.length).toBeGreaterThan(2_000_000)
    const run = (t: string) => () => structuralPass(t, { person: () => '[Persona A]', keepAuthor: () => {} })
    expect(best(run(big)) / Math.max(best(run(small)), 1)).toBeLessThan(24)
  }, 60_000)

  it('🔴 a key followed by a long run of spaces stays linear', () => {
    const run = (n: number) => () => structuralPass(`Autora:${' '.repeat(n)}Ana Ruiz | Autor: ${' '.repeat(n)}x`, { keepAuthor: () => {} })
    expect(best(run(200_000)) / Math.max(best(run(25_000)), 1)).toBeLessThan(24)
  }, 60_000)

  it('🔴 restoreAuthors grows linearly on a one-line 2 MB output', () => {
    const doc = (n: number) => {
      const source = oneLineDoc(n)
      return { source, output: source.replaceAll('Ana Ruiz', '[Persona A]').replaceAll('Luis Gómez', '[Persona B]') }
    }
    const small = doc(280)
    const big = doc(2240)
    const run = (d: { source: string; output: string }) => () => {
      const r = restoreAuthors(d.source, d.output, ['Ana Ruiz', 'Luis Gómez'], noEvidence)
      expect(r.text === d.source).toBe(true) // never diff 2 MB strings
    }
    expect(best(run(big)) / Math.max(best(run(small)), 1)).toBeLessThan(24)
  }, 60_000)

  it('the linear author split returns exactly what String.split returns', () => {
    let seed = 7
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    const atoms = [' ', '  ', '\t', '\n', ' ', ',', ';', '/', '&', 'y', 'e', 'and', 'Ana', 'x', '.', '|']
    const split = /(\s*[,;/&]\s*|\s+(?:y|e|and)\s+)/u
    for (let k = 0; k < 20_000; k++) {
      const s = Array.from({ length: 1 + Math.floor(rnd() * 10) }, () => atoms[Math.floor(rnd() * atoms.length)]).join('')
      expect(splitAuthors(s), JSON.stringify(s)).toEqual(s.split(split))
    }
  })
})
