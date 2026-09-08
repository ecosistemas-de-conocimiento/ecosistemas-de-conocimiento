/**
 * 🔴 THE RETIRE STEP MUST TOLERATE "IT WAS NEVER THERE".
 *
 * Both publish transitions call `admin.setDocumentValidity` to retire a document
 * from the corpus it is leaving. ai-service answers `404` when that corpus does
 * not exist (`CORPUS_NOT_FOUND`) or does not hold the document
 * (`DOCUMENT_NOT_FOUND`) — and both are TRUE STATES of this product, not
 * anomalies: only `INGESTABLE_KINDS` (pdf, docx, audio) are ever ingested, so a
 * `kind: 'markdown'` document — the DEFAULT kind — has no draft corpus at all.
 *
 * Before the fix, `confirmPublish` threw on that 404 and the row stayed at
 * `publishing` with `publicationError: 'ai-service request failed (status 404)'`
 * permanently: content sitting in the ecosistema's SHARED corpus (so every
 * colleague's chat could retrieve it) while the row said it was not published
 * (so no colleague could see it in a list, and the uploader could neither finish
 * the publish nor undo it). Caught by `e2e/publish.e2e.ts`.
 *
 * ⚠ These tests use fake clients on purpose. The live-stack proof is in the e2e
 * suite; what belongs here is the BRANCH — that a 404 is swallowed, that every
 * other failure is still propagated, and that the row is only flipped when the
 * retire really did settle.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Payload } from 'payload'

import {
  UNEXPLAINED_PUBLISH_FAILURE,
  confirmPublish,
  failPublish,
  unpublish,
  type CorpusMover,
} from './publishDocument'

const ORG = 7
const USER = 42
// ⚠ `contentKind: 'documento'` is load-bearing, not decoration. `corpusTextFor`
// reads the RAW value and fails CLOSED, so a fixture without one is treated as
// gated material with no `redactedText` and refuses to publish. See
// `mustPassAnonymisationGate` in `lib/anonymiseDocument.ts`.
const DOC = {
  id: 99,
  name: 'Acta',
  kind: 'markdown',
  contentKind: 'documento',
  extractedText: 'texto',
  organization: ORG,
  uploadedBy: USER,
}

const DRAFT_CORPUS = `eco-${ORG}-draft-${USER}`
const PUBLISHED_CORPUS = `eco-${ORG}`

/** The one call shape these transitions make on Payload. */
type UpdateArgs = { data: Record<string, unknown> }

function fakePayload() {
  const update = vi.fn(async (_args: UpdateArgs) => ({}))
  return {
    payload: { update, logger: { warn: vi.fn() } } as unknown as Payload,
    update,
    /** The `data` of the nth `payload.update` call, or a loud failure. */
    dataOf(n: number): Record<string, unknown> {
      const call = update.mock.calls[n]
      if (!call) throw new Error(`payload.update was not called ${n + 1} time(s)`)
      return call[0].data
    },
  }
}

/** An error shaped like `@edc/ai-client`'s `NotFoundError`. */
function notFound(message: string) {
  return Object.assign(new Error(message), { status: 404, name: 'NotFoundError' })
}

function mover(setDocumentValidity: CorpusMover['admin']['setDocumentValidity']): CorpusMover {
  return {
    ingest: { enqueue: vi.fn(async () => ({ ingestId: 'ing-1' })) },
    admin: { setDocumentValidity },
  }
}

// ---------------------------------------------------------------------------
// confirmPublish
// ---------------------------------------------------------------------------

describe('confirmPublish — retiring the draft copy', () => {
  it('retires from the uploader\'s draft corpus and flips the row to published', async () => {
    const { payload, update, dataOf } = fakePayload()
    const seen: Array<[string, string]> = []
    const retire = vi.fn(async (corpus: string, externalId: string) => {
      seen.push([corpus, externalId])
      return {}
    })
    await confirmPublish(DOC, { payload, client: mover(retire) })

    expect(seen).toEqual([[DRAFT_CORPUS, '99']])
    expect(update).toHaveBeenCalledTimes(1)
    expect(dataOf(0).publicationStatus).toBe('published')
  })

  it('🔴 completes when the draft corpus does not exist at all', async () => {
    // The markdown case: nothing was ever ingested, so there is no corpus. The
    // publish must still finish — the shared-corpus ingest already succeeded.
    const { payload, dataOf } = fakePayload()
    const retire = vi.fn(async () => {
      throw notFound(`corpus '${DRAFT_CORPUS}' not found`)
    })

    await expect(confirmPublish(DOC, { payload, client: mover(retire) })).resolves.toBeUndefined()
    expect(dataOf(0).publicationStatus).toBe('published')
    expect(dataOf(0).publicationError).toBeNull()
  })

  it('🔴 completes when the corpus exists but does not hold this document', async () => {
    const { payload, dataOf } = fakePayload()
    const retire = vi.fn(async () => {
      throw notFound(`document '99' not found in corpus '${DRAFT_CORPUS}'`)
    })

    await expect(confirmPublish(DOC, { payload, client: mover(retire) })).resolves.toBeUndefined()
    expect(dataOf(0).publicationStatus).toBe('published')
  })

  it('🔴 still FAILS on any non-404 — and leaves the row un-flipped', async () => {
    // ⚠ The point of the tolerance is narrow. A 403 (wrong key), a 500, or a
    // dropped connection means the retire genuinely did not happen, and flipping
    // the row would claim a draft copy had been retired when it is still live in
    // the uploader's private corpus.
    const { payload, update } = fakePayload()
    for (const err of [
      Object.assign(new Error('forbidden'), { status: 403 }),
      Object.assign(new Error('boom'), { status: 500 }),
      new Error('socket hang up'),
    ]) {
      update.mockClear()
      const retire = vi.fn(async () => {
        throw err
      })
      await expect(confirmPublish(DOC, { payload, client: mover(retire) })).rejects.toThrow()
      expect(update).not.toHaveBeenCalled()
    }
  })
})

