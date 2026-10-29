/**
 * The one-off repair for gated rows that are published without clearing the
 * gate (13 on dev, 2026-10-21). Fake Payload and fake ai-service: no network.
 */
import { describe, expect, it, vi } from 'vitest'

import { isSharedButNotCleared, repairHeldPublished } from './repairHeldPublished'

type Row = Record<string, unknown>

function fakeDb(rows: Row[]) {
  const store = rows.map((r) => ({ ...r }))
  const find = vi.fn(async (args: { where: { publicationStatus: { in: string[] } } }) => ({
    docs: store.filter((r) => args.where.publicationStatus.in.includes(String(r.publicationStatus))).map((r) => ({ ...r })),
  }))
  const update = vi.fn(async (args: { where: { and: Array<Record<string, { equals?: unknown; exists?: boolean }>> }; data: Row }) => {
    const hits = store.filter((r) =>
      args.where.and.every((clause) =>
        Object.entries(clause).every(([k, op]) =>
          'exists' in op ? (r[k] != null) === op.exists : r[k] === op.equals,
        ),
      ),
    )
    for (const r of hits) Object.assign(r, args.data)
    return { docs: hits }
  })
  return { payload: { find, update } as never, store, update }
}

const held = (id: number, over: Row = {}): Row => ({
  id,
  organization: 1,
  uploadedBy: 2,
  contentKind: 'testimonio',
  publicationStatus: 'published',
  anonymisationStatus: 'held',
  anonymisationError: 'verify: Quedó 1 dato que podría identificar a alguien.',
  redactedText: null,
  heldText: 'Me llamo [Persona A] y vivo en la colonia Portales.',
  ...over,
})

function client() {
  const setDocumentValidity = vi.fn(async (_corpus: string, _externalId: string, _bounds: unknown) => ({}))
  const deleteDocument = vi.fn(async (_corpus: string, _externalId: string): Promise<unknown> => ({ deleted: true }))
  return {
    mover: { ingest: { enqueue: vi.fn() }, admin: { setDocumentValidity, deleteDocument } },
    setDocumentValidity,
    deleteDocument,
  }
}

describe('isSharedButNotCleared', () => {
  it.each([
    ['held + published testimonio', held(1), true],
    ['held + publishing', held(1, { publicationStatus: 'publishing' }), true],
    ['held draft (ordinary hold)', held(1, { publicationStatus: 'draft' }), false],
    ['ready + published', held(1, { anonymisationStatus: 'ready', redactedText: 'texto' }), false],
    ['approved + published', held(1, { anonymisationStatus: 'approved', redactedText: 'texto' }), false],
    ['ready but empty redaction', held(1, { anonymisationStatus: 'ready', redactedText: '' }), true],
    ['a published documento', held(1, { contentKind: 'documento', anonymisationStatus: 'n/a', extractedText: 'x' }), false],
  ])('%s → %s', (_case, row, expected) => {
    expect(isSharedButNotCleared(row)).toBe(expected)
  })
})

