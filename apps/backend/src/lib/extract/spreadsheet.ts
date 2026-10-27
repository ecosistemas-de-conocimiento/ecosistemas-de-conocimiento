/**
 * Spreadsheets (xlsx, csv) as plain text for the ingest path.
 *
 * Shape: one `# Hoja: <name>` line per non-empty sheet (xlsx only), then one
 * line per non-empty row, cells joined with ` | `. A sheet wider than
 * `MAX_COLUMNS` keeps its first columns and says how many it dropped — a
 * 16,000-column row is noise to retrieval, not content.
 */

import {
  DEFAULT_MAX_CHARS,
  decodeText,
  LineSink,
  type ExtractOptions,
} from './text'

export const MAX_COLUMNS = 100
/** A single cell longer than this is cut; a pasted essay still reads, a blob does not flood. */
const MAX_CELL_CHARS = 2000

type Cell = string | number | boolean | Date | null | undefined | object

function cellText(value: Cell): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return ''
    const iso = value.toISOString()
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso
  }
  return String(value).replace(/\s+/g, ' ').trim().slice(0, MAX_CELL_CHARS)
}

/** One output line for a row, or `null` for a row with no text in it. */
function rowLine(row: readonly Cell[]): string | null {
  const cells = row.map(cellText)
  while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop()
  if (cells.length === 0) return null
  if (cells.length <= MAX_COLUMNS) return cells.join(' | ')
  const dropped = cells.length - MAX_COLUMNS
  return [...cells.slice(0, MAX_COLUMNS), `(+${dropped} columnas)`].join(' | ')
}

/** ⚠ Pass bytes, never a string: `read-excel-file/node` reads a string as a PATH. */
export async function extractXlsxText(bytes: Buffer, opts: ExtractOptions = {}): Promise<string> {
  const { default: readXlsxFile } = await import('read-excel-file/node')
  const sheets = await readXlsxFile(bytes)
  const sink = new LineSink(opts.maxChars ?? DEFAULT_MAX_CHARS)
  for (const { sheet, data } of sheets) {
    const lines = data.map((row) => rowLine(row as Cell[])).filter((l): l is string => l !== null)
    if (lines.length === 0) continue
    if (sink.lines.length > 0) sink.push('')
    sink.push(`# Hoja: ${cellText(sheet)}`)
    for (const line of lines) sink.push(line)
  }
  return sink.text()
}

/** The delimiter used most on the first line: `,`, `;` (Excel in Spanish) or tab. */
function sniffDelimiter(text: string): string {
  const first = text.slice(0, text.indexOf('\n') === -1 ? undefined : text.indexOf('\n'))
  let best = ','
  let bestCount = 0
  for (const d of [',', ';', '\t']) {
    const count = first.split(d).length - 1
    if (count > bestCount) {
      best = d
      bestCount = count
    }
  }
  return best
}

/** RFC 4180 rows: quoted fields may hold the delimiter, `""` and newlines. */
function* csvRows(text: string, delim: string): Generator<string[]> {
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
    } else if (ch === '"' && field === '') quoted = true
    else if (ch === delim) {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      yield row
      row = []
      field = ''
    } else field += ch
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    yield row
  }
}

export function extractCsvText(bytes: Uint8Array, opts: ExtractOptions = {}): string {
  const text = decodeText(bytes)
  const sink = new LineSink(opts.maxChars ?? DEFAULT_MAX_CHARS)
  for (const row of csvRows(text, sniffDelimiter(text))) {
    const line = rowLine(row)
    if (line !== null) sink.push(line)
  }
  return sink.text()
}
