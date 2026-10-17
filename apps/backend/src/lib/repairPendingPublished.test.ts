/**
 * The one-off repair for rows that read `published` + `ingestStatus: 'pending'`.
 *
 * Before `confirmPublish` wrote `ingestStatus: 'ready'`, every publish left the
 * row at whatever ingest state it had — and a row that was never draft-ingested
 * (seeded, or its extract lost) stayed `pending` forever. The repair may only
 * write `ready` where ai-service PROVES the document is live in the shared
 * corpus: `published` on the backend row is not proof, because the seed writes
 * `published` without ingesting anything.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Payload } from 'payload'

import {
  CANDIDATE_WHERE,
  liveCheckViaRetrieve,
  repairPendingPublished,
  type LiveCheck,
} from './repairPendingPublished'

type Row = Record<string, unknown>

function fakeDb(rows: Row[]) {
  const store = rows.map((r) => ({ ...r }))
  const find = vi.fn(async () => ({
    docs: store.filter(
      (r) => r.publicationStatus === 'published' && r.ingestStatus === 'pending' && r.ingestId == null,
    ),
  }))
  const update = vi.fn(async (args: { where: unknown; data: Row }) => {
    // Honour the guard the same way: the row must still match.
    const id = ((args.where as { and: Array<Record<string, { equals?: unknown }>> }).and[0]!.id!
      .equals) as number
    const hits = store.filter(
      (r) => r.id === id && r.publicationStatus === 'published' && r.ingestStatus === 'pending' && r.ingestId == null,
    )
    for (const r of hits) Object.assign(r, args.data)
    return { docs: hits }
  })
  return {
    store,
    find,
    update,
    payload: { find, update } as unknown as Pick<Payload, 'find' | 'update'>,
    row: (id: number) => store.find((r) => r.id === id)!,
  }
}

const published = (id: number, over: Row = {}): Row => ({
  id,
  name: `Doc ${id}`,
  organization: 7,
  publicationStatus: 'published',
  ingestStatus: 'pending',
  ...over,
})

describe('repairPendingPublished', () => {
  it('🔴 is a DRY RUN by default — it checks and reports, and writes nothing', async () => {
    const db = fakeDb([published(1)])
    const isLive: LiveCheck = vi.fn(async () => 'live' as const)

    const report = await repairPendingPublished(db.payload, isLive, { delayMs: 0 })

    expect(report).toMatchObject({ apply: false, candidates: 1, live: 1, repaired: 0 })
    expect(db.update).not.toHaveBeenCalled()
    expect(db.row(1).ingestStatus).toBe('pending')
  })

  it('🔴 with apply, writes `ready` ONLY on rows ai-service confirms are live', async () => {
    const db = fakeDb([published(1), published(2), published(3)])
    const isLive: LiveCheck = async (doc) => {
      if (doc.id === 1) return 'live'
      if (doc.id === 2) return 'absent'
      throw new Error('ai-service 503')
    }

    const report = await repairPendingPublished(db.payload, isLive, { apply: true, delayMs: 0 })

    expect(report).toMatchObject({ candidates: 3, live: 1, absent: 1, errors: 1, repaired: 1 })
    expect(db.row(1)).toMatchObject({ ingestStatus: 'ready', ingestError: null })
    // Not live, or unknown: left exactly as it was. An error is never "absent".
    expect(db.row(2).ingestStatus).toBe('pending')
    expect(db.row(3).ingestStatus).toBe('pending')
    expect(report.absentIds).toEqual(['2'])
    expect(report.errorIds).toEqual(['3'])
  })

  it('writes two fields, guarded on the row still being a candidate, without re-firing the hook', async () => {
    const db = fakeDb([published(1)])
    await repairPendingPublished(db.payload, async () => 'live', { apply: true, delayMs: 0 })

    const call = db.update.mock.calls[0]![0] as unknown as {
      where: { and: unknown[] }
      data: Row
      context: unknown
    }
    expect(Object.keys(call.data).sort()).toEqual(['ingestError', 'ingestStatus'])
    expect(call.context).toEqual({ __skipDocsExtract: true })
    expect(call.where.and).toEqual([{ id: { equals: 1 } }, ...CANDIDATE_WHERE])
  })

  it('the candidate query is published + pending + no ingest id, nothing wider', () => {
    expect(CANDIDATE_WHERE).toEqual([
      { publicationStatus: { equals: 'published' } },
      { ingestStatus: { equals: 'pending' } },
      { ingestId: { exists: false } },
    ])
  })
})

describe('liveCheckViaRetrieve', () => {
  it('asks the SHARED corpus for this doc id, current as of now', async () => {
    const retrieve = vi.fn(async () => ({ chunks: [{ chunkId: 'c1', metadata: { docId: '5' } }] }))
    const check = liveCheckViaRetrieve({ retrieve } as never, () => new Date('2026-10-16T00:00:00Z'))

    await expect(check({ id: 5, name: 'Acta', organization: { id: 7 } })).resolves.toBe('live')
    expect(retrieve).toHaveBeenCalledWith(
      expect.objectContaining({
        corpus: 'eco-7',
        topK: 1,
        query: 'documento',
        filter: { docId: '5' },
        asOf: '2026-10-16T00:00:00.000Z',
      }),
    )
  })

  it('a chunk for another doc is absent — the filter is not trusted alone', async () => {
    const ignoresFilter = liveCheckViaRetrieve({
      retrieve: async () => ({ chunks: [{ chunkId: 'c9', metadata: { docId: '9' } }] }),
    } as never)
    await expect(ignoresFilter({ id: 5, organization: 7 })).resolves.toBe('absent')
  })

  it('no chunks, or a 404 corpus, is absent', async () => {
    const empty = liveCheckViaRetrieve({ retrieve: async () => ({ chunks: [] }) } as never)
    await expect(empty({ id: 5, organization: 7 })).resolves.toBe('absent')

    const missing = liveCheckViaRetrieve({
      retrieve: async () => {
        throw Object.assign(new Error('corpus not found'), { status: 404 })
      },
    } as never)
    await expect(missing({ id: 5, organization: 7 })).resolves.toBe('absent')
  })

  it('🔴 any other failure THROWS — "could not ask" must never read as an answer', async () => {
    const down = liveCheckViaRetrieve({
      retrieve: async () => {
        throw Object.assign(new Error('rate limited'), { status: 429 })
      },
    } as never)
    await expect(down({ id: 5, organization: 7 })).rejects.toThrow('rate limited')
    await expect(
      liveCheckViaRetrieve({ retrieve: vi.fn() } as never)({ id: 5, organization: null }),
    ).rejects.toThrow()
  })
})
