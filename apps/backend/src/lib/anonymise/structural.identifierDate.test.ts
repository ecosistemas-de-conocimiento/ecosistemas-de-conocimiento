/**
 * D2 (navegador 2026-11-10, doc 1439 on dev): the heading "# Nota
 * nav-2026-11-10-7" came out "# Nota nav-2026-11-7". The ISO rule coarsened
 * the date inside the identifier to `2026-11`, which glued onto "-7" and read
 * as a different identifier, with nothing marking the cut. A date glued into an
 * identifier is still a real date, so it is still removed: whole, and marked.
 */

import { describe, expect, it } from 'vitest'

import { LABEL_FECHA, structuralPass } from './structural'

const fechas = (text: string) => structuralPass(text).removed.find((r) => r.label === LABEL_FECHA)?.count ?? 0

describe('a date glued into an identifier is removed whole, with a placeholder', () => {
  it.each([
    ['# Nota nav-2026-11-10-7', '# Nota nav-[Dato omitido]-7'],
    ['entrevista_2026-03-03.m4a', 'entrevista_[Dato omitido].m4a'],
    ['2026-03-03_entrevista.m4a', '[Dato omitido]_entrevista.m4a'],
    ['lote-3-4-25', 'lote-[Dato omitido]'],
    ['caso-15/08/2026-b', 'caso-[Dato omitido]-b'],
  ])('%s', (text, expected) => {
    expect(structuralPass(text).text).toBe(expected)
    expect(fechas(text)).toBe(1)
  })
})

describe('real dates in prose are coarsened exactly as before', () => {
  it.each([
    ['2026-11-10', '2026-11'],
    ['Nos vimos el 2026-11-10.', 'Nos vimos el 2026-11.'],
    ['Nos vimos el 2026-11-10, en la tarde.', 'Nos vimos el 2026-11, en la tarde.'],
    ['(2026-11-10)', '(2026-11)'],
    ['Ocurrió el 2026-08-15T10:23:45Z.', 'Ocurrió el 2026-08.'],
    ['del 2026-11-10 al 2026-11-12', 'del 2026-11 al 2026-11'],
    ['Fue el 15/08/2026 y el 3-3-26.', 'Fue el 08/2026 y el 03/26.'],
    ['el 15 de agosto de 2026', 'el agosto de 2026'],
  ])('%s', (text, expected) => {
    expect(structuralPass(text).text).toBe(expected)
  })

  it('two ISO dates joined by a hyphen are both still removed', () => {
    const out = structuralPass('Periodo 2026-11-10-2026-11-12.').text
    expect(out).not.toMatch(/10|12\b/)
  })
})

describe('identifiers that are not dates are left alone', () => {
  it.each(['nav-2026-7', 'folio 2026-0042', 'v1-2-26', 'caso-12-3', 'ISO-8601'])('%s', (text) => {
    expect(structuralPass(text).text).toBe(text)
    expect(fechas(text)).toBe(0)
  })
})
