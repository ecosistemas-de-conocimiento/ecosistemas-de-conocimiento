/**
 * 🔴 AN UNEXPECTED THROW IN THE BACKGROUND EXTRACT+INGEST MUST LEAVE THE ROW
 * `failed`, NOT `extracting` FOREVER.
 *
 * Measured on dev 2026-10-26: a PDF whose text was over Payload's 40,000-char
 * default failed the `extractedText` save with a 400 ValidationError. Nothing in
 * `runExtractAndIngest` caught it; the hook's `.catch` only logged, so the row
 * sat at `extracting` and publish answered 409 for good.
 *
 * Same stateful fake as `Documents.audioRename.test.ts`, plus a fake PDF
 * extractor, so the throw comes from exactly the write that threw on dev.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ValidationError } from 'payload'

vi.mock('@/lib/documentColumns', () => import('@/lib/documentColumns.testFake'))

/** A marker that must never reach `ingestError`: it stands for the document text. */
const SECRET = 'TEXTO-DEL-DOCUMENTO-QUE-NO-DEBE-FILTRARSE'
const LONG_TEXT = `${SECRET} `.repeat(20)

vi.mock('@/lib/storage/client', () => ({
  isStorageConfigured: () => true,
  getObjectBytes: async () => ({ bytes: Buffer.from('%PDF-1.4 fake') }),
}))
vi.mock('unpdf', () => ({
  getDocumentProxy: async () => ({}),
  extractText: async () => ({ text: LONG_TEXT }),
}))

type Row = Record<string, unknown>
let row: Row
/** What the fake `update` throws when a write carries `extractedText`. */
let throwOnTextWrite: () => Error

type Clause = Record<string, Record<string, unknown>>
const matchesClause = (clause: Clause): boolean =>
  Object.entries(clause).every(([field, op]) => {
    if (field === 'id') return true
    const value = row[field]
    if ('equals' in op) return String(value ?? '') === String(op.equals)
    if ('in' in op) return (op.in as unknown[]).map(String).includes(String(value ?? ''))
    throw new Error(`fake: unsupported operator ${JSON.stringify(op)} on ${field}`)
  })

const fakePayload = {
  findByID: async (args: { collection: string }) =>
    args.collection === 'media' ? { filename: 'informe.pdf', mimeType: 'application/pdf' } : { ...row },
  create: async () => ({}),
  find: async () => ({ docs: [] }),
  delete: async () => ({}),
  update: async (args: { data: Row; context?: Row; where?: { and?: Clause[] } }) => {
    if ('extractedText' in args.data) throw throwOnTextWrite()
    // A guarded write (`documentColumns.testFake` passes `where`) applies only
    // if the row matches, like the real conditional UPDATE.
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
  id: 276,
  kind: 'pdf',
  contentKind: 'documento',
  name: 'Informe.pdf',
  organization: 10,
  uploadedBy: 3,
  publicationStatus: 'draft',
  anonymisationStatus: 'n/a',
  ingestStatus: 'pending',
  extractedText: null,
  ingestId: null,
  mediaFile: 7,
  ...over,
})

beforeEach(() => {
  enqueue.mockClear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the extracted text cannot be saved', () => {
  it('🔴 a ValidationError on the text write leaves the row `failed` with a short reason', async () => {
    throwOnTextWrite = () =>
      new ValidationError({
        collection: 'documents',
        errors: [{ message: 'This value must be shorter than the max length', path: 'extractedText' }],
      })
    row = base()
    await fakePayload.update({ data: { name: 'Informe final.pdf' } })
    await vi.waitFor(() => expect(row.ingestStatus).toBe('failed'), { timeout: 5000, interval: 10 })
    expect(String(row.ingestError)).toMatch(/^extract_ingest_failed: /)
    expect(String(row.ingestError)).toContain('extractedText')
    expect(String(row.ingestError).length).toBeLessThanOrEqual(500)
    expect(enqueue).not.toHaveBeenCalled()
    // The first case pays the cold import of `Documents`.
  }, 20_000)

  it('🔴 an error whose message quotes the text never copies it into `ingestError`', async () => {
    // A drizzle query error quotes its parameters — the document text itself.
    throwOnTextWrite = () => new Error(`Failed query: update "documents" params: ${LONG_TEXT}`)
    row = base()
    await fakePayload.update({ data: { name: 'Informe final.pdf' } })
    await vi.waitFor(() => expect(row.ingestStatus).toBe('failed'), { timeout: 5000, interval: 10 })
    expect(String(row.ingestError)).toMatch(/^extract_ingest_failed: /)
    expect(String(row.ingestError)).not.toContain(SECRET)
  }, 20_000)
})
