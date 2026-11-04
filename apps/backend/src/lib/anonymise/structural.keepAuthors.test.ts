/**
 * R60 (owner, 2026-10-28) below the gate: stage 1's `keepAuthors` (which
 * byline pieces it leaves as written) and `restoreAuthors` (which
 * placeholders come back), plus linear time. The gate-level behaviour is in
 * `gate.authorByline.test.ts`. Synthetic names only.
 */

import { describe, expect, it } from 'vitest'

import { restoreAuthors } from './authorRestore'
import { splitAuthors, structuralPass } from './structural'

function pass(text: string, keepAuthors: string[]): { text: string; labelled: string[]; bylines: string[] } {
  const labelled: string[] = []
  const out = structuralPass(text, {
    person: (n) => {
      labelled.push(n)
      return '[Persona A]'
    },
    keepAuthors,
  })
  return { text: out.text, labelled, bylines: out.bylines.map(([s, e]) => out.text.slice(s, e)) }
}

describe('structuralPass — keepAuthors', () => {
  it('leaves a byline piece naming a trusted author as written; redacts the rest', () => {
    const r = pass('Autores: Ana Ruiz y Luis Gómez\n\nTexto.', ['Ana Ruiz'])
    expect(r.text).toBe('Autores: Ana Ruiz y [Persona A]\n\nTexto.')
    expect(r.labelled).toEqual(['Luis Gómez'])
    expect(r.bylines).toEqual(['Ana Ruiz'])
  })

  it('🔴 keeps only the whole name as written: no title, reordering or other case', () => {
    expect(pass('Autora: Ana Ruiz', ['Ana Ruiz']).bylines).toEqual(['Ana Ruiz'])
    expect(pass('Autora: Dra. Ana Ruiz', ['Ana Ruiz']).bylines).toEqual([])
    expect(pass('Autores: Ruiz, Ana y Gómez, Luis', ['Ana Ruiz']).text).toBe('Autores: [Persona A], [Persona A] y [Persona A], [Persona A]')
    expect(pass('Autores: Ruiz, Ana', ['Ana Ruiz']).bylines).toEqual([])
    expect(pass('Autora: ANA RUIZ', ['Ana Ruiz']).bylines).toEqual([])
    expect(pass('Autora: ana ruiz', ['Ana Ruiz']).bylines).toEqual([])
    expect(pass('Autora: Ana Ruiz', ['ana ruiz']).bylines).toEqual([])
  })

  it('🔴 a part of the author is not the author', () => {
    expect(pass('Autora: Ana', ['Ana Ruiz']).text).toBe('Autora: [Persona A]')
    expect(pass('Autora: Ana Ruiz Pérez', ['Ana Ruiz']).text).toBe('Autora: [Persona A]')
  })

  it('🔴 a name the rules above took part of is no kept piece (the prefix)', () => {
    // "Ma." ends the field value on its dot, and the rest arrives with a prefix.
    const r = pass('Autora: Ma. Ana Ruiz', ['Ana Ruiz'])
    expect(r.bylines).toEqual([])
    expect(r.text).not.toContain('Ana Ruiz')
  })

  it('🔴 a one-word trusted name keeps nothing', () => {
    expect(pass('Autora: Ruiz', ['Ruiz']).text).toBe('Autora: [Persona A]')
  })

  it('without keepAuthors nothing changes, and the input is not touched', () => {
    expect(pass('Autora: Ana Ruiz', []).text).toBe('Autora: [Persona A]')
  })

  it('a noncharacter in the input never becomes a kept piece', () => {
    const r = pass('﷐\nAutora: Ana Ruiz', ['Ana Ruiz'])
    expect(r.text).toBe('�\nAutora: Ana Ruiz')
    expect(r.bylines).toEqual(['Ana Ruiz'])
  })

  it('both passes agree everywhere but the kept pieces', () => {
    const text = 'id 8f1c2b3a-1111-2222-3333-444455556666\nAutores: Ana Ruiz y Luis Gómez\nNotas. Autor: Eva Paz.\n15/08/2026'
    const a = structuralPass(text, { person: () => '[Persona A]' }).text
    const b = structuralPass(text, { person: () => '[Persona A]', keepAuthors: ['Ana Ruiz'] }).text
    expect(b.replace('Ana Ruiz', '[Persona A]')).toBe(a)
  })
})

