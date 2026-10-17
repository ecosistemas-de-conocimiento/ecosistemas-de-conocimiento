/**
 * 🔴 WHAT "DELETE THIS CONVERSATION" ACTUALLY DELETES.
 *
 * Deleting a session used to FAIL outright. `messages.session_id` and
 * `ratings.session_id` are NOT NULL columns whose foreign keys say `ON DELETE
 * SET NULL` — a contradiction Postgres resolves by refusing the parent delete:
 *
 *   ERROR: null value in column "session_id" of relation "messages"
 *          violates not-null constraint
 *
 * `Sessions.beforeDelete` removes the children first so the foreign key never
 * fires. This file pins the three things about it that a future reader would
 * otherwise "simplify" away:
 *
 *   1. RATINGS ARE DELETED BEFORE MESSAGES. `ratings.message_id` has the SAME
 *      defect, so a message deleted before its rating fails the same way. The
 *      two calls look independent and are not — hence an ORDER assertion, not
 *      two "was called" assertions.
 *   2. RETIREMENT HAPPENS BEFORE THE ROWS GO. The corpus copies are addressed
 *      by `msg-<messageId>`; once the rows are deleted nothing points at them
 *      and they keep answering colleagues' questions from a conversation the
 *      owner believes is gone.
 *   3. EVERY DELETE USES `overrideAccess: true`. The janitor runs with no
 *      `req.user`, and access on both child collections is per-user — without
 *      it the delete matches nothing and the session stays undeletable.
 *
 * 🔴 AND TWO THINGS THAT MUST NEVER HAPPEN: no corpus is deleted (the corpora
 * are SHARED across an ecosistema — one `deleteCorpus` is a whole knowledgebase
 * gone), and no document is deleted (a document outlives every conversation it
 * was attached to; only the `documents_rels` join row cascades).
 */

import { describe, expect, it, vi } from 'vitest'
import type { Payload } from 'payload'

// If anything in the delete path ever reached `deleteCorpus`, this spy sees it.
// The assertion is that it stays at zero.
const deleteCorpus = vi.fn(async (_corpus: string) => ({ deleted: true }))
vi.mock('@edc/ai-client', () => ({
  AIClient: class {
    admin = { deleteCorpus }
  },
}))

import { deleteConversationChildren, RETIRABLE_TURN_STATES, Sessions } from './Sessions'

const SESSION = 7
const ECO = 42
const OWNER = 5

interface MessageRow {
  id: number
  session: number
  corpusStatus?: string
}

interface Call {
  op: string
  collection?: string
  args?: Record<string, unknown>
}

/**
 * A minimal Payload stand-in that records every call in order. `where` is
 * honoured only as far as this hook uses it (session equality + a
 * `corpusStatus` `in` list), which is enough to prove the selection.
 */
function fakePayload(
  messages: MessageRow[],
  ratings: Array<{ id: number; session: number }>,
  opts: { organization?: number | null; failDelete?: string } = {},
): { payload: Payload; calls: Call[] } {
  const calls: Call[] = []

  const payload = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },

    findByID: async (args: { collection: string; id: number }) => {
      calls.push({ op: 'findByID', collection: args.collection, args })
      if (args.collection !== 'sessions') throw new Error(`unexpected findByID ${args.collection}`)
      return {
        id: args.id,
        organization: opts.organization === undefined ? ECO : opts.organization,
        user: OWNER,
      }
    },

    find: async (args: { collection: string; where?: unknown }) => {
      calls.push({ op: 'find', collection: args.collection, args })
      if (args.collection !== 'messages') throw new Error(`unexpected find ${args.collection}`)
      const and = (args.where as { and?: Array<Record<string, unknown>> })?.and ?? []
      const statuses =
        (and.find((c) => 'corpusStatus' in c)?.corpusStatus as { in?: string[] } | undefined)?.in ??
        null
      const docs = messages.filter(
        (m) => m.session === SESSION && (statuses === null || statuses.includes(m.corpusStatus!)),
      )
      return { docs, totalDocs: docs.length, totalPages: 1, page: 1 }
    },

    delete: async (args: { collection: string; where?: unknown }) => {
      calls.push({ op: 'delete', collection: args.collection, args })
      if (opts.failDelete === args.collection) {
        // ⚠ Payload's bulk delete does NOT throw on a per-row failure — it
        // collects them here. This is the shape the hook has to notice.
        return { docs: [], errors: [{ id: 1, isPublic: false, message: 'row is locked' }] }
      }
      if (args.collection === 'ratings') return { docs: ratings, errors: [] }
      if (args.collection === 'messages') return { docs: messages, errors: [] }
      throw new Error(`unexpected delete ${args.collection}`)
    },
  } as unknown as Payload

  return { payload, calls }
}

