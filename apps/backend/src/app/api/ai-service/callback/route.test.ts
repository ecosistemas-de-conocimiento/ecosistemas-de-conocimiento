/**
 * Receiver route — the end of the round-trip that actually moves a document out
 * of `embedding`.
 *
 * Both directions are asserted on purpose. A receiver that 401s everything looks
 * "secure" and passes any wrong-signature-only test, while stranding every
 * upload in `embedding` forever with nothing but a warn line to show for it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/documentColumns', () => import('@/lib/documentColumns.testFake'))

// The ai-service admin client the late-turn erase uses. `clientOrgs` records
// which ecosistema each client was built for (it sets `X-AI-Org`).
const deleteDocument = vi.fn(async (_corpus: string, _id: string): Promise<unknown> => ({ deleted: true }))
const clientOrgs: string[] = []
vi.mock('@/lib/aiClient', () => ({
  getAdminAIClient: (org: number | string) => {
    clientOrgs.push(String(org))
    return { admin: { deleteDocument } }
  },
}))

// Owner rule 2026-10-24: a participant's draft is published by the system once
// its draft ingest lands. The rule itself is `lib/autoPublish.test.ts`; here,
// only that the receiver asks at the right moment.
const autoPublish = vi.fn(async (_args: { documentId: unknown }) => ({ published: false, reason: 'not-participant' }))
vi.mock('@/lib/autoPublish', () => ({ autoPublishParticipantDocument: autoPublish }))

import { signCallback } from '@/lib/hmac'

const SECRET = 'd'.repeat(64)

const created: Array<Record<string, unknown>> = []
const updated: Array<Record<string, unknown>> = []
/** The `aiServiceCallbacks` table: what `create` inserted and `delete` has not removed. */
let dedupeRows: Array<{ id: number }> = []

let createImpl: (args: Record<string, unknown>) => Promise<unknown>
let updateImpl: (args: Record<string, unknown>) => Promise<unknown>

/**
 * The row the receiver reads before dispatching.
 *
 * ⚠ The route reads the document FIRST, because a callback carrying
 * `publishIngestId` means "the shared-corpus copy is ready" and takes a
 * completely different path from a plain draft ingest. A mock without
 * `findByID` makes the route log "no documents row" and return, which strands
 * every assertion on an empty `updated` — the failure looks like a broken
 * receiver when it is only a stale mock. Default: a plain draft (no
 * `publishIngestId`), i.e. the ordinary ingest path.
 */
let findByIDImpl: (args: Record<string, unknown>) => Promise<unknown>

const fakePayload = {
  create: (args: Record<string, unknown>) => createImpl(args),
  findByID: (args: Record<string, unknown>) => findByIDImpl(args),
  update: (args: Record<string, unknown>) => updateImpl(args),
  delete: async (args: { collection: string; id: number }) => {
    if (args.collection === 'aiServiceCallbacks') {
      dedupeRows = dedupeRows.filter((r) => r.id !== args.id)
    }
    return {}
  },
}

vi.mock('payload', () => ({
  getPayload: async () => fakePayload,
}))
// Never construct the real config (it builds a postgres adapter).
vi.mock('@payload-config', () => ({ default: {} }))

const post = async (body: string, headers: Record<string, string>) => {
  const { POST } = await import('./route')
  return POST(new Request('http://chat.test/api/ai-service/callback', {
    method: 'POST',
    body,
    headers,
  }))
}

const envelope = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    event: 'ingest.completed',
    ingestId: 'ing_abc',
    docId: '42',
    ...over,
  })

const headersFor = (body: string, opts: { secret?: string; skewSeconds?: number } = {}) => {
  const timestamp = Math.floor(Date.now() / 1000) + (opts.skewSeconds ?? 0)
  return {
    'content-type': 'application/json',
    'x-aiservice-timestamp': String(timestamp),
    'x-aiservice-signature': signCallback({
      timestamp,
      body,
      secret: opts.secret ?? SECRET,
    }),
  }
}

