/**
 * OLA 4, CARRIL F (2026-11-10): dates and CURPs stage 1 let through.
 *
 * `03.05.1990`, `1990/05/03` and "3 de mayo del 90" came out of the gate as
 * written (measured on 6a880e01 with `staticDetector([])`), and
 * `curp_GOMA900503HDFRRN09` too: stage 2's CURP rule has `\b` edges, and `_`
 * is a word character. Same policy as the existing rules: the day goes, month
 * and year stay; glued into an identifier by `-`/`_`, the date goes whole.
 */

import { describe, expect, it } from 'vitest'

import { runAnonymisationGate } from './gate'
import { staticDetector } from './detector'
import { LABEL_CURP, LABEL_FECHA, structuralPass } from './structural'

const count = (text: string, label: string) => structuralPass(text).removed.find((r) => r.label === label)?.count ?? 0

describe('numeric dates the rules above never read', () => {
  it.each([
    ['Nació el 03.05.1990 en Oaxaca.', 'Nació el 05.1990 en Oaxaca.'],
    ['Nació el 3.5.1990.', 'Nació el 05.1990.'],
    ['el 03.05.90, de noche', 'el 05.90, de noche'],
    ['Fecha: 1990/05/03.', 'Fecha: 1990/05.'],
    ['Fecha: 1990/5/3', 'Fecha: 1990/05'],
    ['el 1990.05.03', 'el 1990.05'],
    ['el 1990-5-3', 'el 1990-05'],
    ['(31.12.2025)', '(12.2025)'],
  ])('%s', (text, expected) => {
    expect(structuralPass(text).text).toBe(expected)
    expect(count(text, LABEL_FECHA)).toBe(1)
  })

  it.each([
    ['acta_03.05.1990.pdf', 'acta_[Dato omitido].pdf'],
    ['nav-1990/05/03-7', 'nav-[Dato omitido]-7'],
    ['1990.05.03_notas', '[Dato omitido]_notas'],
  ])('glued into an identifier: %s is removed whole (D2)', (text, expected) => {
    expect(structuralPass(text).text).toBe(expected)
  })
})

describe('day + month in words', () => {
  it.each([
    ['Renunció el 3 de mayo del 90.', 'Renunció el mayo del 90.'],
    ['Renunció el 3 de mayo de 90.', 'Renunció el mayo de 90.'],
    ['el 3 de mayo', 'el mayo'],
    ['El 3 De Mayo Del 90', 'El Mayo Del 90'],
    ['EL 3 DE MAYO DEL 90', 'EL MAYO DEL 90'],
    ['el 3 de setiembre del 90', 'el setiembre del 90'],
    ['el 3 de septiembre del 90', 'el septiembre del 90'],
    ['el 3 mayo 1990', 'el mayo 1990'],
    ['el 1º de mayo', 'el mayo'],
    ['el primero de mayo del 90', 'el mayo del 90'],
    ['3 de Mayo fue el día.', 'Mayo fue el día.'],
    ['Desde el 5 de Mayo', 'Desde el Mayo'],
    ['Fecha: 5 de Mayo', 'Fecha: Mayo'],
  ])('%s', (text, expected) => {
    expect(structuralPass(text).text).toBe(expected)
    expect(count(text, LABEL_FECHA)).toBe(1)
  })

  it.each([
    ['Oslo, 7-9 enero 2000', 'Oslo, enero 2000'],
    ['n. 1.021, 1-7 junio de 1984', 'n. 1.021, junio de 1984'],
    ['28 junio-5 julio de 1984', 'junio-julio de 1984'],
    ['del 1 al 15 de agosto de 2026', 'del agosto de 2026'],
    ['entre 3 y 5 de mayo', 'entre mayo'],
  ])('a range loses both days: %s', (text, expected) => {
    expect(structuralPass(text).text).toBe(expected)
  })

  it('a 4-digit year keeps the existing output', () => {
    expect(structuralPass('3 de mayo de 1990').text).toBe('mayo de 1990')
    expect(structuralPass('3 de marzo del 2024').text).toBe('marzo de 2024')
  })
})

describe('a CURP', () => {
  it.each([
    ['Su CURP es GOMA900503HDFRRN09.', 'Su CURP es [Dato omitido].'],
    ['curp_GOMA900503HDFRRN09', 'curp_[Dato omitido]'],
    ['curp_goma900503mdfrrna9.pdf', 'curp_[Dato omitido].pdf'],
    ['CURP:GOMA900503MDFRRNA9', 'CURP:[Dato omitido]'],
  ])('%s', (text, expected) => {
    expect(structuralPass(text).text).toBe(expected)
    expect(count(text, LABEL_CURP)).toBe(1)
  })
})

describe('left as written', () => {
  it.each([
    'versión 1.2.3',
    'versión 1.2.10',
    'a las 10.30',
    'cuesta 3.50 pesos',
    '$1.234.567',
    'IP 10.10.2010.1',
    '192.168.1.1',
    'v1.2.2020',
    'pp. 12-15',
    'folio 2026-0042',
    '2019/2020',
    '1990/13/03',
    '32.01.1990',
    '00.05.1990',
    'mayo del 90',
    'Fue en agosto, después de todo.',
    'Vivo en Calle 5 de Mayo.',
    'la Escuela 16 de Septiembre',
    'Av. 20 de Noviembre',
    'son 3 de cada 10',
    '40 de mayo',
    'GOMA900503HDFRRN0',
    'XGOMA900503HDFRRN09',
    'GOMA900503XDFRRN09',
  ])('%s', (text) => {
    const out = structuralPass(text)
    expect(out.text).toBe(text)
    expect(out.removed).toEqual([])
  })
})

describe('through the gate, model off', () => {
  it.each([
    ['Nació el 03.05.1990.', '03.05'],
    ['Fecha: 1990/05/03.', '05/03'],
    ['Renunció el 3 de mayo del 90.', '3 de'],
    ['curp_GOMA900503HDFRRN09', 'GOMA'],
  ])('%s', async (text, gone) => {
    const r = await runAnonymisationGate({ contentKind: 'documento', text }, { detector: staticDetector([]) })
    expect(r.status).toBe('ready')
    expect(r.status === 'ready' ? r.redactedText : '').not.toContain(gone)
  })
})
