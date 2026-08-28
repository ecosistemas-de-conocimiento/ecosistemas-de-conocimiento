/**
 * What actually reaches the ai-service ingest call.
 *
 * There is no callback feature-switch, so there is no configuration in which an
 * operator meant to turn callbacks off. Two properties follow, and both are
 * asserted here against the real `Documents.ts` enqueue code:
 *
 *   1. Configured ⇒ a `callbackUrl` is on the wire. Without it the round-trip
 *      never starts and the row is stranded at `embedding`.
 *   2. Misconfigured ⇒ the ingest still happens, just without `callbackUrl`.
 *      ai-service validates that field with `z.string().url()`, so passing a
 *      malformed value 400s the INGEST call — losing the document entirely
 *      rather than losing its status update. Degrade, never escalate.
 *
 * 🔴 And the third, which is the tenant boundary: an upload goes into the
 * UPLOADER'S PRIVATE DRAFT CORPUS, never into the ecosistema's shared one.
 * Ingesting straight into `eco-{orgId}` would share every document the instant
 * it finished uploading — the opposite of what `publicationStatus: 'draft'`
 * promises on the row.
 *
 * No network and no inference: `@/lib/aiClient` is mocked wholesale. `lib/corpus`
 * is NOT mocked — the corpus name it builds is the thing under test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CALLBACK_BASE_URL_VAR, CALLBACK_SECRET_VAR } from '@/lib/callbackConfig'
import { enqueueIngestForDoc } from './Documents'

const SECRET = 'f'.repeat(64)

const enqueue = vi.fn(async (_args: Record<string, unknown>) => ({ ingestId: 'ing_test_1' }))

vi.mock('@/lib/aiClient', () => ({
  getAppAIClient: () => ({ ingest: { enqueue } }),
}))

const updates: Array<Record<string, unknown>> = []
const fakePayload = {
  update: async (args: Record<string, unknown>) => {
    updates.push(args)
    return {}
  },
}

const run = () =>
  enqueueIngestForDoc({
    // Only `.update` is exercised; the rest of the Payload surface is irrelevant
    // here and standing it up would mean a real DB.
    payload: fakePayload as unknown as Parameters<typeof enqueueIngestForDoc>[0]['payload'],
    docId: 42,
    organizationId: 10,
    uploadedById: 3,
    fresh: { name: 'Acta.pdf', kind: 'pdf' },
    extractedText: 'contenido extraído',
  })

const wireArgs = (): Record<string, unknown> => enqueue.mock.calls[0]![0]

/**
 * ⚠ FIND THE UPDATE BY WHAT IT CARRIES, NOT BY ITS INDEX.
 *
 * The anonymisation gate writes the row's `anonymisationStatus` before the
 * ingest ever starts (`n/a` for an ordinary `documento`), so the enqueue's own
 * writes are no longer the first two. These assertions are about ORDER between
 * two specific writes, not about their absolute position, and pinning them to
 * `updates[0]` / `updates[1]` made a correct change look like a regression.
 */
const indexOfUpdate = (key: string): number =>
  updates.findIndex((u) => Object.prototype.hasOwnProperty.call(
    (u.data ?? {}) as Record<string, unknown>, key))

beforeEach(() => {
  enqueue.mockClear()
  updates.length = 0
  vi.stubEnv(CALLBACK_SECRET_VAR, SECRET)
  vi.stubEnv(CALLBACK_BASE_URL_VAR, 'https://backend.test')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('enqueue with callbacks configured', () => {
  it('puts the receiver URL on the wire', async () => {
    await run()

    expect(enqueue).toHaveBeenCalledOnce()
    expect(wireArgs().callbackUrl).toBe('https://backend.test/api/ai-service/callback')
    expect(wireArgs().corpus).toBe('eco-10-draft-3')
  })

  it('marks the row `embedding` before enqueue and records the ingestId after', async () => {
    // Order matters: `embedding` must be visible even if the enqueue call
    // hangs, otherwise a stuck upload looks like nothing ever happened.
    await run()

    const embeddingAt = indexOfUpdate('ingestStatus')
    const ingestIdAt = indexOfUpdate('ingestId')
    expect(updates[embeddingAt]).toMatchObject({ data: { ingestStatus: 'embedding' } })
    expect(updates[ingestIdAt]).toMatchObject({ data: { ingestId: 'ing_test_1' } })
    expect(embeddingAt).toBeLessThan(ingestIdAt)
    // Never flipped to a done state on the 202 — only the callback may do that.
    expect(JSON.stringify(updates)).not.toContain('ready')
  })

  it('does not send a callbackUrl the ai-service would reject', async () => {
    await run()
    expect(() => new URL(wireArgs().callbackUrl as string)).not.toThrow()
  })
})

describe('enqueue with callbacks misconfigured — degrade, do not break ingestion', () => {
  it.each([
    ['base URL unset', CALLBACK_BASE_URL_VAR, ''],
    ['base URL is a bare host', CALLBACK_BASE_URL_VAR, 'chat.test'],
    ['base URL is a relative path', CALLBACK_BASE_URL_VAR, '/api'],
    ['base URL is a placeholder', CALLBACK_BASE_URL_VAR, 'unset'],
    ['secret unset', CALLBACK_SECRET_VAR, ''],
  ])('still ingests, with no callbackUrl (%s)', async (_label, varName, value) => {
    vi.stubEnv(varName, value)

    await run()

    expect(enqueue).toHaveBeenCalledOnce()
    expect(wireArgs()).not.toHaveProperty('callbackUrl')
    // The document is still enqueued and still gets embedded upstream.
    expect(wireArgs().corpus).toBe('eco-10-draft-3')
    expect(updates[indexOfUpdate('ingestId')]).toMatchObject({
      data: { ingestId: 'ing_test_1' },
    })
  })

  it('warns at the call site naming what is missing', async () => {
    vi.stubEnv(CALLBACK_BASE_URL_VAR, '')
    await run()

    const warned = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .flat()
      .join(' ')
    expect(warned).toContain(CALLBACK_BASE_URL_VAR)
    expect(warned).toContain('embedding')
  })

  it('never leaks the secret into the warning', async () => {
    vi.stubEnv(CALLBACK_BASE_URL_VAR, '')
    await run()

    const warned = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .flat()
      .join(' ')
    expect(warned).not.toContain(SECRET)
  })
})

describe('enqueue failure', () => {
  it('marks the row `failed` rather than leaving it at `embedding`', async () => {
    enqueue.mockRejectedValueOnce(new Error('ai-service 400'))

    await expect(run()).resolves.toBeUndefined()

    expect(updates.at(-1)).toMatchObject({ data: { ingestStatus: 'failed' } })
  })
})

describe('🔴 the corpus an upload lands in', () => {
  it('is the UPLOADER\'S PRIVATE DRAFT corpus, never the shared one', async () => {
    await run()
    const corpus = wireArgs().corpus as string
    expect(corpus).toBe('eco-10-draft-3')
    // The shared corpus for the same ecosistema. Landing here would publish
    // every document the moment it finished uploading.
    expect(corpus).not.toBe('eco-10')
  })

  it('tags the chunks with the ecosistema and the draft state', async () => {
    await run()
    const documents = wireArgs().documents as Array<{ metadata: Record<string, unknown> }>
    expect(documents[0]!.metadata).toMatchObject({
      organizationId: '10',
      publication: 'draft',
    })
  })
})