beforeEach(() => {
  created.length = 0
  updated.length = 0
  dedupeRows = []
  createImpl = async (args) => {
    created.push(args)
    const row = { id: 900 + created.length }
    dedupeRows.push(row)
    return row
  }
  updateImpl = async (args) => {
    updated.push(args)
    return {}
  }
  // A plain draft: no `publishIngestId`, so the receiver takes the ordinary
  // ingest path rather than the publish-move path.
  findByIDImpl = async () => ({ id: 42, ingestId: 'ing_abc', publicationStatus: 'draft' })
  vi.stubEnv('CALLBACK_SECRET', SECRET)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('POST /api/ai-service/callback — correct signature', () => {
  it('accepts (200) and flips the document to `ready`', async () => {
    const body = envelope()
    const res = await post(body, headersFor(body))

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ ok: true, dispatched: true })
    expect(updated).toHaveLength(1)
    expect(updated[0]).toMatchObject({
      collection: 'documents',
      id: 42,
      data: { ingestStatus: 'ready' },
    })
  })

  it('flips to `failed` on ingest.failed — the only path that reports a bad ingest', async () => {
    const body = envelope({ event: 'ingest.failed', error: { message: 'boom' } })
    const res = await post(body, headersFor(body))

    expect(res.status).toBe(200)
    expect(updated[0]).toMatchObject({ data: { ingestStatus: 'failed' } })
  })

  it('🔴 writes ONLY the ingest columns, through the narrow write', async () => {
    // A whole-row write would put back whatever graph status it read, and would
    // re-fire `afterChange`. The narrow write (`lib/documentColumns.ts`, mocked
    // here by its test fake) touches these two columns and runs no hook.
    for (const event of ['ingest.completed', 'ingest.failed']) {
      updated.length = 0
      findByIDImpl = async () => ({ id: 42, ingestId: `ing_${event}`, publicationStatus: 'draft' })
      const body = envelope({ event, ingestId: `ing_${event}` })
      await post(body, headersFor(body))
      expect(Object.keys(updated[0]!.data as Record<string, unknown>).sort()).toEqual([
        'ingestError',
        'ingestStatus',
      ])
    }
  })

  it('finds the row by docId, so a callback that beats the ingestId write still lands', async () => {
    // The race from commit 7bf0622: the row is `embedding` and has no id yet.
    findByIDImpl = async () => ({
      id: 42,
      ingestId: null,
      ingestStatus: 'embedding',
      publicationStatus: 'draft',
    })
    const body = envelope()
    await post(body, headersFor(body))
    expect(updated[0]).toMatchObject({ id: 42, data: { ingestStatus: 'ready' } })
  })

  it('dedupes a retried event: 200, no second document write', async () => {
    createImpl = async () => {
      throw Object.assign(new Error('duplicate key value'), { code: '23505' })
    }
    const body = envelope()
    const res = await post(body, headersFor(body))

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ deduped: true, dispatched: false })
    expect(updated).toHaveLength(0)
  })
})

describe('🔴 auto-publish after the draft ingest', () => {
  beforeEach(() => autoPublish.mockClear())

  it('asks once the draft ingest completed, after writing `ready`', async () => {
    const body = envelope()
    const res = await post(body, headersFor(body))
    expect(res.status).toBe(200)
    expect(autoPublish).toHaveBeenCalledTimes(1)
    expect(autoPublish.mock.calls[0]![0]).toMatchObject({ documentId: 42 })
    expect(updated[0]).toMatchObject({ data: { ingestStatus: 'ready' } })
  })

  it('does not ask on ingest.failed', async () => {
    const body = envelope({ event: 'ingest.failed', error: { message: 'boom' } })
    await post(body, headersFor(body))
    expect(autoPublish).not.toHaveBeenCalled()
  })

  it('does not ask on a superseded ingest', async () => {
    findByIDImpl = async () => ({ id: 42, ingestId: 'ing_other', publicationStatus: 'draft' })
    const body = envelope()
    await post(body, headersFor(body))
    expect(autoPublish).not.toHaveBeenCalled()
  })

  it('a failed auto-publish never turns the callback into a 500', async () => {
    autoPublish.mockImplementationOnce(async () => {
      throw new Error('boom')
    })
    const body = envelope()
    const res = await post(body, headersFor(body))
    expect(res.status).toBe(200)
  })
})

