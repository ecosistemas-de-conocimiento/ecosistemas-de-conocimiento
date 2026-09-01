/**
 * 🔴 THE 99 INVISIBLE ROWS.
 *
 * `beginPublish` writes `publicationStatus: 'publishing'` and THEN calls
 * `ingest.enqueue`. When ai-service's rate limiter refused that call, the throw
 * went straight past every caller: the seed logged a warning, the endpoint
 * returned a 500, and the ROW was left in the in-flight state with no
 * `publicationError` and no `publishIngestId`.
 *
 * Measured on `edc_backend` after a 285-document seed: 145 rows in `publishing`,
 * 99 of them in exactly that shape. A user sees "still working" forever. An
 * operator sees nothing to act on.
 *
 * ⚠ THE ASSERTION THAT MATTERS IN THIS FILE IS NOT "IT RETRIED". It is that
 * WHATEVER HAPPENS, THE ROW ENDS UP SAYING SO. Retrying is an optimisation;
 * a visible failure is the correctness property.
 *
 * ⚠ Fake clients on purpose, and `sleep` is injected — see `aiRetry.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Payload } from 'payload'

import { beginPublish, unpublish, type CorpusMover } from './publishDocument'

const ORG = 7
const USER = 42

// `contentKind: 'documento'` is load-bearing — `corpusTextFor` fails CLOSED and
// treats a fixture without one as gated material. See `publishDocument.test.ts`.
const DOC = {
  id: 99,
  name: 'Acta',
  kind: 'markdown',
  contentKind: 'documento',
  extractedText: 'texto',
  organization: ORG,
  uploadedBy: USER,
}

/** Shaped like `@edc/ai-client`'s `RateLimitedError`. */
function rateLimited(retryAfterSeconds = 5) {
  return Object.assign(new Error(`Rate limit exceeded. Retry after ~${retryAfterSeconds}s.`), {
    status: 429,
    name: 'RateLimitedError',
    retryAfterSeconds,
  })
}

type UpdateArgs = { data: Record<string, unknown> }

function fakePayload() {
  const update = vi.fn(async (_args: UpdateArgs) => ({}))
  return {
    payload: { update, logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } } as unknown as Payload,
    update,
    /** Every `data` object written, in order. */
    writes(): Record<string, unknown>[] {
      return update.mock.calls.map((c) => c[0].data)
    },
    /** The merged final view of the row, as the writes left it. */
    finalRow(): Record<string, unknown> {
      return Object.assign({}, ...update.mock.calls.map((c) => c[0].data))
    },
  }
}

function mover(
  enqueue: CorpusMover['ingest']['enqueue'],
  setDocumentValidity: CorpusMover['admin']['setDocumentValidity'] = vi.fn(async () => ({})),
): CorpusMover {
  return { ingest: { enqueue }, admin: { setDocumentValidity } }
}

/** Records sleeps instead of performing them. */
function noSleep() {
  const slept: number[] = []
  return { slept, retry: { sleep: async (ms: number) => void slept.push(ms), random: () => 0 } }
}

// ---------------------------------------------------------------------------
// beginPublish
// ---------------------------------------------------------------------------

