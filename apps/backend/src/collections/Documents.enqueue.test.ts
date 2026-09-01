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
    // ⚠ `contentKind` is REQUIRED on a fixture now: the gate reads the raw value
    // and fails closed on anything it does not recognise, so a row assembled
    // without one is treated as gated material. See `mustPassAnonymisationGate`.
    fresh: {
      name: 'Acta.pdf',
      kind: 'pdf',
      contentKind: 'documento',
      // 🔴 A REQUIRED KEY. `enqueueIngestForDoc` refuses a `held`/`rejected` row
      // and honours an `approved` one, and the type makes it impossible for a
      // caller to omit the field — which is how the audio path lost it.
      anonymisationStatus: null,
    },
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

// ---------------------------------------------------------------------------
// 🔴 A SETTLED ROW NEVER REACHES THE GATE, WHICHEVER DOOR IT COMES THROUGH
// ---------------------------------------------------------------------------

describe('🔴 enqueueIngestForDoc refuses a settled row', () => {
  /**
   * ── WHY THE GUARD IS HERE AND NOT IN `runExtractAndIngest` ────────────────
   *
   * It used to be one level up, in `runExtractAndIngest`. But
   * `dispatchTranscribeCompleted` — the audio callback — calls
   * `enqueueIngestForDoc` DIRECTLY, so a replayed `transcribe.completed` walked
   * straight past it. That callback's idempotency guard needs an `ingestId`,
   * which a held row never got, so the replay was not short-circuited either.
   *
   * The result: a REJECTED testimony re-ran a probabilistic gate, and a `ready`
   * verdict would have ingested it — into a corpus with no per-document delete.
   * Exactly the failure `lib/anonymiseDocument.ts` opens by warning about: "the
   * one that got forgotten would be the audio path".
   */
  const settled = (anonymisationStatus: string) => ({
    payload: fakePayload as unknown as Parameters<typeof enqueueIngestForDoc>[0]['payload'],
    docId: 42,
    organizationId: 10,
    uploadedById: 3,
    fresh: {
      name: 'Voz de la asamblea',
      kind: 'audio',
      contentKind: 'testimonio',
      anonymisationStatus,
      extractedText: 'el testimonio completo',
    },
    extractedText: 'el testimonio completo',
  })

  it('refuses a REJECTED row — a human said no, and a replay must not re-ask', async () => {
    await enqueueIngestForDoc(settled('rejected'))
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('refuses a HELD row — re-running the gate is what a review is for', async () => {
    await enqueueIngestForDoc(settled('held'))
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('🔴 honours an APPROVED row: ingests the human’s text, and never re-gates', async () => {
    // Without the field on the slice, `fresh.anonymisationStatus` was
    // `undefined` on the audio path, the approval branch never fired, and a
    // replay silently discarded what a reviewer had cleared — replacing it with
    // whatever a fresh gate run produced from the RAW original.
    await enqueueIngestForDoc({
      ...settled('approved'),
      fresh: {
        name: 'Voz de la asamblea',
        kind: 'audio',
        contentKind: 'testimonio',
        anonymisationStatus: 'approved',
        redactedText: 'Lo que [Persona A] aprobó.',
      },
      extractedText: 'El original, con María López en él.',
    })

    expect(enqueue).toHaveBeenCalledTimes(1)
    const wire = JSON.stringify(enqueue.mock.calls[0]![0])
    expect(wire).toContain('Lo que [Persona A] aprobó.')
    expect(wire).not.toContain('María López')
  })
})

// ---------------------------------------------------------------------------
// 🔴 The rate limit — the same 100/min bucket the publish move hits
// ---------------------------------------------------------------------------

/**
 * ai-service caps `/v1` at 100 requests per minute per API key. A bulk upload or
 * a corpus seed walks straight into that, and before the fix EVERY refusal was a
 * terminal `ingest_enqueue_failed` a human had to retry by hand, one row at a
 * time.
 *
 * ⚠ Waiting is nearly free on THIS path, unlike `beginPublish`: this function
 * runs inside a `setImmediate` after the HTTP response has already gone out, so
 * nothing is holding a connection open while it sleeps.
 */
describe('enqueue when ai-service is rate-limiting', () => {
  const rateLimited = (retryAfterSeconds: number) =>
    Object.assign(new Error('Rate limit exceeded. Retry after ~1s.'), {
      status: 429,
      name: 'RateLimitedError',
      retryAfterSeconds,
    })

  /**
   * ⚠ IN `afterEach`, NOT AT THE END OF EACH TEST BODY. `beforeEach` only calls
   * `mockClear`, which keeps implementations — so a test that sets a throwing
   * implementation and then FAILS an assertion would leave `enqueue` throwing
   * for every later test in this file, turning one red test into a cascade.
   */
  afterEach(() => {
    enqueue.mockReset()
    enqueue.mockImplementation(async () => ({ ingestId: 'ing_test_1' }))
  })

  it('🔴 waits and retries a 429 instead of failing the document', async () => {
    // `retryAfterSeconds: 1` so the suite pays about a second, not a minute. The
    // wait is the SERVER'S number, not a guess — see `lib/aiRetry.ts`.
    enqueue.mockImplementationOnce(async () => {
      throw rateLimited(1)
    })

    await run()

    expect(enqueue).toHaveBeenCalledTimes(2)
    // The document lands normally: no `failed`, no error text on the row.
    expect(updates[indexOfUpdate('ingestId')]).toMatchObject({ data: { ingestId: 'ing_test_1' } })
    expect(JSON.stringify(updates)).not.toContain('ingest_enqueue_failed')
  })

  it('🔴 still records a VISIBLE failure when the backoff budget runs out', async () => {
    // A bounded wait is only safe because giving up is legible. A zero budget is
    // the degenerate case: try once, never sleep, write down what happened.
    vi.stubEnv('AI_RETRY_TOTAL_WAIT_MS', '0')
    enqueue.mockImplementation(async () => {
      throw rateLimited(30)
    })

    await run()

    expect(enqueue).toHaveBeenCalledTimes(1)
    // ⚠ The LAST write, not the first. `ingestError: null` is also written on the
    // way in (alongside `ingestStatus: 'embedding'`) to clear a previous
    // attempt's reason, so `indexOfUpdate` finds that one.
    const failed = updates.at(-1)!.data as Record<string, unknown>
    expect(failed.ingestStatus).toBe('failed')
    expect(String(failed.ingestError)).toContain('Rate limit exceeded')
  })

  it('does NOT retry an error that will not fix itself', async () => {
    // A 500 might mean the ingest was half-created; re-sending would embed the
    // document twice into the same corpus.
    enqueue.mockImplementation(async () => {
      throw Object.assign(new Error('upstream exploded'), { status: 500 })
    })

    await run()

    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(updates)).toContain('ingest_enqueue_failed')
  })
})
