/**
 * ERASING A DELETED CONVERSATION'S TURNS FROM AI-SERVICE, AFTER COMMIT.
 *
 * Audit 2026-10-17 §3 item 2: deleting a conversation only RETIRED its turns
 * (`validTo`), so their text and vectors stayed in the shared corpus, and a
 * retrieve without `asOf` still returned them. This pins the erase that now
 * follows the retire. The real-Postgres side is in
 * `conversationTurnErasure.pg.test.ts`.
 */

import type { Payload } from 'payload'
import { describe, expect, it, vi } from 'vitest'

import {
  eraseTurnsAfterCommit,
  scheduleTurnErasure,
  type TurnErasurePlan,
} from './conversationTurnErasure'

const plan = (over: Partial<TurnErasurePlan> = {}): TurnErasurePlan => ({
  sessionId: 7,
  xid: '777',
  organizationId: 42,
  corpus: 'eco-42',
  messageIds: [1, 2],
  ...over,
})

function fakes(opts: { sessionSurvives?: boolean; survivingMessages?: number[] } = {}) {
  const info = vi.fn()
  const warn = vi.fn()
  const payload = {
    logger: { info, warn, error: warn, debug: () => {} },
    findByID: async (args: { collection: string; id: number }) => {
      if (args.collection === 'sessions') return opts.sessionSurvives ? { id: args.id } : null
      if (args.collection === 'messages') {
        return opts.survivingMessages?.includes(args.id) ? { id: args.id } : null
      }
      throw new Error(`unexpected findByID ${args.collection}`)
    },
  } as unknown as Payload
  const deleteDocument = vi.fn(async (_corpus: string, _id: string) => ({ deleted: true }))
  const corpusClient = vi.fn(async (_org: number | string) => ({ admin: { deleteDocument } }))
  return { payload, info, warn, deleteDocument, corpusClient }
}

const status = (...answers: Array<string | null>) => {
  let i = 0
  return vi.fn(async () => answers[Math.min(i++, answers.length - 1)] ?? null)
}

const absent = () =>
  Object.assign(new Error('not found'), { status: 404, code: 'DOCUMENT_NOT_FOUND' })