// ---------------------------------------------------------------------------
// unpublish
// ---------------------------------------------------------------------------

describe('unpublish — retiring the shared copy', () => {
  it('retires from the SHARED corpus first, then re-ingests into drafts', async () => {
    const { payload } = fakePayload()
    const order: string[] = []
    const retire = vi.fn(async (corpus: string) => {
      order.push(`retire:${corpus}`)
      return {}
    })
    const client = mover(retire)
    client.ingest.enqueue = vi.fn(async (req: { corpus: string }) => {
      order.push(`ingest:${req.corpus}`)
      return { ingestId: 'ing-2' }
    })

    const result = await unpublish(DOC, { payload, client })

    // 🔴 Sharing must stop BEFORE the slow re-embed, not after it.
    expect(order).toEqual([`retire:${PUBLISHED_CORPUS}`, `ingest:${DRAFT_CORPUS}`])
    expect(result.corpus).toBe(DRAFT_CORPUS)
  })

  it('🔴 proceeds when the shared corpus has no such document', async () => {
    // "Not in the shared corpus" IS the guarantee unpublishing has to make, so a
    // 404 here means the job is already half done — not that it cannot be done.
    const { payload } = fakePayload()
    const retire = vi.fn(async () => {
      throw notFound(`document '99' not found in corpus '${PUBLISHED_CORPUS}'`)
    })
    const client = mover(retire)

    await expect(unpublish(DOC, { payload, client })).resolves.toMatchObject({
      corpus: DRAFT_CORPUS,
    })
    expect(client.ingest.enqueue).toHaveBeenCalledTimes(1)
  })

  it('does NOT re-ingest when the retire fails for any other reason', async () => {
    // ⚠ Ordering is the safety property: if we cannot prove the document left
    // the shared corpus, we must not report progress by moving on.
    const { payload } = fakePayload()
    const retire = vi.fn(async () => {
      throw Object.assign(new Error('nope'), { status: 500 })
    })
    const client = mover(retire)

    await expect(unpublish(DOC, { payload, client })).rejects.toThrow()
    expect(client.ingest.enqueue).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// failPublish
// ---------------------------------------------------------------------------

describe('failPublish — a failure with no words in it is still a failure', () => {
  it('writes the reason it was given, trimmed to the field', async () => {
    const { payload, dataOf } = fakePayload()
    await failPublish(DOC, { payload }, 'Rate limit exceeded')
    expect(dataOf(0).publicationError).toBe('Rate limit exceeded')
  })

  it.each(['', '   ', '\n'])(
    '🔴 substitutes a real message for a blank reason (%j), which would be invisible',
    async (blank) => {
      // Two independent ways a blank reason reaches here: `envelope.error` off
      // the wire on an `ingest.failed`, and `new Error().message`.
      //
      // ⚠ AN EMPTY STRING IS UNRECOVERABLE, not merely ugly. The UI shows the
      // error only when populated, so the user sees nothing — and
      // `publishJanitor.ts` cannot rescue the row either, because its `where`
      // uses `publicationError: { exists: false }`, which Payload compiles to
      // `IS NULL` alone. A row holding `''` is never returned by the sweep
      // whose whole job is to make this state visible.
      const { payload, dataOf } = fakePayload()
      await failPublish(DOC, { payload }, blank)

      const written = String(dataOf(0).publicationError)
      expect(written).toBe(UNEXPLAINED_PUBLISH_FAILURE)
      expect(written.trim()).not.toBe('')
      expect(written).toMatch(/servicio de IA/)
      expect(written.length).toBeLessThanOrEqual(500)
    },
  )
})
