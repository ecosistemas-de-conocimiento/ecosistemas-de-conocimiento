/**
 * One-off: move participants' existing drafts onto the auto-publish rule
 * (owner rule, 2026-10-24). Fake Payload; publish and participant check injected.
 */
import { describe, expect, it, vi } from 'vitest'

import { autoPublishParticipantDrafts } from './autoPublishBackfill'

type Row = Record<string, unknown>

const row = (id: number, over: Row = {}): Row => ({
  id,
  organization: 1,
  uploadedBy: 2,
  kind: 'pdf',
  contentKind: 'documento',
  publicationStatus: 'draft',
  ingestStatus: 'ready',
  anonymisationStatus: 'n/a',
  extractedText: 'texto',
  ...over,
})

function fakeDb(rows: Row[]) {
  const store = rows.map((r) => ({ ...r }))
  const find = vi.fn(async () => ({ docs: store.map((r) => ({ ...r })) }))
  const update = vi.fn(async (args: { where: { and: Array<Record<string, { equals: unknown }>> }; data: Row; context?: unknown }) => {
    const hits = store.filter((r) =>
      args.where.and.every((c) => Object.entries(c).every(([k, op]) => r[k] === op.equals)),
    )
    for (const r of hits) Object.assign(r, args.data)
    return { docs: hits }
  })
  return { payload: { find, update } as never, store, update }
}

const deps = (over: Partial<Parameters<typeof autoPublishParticipantDrafts>[1]> = {}) => ({
  apply: false,
  limit: 100,
  isParticipant: vi.fn(async (uploader: unknown) => String(uploader) === '2'),
  publish: vi.fn(async () => ({ published: true }) as const),
  log: () => {},
  ...over,
})

describe('autoPublishParticipantDrafts', () => {
  const rows = [
    row(1), // 🔴 participant pdf, UNGATED (pre-10-26) → never published raw (audit 2026-10-28, item 8)
    row(2, { kind: 'audio' }), // participant audio documento → re-gate as testimonio
    row(3, { contentKind: 'testimonio', anonymisationStatus: 'ready', redactedText: 'x' }), // cleared → publish
    row(4, { contentKind: 'testimonio', anonymisationStatus: 'held' }), // held → stays
    row(5, { uploadedBy: 9 }), // investigador → untouched
    row(6, { ingestStatus: 'embedding' }), // in flight → skipped
    row(7, { kind: 'audio', extractedText: null, ingestStatus: 'failed' }), // no transcript → skipped
    row(8, { anonymise: true, anonymisationStatus: 'ready', redactedText: 'x' }), // gated pdf, cleared → publish
  ]

  it('🔴 dry run writes nothing and publishes nothing, but reports the plan', async () => {
    const { payload, update } = fakeDb(rows)
    const d = deps()
    const report = await autoPublishParticipantDrafts(payload, d)
    expect(update).not.toHaveBeenCalled()
    expect(d.publish).not.toHaveBeenCalled()
    expect(report).toMatchObject({
      apply: false,
      scanned: 8,
      published: ['3', '8'],
      regated: ['2'],
      held: ['4'],
      notParticipant: 1,
    })
    expect(report.skipped).toEqual([
      { id: '1', reason: 'not-gated' },
      { id: '6', reason: 'not-ingested' },
      { id: '7', reason: 'no-text' },
    ])
  })

  it('apply publishes the cleared drafts and re-gates the audio as a testimonio', async () => {
    const { payload, store, update } = fakeDb(rows)
    const d = deps({ apply: true })
    const report = await autoPublishParticipantDrafts(payload, d)
    expect(d.publish).toHaveBeenCalledTimes(2)
    expect((d.publish as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]))).toEqual(['3', '8'])
    expect(update).toHaveBeenCalledTimes(1)
    // ⚠ No `__skipDocsExtract`: the ordinary hook runs the gate on the new kind.
    expect(update.mock.calls[0]![0].context).toBeUndefined()
    expect(store.find((r) => r.id === 2)).toMatchObject({
      contentKind: 'testimonio',
      ingestStatus: 'pending',
      ingestId: null,
      anonymisationStatus: 'n/a',
      redactedText: null,
    })
    expect(store.find((r) => r.id === 4)!.anonymisationStatus).toBe('held')
    expect(report.failed).toEqual([])
  })

  it('a publish the system refused is reported, not hidden', async () => {
    const { payload } = fakeDb([row(1, { anonymise: true, anonymisationStatus: 'ready', redactedText: 'x' })])
    const d = deps({ apply: true, publish: vi.fn(async () => ({ published: false, reason: 'failed' }) as const) })
    const report = await autoPublishParticipantDrafts(payload, d)
    expect(report.published).toEqual([])
    expect(report.failed).toEqual([{ id: '1', reason: 'failed' }])
  })
})
