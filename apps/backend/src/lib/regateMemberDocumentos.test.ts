/**
 * The one-off that sends participants' already-published, UNGATED documentos
 * back through the anonymisation gate (2026-10-26 audit). Fake Payload, fake
 * ai-service: no network, no model call.
 */
import { describe, expect, it, vi } from 'vitest'

import { needsRegate, regateMemberDocumentos } from './regateMemberDocumentos'

type Row = Record<string, unknown>

const doc = (id: number, over: Row = {}): Row => ({
  id,
  organization: 1,
  uploadedBy: 2,
  kind: 'pdf',
  contentKind: 'documento',
  anonymise: false,
  publicationStatus: 'published',
  anonymisationStatus: 'n/a',
  extractedText: 'Me llamo María López.',
  name: 'informe.pdf',
  ...over,
})

function fakeDb(rows: Row[]) {
  const store = rows.map((r) => ({ ...r }))
  const calls: string[] = []
  const find = vi.fn(async () => ({ docs: store.map((r) => ({ ...r })) }))
  const matches = (r: Row, clause: Record<string, unknown>): boolean =>
    Object.entries(clause).every(([k, op]) => {
      if (k === 'or') return (op as Row[]).some((c) => matches(r, c))
      if (k === 'and') return (op as Row[]).every((c) => matches(r, c))
      const o = op as { equals?: unknown; exists?: boolean }
      return 'exists' in o ? (r[k] != null) === o.exists : r[k] === o.equals
    })
  const update = vi.fn(async (args: { where: Row; data: Row }) => {
    calls.push('row')
    const hits = store.filter((r) => matches(r, args.where))
    for (const r of hits) Object.assign(r, args.data)
    return { docs: hits.map((r) => ({ ...r })) }
  })
  return { payload: { find, update } as never, store, calls, update }
}

function client(calls: string[]) {
  const setDocumentValidity = vi.fn(async (corpus: string) => {
    calls.push(`retire:${corpus}`)
    return {}
  })
  const deleteDocument = vi.fn(async (corpus: string) => {
    calls.push(`erase:${corpus}`)
    return { deleted: true }
  })
  return { ingest: { enqueue: vi.fn() }, admin: { setDocumentValidity, deleteDocument } }
}

const participant = vi.fn(async (uploader: unknown) => String(uploader) === '2')

describe('needsRegate', () => {
  it.each([
    ['published ungated documento', doc(1), true],
    ['anonymise null', doc(1, { anonymise: null }), true],
    ['already gated', doc(1, { anonymise: true }), false],
    ['a draft', doc(1, { publicationStatus: 'draft' }), false],
    ['a testimonio', doc(1, { contentKind: 'testimonio' }), false],
  ])('%s → %s', (_c, row, expected) => {
    expect(needsRegate(row)).toBe(expected)
  })
})

describe('regateMemberDocumentos', () => {
  it('🔴 dry run writes nothing and lists only participant uploads', async () => {
    const { payload, store, calls } = fakeDb([doc(1), doc(2, { uploadedBy: 9 }), doc(3, { anonymise: true })])
    const gate = vi.fn()
    const report = await regateMemberDocumentos(payload, {
      apply: false,
      isParticipant: participant,
      clientFor: () => client(calls) as never,
      gate,
    })
    expect(report).toMatchObject({ examined: 3, matched: 1, ids: ['1'], regated: 0 })
    expect(calls).toEqual([])
    expect(gate).not.toHaveBeenCalled()
    expect(store[0]).toMatchObject({ anonymise: false, publicationStatus: 'published' })
  })

  it('🔴 apply: retires the shared copy FIRST, then files it gated as a draft, then gates it', async () => {
    const { payload, store, calls } = fakeDb([doc(1)])
    const gate = vi.fn(async (_row: Row) => {
      calls.push('gate')
    })
    const report = await regateMemberDocumentos(payload, {
      apply: true,
      isParticipant: participant,
      clientFor: () => client(calls) as never,
      gate,
    })
    // 🔴 Erased from the shared and the draft corpus BEFORE the gate re-ingests (audit 2026-10-28).
    expect(calls).toEqual(['retire:eco-1', 'row', 'erase:eco-1', 'erase:eco-1-draft-2', 'gate'])
    expect(store[0]).toMatchObject({
      anonymise: true,
      publicationStatus: 'draft',
      anonymisationStatus: 'n/a',
      redactedText: null,
      ingestId: null,
      ingestStatus: 'extracting',
    })
    expect(gate.mock.calls[0]![0]).toMatchObject({ id: 1, anonymise: true })
    expect(report).toMatchObject({ matched: 1, regated: 1, failed: [] })
  })

  it('a failed retire leaves the row published and reports it', async () => {
    const { payload, store } = fakeDb([doc(1)])
    const broken = {
      ingest: { enqueue: vi.fn() },
      admin: { setDocumentValidity: vi.fn(async () => { throw Object.assign(new Error('x'), { status: 500 }) }) },
    }
    const report = await regateMemberDocumentos(payload, {
      apply: true,
      isParticipant: participant,
      clientFor: () => broken as never,
      gate: vi.fn(),
    })
    expect(store[0]).toMatchObject({ publicationStatus: 'published', anonymise: false })
    expect(report.failed).toEqual(['1'])
  })

  it('a failed erase still regates the row', async () => {
    const { payload, calls } = fakeDb([doc(1)])
    const c = client(calls)
    c.admin.deleteDocument.mockImplementation(async () => {
      throw Object.assign(new Error('unavailable'), { status: 503 })
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const lines: string[] = []
    const report = await regateMemberDocumentos(payload, {
      apply: true,
      isParticipant: participant,
      clientFor: () => c as never,
      gate: vi.fn(),
      log: (l) => lines.push(l),
    })
    expect(report).toMatchObject({ regated: 1, failed: [] })
    expect(lines.some((l) => l.includes('NOT erased'))).toBe(true)
  })

  it('a row with no extracted text is withdrawn but not gated', async () => {
    const { payload, store, calls } = fakeDb([doc(1, { kind: 'markdown', extractedText: null })])
    const gate = vi.fn()
    const report = await regateMemberDocumentos(payload, {
      apply: true,
      isParticipant: participant,
      clientFor: () => client(calls) as never,
      gate,
    })
    expect(store[0]).toMatchObject({ anonymise: true, publicationStatus: 'draft' })
    expect(gate).not.toHaveBeenCalled()
    expect(report.withdrawnOnly).toEqual(['1'])
  })
})
