/**
 * Legacy Excel (`.xls`: BIFF8 records inside an OLE2 compound file) as rows of
 * cells, the shape `read-excel-file` gives `./spreadsheet.ts` for an xlsx.
 *
 * 🔴 HAND-WRITTEN ON PURPOSE (2026-10-28). Every maintained JS reader of .xls is
 * SheetJS: the npm `xlsx` package stops at 0.18.5 with CVE-2023-30533
 * (prototype pollution) and CVE-2024-22363 (ReDoS) unfixed; the fixes ship only
 * from SheetJS's own CDN. LibreOffice is not in the backend image. This file
 * reads only what text needs — cell values, sheet names, the shared strings and
 * which number formats are dates — and nothing else: no formulas, styles,
 * macros or embedded objects.
 *
 * Cheap by construction: an OLE2 file is not compressed, every sector chain is
 * walked at most once and bounded by the file, and nothing is allocated from a
 * count the file declares. The caps are the xlsx ones:
 *   · the SUM over sheets of highest row × highest column may not pass
 *     `MAX_CELLS` (`./xlsxGuard.ts`) → `extract_too_large`;
 *   · the text cap (`LineSink`) and the worker's heap, memory and wall clock
 *     (`./sandbox.ts`) apply unchanged.
 *
 * Refusals: `xls_invalid: …` (malformed), `xls_encrypted: …` (a password),
 * `xls_unsupported: …` (Excel 5.0/95 and older, which are not BIFF8).
 */

import { ExtractTooLargeError, isCfb } from './text'
import { MAX_CELLS } from './xlsxGuard'

export { isCfb }

export class XlsInvalidError extends Error {
  constructor(detail: string) {
    super(`xls_invalid: ${detail}`)
  }
}

// ── The compound file ────────────────────────────────────────────────────────

const ENDOFCHAIN = 0xfffffffe
const MAXREGSECT = 0xfffffffa
const NOSTREAM = 0xffffffff

type DirEntry = { name: string; type: number; start: number; size: number }

/** One compound file's sectors, FAT and directory. */
class Cfb {
  readonly sectorSize: number
  private readonly sectorCount: number
  private readonly fat: Uint32Array
  readonly entries: DirEntry[]

  constructor(private readonly buf: Buffer) {
    if (!isCfb(buf) || buf.length < 512) throw new XlsInvalidError('not an OLE2 compound file')
    const shift = buf.readUInt16LE(0x1e)
    if (shift !== 9 && shift !== 12) throw new XlsInvalidError(`sector shift ${shift}`)
    if (buf.readUInt16LE(0x20) !== 6) throw new XlsInvalidError('mini sector shift')
    this.sectorSize = 1 << shift
    this.sectorCount = Math.max(0, Math.ceil((buf.length - this.sectorSize) / this.sectorSize))
    this.fat = this.readFat()
    this.entries = this.readDirectory()
  }

  /** Sector `n`'s bytes; a truncated last sector is what the file has. */
  private sector(n: number): Buffer {
    if (n >= this.sectorCount) throw new XlsInvalidError(`sector ${n} past the end of the file`)
    const at = (n + 1) * this.sectorSize
    return this.buf.subarray(at, Math.min(at + this.sectorSize, this.buf.length))
  }

  private readFat(): Uint32Array {
    const numFat = this.buf.readUInt32LE(0x2c)
    if (numFat > this.sectorCount) throw new XlsInvalidError(`${numFat} FAT sectors in a ${this.sectorCount}-sector file`)
    const fatSectors: number[] = []
    for (let i = 0; i < 109 && fatSectors.length < numFat; i++) fatSectors.push(this.buf.readUInt32LE(0x4c + i * 4))
    // The DIFAT chain: each sector lists FAT sectors, its last slot is the next one.
    let next = this.buf.readUInt32LE(0x44)
    const perDifat = this.sectorSize / 4 - 1
    for (let hops = 0; fatSectors.length < numFat; hops++) {
      if (next > MAXREGSECT || hops > this.sectorCount) throw new XlsInvalidError('DIFAT chain')
      const s = this.sector(next)
      for (let i = 0; i < perDifat && fatSectors.length < numFat; i++) fatSectors.push(s.readUInt32LE(i * 4))
      next = s.readUInt32LE(perDifat * 4)
    }
    const per = this.sectorSize / 4
    const fat = new Uint32Array(numFat * per).fill(NOSTREAM)
    fatSectors.forEach((n, k) => {
      const s = this.sector(n)
      for (let i = 0; i < per && i * 4 + 4 <= s.length; i++) fat[k * per + i] = s.readUInt32LE(i * 4)
    })
    return fat
  }

