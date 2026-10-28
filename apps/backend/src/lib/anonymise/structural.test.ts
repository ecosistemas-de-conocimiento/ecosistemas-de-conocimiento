/**
 * Stage 1. A date to the day is a join key ("el ingeniero que renunció el 3 de
 * marzo"), so each form has to actually lose its day — including the forms a
 * transcriber or an export writes, not just the ISO one a developer thinks of.
 */

import { describe, expect, it } from 'vitest'

import { LABEL_AUTOR, LABEL_FECHA, LABEL_ID, structuralPass } from './structural'

function countOf(removed: Array<{ label: string; count: number }>, label: string): number {
  return removed.find((r) => r.label === label)?.count ?? 0
}

describe('structuralPass — dates', () => {
  it('coarsens an ISO timestamp to the month', () => {
    const out = structuralPass('Ocurrió el 2026-08-15T10:23:45Z, por la mañana.')
    expect(out.text).toContain('2026-08')
    expect(out.text).not.toContain('15')
    expect(out.text).not.toContain('10:23')
    expect(countOf(out.removed, LABEL_FECHA)).toBe(1)
  })

  it('coarsens a bare ISO date', () => {
    expect(structuralPass('2026-08-15').text).toBe('2026-08')
  })

  it('coarsens dd/mm/yyyy and dd-mm-yyyy to mm/yyyy', () => {
    expect(structuralPass('El 15/08/2026 renunció.').text).toBe('El 08/2026 renunció.')
    expect(structuralPass('El 15-08-2026 renunció.').text).toBe('El 08/2026 renunció.')
  })

  it('coarsens a Spanish long date', () => {
    const out = structuralPass('Fue el 15 de agosto de 2026 cuando pasó.')
    expect(out.text).toBe('Fue el agosto de 2026 cuando pasó.')
    expect(countOf(out.removed, LABEL_FECHA)).toBe(1)
  })

  it('coarsens "del" long dates and other months', () => {
    expect(structuralPass('3 de marzo del 2024').text).toBe('marzo de 2024')
  })

  it('leaves a month with no day alone', () => {
    // Already coarse. Re-coarsening would be a no-op, but a rule that fired here
    // would also fire on prose and shred it.
    const out = structuralPass('Fue en agosto, después de todo.')
    expect(out.text).toBe('Fue en agosto, después de todo.')
    expect(out.removed).toEqual([])
  })
})

describe('structuralPass — internal identifiers', () => {
  it('strips a UUID', () => {
    const out = structuralPass('Origen: 3f2504e0-4f89-11d3-9a0c-0305e82c3301 en el export.')
    expect(out.text).toBe('Origen: [Dato omitido] en el export.')
    expect(countOf(out.removed, LABEL_ID)).toBe(1)
  })

  it('strips author markers with the key, not just the value', () => {
    const out = structuralPass('user:42 subió esto; uploadedBy=17; usuario 8f1c2')
    expect(out.text).not.toContain('42')
    expect(out.text).not.toContain('uploadedBy')
    expect(out.text).not.toContain('8f1c2')
    expect(countOf(out.removed, LABEL_ID)).toBe(3)
  })

  it('⚠ leaves "usuario" as an ordinary Spanish noun alone', () => {
    // A rule that ate the next word would turn "el usuario dijo" into
    // "el [Dato omitido]" — corrupting prose while removing nothing.
    const out = structuralPass('El usuario dijo que no volvería.')
    expect(out.text).toBe('El usuario dijo que no volvería.')
    expect(out.removed).toEqual([])
  })

  it('reports nothing when there is nothing to remove', () => {
    const out = structuralPass('Una tarde cualquiera, sin fechas ni folios.')
    expect(out.removed).toEqual([])
  })
})

/**
 * 🔴 THE BYLINE LEAK (measured 2026-10-28): `autor` sat in the id-key list, whose
 * value is ONE token, so "Autor: Juan Pérez" came out "[Dato omitido] Pérez" — a
 * surname left in the corpus beside a redaction that makes it look safe. And
 * `\b` before the key let "función-autor: cuando" lose its "autor".
 */
