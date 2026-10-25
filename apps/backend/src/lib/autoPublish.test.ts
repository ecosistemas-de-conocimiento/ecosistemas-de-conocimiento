/**
 * Owner rule, 2026-10-24: a participant never publishes by hand. Their upload
 * is published by the system once the draft ingest lands, and the gate decides:
 * `ready`/`approved` goes out, `held` waits in Revisión. Fake Payload, fake
 * ai-service: no network.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('./documentColumns', () => import('./documentColumns.testFake'))

import {
  autoPublishBlocker,
  autoPublishParticipantDocument,
  fileParticipantAudioAsTestimonio,
} from './autoPublish'

type Row = Record<string, unknown>

const draft = (over: Row = {}): Row => ({
  id: 7,
  organization: 1,
  uploadedBy: 2,
  kind: 'audio',
  contentKind: 'testimonio',
  publicationStatus: 'draft',
  ingestStatus: 'ready',
  anonymisationStatus: 'ready',
  redactedText: 'Vivo en [Lugar A] y siembro maíz.',
  extractedText: 'Vivo en Tepoztlán y siembro maíz.',
  ...over,
})

describe('autoPublishBlocker — which drafts the system may publish', () => {
  it.each([
    ['gate ready', draft(), null],
    ['approved by a reviewer', draft({ anonymisationStatus: 'approved' }), null],
    ['an ungated documento', draft({ contentKind: 'documento', anonymisationStatus: 'n/a', redactedText: null }), null],
    ['held by the gate', draft({ anonymisationStatus: 'held', redactedText: null }), 'gate-not-cleared'],
    ['gate still running', draft({ anonymisationStatus: 'pending' }), 'gate-not-cleared'],
    ['ready but no redaction', draft({ redactedText: '' }), 'gate-not-cleared'],
    ['rejected', draft({ anonymisationStatus: 'rejected', redactedText: null }), 'rejected'],
    ['rejected documento', draft({ contentKind: 'documento', anonymisationStatus: 'rejected' }), 'rejected'],
    ['already published', draft({ publicationStatus: 'published' }), 'not-draft'],
    ['publishing', draft({ publicationStatus: 'publishing' }), 'not-draft'],
    ['draft ingest still running', draft({ ingestStatus: 'embedding' }), 'not-ingested'],
    ['a conversacion row', draft({ contentKind: 'conversacion' }), 'not-a-contribution'],
  ])('%s → %s', (_case, row, expected) => {
    expect(autoPublishBlocker(row)).toBe(expected)
  })
})

describe('fileParticipantAudioAsTestimonio — a participant’s recording goes through the gate', () => {
  it.each([
    ['participant audio documento', { declared: 'documento', kind: 'audio', role: 'member', platformAdmin: false }, true],
    ['participant pdf', { declared: 'documento', kind: 'pdf', role: 'member', platformAdmin: false }, false],
    ['investigador audio', { declared: 'documento', kind: 'audio', role: 'investigador', platformAdmin: false }, false],
    ['admin audio', { declared: 'documento', kind: 'audio', role: 'admin', platformAdmin: false }, false],
    ['platform admin audio', { declared: 'documento', kind: 'audio', role: 'member', platformAdmin: true }, false],
    ['no membership', { declared: 'documento', kind: 'audio', role: null, platformAdmin: false }, false],
  ] as const)('%s → %s', (_case, input, expected) => {
    expect(fileParticipantAudioAsTestimonio(input)).toBe(expected)
  })
})

function fakePayload(row: Row | null, opts: { role?: string | null; platformAdmin?: boolean } = {}) {
  const store = row ? { ...row } : null
  const role = opts.role === undefined ? 'member' : opts.role
  const findByID = vi.fn(async (args: { collection: string }) => {
    if (args.collection === 'users') return { id: 2, isPlatformAdmin: opts.platformAdmin === true }
    if (!store) throw Object.assign(new Error('not found'), { status: 404 })
    return { ...store }
  })
  const find = vi.fn(async (args: { collection: string }) => {
    if (args.collection === 'memberships') {
      return { docs: role ? [{ organization: 1, role, isActive: true }] : [], hasNextPage: false }
    }
    if (args.collection === 'organizations') return { docs: [{ id: 1, isActive: true }], hasNextPage: false }
    return { docs: [], hasNextPage: false }
  })
  const update = vi.fn(async (args: { data: Row }) => {
    if (store) Object.assign(store, args.data)
    return { ...store }
  })
  return { payload: { findByID, find, update, logger: { warn: vi.fn(), error: vi.fn() } } as never, store, update }
}

function fakeClient() {
  const enqueue = vi.fn(async (_req: unknown) => ({ ingestId: 'pub_1' }))
  const setDocumentValidity = vi.fn(async () => ({}))
  return { client: { ingest: { enqueue }, admin: { setDocumentValidity } }, enqueue }
}

describe('autoPublishParticipantDocument', () => {
  it('🔴 publishes a participant’s gate-cleared draft, embedding the REDACTED text', async () => {
    const { payload, store } = fakePayload(draft())
    const { client, enqueue } = fakeClient()
    const out = await autoPublishParticipantDocument({ payload, documentId: 7, clientFor: () => client })
    expect(out).toEqual({ published: true })
    expect(store?.publicationStatus).toBe('publishing')
    const req = enqueue.mock.calls[0]![0] as { corpus: string; documents: Array<{ text: string }> }
    expect(req.corpus).toBe('eco-1')
    expect(req.documents[0]!.text).toBe('Vivo en [Lugar A] y siembro maíz.')
  })

  it('🔴 never publishes a held draft — it stays for Revisión', async () => {
    const { payload, store } = fakePayload(draft({ anonymisationStatus: 'held', redactedText: null }))
    const { client, enqueue } = fakeClient()
    const out = await autoPublishParticipantDocument({ payload, documentId: 7, clientFor: () => client })
    expect(out).toEqual({ published: false, reason: 'gate-not-cleared' })
    expect(enqueue).not.toHaveBeenCalled()
    expect(store?.publicationStatus).toBe('draft')
  })

  it.each([
    ['investigador', { role: 'investigador' }],
    ['admin', { role: 'admin' }],
    ['owner', { role: 'owner' }],
    ['platform admin', { role: 'member', platformAdmin: true }],
    ['no longer a member', { role: null }],
  ])('leaves an upload by %s to its uploader', async (_case, opts) => {
    const { payload } = fakePayload(draft(), opts)
    const { client, enqueue } = fakeClient()
    const out = await autoPublishParticipantDocument({ payload, documentId: 7, clientFor: () => client })
    expect(out).toEqual({ published: false, reason: 'not-participant' })
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('never throws: an ai-service failure is reported, not raised', async () => {
    const { payload } = fakePayload(draft())
    const client = {
      ingest: { enqueue: vi.fn(async () => { throw Object.assign(new Error('boom'), { status: 500 }) }) },
      admin: { setDocumentValidity: vi.fn() },
    }
    const out = await autoPublishParticipantDocument({ payload, documentId: 7, clientFor: () => client })
    expect(out).toEqual({ published: false, reason: 'failed' })
  })

  it('a missing row is a skip', async () => {
    const { payload } = fakePayload(null)
    const { client } = fakeClient()
    const out = await autoPublishParticipantDocument({ payload, documentId: 7, clientFor: () => client })
    expect(out).toEqual({ published: false, reason: 'not-found' })
  })
})
