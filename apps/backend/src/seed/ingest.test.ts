/**
 * `ingestSeededDocuments` under ai-service's rate limit.
 *
 * The real `beginPublish` runs; only the ai-service client and the callback
 * URL are faked. Nothing sleeps: the throttle's and the retry's `sleep` are
 * injected.
 */
import { RateLimitError } from '@edc/ai-client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const enqueue = vi.fn()
vi.mock('@/lib/aiClient', () => ({
  getAdminAIClient: () => ({ ingest: { enqueue } }),
}))
vi.mock('@/lib/callbackConfig', () => ({ ingestCallbackUrl: () => null }))

const { ingestSeededDocuments, SEED_PUBLISH_RETRY } = await import('./corpus')

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined }

function published(id: number) {
  return {
    id,
    organization: 1,
    uploadedBy: 2,
    contentKind: 'documento',
    kind: 'pdf',
    name: `Doc ${id}`,
    extractedText: 'Texto del documento.',
    publicationStatus: 'published',
    anonymisationStatus: 'n/a',
  }
}

function fakePayload(docs: Record<string, unknown>[], byId: (id: unknown) => Record<string, unknown>) {
  const updates: { id: unknown; data: Record<string, unknown> }[] = []
  const payload = {
    logger: silentLogger,
    find: async () => ({ docs }),
    findByID: async ({ id }: { id: unknown }) => byId(id),
    update: async (args: { id: unknown; data: Record<string, unknown> }) => {
      updates.push({ id: args.id, data: args.data })
      return {}
    },
  }
  return { payload: payload as never, updates }
}

const noSleep = async () => undefined

beforeEach(() => enqueue.mockReset())

describe('ingestSeededDocuments — rate limit', () => {
  it("🔴 a 429 on publish waits the server's retryAfterMs and tries again", async () => {
    enqueue
      .mockRejectedValueOnce(new RateLimitError('too fast', 4321))
      .mockResolvedValueOnce({ ingestId: 'ing-1' })
    const slept: number[] = []
    const { payload, updates } = fakePayload([published(10)], () => ({}))

    const result = await ingestSeededDocuments(payload, 1, {
      sleep: async (ms) => {
        slept.push(ms)
      },
      spacingMs: 0,
      random: () => 0,
    })

    expect(result).toEqual({ enqueued: 1, failed: 0, held: 0 })
    expect(enqueue).toHaveBeenCalledTimes(2)
    expect(slept).toContain(4321)
    expect(updates.at(-1)?.data).toEqual({ publishIngestId: 'ing-1' })
  })

  it('is patient: the seed gives the publish retry a long budget, no human is waiting', () => {
    expect(SEED_PUBLISH_RETRY.attempts).toBeGreaterThanOrEqual(10)
    expect(SEED_PUBLISH_RETRY.budgetMs).toBeGreaterThanOrEqual(10 * 60_000)
  })

  it('caps concurrency and spaces the starts', async () => {
    vi.useFakeTimers({ now: 0 })
    const starts: number[] = []
    enqueue.mockImplementation(async () => {
      starts.push(Date.now())
      return { ingestId: 'x' }
    })
    const { payload } = fakePayload([published(1), published(2), published(3)], () => ({}))
    const run = ingestSeededDocuments(payload, 1, { concurrency: 2, spacingMs: 1500 })
    await vi.runAllTimersAsync()
    await run
    vi.useRealTimers()
    expect(starts).toEqual([0, 1500, 3000])
  })
})

describe('ingestSeededDocuments — drafts', () => {
  it('🔴 holds a draft slot until its gate and enqueue have run, when asked to', async () => {
    const draft = { id: 20, organization: 1, publicationStatus: 'draft', anonymisationStatus: null }
    const reads = [
      { ingestStatus: 'pending', anonymisationStatus: 'pending' },
      { ingestStatus: 'embedding', anonymisationStatus: 'ready' },
    ]
    let n = 0
    const { payload, updates } = fakePayload([draft], () => reads[Math.min(n++, 1)]!)

    const result = await ingestSeededDocuments(payload, 1, {
      sleep: noSleep,
      spacingMs: 0,
      awaitDrafts: true,
    })

    expect(updates).toEqual([{ id: 20, data: {} }])
    expect(n).toBe(2)
    expect(result).toEqual({ enqueued: 1, failed: 0, held: 0 })
  })

  it('does not poll a draft when not asked to', async () => {
    const findByID = vi.fn()
    const { payload } = fakePayload(
      [{ id: 21, organization: 1, publicationStatus: 'draft' }],
      findByID,
    )
    await ingestSeededDocuments(payload, 1, { sleep: noSleep, spacingMs: 0 })
    expect(findByID).not.toHaveBeenCalled()
  })
})
