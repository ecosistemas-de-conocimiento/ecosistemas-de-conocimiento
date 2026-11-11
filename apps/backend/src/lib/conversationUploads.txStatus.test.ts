/**
 * 🔴 A SATURATED POOL DOES NOT KILL THE POST-COMMIT CLEANUP'S WAIT.
 *
 * `freshTxStatus` reads `txid_status` on a fresh pool connection. Since the
 * pool has a checkout timeout (`lib/dbPool.ts`), a busy pool makes that read
 * throw; the wait used to reject on the first one, and the cleanup was
 * abandoned as "failed". Now a throw is "unknown": keep polling within the
 * budget, and if it runs out, give up with the usual log line. The delete
 * that scheduled it answered long before either.
 */

import type { Payload } from 'payload'
import { describe, expect, it, vi } from 'vitest'

import { finishUploadCleanupAfterCommit, waitForOutcome, type UploadCleanupPlan } from './conversationUploads'

/** pg-pool 3.14.0's words for a checkout that waited out `connectionTimeoutMillis`. */
const poolTimeout = () => new Error('timeout exceeded when trying to connect')

function fakePayload() {
  const warn = vi.fn()
  const info = vi.fn()
  const payload = {
    logger: { info, warn, error: warn, debug: () => {} },
    findByID: vi.fn(async () => null),
  } as unknown as Payload
  return { payload, warn, info }
}

const plan: UploadCleanupPlan = { sessionId: 7, xid: '777', documents: [], mediaIds: [3] }

describe('waiting for the delete’s commit on a saturated pool', () => {
  it('a status read that throws is "unknown": the next answer counts', async () => {
    const { payload, warn } = fakePayload()
    let calls = 0
    const txStatus = vi.fn(async () => {
      calls += 1
      if (calls <= 2) throw poolTimeout()
      return 'committed'
    })
    expect(await waitForOutcome('777', { payload, txStatus, intervalMs: 1, attempts: 20 })).toBe('committed')
    expect(txStatus).toHaveBeenCalledTimes(3)
    // One line, not one per failed read.
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[1])).toMatch(/txid_status unavailable/)
  })

  it('every read throwing ends in "gave-up" with a log line, and nothing is deleted', async () => {
    const { payload, warn } = fakePayload()
    const corpusClient = vi.fn()
    const txStatus = vi.fn(async (): Promise<string | null> => {
      throw poolTimeout()
    })
    const outcome = await finishUploadCleanupAfterCommit(plan, { payload, txStatus, corpusClient, intervalMs: 1, attempts: 5 })
    expect(outcome).toBe('gave-up')
    expect(txStatus.mock.calls.length).toBeGreaterThan(0)
    expect(corpusClient).not.toHaveBeenCalled()
    expect(payload.findByID).not.toHaveBeenCalled()
    expect(warn.mock.calls.map((c) => String(c[1]))).toContainEqual(expect.stringMatching(/NOT cleaned up/))
  })

  it('the budget is time as well as count: slow failing reads stop at the deadline', async () => {
    const { payload } = fakePayload()
    // Each read takes 40 ms to fail, like a checkout timing out; the budget is 10 × 5 ms.
    const txStatus = vi.fn(async (): Promise<string | null> => {
      await new Promise((r) => setTimeout(r, 40))
      throw poolTimeout()
    })
    const started = Date.now()
    expect(await waitForOutcome('777', { payload, txStatus, intervalMs: 5, attempts: 10 })).toBe('gave-up')
    expect(txStatus.mock.calls.length).toBeLessThan(10)
    expect(Date.now() - started).toBeLessThan(400)
  })
})