describe('structuralPass — keepAuthors with the additive byline passes', () => {
  it('keeps the uploader after ";" and "|", redacts the rest', () => {
    expect(pass('Autores: Luis Gómez; Ana Ruiz | Eva Paz', ['Ana Ruiz']).text).toBe('Autores: [Persona A]; Ana Ruiz | [Persona A]')
    expect(pass('Autor(es): Ana Ruiz; Luis Gómez', ['Ana Ruiz']).text).toBe('Autor(es): Ana Ruiz; [Persona A]')
  })

  it('🔴 a kept piece glued to more name is not the author', () => {
    const r = pass("Notas. Autora: Ana Ruiz d'Ávila. Fin", ['Ana Ruiz'])
    expect(r.text).not.toContain('Ana Ruiz')
    expect(r.bylines).toEqual([])
  })

  it('🔴 a phone inside the piece keeps nothing', () => {
    expect(pass('Autora: Ana 5551234567 Ruiz', ['Ana Ruiz']).bylines).toEqual([])
    expect(pass('Autora: Ana 5551234567 Ruiz', ['Ana Ruiz']).text).not.toContain('5551234567')
  })

  it('both passes take the same names in the same order, apart from the kept piece', () => {
    const text = 'Autores: Ana Ruiz; Luis Gómez | Lugar: Oaxaca\nNotas. Autores: Eva Paz, Ana Ruiz y Sol Vega.'
    const all: string[] = []
    structuralPass(text, { person: (n) => (all.push(n), '[P]') })
    expect(pass(text, ['Ana Ruiz']).labelled).toEqual(all.filter((n) => n !== 'Ana Ruiz'))
  })
})

