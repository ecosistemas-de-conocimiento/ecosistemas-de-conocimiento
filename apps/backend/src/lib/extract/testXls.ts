/**
 * TEST HELPER: a minimal .xls writer (BIFF8 in a version-3 OLE2 file), so the
 * reader's guard tests build their hostile workbooks in code. Strings go
 * through the shared-string table, numbers as NUMBER, booleans as BOOLERR.
 */

export type TestXlsCell = [row: number, col: number, value: string | number | boolean]
export type TestXlsOptions = {
  /** BOF version: 0x0600 is BIFF8; 0x0500 is Excel 5.0/95. */
  version?: number
  encrypted?: boolean
  /** The stream's directory name; Excel's is `Workbook`. */
  streamName?: string
  /** Keep the stream under 4096 bytes so it lands in the mini stream. */
  mini?: boolean
  /** Point the workbook's last FAT link back at its first sector. */
  fatLoop?: boolean
  /** Make every BOUNDSHEET point at the first sheet's offset. */
  sameOffset?: boolean
}

const rec = (type: number, body: Buffer) => {
  const head = Buffer.alloc(4)
  head.writeUInt16LE(type, 0)
  head.writeUInt16LE(body.length, 2)
  return Buffer.concat([head, body])
}

const u16 = (...n: number[]) => {
  const b = Buffer.alloc(n.length * 2)
  n.forEach((v, i) => b.writeUInt16LE(v, i * 2))
  return b
}

/** An 8-bit string when every char fits, else UTF-16LE; `short` = 1-byte length. */
function xlString(s: string, short: boolean): Buffer {
  const wide = [...s].some((c) => c.charCodeAt(0) > 0xff)
  const len = short ? Buffer.from([s.length]) : u16(s.length)
  return Buffer.concat([len, Buffer.from([wide ? 1 : 0]), Buffer.from(s, wide ? 'utf16le' : 'latin1')])
}

function bof(version: number, dt: number): Buffer {
  return rec(0x0809, Buffer.concat([u16(version, dt), Buffer.alloc(12)]))
}

export function testXlsStream(sheets: { name: string; cells: TestXlsCell[] }[], opts: TestXlsOptions = {}): Buffer {
  const version = opts.version ?? 0x0600
  const strings: string[] = []
  const sstIndex = (s: string) => {
    const i = strings.indexOf(s)
    return i === -1 ? strings.push(s) - 1 : i
  }
  const bodies = sheets.map(({ cells }) => {
    const parts = [bof(version, 0x0010)]
    for (const [row, col, v] of cells) {
      if (typeof v === 'string') {
        const b = Buffer.concat([u16(row, col, 15), Buffer.alloc(4)])
        b.writeUInt32LE(sstIndex(v), 6)
        parts.push(rec(0x00fd, b))
      } else if (typeof v === 'number') {
        const b = Buffer.concat([u16(row, col, 15), Buffer.alloc(8)])
        b.writeDoubleLE(v, 6)
        parts.push(rec(0x0203, b))
      } else parts.push(rec(0x0205, Buffer.concat([u16(row, col, 15), Buffer.from([v ? 1 : 0, 0])])))
    }
    parts.push(rec(0x000a, Buffer.alloc(0)))
    return Buffer.concat(parts)
  })
  const sst = Buffer.concat([Buffer.alloc(8), ...strings.map((s) => xlString(s, false))])
  sst.writeUInt32LE(strings.length, 0)
  sst.writeUInt32LE(strings.length, 4)
  const boundsheets = sheets.map(({ name }) => Buffer.concat([Buffer.alloc(4), Buffer.from([0, 0]), xlString(name, true)]))
  const globalsLen = (bodiesOffset: number[]) =>
    Buffer.concat([
      bof(version, 0x0005),
      ...(opts.encrypted ? [rec(0x002f, Buffer.alloc(6))] : []),
      ...boundsheets.map((b, i) => {
        b.writeUInt32LE(bodiesOffset[i] ?? 0, 0)
        return rec(0x0085, b)
      }),
      rec(0x00fc, sst),
      rec(0x000a, Buffer.alloc(0)),
    ])
  const globals = globalsLen([])
  const offsets: number[] = []
  let at = globals.length
  for (const b of bodies) {
    offsets.push(opts.sameOffset ? globals.length : at)
    at += b.length
  }
  return Buffer.concat([globalsLen(offsets), ...bodies])
}

const ENDOFCHAIN = 0xfffffffe
const FREESECT = 0xffffffff
const FATSECT = 0xfffffffd
const NOSTREAM = 0xffffffff
const SECTOR = 512

