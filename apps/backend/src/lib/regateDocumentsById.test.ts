/**
 * The by-id re-gate (owner's ruling Q24 = A). Fake Payload, fake ai-service:
 * no network, no model call.
 */
import { describe, expect, it, vi } from 'vitest'

import { countPlaceholders, refusalFor, regateDocumentsById } from './regateDocumentsById'

type Row = Record<string, unknown>

const doc = (id: number, over: Row = {}): Row => ({
  id,
  organization: 7,
  uploadedBy: 2,
  kind: 'pdf',
  contentKind: 'documento',
  anonymise: true,
  publicationStatus: 'published',
  anonymisationStatus: 'ready',
  ingestStatus: 'ready',
  redactedText: 'En [Dato omitido] y [Dato omitido], [Persona A] vive en [Domicilio A].',
  extractedText: 'En PILARES y SECIHTI, María vive en la calle Olmo 3.',
  ...over,
})

function fakeDb(rows: Row[]) {
  const store = rows.map((r) => ({ ...r }))
  const calls: string[] = []
  const matches = (r: Row, clause: Record<string, unknown>): boolean =>
    Object.entries(clause).every(([k, op]) => {
      if (k === 'or') return (op as Row[]).some((c) => matches(r, c))
      if (k === 'and') return (op as Row[]).every((c) => matches(r, c))
      const o = op as { equals?: unknown; in?: unknown[] }
      if ('in' in o) return (o.in ?? []).map(String).includes(String(r[k]))
      return r[k] === o.equals
    })
  const find = vi.fn(async (args: { where: Row }) => ({
    docs: store.filter((r) => matches(r, args.where)).map((r) => ({ ...r })),
  }))
  const update = vi.fn(async (args: { where: Row; data: Row }) => {
    calls.push('row')
    const hits = store.filter((r) => matches(r, args.where))
    for (const r of hits) Object.assign(r, args.data)
    return { docs: hits.map((r) => ({ ...r })) }
  })
  return { payload: { find, update } as never, store, calls, update }
}

function client(calls: string[], fail?: string) {
  const setDocumentValidity = vi.fn(async (corpus: string) => {
    calls.push(`retire:${corpus}`)
    if (corpus === fail) throw Object.assign(new Error('boom'), { status: 500 })
    return {}
  })
  const deleteDocument = vi.fn(async (corpus: string) => {
    calls.push(`erase:${corpus}`)
    if (corpus === fail) throw Object.assign(new Error('boom'), { status: 500 })
    return { deleted: true }
  })
  return { ingest: { enqueue: vi.fn() }, admin: { setDocumentValidity, deleteDocument } }
}

describe('countPlaceholders', () => {
  it('counts each placeholder kind', () => {
    expect(countPlaceholders(doc(1).redactedText)).toEqual({ omitted: 2, persona: 1, domicilio: 1 })
    expect(countPlaceholders(null)).toEqual({ omitted: 0, persona: 0, domicilio: 0 })
  })
})

describe('refusalFor', () => {
  it.each([
    ['missing', undefined, false, 'not-found'],
    ['another ecosistema', doc(1, { organization: 3 }), false, 'other-ecosistema'],
    ['relation object in the org', doc(1, { organization: { id: 7 } }), false, null],
    ['a testimonio', doc(1, { contentKind: 'testimonio' }), false, 'testimonio'],
    ['a testimonio with the flag', doc(1, { contentKind: 'testimonio' }), true, null],
    // A testimonio is gated whatever `anonymise` says.
    ['a testimonio without anonymise, with the flag', doc(1, { contentKind: 'testimonio', anonymise: false }), true, null],
    ['a documento without anonymise', doc(1, { contentKind: 'documento', anonymise: false }), true, 'not-gated'],
    ['never gated', doc(1, { anonymise: false }), false, 'not-gated'],
    ['publishing', doc(1, { publicationStatus: 'publishing' }), false, 'in-flight'],
    ['gate running', doc(1, { anonymisationStatus: 'pending' }), false, 'in-flight'],
    ['a held draft', doc(1, { publicationStatus: 'draft', anonymisationStatus: 'held' }), false, null],
  ])('%s → %s', (_c, row, allow, expected) => {
    expect(refusalFor(row as Row | undefined, 7, allow as boolean)).toBe(expected)
  })
})

