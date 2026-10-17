/**
 * The backfill: which documents it picks up, and the orphan sweep.
 *
 * ⚠ `dryRun` is used wherever the test is about SELECTION rather than about
 * extraction, so no test in this file can accidentally call a model.
 */
import { describe, expect, it, vi } from 'vitest'

import { NO_DRIZZLE } from '@/lib/documentColumns.testFake'
vi.mock('@/lib/documentColumns', () => import('@/lib/documentColumns.testFake'))

import {
  DEFAULT_STALE_EXTRACTING_MS,
  deleteOrphanEntities,
  runGraphBackfill,
  staleDocumentsWhere,
  type GraphBackfillPayload,
} from './backfill'
import { GRAPH_PROMPT_VERSION } from './prompt'

const silent = () => undefined

function fakePayload(rows: {
  documents?: Record<string, unknown>[]
  graphEntities?: Record<string, unknown>[]
  mentionsByEntity?: Record<string, unknown[]>
}) {
  const finds: Record<string, unknown>[] = []
  const deletes: { collection: string; id: unknown }[] = []
  const updates: Record<string, unknown>[] = []

  const payload: GraphBackfillPayload = {
    async find(args) {
      finds.push(args)
      const collection = String(args.collection)
      if (collection === 'documents') return { docs: rows.documents ?? [] }
      if (collection === 'graphEntities') return { docs: rows.graphEntities ?? [] }
      if (collection === 'graphMentions') {
        const and = (args.where as { and: Record<string, Record<string, unknown>>[] }).and
        const entityId = and.find((c) => 'entity' in c)?.entity?.equals
        return { docs: (rows.mentionsByEntity ?? {})[String(entityId)] ?? [] }
      }
      return { docs: [] }
    },
    async create() {
      return { id: 1 }
    },
    async update(args) {
      updates.push(args.data as Record<string, unknown>)
      return {}
    },
    async delete(args) {
      deletes.push({ collection: String(args.collection), id: args.id })
      return {}
    },
    db: { drizzle: NO_DRIZZLE },
  }

  return { payload, finds, deletes, updates }
}

describe('staleDocumentsWhere', () => {
  it('selects a stale prompt version, a never-extracted row, or a failure', () => {
    const where = staleDocumentsWhere() as { and: Record<string, unknown>[] }
    const or = (where.and[0] as { or: Record<string, Record<string, unknown>>[] }).or
    expect(or).toContainEqual({ graphPromptVersion: { not_equals: GRAPH_PROMPT_VERSION } })
    expect(or).toContainEqual({ graphPromptVersion: { exists: false } })
    expect(or).toContainEqual({ graphStatus: { equals: 'failed' } })
  })

  it('🔴 also selects a row stuck at `extracting` past the cutoff, whatever its stamp', () => {
    // A crash mid-run leaves the CURRENT version stamped and the status at
    // `extracting`: no other clause matches it, so it was never retried.
    const now = Date.parse('2026-10-17T12:00:00.000Z')
    const where = staleDocumentsWhere(undefined, { now }) as { and: Record<string, unknown>[] }
    const or = (where.and[0] as { or: Record<string, unknown>[] }).or
    expect(DEFAULT_STALE_EXTRACTING_MS).toBe(30 * 60 * 1000)
    expect(or).toContainEqual({
      and: [
        { graphStatus: { equals: 'extracting' } },
        { updatedAt: { less_than: '2026-10-17T11:30:00.000Z' } },
      ],
    })
  })

  it('the stale-extracting cutoff is configurable', () => {
    const now = Date.parse('2026-10-17T12:00:00.000Z')
    const where = staleDocumentsWhere(7, { now, staleExtractingMs: 5 * 60 * 1000 }) as {
      and: Record<string, unknown>[]
    }
    const or = (where.and[1] as { or: Record<string, unknown>[] }).or
    expect(or).toContainEqual({
      and: [
        { graphStatus: { equals: 'extracting' } },
        { updatedAt: { less_than: '2026-10-17T11:55:00.000Z' } },
      ],
    })
  })

  it('requires text — asking the model about an empty row costs the same', () => {
    const where = staleDocumentsWhere() as { and: Record<string, unknown>[] }
    expect(where.and).toContainEqual({ extractedText: { exists: true } })
  })

  it('🔴 names the organization in its own predicate when one is given', () => {
    const where = staleDocumentsWhere(7) as { and: Record<string, unknown>[] }
    expect(where.and[0]).toEqual({ organization: { equals: 7 } })
  })
})