describe('structuralPass — author bylines', () => {
  const NAME_WORDS = ['Juan', 'Pérez', 'Cruz', 'María', 'López', 'Ana', 'Ruiz', 'Luis', 'Gómez']
  const noNameLeft = (text: string) => {
    for (const w of NAME_WORDS) expect(text).not.toContain(w)
  }

  it('redacts every word of the name, not just the first', () => {
    const out = structuralPass('Autor: Juan Pérez')
    noNameLeft(out.text)
    expect(out.text).toBe('Autor: [Dato omitido]')
    expect(countOf(out.removed, LABEL_AUTOR)).toBe(1)
  })

  it('takes an upper-case key and a name with particles', () => {
    const out = structuralPass('AUTOR: Juan Pérez de la Cruz')
    noNameLeft(out.text)
    expect(out.text).toBe('AUTOR: [Dato omitido]')
  })

  it('takes "Autora"', () => {
    const out = structuralPass('Autora: María López')
    noNameLeft(out.text)
    expect(out.text).toBe('Autora: [Dato omitido]')
  })

  it('takes "Autores" and redacts EVERY author, each on its own', () => {
    const out = structuralPass('Autores: Ana Ruiz y Luis Gómez')
    noNameLeft(out.text)
    expect(out.text).toBe('Autores: [Dato omitido] y [Dato omitido]')
    expect(countOf(out.removed, LABEL_AUTOR)).toBe(2)
  })

  it('redacts a byline inside a multi-line header block, and nothing else', () => {
    const header = [
      'Título: Notas de campo',
      'Autor: Juan Pérez',
      'Autora: María López | Lugar: el salón',
      '',
      'El texto empieza aquí.',
    ].join('\n')
    const out = structuralPass(header)
    noNameLeft(out.text)
    expect(out.text).toBe(
      [
        'Título: Notas de campo',
        'Autor: [Dato omitido]',
        'Autora: [Dato omitido] | Lugar: el salón',
        '',
        'El texto empieza aquí.',
      ].join('\n'),
    )
  })

  it('takes markdown bylines: bullets and bold keys', () => {
    const out = structuralPass('- **Autor:** Juan Pérez\n> Autora: María López')
    noNameLeft(out.text)
  })

  it('takes a capitalised name after a mid-line "Autor:"', () => {
    const out = structuralPass('Notas de clase. Autor: Juan Pérez de la Cruz, 2026.')
    noNameLeft(out.text)
    expect(out.text).toBe('Notas de clase. Autor: [Dato omitido], 2026.')
  })

  it('keeps an accented last letter inside the redaction', () => {
    expect(structuralPass('Autor: José').text).toBe('Autor: [Dato omitido]')
  })

  it('stops a byline at a sentence end, not at a title or an initial', () => {
    expect(structuralPass('Autora: Ximena Arriaga. Ximena coordinó.').text).toBe(
      'Autora: [Dato omitido]. Ximena coordinó.',
    )
    expect(structuralPass('Autor: Dr. Juan Pérez').text).toBe('Autor: [Dato omitido]')
    expect(structuralPass('Autor: J. Pérez.').text).toBe('Autor: [Dato omitido].')
  })

  it('labels each author through `person` when the gate supplies one', () => {
    const seen: string[] = []
    const out = structuralPass('Autores: Ana Ruiz y Luis Gómez', {
      person: (name) => {
        seen.push(name)
        return `[Persona ${String.fromCharCode(64 + seen.length)}]`
      },
    })
    expect(out.text).toBe('Autores: [Persona A] y [Persona B]')
    expect(seen).toEqual(['Ana Ruiz', 'Luis Gómez'])
  })

  it('⚠ leaves "función-autor: cuando" alone', () => {
    const out = structuralPass('Foucault habla de la función-autor: cuando un texto circula…')
    expect(out.text).toBe('Foucault habla de la función-autor: cuando un texto circula…')
    expect(out.removed).toEqual([])
  })

  it('⚠ leaves a mid-sentence "el autor: según" alone', () => {
    const out = structuralPass('Lo dice el autor: según él, la obra es colectiva.')
    expect(out.text).toBe('Lo dice el autor: según él, la obra es colectiva.')
    expect(out.removed).toEqual([])
  })
})

/** The same first-token-only shape, on the id keys: a NAME after `usuario:`. */
describe('structuralPass — id keys with a name for a value', () => {
  it('takes the whole capitalised name after a mid-line id key, and stops there', () => {
    const out = structuralPass('Lo subió usuario: Juan Pérez sin aviso')
    expect(out.text).not.toContain('Pérez')
    expect(out.text).toBe('Lo subió [Dato omitido] sin aviso')
  })

  it('takes a lower-case name to the end of a header field', () => {
    const out = structuralPass('uploaded_by: juan pérez\nEl texto.')
    expect(out.text).not.toContain('pérez')
    expect(out.text).toBe('[Dato omitido]\nEl texto.')
  })

  it('keeps an accented last letter inside the redaction', () => {
    expect(structuralPass('usuario: José').text).toBe('[Dato omitido]')
  })

  it('⚠ leaves a key glued to a word by a hyphen alone', () => {
    expect(structuralPass('la función-user: 42').text).toBe('la función-user: 42')
  })
})
