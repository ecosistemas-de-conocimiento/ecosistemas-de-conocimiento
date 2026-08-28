/**
 * Stage 1. A date to the day is a join key ("el ingeniero que renunció el 3 de
 * marzo"), so each form has to actually lose its day — including the forms a
 * transcriber or an export writes, not just the ISO one a developer thinks of.
 */

import { describe, expect, it } from 'vitest'

import { LABEL_FECHA, LABEL_ID, structuralPass } from './structural'

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