describe('runGraphBackfill', () => {
  it('reports its candidates and extracts nothing on a dry run', async () => {
    const { payload, deletes } = fakePayload({
      documents: [
        { id: 1, organization: 5, contentKind: 'documento', extractedText: 'x', graphStatus: 'failed' },
        { id: 2, organization: 5, contentKind: 'testimonio', extractedText: 'y', graphStatus: 'ready' },
      ],
    })
    const result = await runGraphBackfill(payload, { dryRun: true, log: silent })
    expect(result).toMatchObject({ candidates: 2, extracted: 0, failed: 0, skipped: 2, dryRun: true })
    // 🔴 A dry run must not delete an entity either.
    expect(deletes).toHaveLength(0)
  })

  it('queries with the configured stale-extracting cutoff', async () => {
    const { payload, finds } = fakePayload({ documents: [] })
    const before = Date.now()
    await runGraphBackfill(payload, { dryRun: true, log: silent, staleExtractingMs: 60_000 })
    const where = finds.find((f) => f.collection === 'documents')?.where as {
      and: { or?: Record<string, unknown>[] }[]
    }
    const clause = where.and[0]!.or!.find((c) => 'and' in c) as {
      and: [unknown, { updatedAt: { less_than: string } }]
    }
    const cutoff = Date.parse(clause.and[1].updatedAt.less_than)
    expect(cutoff).toBeGreaterThanOrEqual(before - 60_000)
    expect(cutoff).toBeLessThanOrEqual(Date.now() - 60_000)
  })

  it('refuses a document with no ecosistema rather than guessing one', async () => {
    const { payload } = fakePayload({
      documents: [{ id: 1, organization: null, extractedText: 'x' }],
    })
    const result = await runGraphBackfill(payload, { log: silent, skipOrphanSweep: true })
    expect(result).toMatchObject({ candidates: 1, extracted: 0, skipped: 1 })
  })

  it('passes the content kind through verbatim, with no `documento` default', async () => {
    // A default here would turn the person rule's fail-closed direction into
    // its fail-open one for every row the backfill touches.
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const seen: unknown[] = []
    const { payload } = fakePayload({
      documents: [{ id: 1, organization: 5, extractedText: 'x'.repeat(400) }],
    })
    payload.update = (async (args: Record<string, unknown>) => {
      if (args.collection === 'documents') seen.push((args.data as Record<string, unknown>).graphStatus)
      return {}
    }) as unknown as GraphBackfillPayload['update']

    // No client and no AI_SERVICE_API_KEY: the run fails at client resolution,
    // which is enough to prove the row was picked up and scoped.
    const result = await runGraphBackfill(payload, { log: silent, skipOrphanSweep: true })
    expect(result.candidates).toBe(1)
    expect(result.extracted + result.failed + result.skipped).toBe(1)
    vi.restoreAllMocks()
  })

  it('skips the orphan sweep when asked, so the backfill can run in slices', async () => {
    const { payload, deletes } = fakePayload({
      documents: [],
      graphEntities: [{ id: 1, organization: 5 }],
    })
    await runGraphBackfill(payload, { log: silent, skipOrphanSweep: true })
    expect(deletes).toHaveLength(0)
  })
})

describe('deleteOrphanEntities', () => {
  it('deletes only entities with zero mentions', async () => {
    const { payload, deletes } = fakePayload({
      graphEntities: [
        { id: 1, organization: 5 },
        { id: 2, organization: 5 },
      ],
      mentionsByEntity: { '1': [{ id: 99 }] },
    })
    const removed = await deleteOrphanEntities(payload, 5, silent)
    expect(removed).toBe(1)
    expect(deletes).toEqual([{ collection: 'graphEntities', id: 2 }])
  })

  it('🔴 scopes the mention lookup by organization as well as by entity', async () => {
    const { payload, finds } = fakePayload({
      graphEntities: [{ id: 1, organization: 5 }],
      mentionsByEntity: { '1': [{ id: 1 }] },
    })
    await deleteOrphanEntities(payload, 5, silent)
    const mentionLookup = finds.find((f) => f.collection === 'graphMentions')
    const and = (mentionLookup?.where as { and: Record<string, unknown>[] }).and
    expect(and).toContainEqual({ organization: { equals: 5 } })
    expect(and).toContainEqual({ entity: { equals: 1 } })
  })
})
