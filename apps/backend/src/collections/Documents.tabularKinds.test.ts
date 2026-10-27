/**
 * xlsx, csv and html uploads take the same extract → ingest path as pdf/docx.
 * Same stateful fake as `Documents.extractFailure.test.ts`, with the text write
 * allowed through.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/documentColumns', () => import('@/lib/documentColumns.testFake'))

let fileBytes: Buffer = Buffer.from('')
vi.mock('@/lib/storage/client', () => ({
  isStorageConfigured: () => true,
  getObjectBytes: async () => ({ bytes: fileBytes }),
}))

type Row = Record<string, unknown>
let row: Row

type Clause = Record<string, Record<string, unknown>>
const matchesClause = (clause: Clause): boolean =>
  Object.entries(clause).every(([field, op]) => {
    if (field === 'id') return true
    const value = row[field]
    if ('equals' in op) return String(value ?? '') === String(op.equals)
    if ('in' in op) return (op.in as unknown[]).map(String).includes(String(value ?? ''))
    if ('exists' in op) return (value !== null && value !== undefined) === op.exists
    throw new Error(`fake: unsupported operator ${JSON.stringify(op)} on ${field}`)
  })

const fakePayload = {
  findByID: async (args: { collection: string }) =>
    args.collection === 'media' ? { filename: 'f.bin', mimeType: 'text/plain' } : { ...row },
  create: async () => ({}),
  find: async () => ({ docs: [] }),
  delete: async () => ({}),
  update: async (args: { data: Row; context?: Row; where?: { and?: Clause[] } }) => {
    if (args.where && !(args.where.and ?? []).every(matchesClause)) return { docs: [] }
    const previousDoc = { ...row }
    row = { ...row, ...args.data }
    if (!args.context?.__skipDocsExtract) {
      const { Documents } = await import('./Documents')
      for (const hook of Documents.hooks?.afterChange ?? []) {
        await hook({
          doc: { ...row },
          previousDoc,
          operation: 'update',
          req: { context: args.context ?? {}, payload: fakePayload },
        } as never)
      }
    }
    return args.where ? { docs: [{ ...row }] } : { ...row }
  },
}

vi.mock('payload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('payload')>()),
  getPayload: async () => fakePayload,
}))
vi.mock('@payload-config', () => ({ default: {} }))
vi.mock('@/lib/graph/schedule', () => ({ scheduleGraphExtraction: vi.fn() }))

const enqueue = vi.fn(async () => ({ ingestId: 'ing_1' }))
vi.mock('@/lib/aiClient', () => ({
  getAppAIClient: () => ({ ingest: { enqueue } }),
}))

const base = (over: Row = {}): Row => ({
  id: 301,
  contentKind: 'documento',
  organization: 10,
  uploadedBy: 3,
  publicationStatus: 'draft',
  anonymisationStatus: 'n/a',
  anonymise: false,
  ingestStatus: 'pending',
  extractedText: null,
  ingestId: null,
  mediaFile: 7,
  ...over,
})

const fixture = (name: string) =>
  readFileSync(path.join(__dirname, '..', 'lib', 'extract', '__fixtures__', name))

beforeEach(() => {
  enqueue.mockClear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('spreadsheet and web-page documents', () => {
  it.each([
    ['xlsx', fixture('dos-hojas.xlsx'), '# Hoja: Participantes\nNombre | Municipio | Edad'],
    ['csv', Buffer.from('a;b\n1;2\n'), 'a | b\n1 | 2'],
    ['html', Buffer.from('<script>x()</script><h2>Acta</h2><p>Texto</p>'), '## Acta\nTexto'],
  ])('a %s is extracted to text and sent to ingest', async (kind, bytes, expected) => {
    fileBytes = bytes
    row = base({ kind, name: `f.${kind}` })
    await fakePayload.update({ data: { name: `g.${kind}` } })
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalled(), { timeout: 5000, interval: 10 })
    expect(String(row.extractedText)).toContain(expected)
    expect(row.ingestStatus).not.toBe('failed')
  }, 20_000)

  it('a sheet past the text cap fails with text_too_long, not a stuck row', async () => {
    fileBytes = Buffer.from('a,b\n'.repeat(600_000))
    row = base({ kind: 'csv', name: 'big.csv' })
    await fakePayload.update({ data: { name: 'big2.csv' } })
    await vi.waitFor(() => expect(row.ingestStatus).toBe('failed'), { timeout: 5000, interval: 10 })
    expect(String(row.ingestError)).toMatch(/^extraction_failed: text_too_long/)
    expect(enqueue).not.toHaveBeenCalled()
  }, 20_000)
})
