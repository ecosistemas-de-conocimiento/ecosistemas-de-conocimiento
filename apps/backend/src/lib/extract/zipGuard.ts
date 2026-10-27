/**
 * 🔴 THE ZIP DIRECTORY IS READ BEFORE ANY UNZIPPER SEES A DOCX OR XLSX.
 *
 * Re-audit 2026-10-26: a 1.5 MB DOCX (or XLSX) holding 1.5 GB of junk XML
 * killed the whole process. Inflated data lives in Buffers OUTSIDE the
 * worker's heap cap (`./sandbox.ts`), so the heap cap never fired. These checks
 * run on the central directory alone, in microseconds, before mammoth or
 * read-excel-file inflate anything:
 *
 *   · one entry may not declare more than `MAX_ENTRY_BYTES`;
 *   · all entries together may not declare more than `MAX_TOTAL_BYTES`;
 *   · an entry over `RATIO_FLOOR_BYTES` may not inflate more than
 *     `MAX_RATIO`:1 (real XML is ~5–30:1; a bomb is ~1000:1);
 *   · a zip64 size marker is refused, not followed.
 *
 * ⚠ The directory can lie. `./xlsxGuard.ts` inflates sheets with a capped
 * output, and the sandbox's memory watchdog is the backstop for an entry that
 * declares less than it inflates to.
 *
 * Anything this cannot read (not a zip) is left for the parser to refuse.
 */

import { ExtractTooLargeError } from './text'

export const MAX_ENTRY_BYTES = 50_000_000
export const MAX_TOTAL_BYTES = 100_000_000
export const MAX_RATIO = 100
export const RATIO_FLOOR_BYTES = 1_000_000

export type ZipEntry = { name: string; method: number; compressedSize: number; size: number; localOffset: number }

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const ZIP64 = 0xffffffff

/** The central directory, or `null` when the bytes are not a readable zip. */
export function zipEntries(buf: Buffer): ZipEntry[] | null {
  if (buf.length < 22) return null
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
  const entries: ZipEntry[] = []
  for (let n = 0; n < count; n++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== CENTRAL) return null
    const nameLen = buf.readUInt16LE(at + 28)
    entries.push({
      method: buf.readUInt16LE(at + 10),
      compressedSize: buf.readUInt32LE(at + 20),
      size: buf.readUInt32LE(at + 24),
      localOffset: buf.readUInt32LE(at + 42),
      name: buf.toString('utf8', at + 46, at + 46 + nameLen),
    })
    at += 46 + nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32)
  }
  return entries
}

export function assertZipWithinLimits(buf: Buffer): void {
  const entries = zipEntries(buf)
  if (!entries) return
  let total = 0
  for (const e of entries) {
    if (e.size === ZIP64 || e.compressedSize === ZIP64) {
      throw new ExtractTooLargeError(`${e.name} uses zip64 sizes (over 4 GB)`)
    }
    if (e.size > MAX_ENTRY_BYTES) {
      throw new ExtractTooLargeError(`${e.name} declares ${e.size} bytes (cap ${MAX_ENTRY_BYTES})`)
    }
    if (e.size > RATIO_FLOOR_BYTES && e.size > MAX_RATIO * Math.max(e.compressedSize, 1)) {
      throw new ExtractTooLargeError(
        `${e.name} inflates ${Math.round(e.size / Math.max(e.compressedSize, 1))}:1 (ratio cap ${MAX_RATIO}:1)`,
      )
    }
    total += e.size
  }
  if (total > MAX_TOTAL_BYTES) {
    throw new ExtractTooLargeError(`the entries declare ${total} bytes together (cap ${MAX_TOTAL_BYTES})`)
  }
}
