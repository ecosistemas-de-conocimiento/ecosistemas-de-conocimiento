/**
 * Legacy .xls extraction (`./xls.ts`). `muestra.xls` and `muestra.xlsx` are
 * the same workbook, written by xlwt 1.3.0 and openpyxl 3.1.5
 * (`__fixtures__/muestra.py`); the guard workbooks are built by `./testXls.ts`.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { extractXlsText, extractXlsxText } from './spreadsheet'
import { testCfb, testXls, testXlsStream, type TestXlsCell } from './testXls'
import { isCfb, isDateFormatCode, readXls } from './xls'
import { MAX_CELLS } from './xlsxGuard'

const fixture = (name: string) => readFileSync(path.join(__dirname, '__fixtures__', name))

const PEQUENA: { name: string; cells: TestXlsCell[] }[] = [
  {
    name: 'Encuesta',
    cells: [
      [0, 0, 'Pregunta'],
      [0, 1, 'Sí'],
      [1, 0, '¿Hay escuela?'],
      [1, 1, 12],
      [2, 0, 'Agua potable €'],
      [2, 1, true],
    ],
  },
]
const PEQUENA_TEXT = ['# Hoja: Encuesta', 'Pregunta | Sí', '¿Hay escuela? | 12', 'Agua potable € | true'].join('\n')

describe('extractXlsText', () => {
  it('🔴 gives exactly the text the same workbook gives as .xlsx, so retrieval treats both alike', async () => {
    const xls = await extractXlsText(fixture('muestra.xls'))
    expect(xls).toBe(await extractXlsxText(fixture('muestra.xlsx')))
    expect(xls.split('\n').slice(0, 3)).toEqual([
      '# Hoja: Comunidades',
      'Comunidad | Municipio | Participantes | Fecha de visita | Acceso a agua',
      'San Andrés Cohamiata | Mezquitic | 42 | 2026-03-14 | true',
    ])
    // A string past the SST's first record (CONTINUE), and every string after it.
    expect(xls).toContain('Relato largo con € y ñ.')
    expect(xls).toContain('después del relato largo')
    expect(xls).toContain('Registro 100 | Responsable número 100 — José Ñúñez | 300')
    // An empty sheet writes nothing.
    expect(xls).not.toContain('# Hoja: Vacía')
  })

  it('reads strings, numbers and booleans from a regular and from a mini stream alike', async () => {
    expect(await extractXlsText(testXls(PEQUENA))).toBe(PEQUENA_TEXT)
    expect(await extractXlsText(testXls(PEQUENA, { mini: true }))).toBe(PEQUENA_TEXT)
  })

  it('refuses text past the cap instead of building it', async () => {
    await expect(extractXlsText(fixture('muestra.xls'), { maxChars: 50 })).rejects.toThrow(/text_too_long/)
  })

  it('🔴 refuses a sheet whose rows × columns pass the xlsx cell cap', async () => {
    const lejana = testXls([{ name: 'A', cells: [[0, 0, 'a'], [65535, 40, 'b']] }])
    await expect(extractXlsText(lejana)).rejects.toThrow(/extract_too_large/)
  })

  it('🔴 counts the cap over the whole workbook, not per sheet', async () => {
    // Each sheet spans 40,000 × 30 = 1.2M cells: under the cap alone, over it together.
    const sheet = (name: string) => ({ name, cells: [[0, 0, name], [39_999, 29, 1]] as TestXlsCell[] })
    expect(40_000 * 30).toBeLessThan(MAX_CELLS)
    await expect(extractXlsText(testXls([sheet('Una')]))).resolves.toContain('# Hoja: Una')
    await expect(extractXlsText(testXls([sheet('Una'), sheet('Dos')]))).rejects.toThrow(/extract_too_large/)
  })
})

describe('readXls refuses a malformed file with xls_invalid, never a crash', () => {
  it.each([
    ['plain text', Buffer.from('Nombre,Edad\nAna,34\n')],
    ['an empty file', Buffer.alloc(0)],
    ['a bare OLE2 header', fixture('muestra.xls').subarray(0, 512)],
    ['the first half of a real file', fixture('muestra.xls').subarray(0, 15_000)],
    ['a FAT chain that loops', testXls(PEQUENA, { fatLoop: true })],
    ['an OLE2 file with no Workbook stream (.doc, .ppt…)', testXls(PEQUENA, { streamName: 'WordDocument' })],
  ])('%s', (_label, bytes) => {
    expect(() => readXls(bytes)).toThrow(/^xls_invalid: /)
  })

  it('a record that runs past the stream', () => {
    const stream = testXlsStream(PEQUENA)
    // The last cell (a 12-byte BOOLERR) sits before the 4-byte EOF; this is its length field.
    stream.writeUInt16LE(0xffff, stream.length - 4 - 12 + 2)
    expect(() => readXls(testCfb(stream))).toThrow(/^xls_invalid: /)
  })

  it('🔴 sheets that overlap (N sheets at one offset would re-read the stream N times)', () => {
    const two = [PEQUENA[0], { ...PEQUENA[0], name: 'Copia' }]
    expect(() => readXls(testXls(two, { sameOffset: true }))).toThrow(/^xls_invalid: sheet 2 offset/)
  })

  it('a password-protected workbook is xls_encrypted', () => {
    expect(() => readXls(testXls(PEQUENA, { encrypted: true }))).toThrow(/^xls_encrypted: /)
  })

  it('an Excel 5.0/95 workbook is xls_unsupported', () => {
    expect(() => readXls(testXls(PEQUENA, { version: 0x0500 }))).toThrow(/^xls_unsupported: /)
    expect(() => readXls(testXls(PEQUENA, { streamName: 'Book' }))).toThrow(/^xls_unsupported: /)
  })

  it('🔴 200 random byte flips of a real file each end in text or a named refusal', () => {
    const base = fixture('muestra.xls')
    let seed = 7
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed % n
    }
    for (let i = 0; i < 200; i++) {
      const bytes = Buffer.from(base)
      for (let k = 0; k < 8; k++) bytes[rand(bytes.length)] = rand(256)
      try {
        readXls(bytes)
      } catch (err) {
        expect((err as Error).message).toMatch(/^(xls_invalid|xls_unsupported|xls_encrypted|extract_too_large): /)
      }
    }
  })
})

describe('xls helpers', () => {
  it('isCfb is the D0 CF 11 E0 A1 B1 1A E1 magic', () => {
    expect(isCfb(fixture('muestra.xls'))).toBe(true)
    expect(isCfb(fixture('muestra.xlsx'))).toBe(false)
  })

  it.each([
    ['yyyy-mm-dd', true],
    ['d/m/yy h:mm', true],
    ['[$-80A]dddd, d" de "mmmm" de "yyyy', true],
    ['#,##0.00', false],
    ['"días: "0', false],
    ['0.00%', false],
    ['[Red]0.00', false],
    ['General', false],
  ])('isDateFormatCode(%s) is %s', (code, date) => {
    expect(isDateFormatCode(code)).toBe(date)
  })
})
