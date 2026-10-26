/**
 * Review is after the fact (owner rule, 2026-10-24): a reviewer can reject a
 * testimonio that is already published. Fake Payload, fake ai-service.
 */
import { describe, expect, it, vi } from 'vitest'

import { HoldNotVisibleError } from './holdReview'
import { listPublishedTestimonios, rejectPublished } from './rejectPublished'

type Row = Record<string, unknown>

const published = (over: Row = {}): Row => ({
  id: 7,
  organization: 1,
  uploadedBy: 2,
  contentKind: 'testimonio',
  publicationStatus: 'published',
  anonymisationStatus: 'ready',
  redactedText: 'Vivo en [Lugar A].',
  testimonioTitle: 'La siembra del maíz',
  name: 'grabación de María.m4a',
  updatedAt: '2026-10-24T10:00:00.000Z',
  ...over,
})

const reviewer = { id: 9, isActive: true }
const outsider = { id: 10, isActive: true }

function fakePayload(row: Row | null, opts: { reviewerRole?: string } = {}) {
  const store = row ? { ...row } : null
  const created: Row[] = []
  const calls: string[] = []
  const find = vi.fn(async (args: { collection: string; where?: unknown }) => {
    if (args.collection === 'memberships') {
      const uid = JSON.stringify(args.where).includes('"equals":9') ? 9 : 10
      return {
        docs: uid === 9 ? [{ organization: 1, role: opts.reviewerRole ?? 'investigador', isActive: true }] : [],
      }
    }
    if (args.collection === 'organizations') return { docs: [{ id: 1, slug: 'eco-1', isActive: true }] }
    if (args.collection === 'documents') return { docs: store ? [{ ...store }] : [] }
    return { docs: [] }
  })
  const findByID = vi.fn(async () => {
    if (!store) throw Object.assign(new Error('not found'), { status: 404 })
    return { ...store }
  })
  const create = vi.fn(async (args: { data: Row }) => {
    calls.push('audit')
    created.push(args.data)
    return { id: 55 }
  })
  const update = vi.fn(async (args: { data: Row }) => {
    calls.push('row')
    if (store) Object.assign(store, args.data)
    return { docs: store ? [store] : [] }
  })
  return { payload: { find, findByID, create, update } as never, store, created, calls }
}

function fakeClient(calls: string[] = []) {
  const setDocumentValidity = vi.fn(async (corpus: string, _id: string, _b: unknown) => {
    calls.push(`retire:${corpus}`)
    return {}
  })
  return { client: { ingest: { enqueue: vi.fn() }, admin: { setDocumentValidity } }, setDocumentValidity }
}