describe('repairHeldPublished', () => {
  const rows = () => [
    held(227),
    held(28, { organization: 3 }),
    held(5, { anonymisationStatus: 'ready', redactedText: 'texto limpio' }),
    held(9, { publicationStatus: 'draft' }),
  ]

  it('🔴 dry run by default: reports the matches and writes nothing, calls nothing', async () => {
    const db = fakeDb(rows())
    const ai = client()
    const report = await repairHeldPublished(db.payload, { apply: false, clientFor: () => ai.mover })
    expect(report).toMatchObject({ matched: 2, repaired: 0, ids: [227, 28], unreviewable: [], failed: [] })
    expect(db.update).not.toHaveBeenCalled()
    expect(ai.setDocumentValidity).not.toHaveBeenCalled()
  })

  it('apply: retires from the shared corpus of each row\'s ecosistema, then makes it a held draft', async () => {
    const db = fakeDb(rows())
    const ai = client()
    const report = await repairHeldPublished(db.payload, { apply: true, clientFor: () => ai.mover })

    expect(report).toMatchObject({ matched: 2, repaired: 2, failed: [] })
    const corpora = ai.setDocumentValidity.mock.calls.map((c) => `${c[0]}/${c[1]}`)
    expect(corpora).toEqual(['eco-1/227', 'eco-1-draft-2/227', 'eco-3/28', 'eco-3-draft-2/28'])
    const repaired = db.store.find((r) => r.id === 227)!
    expect(repaired).toMatchObject({
      publicationStatus: 'draft',
      anonymisationStatus: 'held',
      ingestStatus: 'failed',
      publishIngestId: null,
    })
    // 🔴 Still reviewable: the gate's columns are untouched.
    expect(repaired.heldText).toBe('Me llamo [Persona A] y vivo en la colonia Portales.')
    expect(String(repaired.ingestError)).toMatch(/^anonymisation_held: verify: /)
    // The cleared row and the ordinary held draft are not touched.
    expect(db.store.find((r) => r.id === 5)!.publicationStatus).toBe('published')
  })

  it('🔴 apply ERASES both copies of each repaired row, after retiring them (audit 2026-10-28)', async () => {
    const db = fakeDb(rows())
    const ai = client()
    const report = await repairHeldPublished(db.payload, { apply: true, clientFor: () => ai.mover })
    expect(ai.deleteDocument.mock.calls.map((c) => `${c[0]}/${c[1]}`)).toEqual([
      'eco-1/227',
      'eco-1-draft-2/227',
      'eco-3/28',
      'eco-3-draft-2/28',
    ])
    expect(report.notErased).toEqual([])
    expect(ai.setDocumentValidity.mock.invocationCallOrder[0]!).toBeLessThan(
      ai.deleteDocument.mock.invocationCallOrder[0]!,
    )
  })

  it('a failed erase still repairs the row and lists it as not erased', async () => {
    const db = fakeDb([held(227)])
    const ai = client()
    ai.deleteDocument.mockImplementation(async () => {
      throw Object.assign(new Error('unavailable'), { status: 503 })
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const report = await repairHeldPublished(db.payload, { apply: true, clientFor: () => ai.mover })
    expect(report).toMatchObject({ repaired: 1, failed: [], notErased: [227] })
    expect(db.store[0]!.publicationStatus).toBe('draft')
  })

  it('never erases a row that changed since it was read', async () => {
    const db = fakeDb([held(227)])
    const ai = client()
    ai.setDocumentValidity.mockImplementationOnce(async () => {
      db.store[0]!.anonymisationStatus = 'approved'
      return {}
    })
    await repairHeldPublished(db.payload, { apply: true, clientFor: () => ai.mover })
    expect(ai.deleteDocument).not.toHaveBeenCalled()
  })

  it('is idempotent: a second apply matches nothing', async () => {
    const db = fakeDb(rows())
    const ai = client()
    await repairHeldPublished(db.payload, { apply: true, clientFor: () => ai.mover })
    const again = await repairHeldPublished(db.payload, { apply: true, clientFor: () => ai.mover })
    expect(again).toMatchObject({ matched: 0, repaired: 0 })
  })

  it('🔴 a failed retire leaves the row published and says so', async () => {
    const db = fakeDb([held(227)])
    const setDocumentValidity = vi.fn(async () => {
      throw Object.assign(new Error('forbidden'), { status: 403 })
    })
    const report = await repairHeldPublished(db.payload, {
      apply: true,
      clientFor: () => ({ ingest: { enqueue: vi.fn() }, admin: { setDocumentValidity } }) as never,
    })
    expect(report).toMatchObject({ matched: 1, repaired: 0, failed: [227] })
    expect(db.store[0]!.publicationStatus).toBe('published')
  })

  it('a 404 from ai-service counts as already retired', async () => {
    const db = fakeDb([held(227)])
    const setDocumentValidity = vi.fn(async () => {
      throw Object.assign(new Error('not found'), { status: 404, name: 'NotFoundError', code: 'DOCUMENT_NOT_FOUND' })
    })
    const report = await repairHeldPublished(db.payload, {
      apply: true,
      clientFor: () => ({ ingest: { enqueue: vi.fn() }, admin: { setDocumentValidity } }) as never,
    })
    expect(report).toMatchObject({ repaired: 1, failed: [] })
  })

  it('🔴 skips a publishing row whose ingest is still in flight', async () => {
    const db = fakeDb([held(227, { publicationStatus: 'publishing', publishIngestId: 'ing-9' }), held(28)])
    const ai = client()
    const report = await repairHeldPublished(db.payload, { apply: true, clientFor: () => ai.mover })
    expect(report).toMatchObject({ matched: 1, repaired: 1, inFlight: [227] })
    expect(ai.setDocumentValidity.mock.calls.every((c) => c[1] !== '227')).toBe(true)
    expect(db.store[0]!.publicationStatus).toBe('publishing')
  })

  it('a published row with a stale publishIngestId is still repaired', async () => {
    const db = fakeDb([held(227, { publishIngestId: 'ing-old' })])
    const report = await repairHeldPublished(db.payload, { apply: true, clientFor: () => client().mover })
    expect(report).toMatchObject({ matched: 1, repaired: 1, inFlight: [] })
  })

  it('flags a matched row with no heldText as unreviewable', async () => {
    const db = fakeDb([held(41, { heldText: null })])
    const report = await repairHeldPublished(db.payload, { apply: false, clientFor: () => client().mover })
    expect(report.unreviewable).toEqual([41])
  })
})