  /** A chain's sector numbers. 🔴 A loop or a dangling link is refused, never followed. */
  private chain(start: number, table: Uint32Array, limit: number): number[] {
    const out: number[] = []
    const seen = new Uint8Array(limit)
    for (let n = start; n !== ENDOFCHAIN; n = table[n]) {
      if (n >= limit || n >= table.length || seen[n]) throw new XlsInvalidError('sector chain')
      seen[n] = 1
      out.push(n)
    }
    return out
  }

  /** A whole chain of regular sectors. */
  private chainBytes(start: number): Buffer {
    if (start === ENDOFCHAIN) return Buffer.alloc(0)
    return Buffer.concat(this.chain(start, this.fat, this.sectorCount).map((n) => this.sector(n)))
  }

  /** A stream in regular sectors, cut to `size`. */
  private regular(start: number, size: number): Buffer {
    const data = this.chainBytes(start)
    if (data.length < size) throw new XlsInvalidError('stream shorter than its directory entry')
    return data.subarray(0, size)
  }

  private readDirectory(): DirEntry[] {
    const raw = this.chainBytes(this.buf.readUInt32LE(0x30))
    const entries: DirEntry[] = []
    for (let at = 0; at + 128 <= raw.length; at += 128) {
      const nameLen = Math.min(raw.readUInt16LE(at + 0x40), 64)
      entries.push({
        name: raw.toString('utf16le', at, at + Math.max(0, nameLen - 2)),
        type: raw[at + 0x42],
        start: raw.readUInt32LE(at + 0x74),
        size: raw.readUInt32LE(at + 0x78),
      })
    }
    if (entries[0]?.type !== 5) throw new XlsInvalidError('no root entry')
    return entries
  }

  /** The stream called `name` (case-insensitive), or `null`. */
  stream(name: string): Buffer | null {
    const e = this.entries.find((d) => d.type === 2 && d.name.toLowerCase() === name.toLowerCase())
    if (!e) return null
    if (e.size > this.buf.length) throw new XlsInvalidError(`${name} declares more bytes than the file has`)
    const cutoff = this.buf.readUInt32LE(0x38)
    if (e.size >= cutoff) return this.regular(e.start, e.size)
    // A small stream lives in the mini stream (64-byte sectors held by the root).
    const root = this.entries[0]
    const mini = this.regular(root.start, Math.min(root.size, this.buf.length))
    const miniFatBytes = this.chainBytes(this.buf.readUInt32LE(0x3c))
    const table = new Uint32Array(Math.floor(miniFatBytes.length / 4))
    for (let i = 0; i < table.length; i++) table[i] = miniFatBytes.readUInt32LE(i * 4)
    const parts = this.chain(e.start, table, Math.floor(mini.length / 64)).map((n) => mini.subarray(n * 64, n * 64 + 64))
    const data = Buffer.concat(parts)
    if (data.length < e.size) throw new XlsInvalidError('stream shorter than its directory entry')
    return data.subarray(0, e.size)
  }
}

// ── The BIFF8 records ────────────────────────────────────────────────────────