/** A fake ai-service admin client with only the method retirement needs. */
function fakeCorpus(behaviour: (corpus: string, externalId: string) => void = () => {}) {
  const setDocumentValidity = vi.fn(
    async (corpus: string, externalId: string, _bounds: unknown) => {
      behaviour(corpus, externalId)
      return { ok: true }
    },
  )
  return {
    client: { admin: { setDocumentValidity } } as never,
    setDocumentValidity,
  }
}

function notFound(): Error & { status: number } {
  return Object.assign(new Error('ai-service request failed (status 404)'), { status: 404 })
}

const deleteOps = (calls: Call[]) =>
  calls.filter((c) => c.op === 'delete').map((c) => c.collection)

describe('🔴 only the owner’s delete runs the cascade', () => {
  // Payload 3.88 `deleteByID` runs `beforeDelete` BEFORE it checks the row
  // against `ownOnly`. Without this guard, user A deleting user B's session id
  // retired B's turns from the shared corpus, then got a 403.
  it('refuses a signed-in caller who does not own the conversation, before touching anything', async () => {
    const messages: MessageRow[] = [{ id: 1, session: SESSION, corpusStatus: 'ingested' }]
    const { payload, calls } = fakePayload(messages, [{ id: 9, session: SESSION }])
    const corpus = fakeCorpus()
    const req = { user: { id: OWNER + 1 } } as never

    await expect(
      deleteConversationChildren(SESSION, { payload, req, corpusClient: async () => corpus.client }),
    ).rejects.toMatchObject({ status: 403 })

    expect(calls.map((c) => `${c.op}:${c.collection}`)).toEqual(['findByID:sessions'])
    expect(corpus.setDocumentValidity).not.toHaveBeenCalled()
  })

  it('lets the owner through', async () => {
    const { payload, calls } = fakePayload([], [])

    await deleteConversationChildren(SESSION, { payload, req: { user: { id: OWNER } } as never })

    expect(deleteOps(calls)).toEqual(['ratings', 'messages'])
  })

  it('lets a system caller with no user through — the janitor', async () => {
    const { payload, calls } = fakePayload([], [])

    await deleteConversationChildren(SESSION, { payload, req: {} as never })

    expect(deleteOps(calls)).toEqual(['ratings', 'messages'])
  })
})

