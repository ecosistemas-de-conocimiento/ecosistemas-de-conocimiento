/**
 * 🔴 THE APPROVAL-BEFORE-COMMIT RACE.
 *
 * Measured by an e2e run (`e2e/holds.e2e.ts`, approval block, 1 of 3 runs at
 * load 8): approving a hold sometimes never ingested. The row stayed
 * `anonymisationStatus: 'approved'`, `ingestStatus: 'pending'`, and the backend
 * logged "is HELD by the anonymisation gate — skipping".
 *
 * The mechanism this file pins (read in code):
 *
 *   1. `decideOnHold` writes `approved` with a plain `payload.update`;
 *   2. `afterChange` fires INSIDE that update's transaction and defers
 *      `runExtractAndIngest` with `setImmediate`;
 *   3. the deferred run reads the row on a no-transaction connection. On a
 *      CREATE an uncommitted row is invisible, so the read throws and retries.
 *      On an UPDATE the OLD row is visible, so the read SUCCEEDS — and returns
 *      `held`;
 *   4. the held guard returns, nothing else ever drives the row.
 *
 * The fake below has two rows: what is committed, and what the hook was handed.
 * The commit lands a few milliseconds after the hook fires, as in Postgres.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/documentColumns', () => import('@/lib/documentColumns.testFake'))

type Row = Record<string, unknown>
let committed: Row

const fakePayload = {
  findByID: vi.fn(async () => ({ ...committed })),
  create: async () => ({}),
  find: async () => ({ docs: [] }),
  delete: async () => ({}),
  update: async (args: { data: Row }) => {
    committed = { ...committed, ...args.data }
    return { ...committed }
  },
}

vi.mock('payload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('payload')>()),
  getPayload: async () => fakePayload,
}))
vi.mock('@payload-config', () => ({ default: {} }))
vi.mock('@/lib/graph/schedule', () => ({ scheduleGraphExtraction: vi.fn() }))

const enqueue = vi.fn(async () => ({ ingestId: 'ing_1' }))
vi.mock('@/lib/aiClient', () => ({
  getAppAIClient: () => ({ ingest: { enqueue } }),
}))

const HELD_AT = '2026-10-17T10:00:00.000Z'
const APPROVED_AT = '2026-10-17T10:05:00.000Z'

const heldRow = (): Row => ({
  id: 42,
  kind: 'pdf',
  contentKind: 'testimonio',
  name: 'Testimonio.pdf',
  organization: 10,
  uploadedBy: 3,
  publicationStatus: 'draft',
  anonymisationStatus: 'held',
  heldText: 'Mi nombre es [Persona A].',
  redactedText: null,
  extractedText: 'Mi nombre es Ana.',
  ingestStatus: 'failed',
  ingestId: null,
  mediaFile: 7,
  updatedAt: HELD_AT,
})

/** What `decideOnHold` writes, as the hook receives it before the commit. */
const approvedRow = (): Row => ({
  ...heldRow(),
  anonymisationStatus: 'approved',
  redactedText: 'Mi nombre es [Persona A].',
  heldText: null,
  ingestStatus: 'pending',
  updatedAt: APPROVED_AT,
})

async function fireHook(doc: Row) {
  const { Documents } = await import('./Documents')
  for (const hook of Documents.hooks?.afterChange ?? []) {
    await hook({
      doc,
      previousDoc: heldRow(),
      operation: 'update',
      req: { context: {}, payload: fakePayload },
    } as never)
  }
}

beforeEach(() => {
  committed = heldRow()
  enqueue.mockClear()
  fakePayload.findByID.mockClear()
  vi.stubEnv('CALLBACK_SECRET', 'c'.repeat(64))
  vi.stubEnv('PUBLIC_BACKEND_URL', 'https://backend.test')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('approving a hold, when the deferred read lands before the commit', () => {
  it('🔴 waits for the approval to be visible, then ingests the approved text', { timeout: 10_000 }, async () => {
    await fireHook(approvedRow())
    // The commit lands after the hook's first read: the stale-read window.
    setTimeout(() => {
      committed = approvedRow()
    }, 40)

    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1), { timeout: 4000, interval: 10 })
    // It read the stale row at least once before the commit, and did not stop there.
    expect(fakePayload.findByID.mock.calls.length).toBeGreaterThan(1)
    expect(committed.ingestId).toBe('ing_1')
    // The approved redaction is what went out, never the original.
    expect(JSON.stringify(enqueue.mock.calls[0])).toContain('[Persona A]')
    expect(JSON.stringify(enqueue.mock.calls[0])).not.toContain('Ana')
  })

  it('a save that never commits does nothing — the stale row is not acted on', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setImmediate'] })
    try {
      await fireHook(approvedRow())
      await vi.advanceTimersByTimeAsync(5000)
    } finally {
      vi.useRealTimers()
    }
    expect(enqueue).not.toHaveBeenCalled()
    expect(committed.anonymisationStatus).toBe('held')
  })
})