describe('regateDocumentsById', () => {
  it('🔴 dry run writes nothing, calls nothing, and reports status and placeholder counts', async () => {
    const { payload, store, calls } = fakeDb([doc(354), doc(351, { publicationStatus: 'draft' })])
    const gate = vi.fn()
    const lines: string[] = []
    const report = await regateDocumentsById(payload, {
      ids: [354, 351],
      organizationId: 7,
      apply: false,
      client: client(calls) as never,
      gate,
      log: (l) => lines.push(l),
    })
    expect(calls).toEqual([])
    expect(gate).not.toHaveBeenCalled()
    expect(store[0]).toMatchObject({ publicationStatus: 'published', anonymisationStatus: 'ready' })
    expect(report.lines[0]).toMatchObject({
      id: '354',
      publicationStatus: 'published',
      anonymisationStatus: 'ready',
      placeholders: { omitted: 2, persona: 1, domicilio: 1 },
    })
    expect(lines[0]).toContain('2 [Dato omitido]')
    expect(lines[0]).toContain('ends a draft')
    expect(lines[1]).not.toContain('ends a draft')
    expect(report.regated).toEqual([])
  })

  it('🔴 refuses ids outside the org, testimonios and missing ids, and touches none of them', async () => {
    const { payload, store, calls } = fakeDb([doc(1, { organization: 3 }), doc(2, { contentKind: 'testimonio' })])
    const gate = vi.fn()
    const report = await regateDocumentsById(payload, {
      ids: [1, 2, 99],
      organizationId: 7,
      apply: true,
      client: client(calls) as never,
      gate,
    })
    expect(report.refused).toEqual(['1', '2', '99'])
    expect(report.lines.map((l) => l.refused)).toEqual(['other-ecosistema', 'testimonio', 'not-found'])
    expect(calls).toEqual([])
    expect(gate).not.toHaveBeenCalled()
    expect(store[1]).toMatchObject({ publicationStatus: 'published', anonymisationStatus: 'ready' })
  })

  it('🔴 requireErase: both erased BEFORE the reset; a failed erase resets nothing and gates nothing', async () => {
    const ok = fakeDb([doc(354)])
    await regateDocumentsById(ok.payload, {
      ids: ['354'],
      organizationId: 7,
      apply: true,
      requireErase: true,
      client: client(ok.calls) as never,
      gate: async () => {
        ok.calls.push('gate')
      },
    })
    expect(ok.calls).toEqual(['retire:eco-7', 'retire:eco-7-draft-2', 'erase:eco-7', 'erase:eco-7-draft-2', 'row', 'gate'])

    const bad = fakeDb([doc(354)])
    const c = client(bad.calls)
    c.admin.deleteDocument.mockImplementation(async (corpus: string) => {
      bad.calls.push(`erase:${corpus}`)
      throw Object.assign(new Error('down'), { status: 503 })
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const gate = vi.fn()
    const report = await regateDocumentsById(bad.payload, { ids: ['354'], organizationId: 7, apply: true, requireErase: true, client: c as never, gate })
    expect(report.lines[0]?.outcome).toBe('erase-failed')
    expect(bad.calls).not.toContain('row')
    expect(gate).not.toHaveBeenCalled()
    expect(bad.store[0]).toMatchObject({ publicationStatus: 'published', anonymisationStatus: 'ready' })
  })

  it('🔴 P-02: the graph is purged after the erase and BEFORE the reset', async () => {
    const ok = fakeDb([doc(354)])
    await regateDocumentsById(ok.payload, {
      ids: ['354'],
      organizationId: 7,
      apply: true,
      requireErase: true,
      client: client(ok.calls) as never,
      purgeGraph: async (id) => {
        ok.calls.push(`purge:${String(id)}`)
      },
      gate: async () => {
        ok.calls.push('gate')
      },
    })
    expect(ok.calls).toEqual(['retire:eco-7', 'retire:eco-7-draft-2', 'erase:eco-7', 'erase:eco-7-draft-2', 'purge:354', 'row', 'gate'])
  })

  it('🔴 P-02: a purge that throws is erase-failed: nothing reset, nothing gated', async () => {
    const bad = fakeDb([doc(354)])
    const gate = vi.fn()
    const report = await regateDocumentsById(bad.payload, {
      ids: ['354'],
      organizationId: 7,
      apply: true,
      requireErase: true,
      client: client(bad.calls) as never,
      purgeGraph: async () => {
        throw new Error('Failed query: delete from graph_mentions params: López')
      },
      gate,
    })
    expect(report.lines[0]?.outcome).toBe('erase-failed')
    expect(bad.calls).not.toContain('row')
    expect(gate).not.toHaveBeenCalled()
    expect(bad.store[0]).toMatchObject({ publicationStatus: 'published', anonymisationStatus: 'ready' })
  })

  it('a testimonio goes through with allowTestimonio', async () => {
    const { payload, calls } = fakeDb([doc(2, { contentKind: 'testimonio' })])
    const gate = vi.fn(async () => undefined)
    const report = await regateDocumentsById(payload, {
      ids: [2],
      organizationId: 7,
      apply: true,
      allowTestimonio: true,
      client: client(calls) as never,
      gate,
    })
    expect(report.regated).toEqual(['2'])
  })

  it('🔴 apply: shared corpus retired first, then the draft, then the reset, then the erase, then the gate', async () => {
    const { payload, store, calls } = fakeDb([doc(354)])
    const gate = vi.fn(async (row: Row) => {
      calls.push(`gate:${String(row.id)}`)
    })
    const report = await regateDocumentsById(payload, {
      ids: ['354'],
      organizationId: 7,
      apply: true,
      client: client(calls) as never,
      gate,
    })
    expect(calls).toEqual([
      'retire:eco-7',
      'retire:eco-7-draft-2',
      'row',
      // 🔴 Erased BEFORE the gate re-ingests into the draft corpus (audit 2026-10-28).
      'erase:eco-7',
      'erase:eco-7-draft-2',
      'gate:354',
    ])
    expect(store[0]).toMatchObject({
      publicationStatus: 'draft',
      anonymisationStatus: 'n/a',
      redactedText: null,
      heldText: null,
      ingestStatus: 'extracting',
      ingestId: null,
      anonymise: true,
    })
    expect(gate.mock.calls[0]?.[0]).toMatchObject({ extractedText: expect.stringContaining('PILARES') })
    expect(report).toMatchObject({ regated: ['354'], failed: [] })
  })

  it('a failed retire leaves the row as it was and goes on to the next id', async () => {
    const { payload, store, calls } = fakeDb([doc(1), doc(2, { organization: 7 })])
    const gate = vi.fn(async () => undefined)
    const c = client(calls, 'eco-7')
    let first = true
    c.admin.setDocumentValidity.mockImplementation(async (corpus: string) => {
      calls.push(`retire:${corpus}`)
      if (first) {
        first = false
        throw Object.assign(new Error('boom'), { status: 500 })
      }
      return {}
    })
    const report = await regateDocumentsById(payload, { ids: [1, 2], organizationId: 7, apply: true, client: c as never, gate })
    expect(report.failed).toEqual(['1'])
    expect(report.regated).toEqual(['2'])
    expect(store[0]).toMatchObject({ publicationStatus: 'published', anonymisationStatus: 'ready' })
  })

  it('a 404 on retire is "already absent", not a failure', async () => {
    const { payload, calls } = fakeDb([doc(1)])
    const c = client(calls)
    c.admin.setDocumentValidity.mockImplementation(async () => {
      throw Object.assign(new Error('nope'), { status: 404 })
    })
    const report = await regateDocumentsById(payload, {
      ids: [1],
      organizationId: 7,
      apply: true,
      client: c as never,
      gate: vi.fn(async () => undefined),
    })
    expect(report.regated).toEqual(['1'])
  })

  it('a row that changed between read and write is left alone, and not gated', async () => {
    const { payload, store, calls, update } = fakeDb([doc(1)])
    update.mockImplementationOnce(async () => ({ docs: [] }))
    const gate = vi.fn()
    const report = await regateDocumentsById(payload, { ids: [1], organizationId: 7, apply: true, client: client(calls) as never, gate })
    expect(gate).not.toHaveBeenCalled()
    expect(report.lines[0]?.outcome).toBe('changed-meanwhile')
    expect(store[0]).toMatchObject({ anonymisationStatus: 'ready' })
  })

  it('a row with no extracted text is withdrawn and left a gated draft', async () => {
    const { payload, calls } = fakeDb([doc(1, { extractedText: '' })])
    const gate = vi.fn()
    const report = await regateDocumentsById(payload, { ids: [1], organizationId: 7, apply: true, client: client(calls) as never, gate })
    expect(gate).not.toHaveBeenCalled()
    expect(report.lines[0]?.outcome).toBe('withdrawn-only')
  })
})