describe('🔴 a late callback from a superseded ingest', () => {
  it('is ignored when the row carries a different ingestId', async () => {
    // A retry cleared the id and enqueued again; the OLD run's `failed` lands.
    findByIDImpl = async () => ({ id: 42, ingestId: 'ing_new', ingestStatus: 'embedding', publicationStatus: 'draft' })
    const body = envelope({ event: 'ingest.failed', ingestId: 'ing_old', error: { message: 'old' } })
    const res = await post(body, headersFor(body))
    expect(res.status).toBe(200)
    expect(updated).toHaveLength(0)
  })

  it('is ignored when the row has no ingestId and is not embedding', async () => {
    // `pending` after a retry, before the new enqueue: no run can be reporting.
    for (const ingestStatus of ['pending', 'failed', 'ready']) {
      findByIDImpl = async () => ({ id: 42, ingestId: null, ingestStatus, publicationStatus: 'draft' })
      const body = envelope({ ingestId: `ing_${ingestStatus}` })
      await post(body, headersFor(body))
    }
    expect(updated).toHaveLength(0)
  })

  it('still heals a row the janitor stamped failed, when the ids match', async () => {
    findByIDImpl = async () => ({ id: 42, ingestId: 'ing_abc', ingestStatus: 'failed', publicationStatus: 'draft' })
    const body = envelope()
    await post(body, headersFor(body))
    expect(updated[0]).toMatchObject({ data: { ingestStatus: 'ready', ingestError: null } })
  })
})

describe('🔴 a handler that throws', () => {
  it('answers 500 and leaves no dedupe row, so the sender’s retry is processed', async () => {
    updateImpl = async () => {
      throw new Error('connection terminated unexpectedly')
    }
    const body = envelope()
    const res = await post(body, headersFor(body))
    expect(res.status).toBe(500)
    expect(created).toHaveLength(1)
    expect(dedupeRows).toEqual([])

    // The retry: the database is back, and the event is NOT deduped away.
    updateImpl = async (args) => {
      updated.push(args)
      return {}
    }
    const retry = await post(body, headersFor(body))
    expect(retry.status).toBe(200)
    await expect(retry.json()).resolves.toMatchObject({ deduped: false, dispatched: true })
    expect(updated[0]).toMatchObject({ data: { ingestStatus: 'ready' } })
  })

  it('answers 500 when the row cannot be READ for a reason other than "not found"', async () => {
    findByIDImpl = async () => {
      throw new Error('connection refused')
    }
    const body = envelope()
    const res = await post(body, headersFor(body))
    expect(res.status).toBe(500)
    expect(dedupeRows).toEqual([])
  })

  it('answers 200 for a row that does not exist — a retry cannot fix that', async () => {
    findByIDImpl = async () => {
      throw Object.assign(new Error('Not Found'), { status: 404 })
    }
    const body = envelope()
    const res = await post(body, headersFor(body))
    expect(res.status).toBe(200)
  })
})