describe('restoreAuthors — guards', () => {
  it('🔴 whole word: a placeholder that ended mid-word is not restored', () => {
    const source = 'Autora: x\n\nAna Ruizito llegó.'
    const output = 'Autora: x\n\n[Persona A]ito llegó.'
    expect(restoreAuthors(source, output, ['Ana Ruiz']).text).toBe(output)
    // The same text on a word boundary comes back.
    expect(restoreAuthors('Ana Ruiz llegó.', '[Persona A] llegó.', ['Ana Ruiz']).text).toBe('Ana Ruiz llegó.')
  })

  it.each([
    ['Ana Ruiz Pérez llegó.', '[Persona A] [Persona B] llegó.'],
    ['Ana Ruiz y Pérez llegó.', '[Persona A] y [Persona B] llegó.'],
    ['Ana Ruiz-Pérez llegó.', '[Persona A]-[Persona B] llegó.'],
    ['Ana Ruiz de la Vega llegó.', '[Persona A] de la [Persona B] llegó.'],
    ['Ana Ruiz Pérez llegó.', '[Persona A] [Persona B] llegó.'],
  ])('🔴 glue: %j stays redacted', (source, output) => {
    expect(restoreAuthors(source, output, ['Ana Ruiz']).text).toBe(output)
  })

  it('🔴 byline: a kept piece comes back even glued; the same text outside one does not', () => {
    const source = 'Autores: Ana Ruiz y Pedro Gómez'
    const output = 'Autores: [Persona A] y [Persona B]'
    const at = source.indexOf('Ana Ruiz')
    expect(restoreAuthors(source, output, ['Ana Ruiz'], [[at, at + 8]]).text).toBe('Autores: Ana Ruiz y [Persona B]')
    expect(restoreAuthors(source, output, ['Ana Ruiz']).text).toBe(output)
  })

  it.each([['Ana Ruiz 2'], ['Ana 5551234567 Ruiz'], ['Ana ٣ Ruiz']])('🔴 a digit in the name keeps nothing: %s', (name) => {
    const source = `${name} llegó.`
    expect(restoreAuthors(source, '[Persona A] llegó.', [name])).toEqual({ text: '[Persona A] llegó.', kept: [] })
    // Not even inside a range stage 1 reports as a byline.
    const r = restoreAuthors(source, '[Persona A] llegó.', [name], [[0, name.length]])
    expect(r.text).toBe('[Persona A] llegó.')
  })

  it.each([['[Dato omitido]'], ['[Lugar A]'], ['[Domicilio A]']])('🔴 only a [Persona X] comes back: %s stays', (label) => {
    const source = 'Ana Ruiz llegó.'
    const output = `${label} llegó.`
    expect(restoreAuthors(source, output, ['Ana Ruiz'])).toEqual({ text: output, kept: [] })
    expect(restoreAuthors(source, '[Persona A] llegó.', ['Ana Ruiz']).kept).toEqual(['Ana Ruiz'])
  })

  it.each(['Ana ② Ruiz', 'Ana Ⅷ Ruiz', 'Ana ٣ Ruiz', 'Ana 3 Ruiz'])('🔴 a name holding any number is not restored: %s', (name) => {
    const output = '[Persona A] llegó.'
    expect(restoreAuthors(`${name} llegó.`, output, [name]).text).toBe(output)
    expect(restoreAuthors(`${name} llegó.`, output, [name]).kept).toEqual([])
  })

  it('🔴 lower case is never restored outside a byline', () => {
    expect(restoreAuthors('la otra es ana ruiz.', 'la otra es [Persona A].', ['Ana Ruiz']).text).toBe(
      'la otra es [Persona A].',
    )
  })

  it.each([
    ['María me contó su caso.', '[Persona A] me contó su caso.', 'Ana María López'],
    ['Ana me contó su caso.', '[Persona A] me contó su caso.', 'Ana María López'],
    ['López me contó su caso.', '[Persona A] me contó su caso.', 'Ana María López'],
    ['Ana López me contó su caso.', '[Persona A] me contó su caso.', 'Ana María López'],
    ['María López me contó su caso.', '[Persona A] me contó su caso.', 'Ana María López'],
    ['Carlos me contó su caso.', '[Persona A] me contó su caso.', 'Juan Carlos Pérez'],
    ['Juan Carlos me contó su caso.', '[Persona A] me contó su caso.', 'Juan Carlos Pérez'],
    ['Pérez me contó su caso.', '[Persona A] me contó su caso.', 'Juan Carlos Pérez'],
    ['Guadalupe me contó su caso.', '[Persona A] me contó su caso.', 'María Guadalupe'],
    ['María me contó su caso.', '[Persona A] me contó su caso.', 'María Guadalupe'],
    ['Ruiz habló.', '[Persona A] habló.', 'Ana Ruiz'],
    ['Ruiz, Ana habló.', '[Persona A] habló.', 'Ana Ruiz'],
    ['Dra. Ana Ruiz habló.', '[Persona A] habló.', 'Ana Ruiz'],
    ['ANA RUIZ habló.', '[Persona A] habló.', 'Ana Ruiz'],
    ['Ana Ruiz habló.', '[Persona A] habló.', 'ana ruiz'],
    ['Ana Ruíz habló.', '[Persona A] habló.', 'Ana Ruiz'],
    ['Ana  Ruiz habló.', '[Persona A] habló.', 'Ana Ruiz'],
  ])('🔴 part or variant: %j stays redacted when the author is %j', (source, output, author) => {
    expect(restoreAuthors(source, output, [author])).toEqual({ text: output, kept: [] })
  })

  it('🔴 a part stays redacted even inside a range stage 1 reports as a byline', () => {
    const source = 'Autora: María'
    const output = 'Autora: [Persona A]'
    const at = source.indexOf('María')
    expect(restoreAuthors(source, output, ['Ana María López'], [[at, at + 5]])).toEqual({ text: output, kept: [] })
  })

  it.each([['Ana María López'], ['Juan Carlos Pérez'], ['María Guadalupe'], ['Ana de la Cruz']])(
    'the whole name %j comes back',
    (author) => {
      expect(restoreAuthors(`${author} llegó.`, '[Persona A] llegó.', [author])).toEqual({ text: `${author} llegó.`, kept: [author] })
    },
  )

  it('🔴 a one-part name keeps nothing, even when it matches', () => {
    expect(restoreAuthors('Ruiz habló.', '[Persona A] habló.', ['Ruiz']).text).toBe('[Persona A] habló.')
    expect(restoreAuthors('Ana Ana habló.', '[Persona A] habló.', ['Ana Ana']).text).toBe('[Persona A] habló.')
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

  it('🔴 structuralPass with keepAuthors grows linearly on a one-line 2 MB document', () => {
    // A RATIO of two runs on the same box, so load does not decide it: 8x the
    // text must cost well under 64x (quadratic).
    const small = oneLineDoc(280)
    const big = oneLineDoc(2240)
    expect(big.length).toBeGreaterThan(2_000_000)
    const run = (t: string) => () => structuralPass(t, { person: () => '[Persona A]', keepAuthors: ['Ana Ruiz'] })
    run(small)() // warm-up
    expect(best(run(big)) / Math.max(best(run(small)), 1)).toBeLessThan(24)
  }, 60_000)

  it('🔴 a byline key followed by a long run of spaces stays linear', () => {
    // Measured 2026-10-28 (local tsx): "Autor:" + 20k spaces + "x" took 0.5 s
    // before BYLINE_SEP lost its ambiguous spaces, 0.3 ms after.
    const run = (n: number) => () => structuralPass(`Autora:${' '.repeat(n)}Ana Ruiz | Autor: ${' '.repeat(n)}x`, { keepAuthors: ['Ana Ruiz'] })
    run(1000)()
    expect(best(run(200_000)) / Math.max(best(run(25_000)), 1)).toBeLessThan(24)
  }, 60_000)

  it('🔴 restoreAuthors grows linearly on a one-line 2 MB output', () => {
    const doc = (n: number) => {
      // ", con": a comma ends the glue scan (" y Luis" would glue them).
      const source = oneLineDoc(n).replaceAll(' y Luis', ', con Luis')
      return { source, output: source.replaceAll('Ana Ruiz', '[Persona A]').replaceAll('Luis Gómez', '[Persona B]') }
    }
    const small = doc(280)
    const big = doc(2240)
    const run = (d: { source: string; output: string }) => () => {
      const r = restoreAuthors(d.source, d.output, ['Ana Ruiz'])
      expect(r.text === d.output.replaceAll('[Persona A]', 'Ana Ruiz')).toBe(true) // never diff 2 MB strings
    }
    run(small)()
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

describe('R60: what a kept byline piece may hold', () => {
  it('🔴 a trusted name with a digit is not kept at the structural pass, on its own', () => {
    const trusted = 'Ana Ruiz 2'
    const out = structuralPass(`Autor: ${trusted}`, { keepAuthors: [trusted] })
    expect(out.bylines).toEqual([])
    expect(out.text).not.toContain(trusted)
  })

  it('a trusted name with only letters is kept: the guard above is not a blanket refusal', () => {
    const out = structuralPass('Autor: Ana Ruiz', { keepAuthors: ['Ana Ruiz'] })
    expect(out.bylines.length).toBe(1)
    expect(out.text).toContain('Ana Ruiz')
  })
})