const BOF = 0x0809
const EOF = 0x000a
const CONTINUE = 0x003c
const FILEPASS = 0x002f
const DATEMODE = 0x0022
const FORMAT = 0x041e
const XF = 0x00e0
const BOUNDSHEET = 0x0085
const SST = 0x00fc
const NUMBER = 0x0203
const RK = 0x027e
const MULRK = 0x00bd
const LABELSST = 0x00fd
const LABEL = 0x0204
const RSTRING = 0x00d6
const BOOLERR = 0x0205
const FORMULA = 0x0006
const STRING = 0x0207

type Rec = { type: number; at: number; len: number }

/** Every record from `from` to the end of the stream. A record cut short is refused. */
function* records(wb: Buffer, from: number): Generator<Rec> {
  for (let at = from; at + 4 <= wb.length; ) {
    const type = wb.readUInt16LE(at)
    const len = wb.readUInt16LE(at + 2)
    if (at + 4 + len > wb.length) throw new XlsInvalidError(`record 0x${type.toString(16)} runs past the stream`)
    yield { type, at: at + 4, len }
    at += 4 + len
  }
}

/** `n` characters at `at`: 8-bit (the low bytes of UTF-16, i.e. Latin-1) or UTF-16LE. */
const chars = (b: Buffer, at: number, n: number, wide: boolean) =>
  wide ? b.toString('utf16le', at, at + n * 2) : b.toString('latin1', at, at + n)

/** An XLUnicodeString (`cch` 16-bit) or ShortXLUnicodeString (8-bit), cut at `end`. */
function unicodeString(b: Buffer, at: number, end: number, short: boolean): string {
  if (at + (short ? 2 : 3) > end) return ''
  const cch = short ? b[at] : b.readUInt16LE(at)
  const flags = b[at + (short ? 1 : 2)]
  let p = at + (short ? 2 : 3)
  if (flags & 0x08) p += 2 // rich-text run count
  if (flags & 0x04) p += 4 // phonetic block size
  const wide = (flags & 1) === 1
  const n = Math.max(0, Math.min(cch, Math.floor((end - p) / (wide ? 2 : 1))))
  return chars(b, p, n, wide)
}

/**
 * The shared-string table. Its strings may break across CONTINUE records; at a
 * break the character data resumes with a fresh 1-byte "wide" flag.
 * `bounds` are the offsets in `sst` where each CONTINUE's data starts.
 */
function readSst(sst: Buffer, bounds: number[]): string[] {
  if (sst.length < 8) throw new XlsInvalidError('SST too short')
  const unique = sst.readUInt32LE(4)
  const out: string[] = []
  let p = 8
  let bi = 0
  const boundaryAfter = (pos: number) => {
    while (bi < bounds.length && bounds[bi] <= pos) bi++
    return bi < bounds.length ? bounds[bi] : sst.length
  }
  while (out.length < unique && p + 3 <= sst.length) {
    const cch = sst.readUInt16LE(p)
    let flags = sst[p + 2]
    p += 3
    let runs = 0
    let ext = 0
    if (flags & 0x08) {
      runs = sst.readUInt16LE(p)
      p += 2
    }
    if (flags & 0x04) {
      ext = sst.readUInt32LE(p)
      p += 4
    }
    let s = ''
    for (let left = cch; left > 0; ) {
      const end = boundaryAfter(p)
      const wide = (flags & 1) === 1
      const n = Math.min(left, Math.floor((end - p) / (wide ? 2 : 1)))
      s += chars(sst, p, n, wide)
      p += n * (wide ? 2 : 1)
      left -= n
      if (left === 0) break
      if (p !== end || p >= sst.length) throw new XlsInvalidError('SST string runs past the table')
      flags = sst[p]
      p += 1
    }
    p += runs * 4 + ext
    out.push(s)
  }
  return out
}

/** Built-in number formats that show a date or time. */
const DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58])

/** A custom format code shows a date when a d/m/y/h/s sits outside quotes, escapes and brackets. */
export function isDateFormatCode(code: string): boolean {
  const bare = code.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[[^\]]*\]/g, '')
  return /[dmyhs]/i.test(bare.split(';')[0] ?? '')
}