describe('🔴 a turn that lands after its conversation was deleted', () => {
  // Audit 2026-10-17 §3 item 2: the conversation went while this turn was
  // `embedding`; ai-service created the document only afterwards, in its
  // worker, so the post-commit erase found nothing.
  beforeEach(() => {
    deleteDocument.mockReset()
    deleteDocument.mockImplementation(async () => ({ deleted: true }))
    clientOrgs.length = 0
    findByIDImpl = async (args) => {
      if (args.collection === 'messages') throw Object.assign(new Error('Not Found'), { status: 404 })
      throw new Error(`unexpected findByID ${String(args.collection)}`)
    }
  })

  it('🔴 erases msg-<id> from its shared corpus, with that ecosistema’s client', async () => {
    const body = envelope({ docId: 'msg-77', corpus: 'eco-3' })
    const res = await post(body, headersFor(body))

    expect(res.status).toBe(200)
    expect(deleteDocument.mock.calls).toEqual([['eco-3', 'msg-77']])
    expect(clientOrgs).toEqual(['3'])
    expect(updated).toHaveLength(0)
  })

  it('erases on ingest.failed too (a partial landing is still a landing)', async () => {
    const body = envelope({ event: 'ingest.failed', docId: 'msg-77', corpus: 'eco-3' })
    await post(body, headersFor(body))
    expect(deleteDocument.mock.calls).toEqual([['eco-3', 'msg-77']])
  })

  it('ai-service’s own not-found is success', async () => {
    deleteDocument.mockImplementation(async () => {
      throw Object.assign(new Error('nf'), { status: 404, code: 'DOCUMENT_NOT_FOUND' })
    })
    const body = envelope({ docId: 'msg-77', corpus: 'eco-3' })
    expect((await post(body, headersFor(body))).status).toBe(200)
  })

  it('🔴 a failed erase answers 500 and forgets the event, so ai-service retries', async () => {
    deleteDocument.mockImplementation(async () => {
      throw Object.assign(new Error('unavailable'), { status: 503 })
    })
    const body = envelope({ docId: 'msg-77', corpus: 'eco-3' })
    const res = await post(body, headersFor(body))
    expect(res.status).toBe(500)
    expect(dedupeRows).toEqual([])
  })

  it('never erases outside a shared eco-<id> corpus', async () => {
    for (const corpus of [undefined, 'eco-3-draft-5', 'other']) {
      const body = envelope({ docId: 'msg-77', ...(corpus ? { corpus } : {}) })
      expect((await post(body, headersFor(body))).status).toBe(200)
    }
    expect(deleteDocument).not.toHaveBeenCalled()
  })

  it('never erases a turn whose row still exists (a superseded run is only ignored)', async () => {
    findByIDImpl = async () => ({ id: 77, corpusIngestId: 'ing_new' })
    const body = envelope({ docId: 'msg-77', corpus: 'eco-3', ingestId: 'ing_old' })
    expect((await post(body, headersFor(body))).status).toBe(200)
    expect(deleteDocument).not.toHaveBeenCalled()
    expect(updated).toHaveLength(0)
  })
})

describe('POST /api/ai-service/callback — rejected', () => {
  it('401s a wrong signature and does NOT touch the document', async () => {
    const body = envelope()
    const res = await post(body, headersFor(body, { secret: 'e'.repeat(64) }))

    expect(res.status).toBe(401)
    expect(updated).toHaveLength(0)
    expect(created).toHaveLength(0)
  })

  it('401s when CALLBACK_SECRET is unset — the live "documents hang" failure', async () => {
    // This is what a deployed env with a missing secret looks like from the
    // receiver's side: ai-service calls, chat 401s, the row never moves. The
    // boot check in lib/callbackConfig.ts exists to make this state loud.
    vi.stubEnv('CALLBACK_SECRET', '')
    const body = envelope()
    const res = await post(body, headersFor(body))

    expect(res.status).toBe(401)
    expect(updated).toHaveLength(0)
  })

  it('401s a stale timestamp outside the replay window', async () => {
    const body = envelope()
    const res = await post(body, headersFor(body, { skewSeconds: -3600 }))
    expect(res.status).toBe(401)
  })

  it('401s a body tampered with after signing', async () => {
    const body = envelope()
    const headers = headersFor(body)
    const res = await post(envelope({ docId: '999' }), headers)
    expect(res.status).toBe(401)
    expect(updated).toHaveLength(0)
  })

  it('400s a signed body that is not JSON — never a retryable 5xx', async () => {
    const body = 'not json'
    const res = await post(body, headersFor(body))
    expect(res.status).toBe(400)
  })

  it('500s only on a genuine dedupe failure, so ai-service retries', async () => {
    createImpl = async () => {
      throw new Error('connection terminated unexpectedly')
    }
    const body = envelope()
    const res = await post(body, headersFor(body))
    expect(res.status).toBe(500)
  })
})
