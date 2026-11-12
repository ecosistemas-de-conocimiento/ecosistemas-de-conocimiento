/**
 * A failure's text lands in a reason column (`ingestError`, `corpusError`,
 * `publicationError`) the web hands to the browser. ai-service's `job-failed`
 * message is the raw `err.message` of whatever threw in its worker, and a
 * failed query there is drizzle's `Failed query: <sql>\nparams: <params>`; a
 * database error thrown here carries the same. Neither may reach the column.
 */
import { DrizzleQueryError } from '@payloadcms/db-postgres/drizzle'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/documentColumns', () => import('@/lib/documentColumns.testFake'))
vi.mock('@/lib/aiClient', () => ({
  getAdminAIClient: () => ({ admin: { deleteDocument: async () => ({ deleted: true }) } }),
  getAppAIClient: () => ({}),
}))
vi.mock('@/lib/autoPublish', () => ({ autoPublishParticipantDocument: async () => ({ published: false }) }))

const confirmPublish = vi.fn(async (..._args: unknown[]): Promise<void> => {})
vi.mock('@/lib/publishDocument', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/publishDocument')>()),
  confirmPublish: (...args: unknown[]) => confirmPublish(...args),
}))

import { signCallback } from '@/lib/hmac'

const SECRET = 'd'.repeat(64)
const ROW_TEXT = 'Me llamo Lucía Hernández y vivo con mi hermano Tomás Ruiz'
const QUERY_MESSAGE = `Failed query: insert into "chunks" ("text") values ($1)\nparams: ${ROW_TEXT}`

const updated: Array<Record<string, unknown>> = []
let findByIDImpl: (args: Record<string, unknown>) => Promise<unknown>

const fakePayload = {
  create: async () => ({ id: 901 }),
  findByID: (args: Record<string, unknown>) => findByIDImpl(args),
  update: async (args: Record<string, unknown>) => {
    updated.push(args)
    return {}
  },
  delete: async () => ({}),
}
vi.mock('payload', () => ({ getPayload: async () => fakePayload }))
vi.mock('@payload-config', () => ({ default: {} }))

const post = async (body: string, extra: Record<string, string> = {}) => {
  const { POST } = await import('./route')
  const timestamp = Math.floor(Date.now() / 1000)
  return POST(
    new Request('http://chat.test/api/ai-service/callback', {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'x-aiservice-timestamp': String(timestamp),
        'x-aiservice-signature': signCallback({ timestamp, body, secret: SECRET }),
        ...extra,
      },
    }),
  )
}

const failed = (message: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    event: 'ingest.failed',
    ingestId: 'ing_abc',
    docId: '42',
    error: { code: 'job-failed', message },
    ...over,
  })

/** Every string the route wrote, flattened. */
const written = () => JSON.stringify(updated.map((u) => u.data))

beforeEach(() => {
  updated.length = 0
  confirmPublish.mockReset()
  findByIDImpl = async () => ({ id: 42, ingestId: 'ing_abc', publicationStatus: 'draft' })
  vi.stubEnv('CALLBACK_SECRET', SECRET)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('🔴 ingest.failed on a draft ingest: `ingestError`', () => {
  it('never stores a failed query’s text', async () => {
    const body = failed(QUERY_MESSAGE)
    expect((await post(body)).status).toBe(200)
    expect(updated[0]).toMatchObject({ data: { ingestStatus: 'failed' } })
    expect(String((updated[0]!.data as Record<string, unknown>).ingestError)).toMatch(/^job-failed: /)
    expect(written()).not.toContain(ROW_TEXT)
  })

  it('keeps ai-service’s own message', async () => {
    const body = failed('document text is empty', { error: { code: 'empty', message: 'document text is empty' } })
    await post(body)
    expect(updated[0]).toMatchObject({ data: { ingestError: 'empty: document text is empty' } })
  })
})

describe('🔴 ingest.failed on a conversation turn: `corpusError`', () => {
  beforeEach(() => {
    findByIDImpl = async () => ({ id: 77, corpusIngestId: 'ing_abc' })
  })

  it('never stores a failed query’s text', async () => {
    await post(failed(QUERY_MESSAGE, { docId: 'msg-77' }))
    expect(updated[0]).toMatchObject({ collection: 'messages', data: { corpusStatus: 'failed' } })
    expect(written()).not.toContain(ROW_TEXT)
  })

  it('keeps ai-service’s own message', async () => {
    await post(failed('document produced no chunks', { docId: 'msg-77' }))
    expect(updated[0]).toMatchObject({ data: { corpusError: 'job-failed: document produced no chunks' } })
  })
})

describe('🔴 the publish move: `publicationError`', () => {
  beforeEach(() => {
    findByIDImpl = async () => ({
      id: 42,
      ingestId: 'ing_draft',
      publishIngestId: 'ing_abc',
      publicationStatus: 'publishing',
      organization: 3,
    })
  })

  it('an ingest.failed never stores a failed query’s text', async () => {
    await post(failed(QUERY_MESSAGE))
    expect(updated).toHaveLength(1)
    expect(updated[0]).toMatchObject({ collection: 'documents', data: { publicationError: expect.any(String) } })
    expect(written()).not.toContain(ROW_TEXT)
  })

  it('an ingest.failed keeps ai-service’s own message', async () => {
    await post(failed('corpus eco-3 no longer exists'))
    expect(updated[0]).toMatchObject({ data: { publicationError: 'job-failed: corpus eco-3 no longer exists' } })
  })

  it('a database error finishing the move stores its summary, not its params', async () => {
    confirmPublish.mockRejectedValue(
      new DrizzleQueryError('update "documents" set "redacted_text" = $1', [ROW_TEXT], new Error('deadlock')),
    )
    await post(failed('', { event: 'ingest.completed', error: undefined }))
    expect(updated).toHaveLength(1)
    expect(updated[0]).toMatchObject({ data: { publicationError: 'DrizzleQueryError' } })
    expect(written()).not.toContain(ROW_TEXT)
  })

  it('an ordinary error finishing the move keeps its message', async () => {
    confirmPublish.mockRejectedValue(new Error('ai-service 503 at /v1/admin/documents'))
    await post(failed('', { event: 'ingest.completed', error: undefined }))
    expect(updated[0]).toMatchObject({ data: { publicationError: 'ai-service 503 at /v1/admin/documents' } })
  })
})

describe('🔴 transcribe.failed: `ingestError`', () => {
  beforeEach(() => {
    findByIDImpl = async () => ({ id: 42, transcribeId: 'tr_1', ingestStatus: 'transcribing' })
  })
  const transcribeFailed = (message: string) =>
    JSON.stringify({
      event: 'transcribe.failed',
      transcribeId: 'tr_1',
      externalId: '42',
      error: { code: 'worker_crashed', message },
    })

  it('never stores a failed query’s text', async () => {
    await post(transcribeFailed(QUERY_MESSAGE), { 'x-callback-source': 'audio-service' })
    expect(updated[0]).toMatchObject({ data: { ingestStatus: 'failed' } })
    expect(written()).not.toContain(ROW_TEXT)
  })

  it('keeps audio-service’s own message', async () => {
    await post(transcribeFailed('no audio stream'), { 'x-callback-source': 'audio-service' })
    expect(updated[0]).toMatchObject({ data: { ingestError: 'worker_crashed: no audio stream' } })
  })
})