describe('erasing a deleted conversation’s turns after commit', () => {
  it('🔴 waits for "committed", then deletes each turn from the ecosistema’s corpus', async () => {
    const t = fakes()
    const txStatus = status('in progress', 'committed')

    const outcome = await eraseTurnsAfterCommit(plan(), {
      payload: t.payload,
      corpusClient: t.corpusClient,
      txStatus,
      intervalMs: 1,
    })

    expect(outcome).toBe('committed')
    expect(txStatus).toHaveBeenCalledWith('777')
    expect(t.corpusClient).toHaveBeenCalledWith(42)
    // `deleteDocument` removes the document AND its chunks in one call.
    expect(t.deleteDocument.mock.calls).toEqual([
      ['eco-42', 'msg-1'],
      ['eco-42', 'msg-2'],
    ])
  })

  it('🔴 an aborted transaction erases nothing: the conversation is still there', async () => {
    const t = fakes()

    const outcome = await eraseTurnsAfterCommit(plan(), {
      payload: t.payload,
      corpusClient: t.corpusClient,
      txStatus: status('aborted'),
      intervalMs: 1,
    })

    expect(outcome).toBe('aborted')
    expect(t.deleteDocument).not.toHaveBeenCalled()
  })

  it('gives up after its budget, erases nothing, and logs every turn id', async () => {
    const t = fakes()

    const outcome = await eraseTurnsAfterCommit(plan(), {
      payload: t.payload,
      corpusClient: t.corpusClient,
      txStatus: status('in progress'),
      attempts: 3,
      intervalMs: 1,
    })

    expect(outcome).toBe('gave-up')
    expect(t.deleteDocument).not.toHaveBeenCalled()
    expect(t.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: '7', corpus: 'eco-42', turnIds: ['msg-1', 'msg-2'] }),
      expect.stringContaining('NOT erased'),
    )
  })

  it('🔴 committed but the SESSION survived (a failed row in a bulk delete): erases nothing', async () => {
    const t = fakes({ sessionSurvives: true })

    const outcome = await eraseTurnsAfterCommit(plan(), {
      payload: t.payload,
      corpusClient: t.corpusClient,
      txStatus: status('committed'),
      intervalMs: 1,
    })

    expect(outcome).toBe('session-survived')
    expect(t.deleteDocument).not.toHaveBeenCalled()
  })

  it('skips a turn whose message row is still there', async () => {
    const t = fakes({ survivingMessages: [2] })

    await eraseTurnsAfterCommit(plan(), {
      payload: t.payload,
      corpusClient: t.corpusClient,
      txStatus: status('committed'),
      intervalMs: 1,
    })

    expect(t.deleteDocument.mock.calls).toEqual([['eco-42', 'msg-1']])
  })

  it('treats ai-service’s own "no such document" as already erased, without a warning', async () => {
    const t = fakes()
    t.deleteDocument.mockImplementationOnce(async () => {
      throw absent()
    })

    await eraseTurnsAfterCommit(plan(), {
      payload: t.payload,
      corpusClient: t.corpusClient,
      txStatus: status('committed'),
      intervalMs: 1,
    })

    expect(t.warn).not.toHaveBeenCalled()
    expect(t.info).toHaveBeenCalledWith(
      expect.objectContaining({ erasedTurnIds: ['msg-2'], absentTurnIds: ['msg-1'] }),
      expect.stringContaining('finished'),
    )
  })

  it('a bare 404 (an ai-service without the route) is a failure, logged with ids; the rest still runs', async () => {
    const t = fakes()
    t.deleteDocument.mockImplementationOnce(async () => {
      throw Object.assign(new Error('route not found'), { status: 404 })
    })

    await eraseTurnsAfterCommit(plan(), {
      payload: t.payload,
      corpusClient: t.corpusClient,
      txStatus: status('committed'),
      intervalMs: 1,
    })

    expect(t.deleteDocument).toHaveBeenCalledTimes(2)
    expect(t.warn).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: 'msg-1', corpus: 'eco-42' }),
      expect.stringContaining('retired but NOT erased'),
    )
    expect(t.info).toHaveBeenCalledWith(
      expect.objectContaining({ erasedTurnIds: ['msg-2'], absentTurnIds: [] }),
      expect.stringContaining('finished'),
    )
  })

  it('with no transaction (autocommit), erases at once the turns that are gone', async () => {
    const t = fakes()
    const txStatus = status('committed')

    const outcome = await eraseTurnsAfterCommit(plan({ xid: null }), {
      payload: t.payload,
      corpusClient: t.corpusClient,
      txStatus,
      intervalMs: 1,
    })

    expect(outcome).toBe('no-transaction')
    expect(txStatus).not.toHaveBeenCalled()
    expect(t.deleteDocument).toHaveBeenCalledTimes(2)
  })

  it('never throws, even when the client cannot be built', async () => {
    const t = fakes()

    await expect(
      eraseTurnsAfterCommit(plan(), {
        payload: t.payload,
        corpusClient: async () => {
          throw new Error('AI_SERVICE_ADMIN_API_KEY is not set.')
        },
        txStatus: status('committed'),
        intervalMs: 1,
      }),
    ).resolves.toBe('committed')
    expect(t.warn).toHaveBeenCalledWith(
      expect.objectContaining({ turnIds: ['msg-1', 'msg-2'] }),
      expect.stringContaining('NOT erased'),
    )
  })

  it('🔴 logs every turn id at SCHEDULE time, before the wait', () => {
    const t = fakes()

    scheduleTurnErasure(t.payload, plan(), {
      corpusClient: t.corpusClient,
      txStatus: status('in progress'),
      attempts: 1,
      intervalMs: 1,
    })

    expect(t.info).toHaveBeenCalledWith(
      { sessionId: '7', xid: '777', corpus: 'eco-42', turnIds: ['msg-1', 'msg-2'] },
      '[sessions] scheduled post-commit turn erasure',
    )
  })
})
