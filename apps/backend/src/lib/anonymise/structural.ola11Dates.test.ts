/**
 * OLA 11, CARRIL B (2026-11-10): date and CURP forms stage 1 still let through
 * (audit of olas 4 and 5, and audit C/D/E). Measured on main a3c9df9f:
 * `03/05/90` and `3/5/90` came out `05/2090` (a century guessed), and
 * `3-V-1990`, `3 may 1990`, `3-mayo-1990`, `03/MAY/1990`, `mayo 3, 1990` and a
 * CURP split by spaces or hyphens came out as written.
 *
 * Same policy as the rules already there: the DAY goes, month and year stay as
 * written; glued into an identifier by `-`/`_`, the date goes whole (D2).
 */

import { describe, expect, it } from 'vitest'

import { runAnonymisationGate } from './gate'
import { staticDetector } from './detector'
import { LABEL_CURP, LABEL_FECHA, structuralPass } from './structural'

const count = (text: string, label: string) => structuralPass(text).removed.find((r) => r.label === label)?.count ?? 0

describe('a two-digit year stays as written', () => {
  it.each([
    ['Nació el 03/05/90.', 'Nació el 05/90.'],
    ['Nació el 3/5/90.', 'Nació el 05/90.'],
    ['el 3-5-90', 'el 05/90'],
    ['el 31/12/05', 'el 12/05'],
  ])('%s', (text, expected) => {
    expect(structuralPass(text).text).toBe(expected)
    expect(count(text, LABEL_FECHA)).toBe(1)
  })
})

describe('a Roman month', () => {
  it.each([
    ['Nació el 3-V-1990.', 'Nació el V-1990.'],
    ['el 3.V.1990', 'el V.1990'],
    ['el 03/XII/1990', 'el XII/1990'],
    ['el 3-v-90', 'el v-90'],
    ['el 31/iv/1990', 'el iv/1990'],
    ['el 9.IX.1990', 'el IX.1990'],
  ])('%s', (text, expected) => {
    expect(structuralPass(text).text).toBe(expected)
    expect(count(text, LABEL_FECHA)).toBe(1)
  })

  it('glued into an identifier: removed whole (D2)', () => {
    expect(structuralPass('acta_3-V-1990.pdf').text).toBe('acta_[Dato omitido].pdf')
  })
})

describe('a month in words or abbreviated, in more forms', () => {
  it.each([
    ['el 3 may 1990', 'el may 1990'],
    ['el 3 may. 1990', 'el may. 1990'],
    ['el 3 de sept. de 1990', 'el sept. de 1990'],
    ['el 3 Dic 90', 'el Dic 90'],
    ['el 3 ENE 2020', 'el ENE 2020'],
    ['el 3-mayo-1990', 'el mayo-1990'],
    ['el 03/MAY/1990', 'el MAY/1990'],
    ['el 3.sept.90', 'el sept.90'],
    ['el 3/ago/1990', 'el ago/1990'],
    ['el 3-mayo, de noche', 'el mayo, de noche'],
    ['el mayo 3, 1990', 'el mayo 1990'],
    ['el mayo 3 1990', 'el mayo 1990'],
    ['el May 3, 1990', 'el May 1990'],
    ['el may. 3, 1990', 'el may. 1990'],
    ['el mayo 3 de 1990', 'el mayo de 1990'],
  ])('%s', (text, expected) => {
    expect(structuralPass(text).text).toBe(expected)
    expect(count(text, LABEL_FECHA)).toBe(1)
  })

  it('glued into an identifier: removed whole (D2)', () => {
    expect(structuralPass('acta-3-mayo-1990.pdf').text).toBe('acta-[Dato omitido].pdf')
  })
})

describe('a CURP split into blocks', () => {
  it.each([
    ['Su CURP es GOMA 900503 HDFRRN 09.', 'Su CURP es [Dato omitido].'],
    ['Su CURP es GOMA-900503-HDFRRN-09.', 'Su CURP es [Dato omitido].'],
    ['CURP: goma - 900503 - mdfrrn - a9', 'CURP: [Dato omitido]'],
    ['CURP: GOMA900503 HDFRRN09', 'CURP: [Dato omitido]'],
    ['curp_GOMA-900503-HDFRRN-09', 'curp_[Dato omitido]'],
  ])('%s', (text, expected) => {
    expect(structuralPass(text).text).toBe(expected)
    expect(count(text, LABEL_CURP)).toBe(1)
  })
})

describe('left as written', () => {
  it.each([
    // Roman numerals that are not a date
    'Capítulo IV',
    'el rey Carlos V',
    'Felipe IV y Carlos V',
    'art. 3-IV',
    'fracción 3-IV-2',
    'versión 3.V.1',
    'Tomo XII/1990',
    '32-V-1990',
    'V-1990',
    // abbreviations without a whole date
    'el mar 1990',
    'Nos vemos el 3 dic.',
    'dic. 1990',
    'sept 1990',
    'el 3-mar',
    'el mar 3',
    'mayo 3, 90 personas',
    'mayo 2024',
    'Calle Mayo 3',
    // versions, times, amounts
    'versión 1.2.3',
    'a las 10.30',
    'a las 10:30',
    'cuesta $3.50',
    'son 3 de cada 10',
    'pp. 12-15',
    // letters and digits that are not a CURP
    'PAGO 200101 HOTELS 12',
    'ABCD 991399 HDFRRN 09',
    'GOMA 900503 HDFRRN 0',
    'XGOMA 900503 HDFRRN 09',
    'GOMA 900503 HDFRRN 091',
    'GOMA\n900503\nHDFRRN\n09',
  ])('%s', (text) => {
    const out = structuralPass(text)
    expect(out.text).toBe(text)
    expect(out.removed).toEqual([])
  })
})

describe('through the gate, model off', () => {
  it.each([
    ['Nació el 03/05/90.', '2090'],
    ['Nació el 3-V-1990.', '3-V'],
    ['Nació el 3 may 1990.', '3 may'],
    ['Nació el 03/MAY/1990.', '03/'],
    ['Nació el mayo 3, 1990.', ' 3,'],
    ['CURP GOMA 900503 HDFRRN 09', 'GOMA'],
    ['CURP GOMA-900503-HDFRRN-09', '900503'],
  ])('%s', async (text, gone) => {
    const r = await runAnonymisationGate({ contentKind: 'documento', text }, { detector: staticDetector([]) })
    expect(r.status).toBe('ready')
    expect(r.status === 'ready' ? r.redactedText : '').not.toContain(gone)
  })
})