describe('beginPublish — 🔴 a rate-limited enqueue is retried, then written down', () => {
  it('waits what the server asked and succeeds on the retry', async () => {
    const { payload, finalRow } = fakePayload()
    let calls = 0
    const enqueue = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw rateLimited(9)
      return { ingestId: 'ing-1' }
    })
    const { slept, retry } = noSleep()

    const result = await beginPublish(DOC, { payload, client: mover(enqueue), retry })

    expect(result.ingestId).toBe('ing-1')
    expect(enqueue).toHaveBeenCalledTimes(2)
    expect(slept).toEqual([9_000])
    // A successful publish leaves NO error behind.
    expect(finalRow().publicationError).toBeNull()
    expect(finalRow().publishIngestId).toBe('ing-1')
  })

  it('🔴 THE BUG: on final give-up the row carries a visible Spanish error', async () => {
    // Before the fix this row ended as `{ publicationStatus: 'publishing' }` and
    // nothing else — the exact shape 99 documents were found in.
    const { payload, finalRow } = fakePayload()
    const enqueue = vi.fn(async () => {
      throw rateLimited(2)
    })
    const { retry } = noSleep()

    await expect(
      beginPublish(DOC, { payload, client: mover(enqueue), retry: { ...retry, attempts: 2 } }),
    ).rejects.toMatchObject({ status: 429 })

    const row = finalRow()
    expect(typeof row.publicationError).toBe('string')
    expect(String(row.publicationError)).not.toBe('')
    // Spanish, because the UI renders `publicationError` verbatim to the uploader.
    expect(String(row.publicationError)).toContain('El servicio de IA está saturado')
    expect(String(row.publicationError)).toContain('No se envió nada')
    // ⚠ Status is NOT rolled back to `draft`. `publishing` + an error is this
    // file's vocabulary for "tried and did not make it"; `draft` would claim the
    // document was never touched.
    expect(row.publicationStatus).toBe('publishing')
    expect(row.publishIngestId).toBeUndefined()
  })

  it('🔴 ANY enqueue failure is written down, not just the rate limit', async () => {
    // The rate limit exposed this, but a 500 or a dropped socket produces the
    // identical invisible row. "The state says what happened" must not hold for
    // one error class only.
    const { payload, finalRow } = fakePayload()
    const enqueue = vi.fn(async () => {
      throw Object.assign(new Error('upstream exploded'), { status: 500 })
    })

    await expect(beginPublish(DOC, { payload, client: mover(enqueue) })).rejects.toThrow(
      'upstream exploded',
    )
    expect(enqueue).toHaveBeenCalledTimes(1) // not retried — a 500 may have half-happened
    expect(String(finalRow().publicationError)).toContain('upstream exploded')
    expect(String(finalRow().publicationError)).toContain('No se pudo publicar')
  })

  it('the ORIGINAL error still reaches the caller, never a write error', async () => {
    // The caller logs and decides; replacing the real cause with a Payload write
    // failure would destroy the only diagnosis anyone has.
    const update = vi.fn(async (args: { data: Record<string, unknown> }) => {
      if ('publicationError' in args.data && args.data.publicationError !== null) {
        throw new Error('db is down')
      }
      return {}
    })
    const payload = { update, logger: { warn: vi.fn() } } as unknown as Payload
    const enqueue = vi.fn(async () => {
      throw rateLimited(1)
    })
    const { retry } = noSleep()

    await expect(
      beginPublish(DOC, { payload, client: mover(enqueue), retry: { ...retry, attempts: 1 } }),
    ).rejects.toMatchObject({ status: 429 })
  })

  it('a successful first attempt does not sleep at all', async () => {
    const { payload } = fakePayload()
    const enqueue = vi.fn(async () => ({ ingestId: 'ing-0' }))
    const { slept, retry } = noSleep()
    await beginPublish(DOC, { payload, client: mover(enqueue), retry })
    expect(slept).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// unpublish
// ---------------------------------------------------------------------------

describe('unpublish — 🔴 the same protection, where it matters more', () => {
  it('records the failure, because the shared copy is ALREADY retired by then', async () => {
    // A silent failure here leaves a document that is no longer shared and not
    // yet back in drafts: its own uploader cannot find it.
    const { payload, finalRow } = fakePayload()
    const enqueue = vi.fn(async () => {
      throw rateLimited(4)
    })
    const { retry } = noSleep()

    await expect(
      unpublish(DOC, { payload, client: mover(enqueue), retry: { ...retry, attempts: 2 } }),
    ).rejects.toMatchObject({ status: 429 })

    const row = finalRow()
    expect(row.publicationStatus).toBe('unpublishing')
    expect(String(row.publicationError)).toContain(
      'quitar este documento de la biblioteca compartida',
    )
  })

  it('retries and succeeds without leaving an error behind', async () => {
    const { payload, finalRow } = fakePayload()
    let calls = 0
    const enqueue = vi.fn(async () => {
      calls += 1
      if (calls < 3) throw rateLimited(1)
      return { ingestId: 'ing-2' }
    })
    const { slept, retry } = noSleep()

    const result = await unpublish(DOC, { payload, client: mover(enqueue), retry })

    expect(result.ingestId).toBe('ing-2')
    expect(slept).toEqual([1_000, 1_000])
    expect(finalRow().publicationError).toBeNull()
  })

  it('🔴 THE SECOND INVISIBLE-ROW HOLE: a failed RETIRE is written down too', async () => {
    // The retire runs AFTER the row is flipped to `unpublishing`, so a throw here
    // left exactly the shape the publish path was fixed for — and worse: the
    // document is still SHARED while the row claims it is being withdrawn.
    // `setDocumentValidity` is an admin-role route, so a mis-scoped key makes
    // this a 403 on every attempt, not a rare accident.
    const { payload, finalRow } = fakePayload()
    const enqueue = vi.fn(async () => ({ ingestId: 'never' }))
    const retire = vi.fn(async () => {
      throw Object.assign(new Error('forbidden'), { status: 403 })
    })

    await expect(
      unpublish(DOC, { payload, client: mover(enqueue, retire) }),
    ).rejects.toThrow('forbidden')

    // Ordering is still the safety property: no re-ingest without a proven retire.
    expect(enqueue).not.toHaveBeenCalled()
    const row = finalRow()
    expect(row.publicationStatus).toBe('unpublishing')
    expect(String(row.publicationError)).toContain('forbidden')
  })

  it('a 404 on the retire is still tolerated and does NOT stamp an error', async () => {
    // "The shared corpus does not hold this document" IS the guarantee
    // unpublishing has to make. The new error-recording must not turn that
    // success into a visible failure.
    const { payload, finalRow } = fakePayload()
    const enqueue = vi.fn(async () => ({ ingestId: 'ing-3' }))
    const retire = vi.fn(async () => {
      throw Object.assign(new Error('not found'), { status: 404, name: 'NotFoundError' })
    })

    await expect(
      unpublish(DOC, { payload, client: mover(enqueue, retire) }),
    ).resolves.toMatchObject({ ingestId: 'ing-3' })
    expect(finalRow().publicationError).toBeNull()
  })
})
