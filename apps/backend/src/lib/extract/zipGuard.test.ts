/**
 * 🔴 Re-audit 2026-10-26: a 1.5 MB DOCX or XLSX holding 1.5 GB of junk XML
 * killed the process — inflated Buffers live outside the worker's heap cap.
 * The zip directory is read before any unzipper sees the bytes.
 */

import { describe, expect, it } from 'vitest'

import { testXlsx, testZip } from './testZip'
import { assertXlsxWithinLimits } from './xlsxGuard'
import { assertZipWithinLimits, MAX_ENTRY_BYTES, MAX_TOTAL_BYTES } from './zipGuard'

const MB = 1_000_000
/** Text that deflates about 2:1, so only the size caps can refuse it. */
const noisy = (bytes: number) => {
  let s = ''
  let x = 12345
  while (s.length < bytes) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    s += x.toString(36)
  }
  return s.slice(0, bytes)
}

describe('assertZipWithinLimits', () => {
  it('passes an ordinary archive', () => {
    expect(() => assertZipWithinLimits(testZip([{ name: 'word/document.xml', data: '<w:document/>' }]))).not.toThrow()
  })

  it('leaves bytes that are not a zip for the parser to refuse', () => {
    expect(() => assertZipWithinLimits(Buffer.from('not a zip at all'))).not.toThrow()
  })

  it('🔴 refuses one entry past MAX_ENTRY_BYTES, by its declared size', () => {
    const zip = testZip([{ name: 'word/document.xml', data: 'x', declaredSize: MAX_ENTRY_BYTES + 1 }])
    expect(() => assertZipWithinLimits(zip)).toThrow(/^extract_too_large: word\/document\.xml/)
  })

  it('🔴 refuses when the SUM of entries passes MAX_TOTAL_BYTES, though each is under the entry cap', () => {
    const each = Math.floor(MAX_TOTAL_BYTES / 3) + 1
    // ~1 MB of noise each keeps the ratio under the cap, so only the sum can refuse it.
    const data = noisy(MB)
    const zip = testZip(['a', 'b', 'c'].map((n) => ({ name: `xl/${n}.xml`, data, declaredSize: each })))
    expect(() => assertZipWithinLimits(testZip([{ name: 'xl/a.xml', data, declaredSize: each }]))).not.toThrow()
    expect(() => assertZipWithinLimits(zip)).toThrow(/^extract_too_large: .*declare/)
  })

  it('🔴 refuses a bomb-ratio entry (2 MB of spaces in a few KB)', () => {
    const zip = testZip([{ name: 'word/document.xml', data: ' '.repeat(2 * MB) }])
    expect(() => assertZipWithinLimits(zip)).toThrow(/^extract_too_large: .*ratio/)
  })

  it('a small repetitive entry is not judged by ratio', () => {
    expect(() => assertZipWithinLimits(testZip([{ name: 'a.xml', data: ' '.repeat(100_000) }]))).not.toThrow()
  })

  it('a large entry that compresses like real text passes', () => {
    expect(() => assertZipWithinLimits(testZip([{ name: 'xl/sharedStrings.xml', data: noisy(3 * MB) }]))).not.toThrow()
  })

  it('🔴 refuses a zip64 size marker rather than trusting it', () => {
    const zip = testZip([{ name: 'word/document.xml', data: 'x', declaredSize: 0xffffffff }])
    expect(() => assertZipWithinLimits(zip)).toThrow(/^extract_too_large/)
  })
})

describe('assertXlsxWithinLimits — sheets found through workbook.xml.rels', () => {
  it('passes an ordinary sheet at the usual path', () => {
    expect(() => assertXlsxWithinLimits(testXlsx([{ path: 'worksheets/sheet1.xml', ref: 'C10' }]))).not.toThrow()
  })

  it('🔴 checks a sheet OUTSIDE xl/worksheets/ that the rels point at', () => {
    const xlsx = testXlsx([{ path: 'hoja.xml', ref: 'XFD1048576' }])
    expect(() => assertXlsxWithinLimits(xlsx)).toThrow(/^extract_too_large: xl\/hoja\.xml spans/)
  })

  it('🔴 …and an absolute rels target', () => {
    const xlsx = testXlsx([{ path: '/xl/otra/hoja.xml', ref: 'XFD1048576' }])
    expect(() => assertXlsxWithinLimits(xlsx)).toThrow(/^extract_too_large: xl\/otra\/hoja\.xml spans/)
  })

  it('🔴 caps the SUM across sheets: three sheets each under the cap, together over it', () => {
    // T = column 20; 20 × 50,000 = 1,000,000 cells each, 3,000,000 together.
    const sheets = [0, 1, 2].map((i) => ({ path: `worksheets/s${i}.xml`, ref: 'T50000' }))
    expect(() => assertXlsxWithinLimits(testXlsx(sheets.slice(0, 1)))).not.toThrow()
    expect(() => assertXlsxWithinLimits(testXlsx(sheets))).toThrow(/^extract_too_large: the sheets span/)
  })
})
