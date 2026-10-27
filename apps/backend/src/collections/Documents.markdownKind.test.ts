/**
 * Markdown documents (an Obsidian vault) take the extract → ingest path: the
 * text comes from the uploaded `.md` file, or from `bodyMarkdown` when there is
 * no file. An in-app note (`ingestStatus: n/a`) still has no pipeline at all.
 * Same stateful fake as `Documents.tabularKinds.test.ts`.
 */

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
    args.collection === 'media' ? { filename: 'f.md', mimeType: 'text/markdown' } : { ...row },
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
  id: 302,
  kind: 'markdown',
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
  name: 'nota.md',
  ...over,
})

const settle = () => fakePayload.update({ data: { name: 'renombrado' } })
const quiet = () => new Promise((r) => setTimeout(r, 300))

beforeEach(() => {
  enqueue.mockClear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('markdown documents', () => {
  it('an uploaded .md is converted to text and sent to ingest', async () => {
    fileBytes = Buffer.from('---\ntags: [autor]\n---\n# Freire\nVer [[Pedagogía del oprimido|su libro]].')
    row = base()
    await settle()
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalled(), { timeout: 5000, interval: 10 })
    expect(row.extractedText).toBe('# Freire\nVer su libro.')
    expect(row.ingestStatus).not.toBe('failed')
  }, 20_000)

  it('with no file, the text comes from bodyMarkdown', async () => {
    row = base({ mediaFile: null, bodyMarkdown: '## Caso 3\n![[mapa.png]]Ver [[Caso 2]]' })
    await settle()
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalled(), { timeout: 5000, interval: 10 })
    expect(row.extractedText).toBe('## Caso 3\nVer Caso 2')
  }, 20_000)

  it('🔴 an in-app note (ingestStatus n/a) is never extracted or ingested', async () => {
    row = base({ mediaFile: null, ingestStatus: 'n/a', bodyMarkdown: '# Nota' })
    await settle()
    await quiet()
    expect(enqueue).not.toHaveBeenCalled()
    expect(row.ingestStatus).toBe('n/a')
    expect(row.extractedText).toBeNull()
  })

  it('a body past the text cap fails with text_too_long, not a stuck row', async () => {
    row = base({ mediaFile: null, bodyMarkdown: 'x'.repeat(2_000_001) })
    await settle()
    await vi.waitFor(() => expect(row.ingestStatus).toBe('failed'), { timeout: 5000, interval: 10 })
    expect(String(row.ingestError)).toMatch(/^extraction_failed: text_too_long/)
    expect(enqueue).not.toHaveBeenCalled()
  }, 20_000)

  it('a markdown row with neither file nor body does not reach ingest', async () => {
    row = base({ mediaFile: null, bodyMarkdown: '  ' })
    await settle()
    await quiet()
    expect(enqueue).not.toHaveBeenCalled()
  })
})

describe('planIngestRetry', () => {
  it('retries a failed markdown document but never an in-app note', async () => {
    const { planIngestRetry } = await import('./Documents')
    expect(planIngestRetry({ kind: 'markdown', ingestStatus: 'failed' } as never)).not.toBeNull()
    expect(planIngestRetry({ kind: 'markdown', ingestStatus: 'n/a' } as never)).toBeNull()
  })
})