describe('deleting a conversation deletes its children', () => {
  it('deletes the ratings and the messages', async () => {
    const { payload, calls } = fakePayload(
      [{ id: 1, session: SESSION, corpusStatus: 'skipped' }],
      [{ id: 9, session: SESSION }],
    )

    await deleteConversationChildren(SESSION, { payload })

    expect(deleteOps(calls)).toEqual(['ratings', 'messages'])
    for (const call of calls.filter((c) => c.op === 'delete')) {
      expect(call.args?.where).toEqual({ session: { equals: SESSION } })
    }
  })

  it('🔴 deletes RATINGS BEFORE MESSAGES — ratings.message_id is NOT NULL + SET NULL', async () => {
    const { payload, calls } = fakePayload(
      [{ id: 1, session: SESSION, corpusStatus: 'skipped' }],
      [{ id: 9, session: SESSION }],
    )

    await deleteConversationChildren(SESSION, { payload })

    const ops = deleteOps(calls)
    expect(ops.indexOf('ratings')).toBeLessThan(ops.indexOf('messages'))
  })

  it('uses overrideAccess on every delete — the janitor runs with no req.user', async () => {
    const { payload, calls } = fakePayload(
      [{ id: 1, session: SESSION, corpusStatus: 'skipped' }],
      [{ id: 9, session: SESSION }],
    )

    await deleteConversationChildren(SESSION, { payload })

    const deletes = calls.filter((c) => c.op === 'delete')
    expect(deletes).toHaveLength(2)
    for (const call of deletes) expect(call.args?.overrideAccess).toBe(true)
  })

  it('deletes a conversation with no messages and no ratings cleanly', async () => {
    const { payload, calls } = fakePayload([], [])

    await expect(deleteConversationChildren(SESSION, { payload })).resolves.toBeUndefined()

    expect(deleteOps(calls)).toEqual(['ratings', 'messages'])
  })

  it('aborts the whole delete when a child delete reports a per-row failure', async () => {
    const { payload, calls } = fakePayload(
      [{ id: 1, session: SESSION, corpusStatus: 'skipped' }],
      [{ id: 9, session: SESSION }],
      { failDelete: 'ratings' },
    )

    await expect(deleteConversationChildren(SESSION, { payload })).rejects.toThrow(/ratings/)

    // Messages must NOT have been deleted: a half-deleted conversation is the
    // state this hook exists to prevent.
    expect(deleteOps(calls)).toEqual(['ratings'])
  })
})

describe('retiring the turns that reached the shared corpus', () => {
  it('retires ingested and embedding turns from eco-{orgId}, before deleting rows', async () => {
    const messages: MessageRow[] = [
      { id: 1, session: SESSION, corpusStatus: 'ingested' },
      { id: 2, session: SESSION, corpusStatus: 'embedding' },
    ]
    const { payload, calls } = fakePayload(messages, [])
    const corpus = fakeCorpus()

    await deleteConversationChildren(SESSION, {
      payload,
      corpusClient: async () => corpus.client,
    })

    expect(corpus.setDocumentValidity.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      [`eco-${ECO}`, 'msg-1'],
      [`eco-${ECO}`, 'msg-2'],
    ])
    // `validTo` is what makes it a retirement rather than a no-op.
    expect(corpus.setDocumentValidity.mock.calls[0][2]).toMatchObject({
      validTo: expect.any(String),
    })

    // ⚠ Order: retirement must precede the row deletes, or the external ids
    // are unknowable afterwards.
    expect(deleteOps(calls)).toEqual(['ratings', 'messages'])
  })

  it('does not retire a turn that never reached the corpus', async () => {
    const messages: MessageRow[] = [
      { id: 1, session: SESSION, corpusStatus: 'skipped' },
      { id: 2, session: SESSION, corpusStatus: 'pending' },
      { id: 3, session: SESSION, corpusStatus: 'failed' },
      { id: 4, session: SESSION, corpusStatus: 'held-gate' },
    ]
    const { payload, calls } = fakePayload(messages, [])
    const corpus = fakeCorpus()

    await deleteConversationChildren(SESSION, {
      payload,
      corpusClient: async () => corpus.client,
    })

    expect(corpus.setDocumentValidity).not.toHaveBeenCalled()
    expect(deleteOps(calls)).toEqual(['ratings', 'messages'])
  })

  it('tolerates a 404 — "it was never there" is the property we asked for', async () => {
    const messages: MessageRow[] = [{ id: 1, session: SESSION, corpusStatus: 'ingested' }]
    const { payload, calls } = fakePayload(messages, [])
    const corpus = fakeCorpus(() => {
      throw notFound()
    })

    await expect(
      deleteConversationChildren(SESSION, { payload, corpusClient: async () => corpus.client }),
    ).resolves.toBeUndefined()

    expect(deleteOps(calls)).toEqual(['ratings', 'messages'])
  })

  it('🔴 a real retire failure aborts the delete and leaves the messages in place', async () => {
    const messages: MessageRow[] = [{ id: 1, session: SESSION, corpusStatus: 'ingested' }]
    const { payload, calls } = fakePayload(messages, [])
    const corpus = fakeCorpus(() => {
      throw Object.assign(new Error('ai-service request failed (status 503)'), { status: 503 })
    })

    await expect(
      deleteConversationChildren(SESSION, { payload, corpusClient: async () => corpus.client }),
    ).rejects.toThrow(/503/)

    // Nothing deleted. A conversation whose rows are gone but whose corpus copy
    // survives is the silent state this policy exists to prevent; the user can
    // retry a failed delete.
    expect(deleteOps(calls)).toEqual([])
  })

  it('never asks for a corpus client when there is nothing to retire', async () => {
    // A local run with no AI_SERVICE_ADMIN_API_KEY throws on construction, so a
    // conversation that never reached the corpus must not need one.
    const { payload } = fakePayload([{ id: 1, session: SESSION, corpusStatus: 'skipped' }], [])
    const corpusClient = vi.fn(async () => {
      throw new Error('AI_SERVICE_ADMIN_API_KEY is not set.')
    })

    await expect(
      deleteConversationChildren(SESSION, { payload, corpusClient: corpusClient as never }),
    ).resolves.toBeUndefined()

    expect(corpusClient).not.toHaveBeenCalled()
  })

  it('refuses rather than guessing when an ingested conversation has no ecosistema', async () => {
    const messages: MessageRow[] = [{ id: 1, session: SESSION, corpusStatus: 'ingested' }]
    const { payload, calls } = fakePayload(messages, [], { organization: null })
    const corpus = fakeCorpus()

    await expect(
      deleteConversationChildren(SESSION, { payload, corpusClient: async () => corpus.client }),
    ).rejects.toThrow(/no ecosistema/)

    expect(corpus.setDocumentValidity).not.toHaveBeenCalled()
    expect(deleteOps(calls)).toEqual([])
  })

  it('lists exactly the states that reached, or are reaching, the corpus', () => {
    expect([...RETIRABLE_TURN_STATES]).toEqual(['ingested', 'embedding'])
  })
})

