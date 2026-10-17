/**
 * 🔴 THE BACKFILL READS THE SAME TEXT AND TITLE THE LIVE INGEST PATH DOES.
 *
 * It used to hand `extractedText` and `documents.name` straight to the
 * extractor. For a `testimonio` that is the raw, un-scrubbed transcript and the
 * uploader's free-text file name. These tests pin the backfill to
 * `corpusTextFor` and `titleFor`, the two functions
 * `scheduleGraphExtractionForDoc` (collections/Documents.ts) uses.
 *
 * `runGraphExtraction` is mocked so the test sees exactly what would reach the
 * model, and no test here can call one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { NO_DRIZZLE } from '@/lib/documentColumns.testFake'
vi.mock('@/lib/documentColumns', () => import('@/lib/documentColumns.testFake'))

const runGraphExtraction = vi.fn(async (_args: Record<string, unknown>) => 'ready' as const)

vi.mock('./schedule', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./schedule')>()),
  runGraphExtraction: (args: Record<string, unknown>) => runGraphExtraction(args),
}))

const { runGraphBackfill } = await import('./backfill')
type Payload = Parameters<typeof runGraphBackfill>[0]

const silent = () => undefined
const RAW = 'María López vive en San Juan Chamula. '.repeat(10)
const REDACTED = '[PERSONA] vive en [LUGAR]. '.repeat(10)

function fakePayload(documents: Record<string, unknown>[]) {
  const deletes: { collection: string; where: unknown }[] = []
  const documentUpdates: { id: unknown; data: Record<string, unknown> }[] = []
  const payload: Payload = {
    async find(args) {
      return { docs: args.collection === 'documents' ? documents : [] }
    },
    async create() {
      return { id: 1 }
    },
    async update(args) {
      if (args.collection === 'documents') {
        documentUpdates.push({ id: args.id, data: args.data as Record<string, unknown> })
      }
      return {}
    },
    async delete(args) {
      deletes.push({ collection: String(args.collection), where: args.where })
      return {}
    },
    db: { drizzle: NO_DRIZZLE },
  }
  return { payload, deletes, documentUpdates }
}

beforeEach(() => runGraphExtraction.mockClear())

describe('runGraphBackfill — privacy', () => {
  it('🔴 extracts a testimonio from its redacted text, under a neutral title', async () => {
    const { payload } = fakePayload([
      {
        id: 1,
        organization: 5,
        contentKind: 'testimonio',
        name: 'Testimonio de María López.mp3',
        extractedText: RAW,
        redactedText: REDACTED,
        anonymisationStatus: 'ready',
      },
    ])
    await runGraphBackfill(payload, { log: silent, skipOrphanSweep: true })

    expect(runGraphExtraction).toHaveBeenCalledTimes(1)
    const args = runGraphExtraction.mock.calls[0]![0]
    expect(args.text).toBe(REDACTED.trim())
    expect(args.title).toBe('Testimonio')
    expect(JSON.stringify({ text: args.text, title: args.title })).not.toContain('María')
  })

  it.each([
    ['held, no redaction', { anonymisationStatus: 'held', redactedText: null }],
    ['pending, no redaction', { anonymisationStatus: 'pending' }],
    ['a stale redaction on a held row', { anonymisationStatus: 'held', redactedText: REDACTED }],
    ['rejected', { anonymisationStatus: 'rejected', redactedText: REDACTED }],
  ])('🔴 never extracts a testimonio that is %s, and clears its old rows', async (_label, extra) => {
    const { payload, deletes, documentUpdates } = fakePayload([
      { id: 7, organization: 5, contentKind: 'testimonio', extractedText: RAW, ...extra },
    ])
    const result = await runGraphBackfill(payload, { log: silent, skipOrphanSweep: true })

    expect(runGraphExtraction).not.toHaveBeenCalled()
    expect(result).toMatchObject({ candidates: 1, extracted: 0, skipped: 1 })
    // Rows a pre-fix run built from the raw transcript must not survive.
    const where = { and: [{ organization: { equals: 5 } }, { document: { equals: 7 } }] }
    expect(deletes).toContainEqual({ collection: 'graphMentions', where })
    expect(deletes).toContainEqual({ collection: 'graphRelations', where })
    expect(documentUpdates.at(-1)?.data).toMatchObject({ graphStatus: 'skipped' })
    expect(String(documentUpdates.at(-1)?.data.graphError)).toMatch(/^not_graphable:/)
  })

  it('a dry run reports an unscrubbed testimonio and deletes nothing', async () => {
    const { payload, deletes, documentUpdates } = fakePayload([
      { id: 7, organization: 5, contentKind: 'testimonio', extractedText: RAW, anonymisationStatus: 'held' },
    ])
    const result = await runGraphBackfill(payload, { log: silent, dryRun: true })
    expect(runGraphExtraction).not.toHaveBeenCalled()
    expect(result.skipped).toBe(1)
    expect(deletes).toHaveLength(0)
    expect(documentUpdates).toHaveLength(0)
  })

  it('a documento still extracts from its own text under its own name', async () => {
    const { payload } = fakePayload([
      { id: 2, organization: 5, contentKind: 'documento', name: 'Acta 2024', extractedText: RAW },
    ])
    await runGraphBackfill(payload, { log: silent, skipOrphanSweep: true })
    const args = runGraphExtraction.mock.calls[0]![0]
    expect(args.text).toBe(RAW.trim())
    expect(args.title).toBe('Acta 2024')
  })

  it('⚠ an unknown content kind is gated, and its name never becomes the title', async () => {
    const { payload } = fakePayload([
      {
        id: 3,
        organization: 5,
        contentKind: null,
        name: 'María López.pdf',
        extractedText: RAW,
        redactedText: REDACTED,
        anonymisationStatus: 'approved',
      },
    ])
    await runGraphBackfill(payload, { log: silent, skipOrphanSweep: true })
    const args = runGraphExtraction.mock.calls[0]![0]
    expect(args.text).toBe(REDACTED.trim())
    expect(String(args.title)).not.toContain('María')
  })
})
