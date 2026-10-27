/**
 * 🔴 CHEAP CHECKS AN XLSX MUST PASS BEFORE `read-excel-file` SEES IT.
 *
 * `read-excel-file` builds every sheet as a dense grid from its HIGHEST cell
 * reference: one valued cell at XFD1048576 in a 1.5 KB file made it allocate
 * ~17 billion cells and the backend died of heap exhaustion (audit 2026-10-26).
 * It ignores `<dimension>`, so this guard does too and reads the cell and row
 * references themselves — the numbers the grid is actually built from.
 *
 *   0. The whole archive passes `assertZipWithinLimits` (`./zipGuard.ts`).
 *   1. The sheets are the ones `xl/_rels/workbook.xml.rels` names — exactly
 *      how read-excel-file finds them, NOT a path guess (re-audit 2026-10-26:
 *      a sheet at `xl/hoja.xml` skipped every check). Their DECLARED size plus
 *      the shared strings' may not pass `MAX_XML_BYTES`.
 *   2. Each sheet is inflated (capped at the same budget, so a lying directory
 *      gains nothing) and the SUM over sheets of highest row × highest column
 *      may not pass `MAX_CELLS` — one cap per workbook, not per sheet, since
 *      read-excel-file holds every sheet's grid at once.
 *
 * Anything this cannot read (not a zip, an unknown compression) is left for
 * `read-excel-file` to refuse with its own error. The worker it runs in
 * (`./sandbox.ts`) is the backstop for whatever slips past.
 */

import { inflateRawSync } from 'node:zlib'

import { ExtractTooLargeError } from './text'
import { assertZipWithinLimits, zipEntries, type ZipEntry } from './zipGuard'

export const MAX_XML_BYTES = 50_000_000
export const MAX_CELLS = 2_000_000

const LOCAL = 0x04034b50

/** An entry's bytes, inflated up to `MAX_XML_BYTES`; `null` if this cannot read it. */
function entryBytes(buf: Buffer, e: ZipEntry): Buffer | null {
  if (e.localOffset + 30 > buf.length || buf.readUInt32LE(e.localOffset) !== LOCAL) return null
  const start = e.localOffset + 30 + buf.readUInt16LE(e.localOffset + 26) + buf.readUInt16LE(e.localOffset + 28)
  const raw = buf.subarray(start, start + e.compressedSize)
  if (e.method === 0) return raw
  if (e.method !== 8) return null
  try {
    return inflateRawSync(raw, { maxOutputLength: MAX_XML_BYTES })
  } catch (err) {
    if (err instanceof RangeError) throw new ExtractTooLargeError(`${e.name} inflates past ${MAX_XML_BYTES} bytes`)
    return null
  }
}

/** Column letters to a 1-based number: A → 1, XFD → 16384. */
function columnNumber(letters: string): number {
  let n = 0
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64)
  return n
}

/** Highest row × highest column referenced by a sheet's `<row r>` and `<c r>`. */
export function sheetCellSpan(xml: string): number {
  let maxRow = 0
  let maxCol = 0
  for (const m of xml.matchAll(/<(?:\w+:)?c\b[^>]*?\sr="([A-Z]{1,3})(\d+)"/g)) {
    maxCol = Math.max(maxCol, columnNumber(m[1]))
    maxRow = Math.max(maxRow, Number(m[2]))
  }
  for (const m of xml.matchAll(/<(?:\w+:)?row\b[^>]*?\sr="(\d+)"/g)) maxRow = Math.max(maxRow, Number(m[1]))
  return maxRow * Math.max(maxCol, 1)
}

const REL_TYPES = [
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/',
]

/** A rels `Target` as a zip path, resolved the way read-excel-file's `parseFilePaths` does. */
const relTarget = (target: string) => (target.startsWith('/') ? target.slice(1) : `xl/${target}`)

const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null

/** Sheet and shared-string paths from `xl/_rels/workbook.xml.rels`. */
function workbookParts(buf: Buffer, entries: ZipEntry[]): { sheets: string[]; sharedStrings: string } {
  const out = { sheets: [] as string[], sharedStrings: 'xl/sharedStrings.xml' }
  const relsEntry = entries.find((e) => e.name === 'xl/_rels/workbook.xml.rels')
  const rels = relsEntry ? entryBytes(buf, relsEntry) : null
  if (!rels) return out
  for (const [tag] of rels.toString('utf8').matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g)) {
    const type = attr(tag, 'Type')
    const target = attr(tag, 'Target')
    if (!type || !target) continue
    const kind = REL_TYPES.find((base) => type.startsWith(base)) ? type.slice(type.lastIndexOf('/') + 1) : null
    if (kind === 'worksheet') out.sheets.push(relTarget(target))
    else if (kind === 'sharedStrings') out.sharedStrings = relTarget(target)
  }
  return out
}

export function assertXlsxWithinLimits(buf: Buffer): void {
  assertZipWithinLimits(buf)
  const entries = zipEntries(buf)
  if (!entries) return
  const parts = workbookParts(buf, entries)
  const sheetNames = new Set(parts.sheets)
  const sheets = entries.filter((e) => sheetNames.has(e.name))
  const xml = entries.filter((e) => sheetNames.has(e.name) || e.name === parts.sharedStrings)
  const declared = xml.reduce((sum, e) => sum + e.size, 0)
  if (declared > MAX_XML_BYTES) {
    throw new ExtractTooLargeError(`the sheets declare ${declared} bytes of XML (cap ${MAX_XML_BYTES})`)
  }
  let total = 0
  for (const e of sheets) {
    const bytes = entryBytes(buf, e)
    if (!bytes) continue
    const span = sheetCellSpan(bytes.toString('latin1'))
    if (span > MAX_CELLS) {
      throw new ExtractTooLargeError(`${e.name} spans ${span} cells (cap ${MAX_CELLS})`)
    }
    total += span
    if (total > MAX_CELLS) {
      throw new ExtractTooLargeError(`the sheets span ${total} cells together (cap ${MAX_CELLS})`)
    }
  }
}