describe('rejectPublished', () => {
  it('🔴 audits, retires the shared copy, then marks the row a rejected draft — in that order', async () => {
    const { payload, store, created, calls } = fakePayload(published())
    const { client, setDocumentValidity } = fakeClient(calls)
    const out = await rejectPublished({ payload, documentId: '7', user: reviewer, note: 'nombra a alguien', clientFor: () => client })

    expect(calls).toEqual(['audit', 'retire:eco-1', 'row'])
    expect(created[0]).toMatchObject({ document: 7, organization: 1, reviewer: 9, decision: 'rejected', note: 'nombra a alguien' })
    expect(setDocumentValidity.mock.calls[0]![0]).toBe('eco-1')
    expect(store).toMatchObject({
      publicationStatus: 'draft',
      anonymisationStatus: 'rejected',
      redactedText: null,
      testimonioTitle: null,
    })
    expect(out).toMatchObject({ id: '7', decision: 'rejected', reviewId: '55', anonymisationStatus: 'rejected' })
  })

  it('🔴 withdraws a published GATED documento the same way (participant PDF)', async () => {
    const { payload, store, created, calls } = fakePayload(
      published({ contentKind: 'documento', anonymise: true, name: 'informe.pdf', testimonioTitle: null }),
    )
    const { client } = fakeClient(calls)
    const out = await rejectPublished({ payload, documentId: 7, user: reviewer, clientFor: () => client })

    expect(calls).toEqual(['audit', 'retire:eco-1', 'row'])
    expect(created[0]).toMatchObject({ document: 7, organization: 1, reviewer: 9, decision: 'rejected' })
    expect(store).toMatchObject({ publicationStatus: 'draft', anonymisationStatus: 'rejected', redactedText: null })
    expect(out).toMatchObject({ id: '7', decision: 'rejected', anonymisationStatus: 'rejected' })
  })

  it('a failed retire leaves the row published and throws', async () => {
    const { payload, store } = fakePayload(published())
    const client = {
      ingest: { enqueue: vi.fn() },
      admin: { setDocumentValidity: vi.fn(async () => { throw Object.assign(new Error('x'), { status: 500 }) }) },
    }
    await expect(rejectPublished({ payload, documentId: 7, user: reviewer, clientFor: () => client })).rejects.toThrow()
    expect(store?.publicationStatus).toBe('published')
  })

  it.each([
    ['not a reviewer there', published(), outsider, undefined],
    ['a participant', published(), reviewer, 'member'],
    ['a draft', published({ publicationStatus: 'draft' }), reviewer, undefined],
    ['an ungated documento', published({ contentKind: 'documento', anonymise: false }), reviewer, undefined],
    ['a documento with no anonymise value', published({ contentKind: 'documento' }), reviewer, undefined],
    ['a gated documento that is a draft', published({ contentKind: 'documento', anonymise: true, publicationStatus: 'draft' }), reviewer, undefined],
    ['missing', null, reviewer, undefined],
  ])('refuses %s with the one 404 error', async (_case, row, user, reviewerRole) => {
    const { payload, created } = fakePayload(row, { reviewerRole })
    const { client } = fakeClient()
    await expect(
      rejectPublished({ payload, documentId: 7, user, clientFor: () => client }),
    ).rejects.toBeInstanceOf(HoldNotVisibleError)
    expect(created).toHaveLength(0)
  })
})

describe('listPublishedTestimonios', () => {
  it('lists with the generated or neutral title, never `name`', async () => {
    const { payload } = fakePayload(published())
    const out = await listPublishedTestimonios({ payload, organizationId: 1, user: reviewer })
    expect(out).toEqual([
      { id: '7', title: 'La siembra del maíz', updatedAt: '2026-10-24T10:00:00.000Z', contentKind: 'testimonio' },
    ])
    const { payload: p2 } = fakePayload(published({ testimonioTitle: null }))
    expect((await listPublishedTestimonios({ payload: p2, organizationId: 1, user: reviewer }))[0]!.title).toBe('Testimonio')
  })

  it('🔴 queries gated documentos too, titled by their own name', async () => {
    const { payload } = fakePayload(
      published({ contentKind: 'documento', anonymise: true, name: 'informe.pdf', testimonioTitle: null }),
    )
    const out = await listPublishedTestimonios({ payload, organizationId: 1, user: reviewer })
    expect(out).toEqual([
      { id: '7', title: 'informe.pdf', updatedAt: '2026-10-24T10:00:00.000Z', contentKind: 'documento' },
    ])
    const where = JSON.stringify((payload as unknown as { find: { mock: { calls: Array<[{ where: unknown }]> } } })
      .find.mock.calls.find((c) => JSON.stringify(c[0].where).includes('publicationStatus'))![0].where)
    expect(where).toContain('"anonymise":{"equals":true}')
    expect(where).toContain('"contentKind":{"equals":"testimonio"}')
  })

  it('refuses a non-reviewer', async () => {
    const { payload } = fakePayload(published())
    await expect(listPublishedTestimonios({ payload, organizationId: 1, user: outsider })).rejects.toBeInstanceOf(
      HoldNotVisibleError,
    )
  })
})
