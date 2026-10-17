/**
 * Receiver route — the end of the round-trip that actually moves a document out
 * of `embedding`.
 *
 * Both directions are asserted on purpose. A receiver that 401s everything looks
 * "secure" and passes any wrong-signature-only test, while stranding every
 * upload in `embedding` forever with nothing but a warn line to show for it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { signCallback } from '@/lib/hmac'

const SECRET = 'd'.repeat(64)

const created: Array<Record<string, unknown>> = []
const updated: Array<Record<string, unknown>> = []

let createImpl: (args: Record<string, unknown>) => Promise<unknown>

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
  update: async (args: Record<string, unknown>) => {
    updated.push(args)
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
  createImpl = async (args) => {
    created.push(args)
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

  it('🔴 writes with `__skipDocsExtract`, so the save cannot re-run the ingest pipeline', async () => {
    // Without it, `afterChange` re-enters `runExtractAndIngest` and a callback
    // that beat the `ingestId` write re-enqueues and reverts to `embedding`.
    for (const event of ['ingest.completed', 'ingest.failed']) {
      updated.length = 0
      const body = envelope({ event, ingestId: `ing_${event}` })
      await post(body, headersFor(body))
      expect(updated[0]).toMatchObject({ context: { __skipDocsExtract: true } })
    }
  })

  it('finds the row by docId, so a callback that beats the ingestId write still lands', async () => {
    findByIDImpl = async () => ({ id: 42, ingestId: null, publicationStatus: 'draft' })
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
