/**
 * 🔴 A FIRST PUBLISH THAT LANDS LATE (audit 2026-11-11).
 *
 * `beginPublish` moves the row to `publishing` and enqueues the shared-corpus
 * ingest J. ai-service answers when it QUEUES J; its worker writes the copy
 * later with `validTo = null`, which clears any retirement done meanwhile. So
 * whatever happened to the row while J was queued (held for consent, then
 * unpublished; or unpublished without a hold), J's landing put the document
 * back in the shared corpus, and its callback was dropped as "superseded".
 *
 * The callback now retires a shared-corpus landing whenever the row may not be
 * shared at that moment: not `publishing`/`published`, or held. Both events: a
 * partial landing is still a landing. And `confirmPublish` never flips a held
 * row to `published`. The real-Postgres side (the hold read `FOR SHARE`) is
 * `lib/publishDocument.consentHeld.pg.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/documentColumns', () => import('@/lib/documentColumns.testFake'))

const deleteDocument = vi.fn(async (_corpus: string, _id: string): Promise<unknown> => ({ deleted: true }))
const setDocumentValidity = vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ ok: true }))
vi.mock('@/lib/aiClient', () => ({
  getAdminAIClient: () => ({ admin: { deleteDocument, setDocumentValidity } }),
  getAppAIClient: () => ({ admin: { deleteDocument, setDocumentValidity } }),
}))

const autoPublish = vi.fn(async (_args: { documentId: unknown }) => ({ published: false, reason: 'not-participant' }))
vi.mock('@/lib/autoPublish', () => ({ autoPublishParticipantDocument: autoPublish }))

const release = vi.fn(async (..._a: unknown[]) => undefined)
vi.mock('@/lib/conversationIngest', async (orig) => ({
  ...(await orig<typeof import('@/lib/conversationIngest')>()),
  releaseConversationsWaitingOn: release,
}))

import { signCallback } from '@/lib/hmac'

const SECRET = 'd'.repeat(64)
const SHARED = 'eco-8'
const DRAFT = 'eco-8-draft-3'

const updated: Array<Record<string, unknown>> = []
let dedupeRows: Array<{ id: number }> = []
let row: Record<string, unknown>

const fakePayload = {
  create: async () => {
    const r = { id: 900 + dedupeRows.length + 1 }
    dedupeRows.push(r)
    return r
  },
  findByID: async () => ({ ...row }),
  update: async (args: Record<string, unknown>) => {
    updated.push(args)
    return {}
  },
  delete: async (args: { collection: string; id: number }) => {
    if (args.collection === 'aiServiceCallbacks') dedupeRows = dedupeRows.filter((r) => r.id !== args.id)
    return {}
  },
}

vi.mock('payload', () => ({ getPayload: async () => fakePayload }))
vi.mock('@payload-config', () => ({ default: {} }))

const post = async (over: Record<string, unknown>) => {
  const body = JSON.stringify({ event: 'ingest.completed', docId: '42', ...over })
  const timestamp = Math.floor(Date.now() / 1000)
  const { POST } = await import('./route')
  return POST(
    new Request('http://chat.test/api/ai-service/callback', {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'x-aiservice-timestamp': String(timestamp),
        'x-aiservice-signature': signCallback({ timestamp, body, secret: SECRET }),
      },
    }),
  )
}

const FAILED = { event: 'ingest.failed', error: { code: 'embed_failed', message: 'x' } }
const retiredCorpora = () => setDocumentValidity.mock.calls.map((c) => c[0])
const statuses = () => updated.map((u) => (u.data as { publicationStatus?: string }).publicationStatus).filter(Boolean)

beforeEach(() => {
  updated.length = 0
  dedupeRows = []
  setDocumentValidity.mockClear()
  autoPublish.mockClear()
  release.mockClear()
  row = { id: 42, ingestId: 'draft-ing', ingestStatus: 'ready', publishIngestId: null, reindexIngestId: null,
    publicationStatus: 'draft', consentHeld: false, organization: 8, uploadedBy: 3 }
  vi.stubEnv('CALLBACK_SECRET', SECRET)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { if (process.env.DBG) process.stderr.write(a.map(String).join(' ') + '\n') })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('🔴 a first-publish ingest that lands after the row left `publishing`', () => {
  it('A: held, then unpublished (draft, `publishIngestId` cleared) while J was queued: J is retired on landing', async () => {
    row = { ...row, consentHeld: true }
    const res = await post({ ingestId: 'pub-J', corpus: SHARED })
    expect(res.status).toBe(200)
    expect(retiredCorpora()).toEqual([SHARED])
    expect(updated).toEqual([])
  })

  it('A, `ingest.failed`: a partial landing is still a landing, retired too', async () => {
    row = { ...row, consentHeld: true }
    await post({ ingestId: 'pub-J', corpus: SHARED, ...FAILED })
    expect(retiredCorpora()).toEqual([SHARED])
    expect(updated).toEqual([])
  })

  it('C: unpublished without a hold while J was queued (`unpublishing`, the id is the draft re-embed K): J is retired', async () => {
    row = { ...row, publicationStatus: 'unpublishing', publishIngestId: 'unpub-K' }
    await post({ ingestId: 'pub-J', corpus: SHARED })
    expect(retiredCorpora()).toEqual([SHARED])
    expect(updated).toEqual([])
  })

  it('C, after K confirmed (`draft`), J lands with `ingest.failed`: retired', async () => {
    await post({ ingestId: 'pub-J', corpus: SHARED, ...FAILED })
    expect(retiredCorpora()).toEqual([SHARED])
  })

  it('no `corpus` on the envelope: still retired (fail closed)', async () => {
    await post({ ingestId: 'pub-J' })
    expect(retiredCorpora()).toEqual([SHARED])
  })

  it('held while `publishing` and J superseded by a retry: retired', async () => {
    row = { ...row, publicationStatus: 'publishing', publishIngestId: 'pub-J2', consentHeld: true }
    await post({ ingestId: 'pub-J', corpus: SHARED })
    expect(retiredCorpora()).toEqual([SHARED])
  })

  it('a retire that fails answers 500, so ai-service sends it again', async () => {
    setDocumentValidity.mockRejectedValueOnce(Object.assign(new Error('ai-service 503'), { status: 503 }))
    const res = await post({ ingestId: 'pub-J', corpus: SHARED })
    expect(res.status).toBe(500)
  })

  it('control: published, not held, a superseded J: left alone (the row may be shared)', async () => {
    row = { ...row, publicationStatus: 'published' }
    await post({ ingestId: 'pub-J', corpus: SHARED })
    expect(retiredCorpora()).toEqual([])
    expect(updated).toEqual([])
  })

  it('control: publishing, not held, a superseded J: left alone', async () => {
    row = { ...row, publicationStatus: 'publishing', publishIngestId: 'pub-J2' }
    await post({ ingestId: 'pub-J', corpus: SHARED })
    expect(retiredCorpora()).toEqual([])
  })

  it('control: a superseded DRAFT-corpus ingest on a draft: nothing retired, nothing written', async () => {
    await post({ ingestId: 'old-draft', corpus: DRAFT })
    expect(retiredCorpora()).toEqual([])
    expect(updated).toEqual([])
  })

  it("control: the row's own draft ingest lands with no `corpus` on the envelope: `ready`, nothing retired", async () => {
    await post({ ingestId: 'draft-ing' })
    expect(retiredCorpora()).toEqual([])
    expect(updated.map((u) => u.data)).toEqual([{ ingestStatus: 'ready', ingestError: null }])
  })

  it("control: the row's own draft ingest lands: `ready`, nothing retired", async () => {
    await post({ ingestId: 'draft-ing', corpus: DRAFT })
    expect(retiredCorpora()).toEqual([])
    expect(updated.map((u) => u.data)).toEqual([{ ingestStatus: 'ready', ingestError: null }])
  })
})

describe('🔴 B: held while `publishing`, J lands and matches', () => {
  const publishing = () => ({ ...row, publicationStatus: 'publishing', publishIngestId: 'pub-J', consentHeld: true,
    contentKind: 'documento', anonymise: false, anonymisationStatus: 'n/a', extractedText: 'x' })

  it('`ingest.completed`: never flipped to `published`; the shared copy is retired and the row is a draft', async () => {
    row = publishing()
    const res = await post({ ingestId: 'pub-J', corpus: SHARED })
    expect(res.status).toBe(200)
    expect(statuses()).not.toContain('published')
    expect(statuses()).toEqual(['draft'])
    expect(retiredCorpora()).toEqual([SHARED])
    expect(updated[0]!.data).toMatchObject({ publishIngestId: null })
  })

  it('`ingest.failed`: retired, a draft, not left `publishing` with an error', async () => {
    row = publishing()
    await post({ ingestId: 'pub-J', corpus: SHARED, ...FAILED })
    expect(retiredCorpora()).toEqual([SHARED])
    expect(statuses()).toEqual(['draft'])
  })

  it('control: not held, J completes: draft copy retired, `published`', async () => {
    row = { ...publishing(), consentHeld: false }
    await post({ ingestId: 'pub-J', corpus: SHARED })
    expect(retiredCorpora()).toEqual([DRAFT])
    expect(statuses()).toEqual(['published'])
  })

  it('control: not held, J fails: stays `publishing` with the error (retryable)', async () => {
    row = { ...publishing(), consentHeld: false }
    await post({ ingestId: 'pub-J', corpus: SHARED, ...FAILED })
    expect(retiredCorpora()).toEqual([])
    expect(statuses()).toEqual([])
    expect(updated.map((u) => Object.keys(u.data as object))).toEqual([['publicationError']])
  })
})

describe('🔴 J still named by `publishIngestId` while the row is `unpublishing`', () => {
  it('the shared copy J put back is retired before the row is a draft again', async () => {
    row = { ...row, publicationStatus: 'unpublishing', publishIngestId: 'pub-J' }
    await post({ ingestId: 'pub-J', corpus: SHARED })
    expect(retiredCorpora()).toEqual([SHARED])
    expect(statuses()).toEqual(['draft'])
  })

  it('control: the draft re-embed K lands in the draft corpus: nothing retired, a draft', async () => {
    row = { ...row, publicationStatus: 'unpublishing', publishIngestId: 'unpub-K' }
    await post({ ingestId: 'unpub-K', corpus: DRAFT })
    expect(retiredCorpora()).toEqual([])
    expect(statuses()).toEqual(['draft'])
  })
})
