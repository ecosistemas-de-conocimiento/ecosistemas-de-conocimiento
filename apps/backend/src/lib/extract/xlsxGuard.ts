/**
 * 🔴 CHEAP CHECKS AN XLSX MUST PASS BEFORE `read-excel-file` SEES IT.
 *
 * `read-excel-file` builds every sheet as a dense grid from its HIGHEST cell
 * reference: one valued cell at XFD1048576 in a 1.5 KB file made it allocate
 * ~17 billion cells and the backend died of heap exhaustion (audit 2026-10-26).
 * It ignores `<dimension>`, so this guard does too and reads the cell and row
 * references themselves — the numbers the grid is actually built from.
 *
 *   1. The zip directory's DECLARED uncompressed size of the sheets plus
 *      `sharedStrings.xml` may not pass `MAX_XML_BYTES`.
 *   2. Each sheet is inflated (capped at the same budget, so a lying directory
 *      gains nothing) and its highest row × highest column may not pass
 *      `MAX_CELLS`.
 *
 * Anything this cannot read (not a zip, an unknown compression) is left for
 * `read-excel-file` to refuse with its own error. The worker it runs in
 * (`./sandbox.ts`) is the backstop for whatever slips past.
 */

import { inflateRawSync } from 'node:zlib'

import { ExtractTooLargeError } from './text'

export const MAX_XML_BYTES = 50_000_000
export const MAX_CELLS = 2_000_000

type Entry = { name: string; method: number; compressedSize: number; size: number; localOffset: number }

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

/** The central directory, or `null` when the bytes are not a readable zip. */
function zipEntries(buf: Buffer): Entry[] | null {
  // The end-of-central-directory record sits in the last 22 + 65,535 bytes.
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return null
  const count = buf.readUInt16LE(eocd + 10)
  let at = buf.readUInt32LE(eocd + 16)
  const entries: Entry[] = []
  for (let n = 0; n < count; n++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== CENTRAL) return null
    const nameLen = buf.readUInt16LE(at + 28)
    entries.push({
      method: buf.readUInt16LE(at + 10),
      compressedSize: buf.readUInt32LE(at + 20),
      // 0xFFFFFFFF means "see the zip64 extra field": over 4 GB, refused below.
      size: buf.readUInt32LE(at + 24),
      localOffset: buf.readUInt32LE(at + 42),
      name: buf.toString('utf8', at + 46, at + 46 + nameLen),
    })
    at += 46 + nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32)
  }
  return entries
}

/** An entry's bytes, inflated up to `MAX_XML_BYTES`; `null` if this cannot read it. */
function entryBytes(buf: Buffer, e: Entry): Buffer | null {
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

const isSheetXml = (name: string) => /^xl\/worksheets\/[^/]+\.xml$/.test(name)

export function assertXlsxWithinLimits(buf: Buffer): void {
  const entries = zipEntries(buf)
  if (!entries) return
  const xml = entries.filter((e) => isSheetXml(e.name) || e.name === 'xl/sharedStrings.xml')
  const declared = xml.reduce((sum, e) => sum + e.size, 0)
  if (declared > MAX_XML_BYTES) {
    throw new ExtractTooLargeError(`the sheets declare ${declared} bytes of XML (cap ${MAX_XML_BYTES})`)
  }
  for (const e of xml) {
    if (!isSheetXml(e.name)) continue
    const bytes = entryBytes(buf, e)
    if (!bytes) continue
    const span = sheetCellSpan(bytes.toString('latin1'))
    if (span > MAX_CELLS) {
      throw new ExtractTooLargeError(`${e.name} spans ${span} cells (cap ${MAX_CELLS})`)
    }
  }
}