function dirEntry(name: string, type: number, start: number, size: number, child = NOSTREAM): Buffer {
  const e = Buffer.alloc(128)
  if (!name) return e
  e.write(name, 0, 'utf16le')
  e.writeUInt16LE((name.length + 1) * 2, 0x40)
  e[0x42] = type
  e[0x43] = 1
  e.writeUInt32LE(NOSTREAM, 0x44)
  e.writeUInt32LE(NOSTREAM, 0x48)
  e.writeUInt32LE(child, 0x4c)
  e.writeUInt32LE(start, 0x74)
  e.writeUInt32LE(size, 0x78)
  return e
}

const pad = (b: Buffer, to: number) => Buffer.concat([b, Buffer.alloc((to - (b.length % to)) % to)])

/** `stream` as the only stream of a compound file. */
export function testCfb(stream: Buffer, opts: TestXlsOptions = {}): Buffer {
  const name = opts.streamName ?? 'Workbook'
  // Regular streams must reach the 4096-byte cutoff; trailing zeros after the
  // last EOF are what real writers pad with too.
  const data = opts.mini ? stream : pad(Buffer.concat([stream, Buffer.alloc(Math.max(0, 4096 - stream.length))]), SECTOR)
  if (opts.mini && stream.length >= 4096) throw new Error('testCfb: a mini stream must be under 4096 bytes')
  const fat: number[] = []
  const chainOf = (first: number, n: number) => {
    for (let i = 0; i < n; i++) fat[first + i] = i === n - 1 ? ENDOFCHAIN : first + i + 1
  }
  const sectors: Buffer[] = []
  let root: Buffer
  let wbEntry: Buffer
  let firstMiniFat = ENDOFCHAIN
  let numMiniFat = 0
  if (opts.mini) {
    const container = pad(stream, SECTOR)
    const nMini = Math.ceil(stream.length / 64)
    const n = container.length / SECTOR
    chainOf(0, n)
    sectors.push(container)
    const miniFat = Buffer.alloc(SECTOR, 0xff)
    for (let i = 0; i < nMini; i++) miniFat.writeUInt32LE(i === nMini - 1 ? ENDOFCHAIN : i + 1, i * 4)
    firstMiniFat = n
    numMiniFat = 1
    chainOf(n, 1)
    sectors.push(miniFat)
    root = dirEntry('Root Entry', 5, 0, nMini * 64, 1)
    wbEntry = dirEntry(name, 2, 0, stream.length)
  } else {
    const n = data.length / SECTOR
    chainOf(0, n)
    if (opts.fatLoop) fat[n - 1] = 0
    sectors.push(data)
    root = dirEntry('Root Entry', 5, ENDOFCHAIN, 0, 1)
    wbEntry = dirEntry(name, 2, 0, data.length)
  }
  const dirSector = fat.length
  chainOf(dirSector, 1)
  sectors.push(Buffer.concat([root, wbEntry, dirEntry('', 0, 0, 0), dirEntry('', 0, 0, 0)]))
  const fatSector = fat.length
  fat[fatSector] = FATSECT
  if (fat.length > SECTOR / 4) throw new Error('testCfb: too big for one FAT sector')
  const fatBytes = Buffer.alloc(SECTOR, 0xff)
  fat.forEach((v, i) => fatBytes.writeUInt32LE(v >>> 0, i * 4))
  sectors.push(fatBytes)

  const header = Buffer.alloc(SECTOR)
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header, 0)
  header.writeUInt16LE(0x3e, 0x18)
  header.writeUInt16LE(3, 0x1a)
  header.writeUInt16LE(0xfffe, 0x1c)
  header.writeUInt16LE(9, 0x1e)
  header.writeUInt16LE(6, 0x20)
  header.writeUInt32LE(1, 0x2c)
  header.writeUInt32LE(dirSector, 0x30)
  header.writeUInt32LE(4096, 0x38)
  header.writeUInt32LE(firstMiniFat, 0x3c)
  header.writeUInt32LE(numMiniFat, 0x40)
  header.writeUInt32LE(ENDOFCHAIN, 0x44)
  header.writeUInt32LE(0, 0x48)
  for (let i = 0; i < 109; i++) header.writeUInt32LE(i === 0 ? fatSector : FREESECT, 0x4c + i * 4)
  return Buffer.concat([header, ...sectors])
}

export function testXls(sheets: { name: string; cells: TestXlsCell[] }[], opts: TestXlsOptions = {}): Buffer {
  return testCfb(testXlsStream(sheets, opts), opts)
}
