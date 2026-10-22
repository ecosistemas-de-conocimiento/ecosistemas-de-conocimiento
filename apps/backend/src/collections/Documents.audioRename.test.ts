/**
 * 🔴 A SAVE ON AN AUDIO ROW MID-DRIVE MUST NOT DRIVE IT A SECOND TIME.
 *
 * A `transcribed` row has its text and no `ingestId`, so the ordinary
 * `afterChange` → `runExtractAndIngest` path (a rename, say) used to fall
 * through to `enqueueIngestForDoc`, outside the claim in
 * `lib/ingestRecovery.ts:driveTranscribedDocument`. Same stateful fake as
 * `Documents.callbackRace.test.ts`: `update` merges into one row and re-fires
 * the real hooks unless the write carries `__skipDocsExtract`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/documentColumns', () => import('@/lib/documentColumns.testFake'))

type Row = Record<string, unknown>
let row: Row

type Clause = Record<string, Record<string, unknown>>
const matchesClause = (clause: Clause): boolean =>
  Object.entries(clause).every(([field, op]) => {
    if (field === 'id') return true
    const value = row[field]
    if ('equals' in op) return String(value ?? '') === String(op.equals)
    if ('exists' in op) return (value != null) === Boolean(op.exists)
    if ('in' in op) return (op.in as unknown[]).map(String).includes(String(value ?? ''))
    if ('not_in' in op) return value == null || !(op.not_in as unknown[]).map(String).includes(String(value))
    throw new Error(`fake: unsupported operator ${JSON.stringify(op)} on ${field}`)
  })

const fakePayload = {
  findByID: async () => ({ ...row }),
  create: async () => ({}),
  find: async () => ({ docs: [] }),
  delete: async () => ({}),
  update: async (args: { data: Row; context?: Row; where?: { and?: Clause[] } }) => {
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

const base = (over: Row): Row => ({
  id: 42,
  kind: 'audio',
  contentKind: 'documento',
  name: 'Junta.m4a',
  organization: 10,
  uploadedBy: 3,
  publicationStatus: 'draft',
  anonymisationStatus: 'n/a',
  extractedText: 'La junta empezó a las diez',
  ingestId: null,
  mediaFile: 7,
  transcribeId: 'tr_1',
  ...over,
})

/** The hook defers its run with `setImmediate` and returns no promise. */
const letHookRun = () => new Promise((r) => setTimeout(r, 150))

beforeEach(() => {
  enqueue.mockClear()
  vi.stubEnv('PUBLIC_BACKEND_URL', 'https://backend.test')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('renaming an audio row the drive owns', () => {
  it.each(['transcribed', 'extracting'])('at `%s`: no enqueue, status untouched', async (status) => {
    row = base({ ingestStatus: status })
    await fakePayload.update({ data: { name: 'Junta de agosto.m4a' } })
    await letHookRun()
    expect(enqueue).not.toHaveBeenCalled()
    expect(row.ingestStatus).toBe(status)
    // The first case pays the cold import of `Documents`: 6 s measured on a
    // host at load average 24.
  }, 20_000)

  it('🔴 the retry path: an audio row with its transcript at `pending` still reaches the enqueue', async () => {
    // `POST /:id/retry` resets the row to `pending` and keeps the text; the
    // guard above must not swallow that.
    row = base({ ingestStatus: 'pending' })
    await fakePayload.update({ data: {} })
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1), { timeout: 5000, interval: 10 })
    await vi.waitFor(() => expect(row.ingestId).toBe('ing_1'), { timeout: 5000, interval: 10 })
    expect(row.ingestStatus).toBe('embedding')
  }, 20_000)

  it('control: the same save on a pdf with text does reach the enqueue', async () => {
    row = base({ kind: 'pdf', name: 'Acta.pdf', ingestStatus: 'failed' })
    await fakePayload.update({ data: { name: 'Acta final.pdf' } })
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1), { timeout: 5000, interval: 10 })
  })
})