/** An RK number: a 30-bit integer or the top 30 bits of a double, maybe ÷ 100. */
function rk(b: Buffer, at: number): number {
  const v = b.readInt32LE(at)
  let n: number
  if (v & 2) n = v >> 2
  else {
    const d = Buffer.alloc(8)
    d.writeUInt32LE((v & 0xfffffffc) >>> 0, 4)
    n = d.readDoubleLE(0)
  }
  return v & 1 ? n / 100 : n
}

const ERRORS: Record<number, string> = {
  0x00: '#NULL!',
  0x07: '#DIV/0!',
  0x0f: '#VALUE!',
  0x17: '#REF!',
  0x1d: '#NAME?',
  0x24: '#NUM!',
  0x2a: '#N/A',
}

export type XlsCell = string | number | boolean | Date | null
export type XlsSheet = { sheet: string; data: XlsCell[][] }

/** Rows of cells for every worksheet, in workbook order. Charts and macro sheets are skipped. */
export function readXls(bytes: Buffer): XlsSheet[] {
  try {
    return readXlsUnguarded(bytes)
  } catch (err) {
    // A length field that points past its buffer: malformed, not a crash.
    if (err instanceof RangeError) throw new XlsInvalidError('a structure runs past its bounds')
    throw err
  }
}

function readXlsUnguarded(bytes: Buffer): XlsSheet[] {
  const cfb = new Cfb(bytes)
  const wb = cfb.stream('Workbook')
  if (!wb) {
    if (cfb.stream('Book')) throw new Error('xls_unsupported: Excel 5.0/95 workbook; save it as .xlsx')
    throw new XlsInvalidError('no Workbook stream (not an Excel file)')
  }

  // ── Globals: dates, formats, sheets, shared strings. ──
  let date1904 = false
  const dateFormats = new Set<number>(DATE_FORMAT_IDS)
  const xfFormats: number[] = []
  const sheets: { name: string; offset: number }[] = []
  let sst: string[] = []
  let sstParts: Buffer[] | null = null
  let sstBounds: number[] = []
  let sstSize = 0
  const flushSst = () => {
    if (sstParts) sst = readSst(Buffer.concat(sstParts), sstBounds)
    sstParts = null
  }
  let first = true
  for (const r of records(wb, 0)) {
    const d = wb.subarray(r.at, r.at + r.len)
    if (first) {
      first = false
      if (r.type !== BOF || r.len < 2) throw new XlsInvalidError('no BOF record')
      const version = d.readUInt16LE(0)
      if (version !== 0x0600) throw new Error('xls_unsupported: Excel 5.0/95 workbook; save it as .xlsx')
      continue
    }
    if (sstParts && r.type === CONTINUE) {
      sstBounds.push(sstSize)
      sstParts.push(d)
      sstSize += d.length
      continue
    }
    flushSst()
    if (r.type === EOF) break
    if (r.type === FILEPASS) throw new Error('xls_encrypted: the workbook is password-protected')
    if (r.type === DATEMODE && r.len >= 2) date1904 = d.readUInt16LE(0) === 1
    else if (r.type === FORMAT && r.len >= 2) {
      const id = d.readUInt16LE(0)
      if (isDateFormatCode(unicodeString(d, 2, d.length, false))) dateFormats.add(id)
      else dateFormats.delete(id)
    } else if (r.type === XF && r.len >= 4) xfFormats.push(d.readUInt16LE(2))
    else if (r.type === BOUNDSHEET && r.len >= 8) {
      if (d[5] === 0) sheets.push({ offset: d.readUInt32LE(0), name: unicodeString(d, 6, d.length, true) })
    } else if (r.type === SST) {
      sstParts = [d]
      sstBounds = []
      sstSize = d.length
    }
  }
  flushSst()

  const isDate = (xf: number) => dateFormats.has(xfFormats[xf] ?? -1)
  const num = (v: number, xf: number): XlsCell => {
    if (!isDate(xf) || !Number.isFinite(v)) return v
    const days = date1904 ? v + 1462 : v
    return new Date(Math.round((days - 25569) * 86_400_000))
  }

  // ── Worksheets, each from its BOUNDSHEET offset to its EOF. ──
  // 🔴 In offset order and never overlapping: N sheets pointing at one offset
  // would otherwise re-read the stream N times.
  const out: XlsSheet[] = []
  let totalSpan = 0
  let floor = 0
  const ordered = sheets.map((s, i) => ({ ...s, i })).sort((a, b) => a.offset - b.offset)
  const parsed = new Map<number, XlsSheet>()
  for (const s of ordered) {
    if (s.offset < floor || s.offset >= wb.length) throw new XlsInvalidError(`sheet ${s.i + 1} offset`)
    const rows: XlsCell[][] = []
    let maxRow = -1
    let maxCol = -1
    let depth = 0
    let pending: { row: number; col: number } | null = null
    const put = (row: number, col: number, v: XlsCell) => {
      if (row > maxRow || col > maxCol) {
        maxRow = Math.max(maxRow, row)
        maxCol = Math.max(maxCol, col)
        const span = (maxRow + 1) * (maxCol + 1)
        if (totalSpan + span > MAX_CELLS) {
          throw new ExtractTooLargeError(`the sheets span more than ${MAX_CELLS} cells (cap ${MAX_CELLS})`)
        }
      }
      ;(rows[row] ??= [])[col] = v
    }
    let end = wb.length
    for (const r of records(wb, s.offset)) {
      const d = wb.subarray(r.at, r.at + r.len)
      if (r.type === BOF) {
        depth++
        continue
      }
      if (depth === 0) throw new XlsInvalidError(`sheet ${s.i + 1} has no BOF`)
      if (r.type === EOF) {
        if (--depth === 0) {
          end = r.at + r.len
          break
        }
        continue
      }
      // An embedded chart's substream sits inside the sheet's: skip its records.
      if (depth > 1) continue
      if (pending && r.type === STRING) {
        put(pending.row, pending.col, unicodeString(d, 0, d.length, false))
        pending = null
        continue
      }
      pending = null
      if (r.len < 6) continue
      const row = d.readUInt16LE(0)
      const col = d.readUInt16LE(2)
      const xf = d.readUInt16LE(4)
      if (r.type === NUMBER && r.len >= 14) put(row, col, num(d.readDoubleLE(6), xf))
      else if (r.type === RK && r.len >= 10) put(row, col, num(rk(d, 6), xf))
      else if (r.type === MULRK) {
        const n = Math.floor((r.len - 6) / 6)
        for (let k = 0; k < n; k++) put(row, col + k, num(rk(d, 4 + k * 6 + 2), d.readUInt16LE(4 + k * 6)))
      } else if (r.type === LABELSST && r.len >= 10) put(row, col, sst[d.readUInt32LE(6)] ?? '')
      else if ((r.type === LABEL || r.type === RSTRING) && r.len >= 9) put(row, col, unicodeString(d, 6, d.length, false))
      else if (r.type === BOOLERR && r.len >= 8) put(row, col, d[7] ? (ERRORS[d[6]] ?? '#ERROR') : d[6] === 1)
      else if (r.type === FORMULA && r.len >= 14) {
        if (d.readUInt16LE(12) !== 0xffff) put(row, col, num(d.readDoubleLE(6), xf))
        else if (d[6] === 0) pending = { row, col }
        else if (d[6] === 1) put(row, col, d[8] === 1)
        else if (d[6] === 2) put(row, col, ERRORS[d[8]] ?? '#ERROR')
      }
    }
    if (depth !== 0) throw new XlsInvalidError(`sheet ${s.i + 1} has no EOF`)
    floor = end
    totalSpan += (maxRow + 1) * (maxCol + 1)
    parsed.set(s.i, { sheet: s.name, data: Array.from(rows, (r) => (r ? Array.from(r, (v) => v ?? null) : [])) })
  }
  for (let i = 0; i < sheets.length; i++) out.push(parsed.get(i)!)
  return out
}
