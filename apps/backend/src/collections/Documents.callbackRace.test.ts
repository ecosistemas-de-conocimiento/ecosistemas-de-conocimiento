/**
 * 🔴 THE CALLBACK-BEFORE-INGESTID RACE.
 *
 * Measured on a dev stack with the fake embedding provider (3 of 4 uploads):
 * ai-service's `ingest.completed` callback reached the receiver ~1 ms BEFORE
 * the enqueue's own HTTP response came back, so before the backend had stored
 * `ingestId`. The row went `ready` and then fell back to `embedding` for good.
 *
 * The mechanism this file pins (read in code, reproduced below):
 *
 *   1. the receiver writes `ingestStatus: 'ready'` WITHOUT `__skipDocsExtract`;
 *   2. that save re-fires `afterChange` → `runExtractAndIngest`;
 *   3. its only "already enqueued" guard is `fresh.ingestId`, which is still
 *      empty inside the race window;
 *   4. so the pipeline runs a SECOND time: `enqueueIngestForDoc` writes
 *      `embedding` over `ready` and enqueues the document again.
 *
 * The stateful fake below stands in for Payload: `update` merges into one row
 * and re-fires the real `afterChange` hooks unless the write carries
 * `__skipDocsExtract`, which is what Payload does. The callback is the REAL
 * route, signed with the real HMAC.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { signCallback } from '@/lib/hmac'

const SECRET = 'c'.repeat(64)

type Row = Record<string, unknown>
let row: Row

const fakePayload = {
  findByID: async () => ({ ...row }),
  create: async () => ({}),
  find: async () => ({ docs: [] }),
  delete: async () => ({}),
  update: async (args: { data: Row; context?: Row }) => {
    const previousDoc = { ...row }
    row = { ...row, ...args.data }
    if (!args.context?.__skipDocsExtract) {
      const { Documents } = await import('./Documents')
      for (const hook of Documents.hooks?.afterChange ?? []) {
        await hook({
          doc: { ...row },
          previousDoc,
          operation: 'update',
          req: { context: args.context ?? {}, payload: fakePayload },
        } as never)
      }
    }
    return { ...row }
  },
}

vi.mock('payload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('payload')>()),
  getPayload: async () => fakePayload,
}))
vi.mock('@payload-config', () => ({ default: {} }))
vi.mock('@/lib/graph/schedule', () => ({ scheduleGraphExtraction: vi.fn() }))

/** Deliver a signed `ingest.completed` through the real receiver. */
const deliverCallback = async (ingestId: string) => {
  const { POST } = await import('@/app/api/ai-service/callback/route')
  const body = JSON.stringify({ event: 'ingest.completed', ingestId, docId: '42' })
  const timestamp = Math.floor(Date.now() / 1000)
  await POST(
    new Request('http://backend.test/api/ai-service/callback', {
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

let calls = 0
const enqueue = vi.fn(async () => {
  calls += 1
  const ingestId = `ing_${calls}`
  if (calls === 1) {
    // The race: the callback lands, THEN the 202 reaches the backend.
    await deliverCallback(ingestId)
    await new Promise((r) => setTimeout(r, 30))
  }
  return { ingestId }
})
vi.mock('@/lib/aiClient', () => ({
  getAppAIClient: () => ({ ingest: { enqueue } }),
}))

/**
 * The hook defers `runExtractAndIngest` with `setImmediate` and never awaits
 * it, so there is no promise to hold. Poll instead of sleeping: a fixed 150 ms
 * wait failed 1 of 3 full-suite runs under load (measured, audit 2026-10-17).
 * `ingestId` is the first run's LAST write, so its arrival marks the pipeline
 * as done; a racing second run would have bumped `enqueue` past one call.
 */
const settle = () =>
  vi.waitFor(() => expect(row.ingestId).toBe('ing_1'), { timeout: 5000, interval: 10 })

beforeEach(() => {
  calls = 0
  enqueue.mockClear()
  row = {
    id: 42,
    kind: 'pdf',
    contentKind: 'documento',
    name: 'Acta.pdf',
    organization: 10,
    uploadedBy: 3,
    publicationStatus: 'draft',
    anonymisationStatus: 'n/a',
    extractedText: 'contenido extraído',
    ingestStatus: 'pending',
    ingestId: null,
    mediaFile: 7,
  }
  vi.stubEnv('CALLBACK_SECRET', SECRET)
  vi.stubEnv('PUBLIC_BACKEND_URL', 'https://backend.test')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('ingest.completed arrives before the backend stores ingestId', () => {
  it('ends `ready`, with the job id stored, and enqueues exactly once', async () => {
    // Kick the pipeline the way an upload does: the afterChange hook.
    await fakePayload.update({ data: {} })
    await settle()

    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(row.ingestStatus).toBe('ready')
    expect(row.ingestId).toBe('ing_1')
  })
})