describe('🔴 deleting a conversation must NOT delete a corpus or a document', () => {
  it('never calls deleteCorpus and never deletes from documents', async () => {
    vi.stubEnv('AI_SERVICE_URL', 'http://ai-service.test')
    vi.stubEnv('AI_SERVICE_ADMIN_API_KEY', 'test-admin-key')

    const messages: MessageRow[] = [
      { id: 1, session: SESSION, corpusStatus: 'ingested' },
      { id: 2, session: SESSION, corpusStatus: 'skipped' },
    ]
    const { payload, calls } = fakePayload(messages, [{ id: 9, session: SESSION }])
    const corpus = fakeCorpus()

    await deleteConversationChildren(SESSION, {
      payload,
      corpusClient: async () => corpus.client,
    })

    // Any cleanup would be behind a dynamic import; drain a few macrotasks
    // before concluding that nothing happened.
    await new Promise((resolve) => setTimeout(resolve, 20))

    // ⚠ The corpora are shared across every session in an ecosistema. One call
    // here is an entire knowledgebase gone.
    expect(deleteCorpus).not.toHaveBeenCalled()

    // ⚠ A document outlives the conversations it was attached to. Only the
    // `documents_rels` join row goes, and Postgres does that itself
    // (`documents_rels_sessions_fk ON DELETE CASCADE`).
    expect(deleteOps(calls)).not.toContain('documents')
    expect(calls.some((c) => c.collection === 'documents')).toBe(false)

    vi.unstubAllEnvs()
  })

  it('is wired as beforeDelete, and nothing was re-added to afterDelete', () => {
    // `beforeDelete`, not `afterDelete`: by afterDelete the parent delete has
    // already failed on the foreign key, so the cascade could never run.
    expect(Sessions.hooks?.beforeDelete ?? []).toHaveLength(1)
    expect(Sessions.hooks?.afterDelete ?? []).toHaveLength(0)
  })
})
