/**
 * TEST HELPER: a minimal zip writer, so guard tests build their hostile
 * archives in code instead of shipping them. `declaredSize` lets a test write a
 * central directory that lies about an entry.
 */

import { crc32, deflateRawSync } from 'node:zlib'

export type TestZipEntry = { name: string; data: Buffer | string; store?: boolean; declaredSize?: number }

export function testZip(entries: TestZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const raw = typeof e.data === 'string' ? Buffer.from(e.data, 'utf8') : e.data
    const body = e.store ? raw : deflateRawSync(raw, { level: 9 })
    const name = Buffer.from(e.name, 'utf8')
    const size = e.declaredSize ?? raw.length
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(e.store ? 0 : 8, 8)
    local.writeUInt32LE(crc32(raw), 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(e.store ? 0 : 8, 10)
    central.writeUInt32LE(crc32(raw), 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, body)
    centrals.push(central, name)
    offset += 30 + name.length + body.length
  }
  const dir = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(dir.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, eocd])
}

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

/** A one-cell-per-sheet xlsx; each sheet's cell sits at `ref`. Paths are relative to `xl/`. */
export function testXlsx(sheets: Array<{ path: string; ref: string }>, extra: TestZipEntry[] = []): Buffer {
  const cells = (ref: string) =>
    `<?xml version="1.0"?><worksheet ${NS}><sheetData><row r="${ref.replace(/^[A-Z]+/, '')}">` +
    `<c r="${ref}" t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>`
  const list = sheets.map((_, i) => `<sheet name="H${i + 1}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
  const rels = sheets
    .map((s, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="${s.path}"/>`)
    .join('')
  return testZip([
    {
      name: '[Content_Types].xml',
      data:
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/></Types>',
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0"?><workbook ${NS} xmlns:r="${REL}"><sheets>${list}</sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
    },
    ...sheets.map((s) => ({ name: s.path.startsWith('/') ? s.path.slice(1) : `xl/${s.path}`, data: cells(s.ref) })),
    ...extra,
  ])
}
