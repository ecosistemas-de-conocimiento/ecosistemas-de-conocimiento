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
 * 🔴 NO CORPUS IS EVER DELETED. The corpora are SHARED across an ecosistema —
 * one `deleteCorpus` is a whole knowledgebase gone.
 *
 * ⚠ UPLOADS THAT BELONG ONLY TO THIS CONVERSATION GO WITH IT. Rodrigo ruled
 * the old "documents always survive" behaviour a bug on 2026-10-17: the smoke
 * PDF stayed in "Mis documentos". Everything else survives: a document attached
 * to another conversation, published, uploaded before the conversation
 * existed or in another conversation (`uploadedInSession`), uploaded by
 * someone else, cited by another conversation, with an anonymisation-review
 * record (unless it is HELD: then the review rows go too), or a conversación.
 * Testimonio drafts go since Rodrigo's 2026-10-17 ruling. The "uploads" block
 * pins each case.
 *
 * 🔴 ONLY THE OWNER'S DELETE RUNS ANY OF IT. Payload runs `beforeDelete` before
 * it applies `ownOnly`, so the hook checks ownership itself.
 *
 * ⚠ FILES AND AI-SERVICE DOCUMENTS GO ONLY AFTER COMMIT. They cannot be rolled
 * back, so the transaction deletes rows and the "after commit" block pins the
 * rest.
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

import {
  consumeCorpusCleanupSkip,
  corpusCleanupSkipList,
  finishUploadCleanupAfterCommit,
  KEEP_CONVERSATION_UPLOADS,
  SKIP_DOCUMENT_CORPUS_CLEANUP,
  type UploadCleanupPlan,
} from '../lib/conversationUploads'
import {
  deleteConversationChildren,
  RETIRABLE_TURN_STATES,
  scheduleUploadCleanup,
  Sessions,
} from './Sessions'

const SESSION = 7
const ECO = 42

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
interface DocRow {
  id: number
  session: number[]
  uploadedInSession?: number | null
  anonymisationStatus?: string
  contentKind?: string
  uploadedBy?: number
  publicationStatus?: string
  createdAt?: string
  mediaFile?: number | null
}

interface FakeOpts {
  organization?: number | null
  failDelete?: string
  /** The documents table. Rows not attached to SESSION live "elsewhere". */
  documents?: DocRow[]
  /** Doc ids another conversation's `contextScope` points at. */
  scopedElsewhere?: number[]
  /** Doc ids a surviving message's `contextRefs` points at. */
  citedElsewhere?: number[]
  /** Doc ids with an anonymisation-review row. */
  reviewed?: number[]
  /** media id → uploader, when it is not OWNER. */
  mediaUploader?: Record<number, number>
  /** `payload_migrations.created_at` of the `uploadedInSession` migration; absent = no row. */
  originRecordedSince?: string
}

const OWNER = 5
const SESSION_CREATED = '2026-10-17T10:00:00.000Z'
const LATER = '2026-10-17T10:05:00.000Z'
const EARLIER = '2026-10-16T09:00:00.000Z'

/** The doc id in a polymorphic `{ field: { equals: { relationTo, value } } }` clause. */
function polymorphicDocId(where: unknown, field: string): number | undefined {
  const w = where as Record<string, unknown>
  const clauses = (w.and as Array<Record<string, unknown>> | undefined) ?? [w]
  const clause = clauses.find((c) => field in c)?.[field] as
    | { equals?: { relationTo?: string; value?: number } }
    | undefined
  if (clause?.equals?.relationTo !== 'documents') return undefined
  return clause.equals.value
}

function fakePayload(
  messages: MessageRow[],
  ratings: Array<{ id: number; session: number }>,
  opts: FakeOpts = {},
): { payload: Payload; calls: Call[] } {
  const calls: Call[] = []
  const documents = opts.documents ?? []

  const payload = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },

    findByID: async (args: { collection: string; id: number }) => {
      calls.push({ op: 'findByID', collection: args.collection, args })
      if (args.collection === 'media') {
        // Every file is the owner's unless the test says otherwise.
        return { id: args.id, uploadedBy: opts.mediaUploader?.[args.id] ?? OWNER }
      }
      if (args.collection !== 'sessions') throw new Error(`unexpected findByID ${args.collection}`)
      return {
        id: args.id,
        organization: opts.organization === undefined ? ECO : opts.organization,
        user: OWNER,
        createdAt: SESSION_CREATED,
      }
    },

    count: async (args: { collection: string; where?: unknown }) => {
      calls.push({ op: 'count', collection: args.collection, args })
      const w = args.where as Record<string, unknown>
      const hit = (ids: number[] | undefined, id: number | undefined) =>
        ({ totalDocs: id !== undefined && ids?.includes(id) ? 1 : 0 })
      if (args.collection === 'sessions') {
        return hit(opts.scopedElsewhere, polymorphicDocId(w, 'contextScope'))
      }
      if (args.collection === 'messages') {
        return hit(opts.citedElsewhere, polymorphicDocId(w, 'contextRefs'))
      }
      if (args.collection === 'anonymisation-reviews') {
        return hit(opts.reviewed, (w.document as { equals?: number })?.equals)
      }
      if (args.collection === 'documents') {
        const and = w.and as Array<Record<string, { equals?: number; not_in?: number[] }>>
        const media = and.find((c) => 'mediaFile' in c)?.mediaFile.equals
        const not = and.find((c) => 'id' in c)?.id.not_in ?? []
        return {
          totalDocs: documents.filter((d) => d.mediaFile === media && !not.includes(d.id)).length,
        }
      }
      throw new Error(`unexpected count ${args.collection}`)
    },

    find: async (args: { collection: string; where?: unknown }) => {
      calls.push({ op: 'find', collection: args.collection, args })
      if (args.collection === 'payload-migrations') {
        const docs = opts.originRecordedSince ? [{ createdAt: opts.originRecordedSince }] : []
        return { docs, totalDocs: docs.length, totalPages: 1, page: 1 }
      }
      if (args.collection === 'documents') {
        const id = (args.where as { session?: { equals?: number } })?.session?.equals
        const docs = documents.filter((d) => id !== undefined && d.session.includes(id))
        return { docs, totalDocs: docs.length, totalPages: 1, page: 1 }
      }
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
      if (args.collection === 'anonymisation-reviews') {
        const doc = (args.where as { document?: { equals?: number } })?.document?.equals
        const docs = (opts.reviewed ?? []).filter((d) => d === doc).map((d) => ({ id: d + 1000 }))
        return { docs, errors: [] }
      }
      if (args.collection === 'messages') return { docs: messages, errors: [] }
      if (args.collection === 'documents' || args.collection === 'media') {
        // By-id deletes: Payload throws on failure rather than collecting errors.
        return { id: (args as { id?: number }).id }
      }
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

    await expect(deleteConversationChildren(SESSION, { payload })).resolves.toBeNull()

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
    ).resolves.toBeNull()

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
    ).resolves.toBeNull()

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

describe('🔴 deleting a conversation must NOT delete a corpus', () => {
  it('never calls deleteCorpus, and never touches a document that lives elsewhere', async () => {
    vi.stubEnv('AI_SERVICE_URL', 'http://ai-service.test')
    vi.stubEnv('AI_SERVICE_ADMIN_API_KEY', 'test-admin-key')

    const messages: MessageRow[] = [
      { id: 1, session: SESSION, corpusStatus: 'ingested' },
      { id: 2, session: SESSION, corpusStatus: 'skipped' },
    ]
    const { payload, calls } = fakePayload(messages, [{ id: 9, session: SESSION }], {
      documents: [{ id: 50, session: [SESSION, 8], uploadedBy: OWNER, createdAt: LATER }],
    })
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

    // ⚠ A document still attached to another conversation survives. Only the
    // `documents_rels` join row goes, and Postgres does that itself
    // (`documents_rels_sessions_fk ON DELETE CASCADE`).
    expect(deleteOps(calls)).toEqual(['ratings', 'messages'])

    vi.unstubAllEnvs()
  })

  it('is wired as one beforeDelete and nothing in afterDelete', () => {
    // `beforeDelete`, not `afterDelete`: by afterDelete the parent delete has
    // already failed on the foreign key. The post-commit cleanup is scheduled
    // from the beforeDelete itself, per row, in a closure.
    expect(Sessions.hooks?.beforeDelete ?? []).toHaveLength(1)
    expect(Sessions.hooks?.afterDelete ?? []).toHaveLength(0)
  })
})

describe('🔴 only the owner’s delete runs the cascade', () => {
  // Payload 3.88 `deleteByID` runs `beforeDelete` BEFORE it checks the row
  // against `ownOnly`. Without this guard, user A deleting user B's session id
  // retires B's turns and deletes B's uploads, then gets a 403.
  it('refuses a signed-in caller who does not own the conversation, before touching anything', async () => {
    const messages: MessageRow[] = [{ id: 1, session: SESSION, corpusStatus: 'ingested' }]
    const { payload, calls } = fakePayload(messages, [{ id: 9, session: SESSION }], {
      documents: [{ id: 50, session: [SESSION], uploadedBy: OWNER, createdAt: LATER, mediaFile: 70 }],
    })
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

describe('uploads that belong ONLY to this conversation go with it', () => {
  /** A documento draft the owner uploaded into SESSION after it was created: the deletable case. */
  const ownUpload = (over: Partial<DocRow> = {}): DocRow => ({
    id: 50,
    session: [SESSION],
    contentKind: 'documento',
    uploadedBy: OWNER,
    publicationStatus: 'draft',
    createdAt: LATER,
    mediaFile: 70,
    ...over,
  })

  const byIdDeletes = (calls: Call[]) =>
    calls
      .filter((c) => c.op === 'delete' && (c.collection === 'documents' || c.collection === 'media'))
      .map((c) => `${c.collection}:${String(c.args?.id)}`)

  /** Wrap `delete` to record the skip-list as each document delete sees it. */
  function recordSkipList(payload: Payload, req: { context: Record<string, unknown> }) {
    const seen: Array<Record<string, true>> = []
    const realDelete = payload.delete.bind(payload)
    const wrapped = {
      ...payload,
      delete: async (args: Parameters<Payload['delete']>[0]) => {
        if (args.collection === 'documents') {
          seen.push({ ...((req.context[SKIP_DOCUMENT_CORPUS_CLEANUP] as Record<string, true>) ?? {}) })
        }
        return realDelete(args)
      },
    } as unknown as Payload
    return { payload: wrapped, seen }
  }

  it('deletes only the ROW in the transaction, and hands the rest to onPlan', async () => {
    const req = { context: {} as Record<string, unknown> }
    const { payload: base, calls } = fakePayload([], [], { documents: [ownUpload()] })
    const { payload, seen } = recordSkipList(base, req)
    const onPlan = vi.fn()

    const plan = await deleteConversationChildren(SESSION, {
      payload,
      req: req as never,
      onUploadPlan: onPlan,
    })

    // ⚠ No media delete in the transaction: it removes the stored object at
    // once, and a rollback cannot bring that back.
    expect(deleteOps(calls)).toEqual(['ratings', 'messages', 'documents'])
    const docDelete = calls.find((c) => c.op === 'delete' && c.collection === 'documents')!
    expect(docDelete.args).toMatchObject({ id: 50, overrideAccess: true, req })
    // ⚠ No `context` argument: it would merge into the shared `req.context`.
    expect(docDelete.args).not.toHaveProperty('context')
    // The document's own afterDelete sees it on the skip-list…
    expect(seen).toEqual([{ '50': true }])
    // …and the entry does not outlive the call.
    expect(req.context[SKIP_DOCUMENT_CORPUS_CLEANUP]).toEqual({})
    expect(plan).toEqual({
      sessionId: SESSION,
      // The fake has no transaction.
      xid: null,
      documents: [{ id: 50, organization: undefined, uploadedBy: OWNER }],
      mediaIds: [70],
    })
    expect(onPlan).toHaveBeenCalledWith(plan)
  })

  it('without a req, scopes the skip to the one delete call', async () => {
    const { payload, calls } = fakePayload([], [], { documents: [ownUpload()] })

    await deleteConversationChildren(SESSION, { payload })

    const docDelete = calls.find((c) => c.op === 'delete' && c.collection === 'documents')!
    expect(docDelete.args?.context).toEqual({ [SKIP_DOCUMENT_CORPUS_CLEANUP]: { '50': true } })
  })

  it('a note with no file leaves no file to delete', async () => {
    const { payload, calls } = fakePayload([], [], {
      documents: [ownUpload({ id: 51, mediaFile: null })],
    })

    const plan = await deleteConversationChildren(SESSION, { payload })

    expect(byIdDeletes(calls)).toEqual(['documents:51'])
    expect(plan?.mediaIds).toEqual([])
  })

  it.each([
    ['attached to another conversation too', { session: [SESSION, 8] }],
    ['published to the ecosistema', { publicationStatus: 'published' }],
    ['mid-publish', { publicationStatus: 'publishing' }],
    ['mid-unpublish', { publicationStatus: 'unpublishing' }],
    ['uploaded before this conversation existed', { createdAt: EARLIER }],
    ['undated', { createdAt: undefined }],
    ['uploaded by someone else', { uploadedBy: OWNER + 1 }],
    ['that is a published testimonio', { contentKind: 'testimonio', publicationStatus: 'published' }],
    ['that is a testimonio mid-publish', { contentKind: 'testimonio', publicationStatus: 'publishing' }],
    ['that is a conversación', { contentKind: 'conversacion' }],
    ['that is a conversación draft held for review', { contentKind: 'conversacion', anonymisationStatus: 'held' }],
    ['with no contentKind', { contentKind: undefined }],
  ] as Array<[string, Partial<DocRow>]>)('keeps a document %s', async (_label, over) => {
    const { payload, calls } = fakePayload([], [], { documents: [ownUpload(over)] })
    const onPlan = vi.fn()

    const plan = await deleteConversationChildren(SESSION, { payload, onUploadPlan: onPlan })

    expect(byIdDeletes(calls)).toEqual([])
    expect(plan).toBeNull()
    expect(onPlan).not.toHaveBeenCalled()
  })

  it.each([
    ['in another conversation’s context scope', { scopedElsewhere: [50] }],
    ['cited by a message in another conversation', { citedElsewhere: [50] }],
    ['with an anonymisation-review record', { reviewed: [50] }],
  ] as Array<[string, FakeOpts]>)('keeps a document %s', async (_label, refs) => {
    const { payload, calls } = fakePayload([], [], { documents: [ownUpload()], ...refs })

    await deleteConversationChildren(SESSION, { payload })

    expect(byIdDeletes(calls)).toEqual([])
  })

  it('🔴 deletes a testimonio draft, as Rodrigo ruled on 2026-10-17', async () => {
    const { payload, calls } = fakePayload([], [], {
      documents: [ownUpload({ contentKind: 'testimonio', anonymisationStatus: 'ready' })],
    })

    const plan = await deleteConversationChildren(SESSION, { payload })

    expect(byIdDeletes(calls)).toEqual(['documents:50'])
    expect(plan?.mediaIds).toEqual([70])
  })

  it('🔴 deletes a HELD testimonio draft AND its review rows, before the document row', async () => {
    const { payload, calls } = fakePayload([], [], {
      documents: [ownUpload({ contentKind: 'testimonio', anonymisationStatus: 'held' })],
      // An earlier decision, before it was held again.
      reviewed: [50],
    })

    const plan = await deleteConversationChildren(SESSION, { payload })

    const deletes = calls.filter((c) => c.op === 'delete').map((c) => c.collection)
    expect(deletes).toEqual(['ratings', 'messages', 'anonymisation-reviews', 'documents'])
    const reviewDelete = calls.find((c) => c.op === 'delete' && c.collection === 'anonymisation-reviews')!
    expect(reviewDelete.args).toMatchObject({ where: { document: { equals: 50 } }, overrideAccess: true })
    // A held row's review record does not keep it.
    expect(calls.some((c) => c.op === 'count' && c.collection === 'anonymisation-reviews')).toBe(false)
    expect(plan?.reviewIds).toEqual([1050])
  })

  it('keeps a REJECTED testimonio draft with a review row: an audit of somebody else’s decision', async () => {
    const { payload, calls } = fakePayload([], [], {
      documents: [ownUpload({ contentKind: 'testimonio', anonymisationStatus: 'rejected' })],
      reviewed: [50],
    })

    await deleteConversationChildren(SESSION, { payload })

    expect(byIdDeletes(calls)).toEqual([])
    expect(calls.some((c) => c.op === 'delete' && c.collection === 'anonymisation-reviews')).toBe(false)
  })

  it('aborts when a held document’s review rows cannot be deleted', async () => {
    const { payload } = fakePayload([], [], {
      documents: [ownUpload({ contentKind: 'testimonio', anonymisationStatus: 'held' })],
      failDelete: 'anonymisation-reviews',
    })
    const onPlan = vi.fn()

    await expect(deleteConversationChildren(SESSION, { payload, onUploadPlan: onPlan })).rejects.toThrow(
      /anonymisation-review/,
    )
    expect(onPlan).toHaveBeenCalledTimes(1)
  })

  describe('uploadedInSession: where the document was uploaded', () => {
    it('deletes a document uploaded in THIS conversation, without reading the migration row', async () => {
      const { payload, calls } = fakePayload([], [], {
        documents: [ownUpload({ uploadedInSession: SESSION })],
      })

      await deleteConversationChildren(SESSION, { payload })

      expect(byIdDeletes(calls)).toEqual(['documents:50'])
      expect(calls.some((c) => c.collection === 'payload-migrations')).toBe(false)
    })

    it('🔴 keeps a document uploaded in another conversation, even when everything else fits', async () => {
      const { payload, calls } = fakePayload([], [], {
        documents: [ownUpload({ uploadedInSession: 8 })],
      })

      expect(await deleteConversationChildren(SESSION, { payload })).toBeNull()
      expect(byIdDeletes(calls)).toEqual([])
    })

    it('NULL on a legacy row (born before the column existed) falls back to the old guess', async () => {
      // Recording began after this row was born: the row is legacy.
      const { payload, calls } = fakePayload([], [], {
        documents: [ownUpload({ uploadedInSession: null })],
        originRecordedSince: '2026-10-18T00:00:00.000Z',
      })

      await deleteConversationChildren(SESSION, { payload })

      expect(byIdDeletes(calls)).toEqual(['documents:50'])
    })

    it('NULL with no migration row (push, a hand-built test database) falls back to the old guess', async () => {
      const { payload, calls } = fakePayload([], [], {
        documents: [ownUpload({ uploadedInSession: null })],
      })

      await deleteConversationChildren(SESSION, { payload })

      expect(byIdDeletes(calls)).toEqual(['documents:50'])
    })

    it('🔴 NULL on a row born AFTER recording began is kept: its origin conversation is gone, or it was no chat upload', async () => {
      const { payload, calls } = fakePayload([], [], {
        documents: [ownUpload({ uploadedInSession: null })],
        originRecordedSince: SESSION_CREATED,
      })

      expect(await deleteConversationChildren(SESSION, { payload })).toBeNull()
      expect(byIdDeletes(calls)).toEqual([])
    })

    it('NULL on a legacy row still needs the old guess: older than the conversation → kept', async () => {
      const { payload, calls } = fakePayload([], [], {
        documents: [ownUpload({ uploadedInSession: null, createdAt: EARLIER })],
        originRecordedSince: '2026-10-18T00:00:00.000Z',
      })

      await deleteConversationChildren(SESSION, { payload })

      expect(byIdDeletes(calls)).toEqual([])
    })
  })

  it('keeps a stored file another surviving document also points at', async () => {
    const { payload, calls } = fakePayload([], [], {
      documents: [ownUpload(), { id: 60, session: [8], uploadedBy: OWNER, mediaFile: 70 }],
    })

    const plan = await deleteConversationChildren(SESSION, { payload })

    expect(byIdDeletes(calls)).toEqual(['documents:50'])
    expect(plan?.mediaIds).toEqual([])
  })

  it('🔴 never plans to delete a file someone else uploaded', async () => {
    // The owner's document points at another person's media id.
    const { payload } = fakePayload([], [], {
      documents: [ownUpload()],
      mediaUploader: { 70: OWNER + 1 },
    })

    const plan = await deleteConversationChildren(SESSION, { payload })

    expect(plan?.documents.map((d) => d.id)).toEqual([50])
    expect(plan?.mediaIds).toEqual([])
  })

  it('deletes only the upload that qualifies when there are several', async () => {
    const { payload, calls } = fakePayload([], [], {
      documents: [
        ownUpload({ id: 50, mediaFile: 70 }),
        ownUpload({ id: 52, mediaFile: 72, session: [SESSION, 8] }),
        ownUpload({ id: 53, mediaFile: 73, publicationStatus: 'published' }),
      ],
    })

    const plan = await deleteConversationChildren(SESSION, { payload })

    expect(byIdDeletes(calls)).toEqual(['documents:50'])
    expect(plan?.mediaIds).toEqual([70])
  })

  it('aborts on a failed row delete, still hands over the plan, and leaves no skip entry behind', async () => {
    const req = { context: {} as Record<string, unknown> }
    const { payload } = fakePayload([], [], { documents: [ownUpload()] })
    const realDelete = payload.delete.bind(payload)
    const failing = {
      ...payload,
      delete: async (args: Parameters<Payload['delete']>[0]) => {
        if (args.collection === 'documents') throw new Error('row is locked')
        return realDelete(args)
      },
    } as unknown as Payload
    const onPlan = vi.fn()

    await expect(
      deleteConversationChildren(SESSION, { payload: failing, req: req as never, onUploadPlan: onPlan }),
    ).rejects.toThrow(/row is locked/)

    // A bulk delete commits what a failing row DID delete; the post-commit
    // half checks each row, so it must still get the plan.
    expect(onPlan).toHaveBeenCalledTimes(1)
    // 🔴 The skip entry must not reach a later delete in the same request.
    expect(req.context[SKIP_DOCUMENT_CORPUS_CLEANUP]).toEqual({})
  })

  it('with keepUploads, reads and deletes no document at all', async () => {
    const { payload, calls } = fakePayload([], [], { documents: [ownUpload()] })

    const plan = await deleteConversationChildren(SESSION, { payload, keepUploads: true })

    expect(plan).toBeNull()
    expect(calls.some((c) => c.collection === 'documents' || c.collection === 'media')).toBe(false)
  })

  it('the hook honours the keep-uploads context flag the janitor sets', async () => {
    const { payload, calls } = fakePayload([], [], { documents: [ownUpload()] })
    const hook = (Sessions.hooks?.beforeDelete ?? [])[0] as unknown as (
      args: unknown,
    ) => Promise<void>
    const context = { [KEEP_CONVERSATION_UPLOADS]: true }

    await hook({ id: SESSION, req: { payload, context }, context })

    expect(calls.some((c) => c.collection === 'documents')).toBe(false)
  })
})

describe('the skip-list Documents.afterDelete reads', () => {
  it('is one-shot and per id', () => {
    const context = { [SKIP_DOCUMENT_CORPUS_CLEANUP]: { '50': true } }

    expect(consumeCorpusCleanupSkip(context, 51)).toBe(false)
    expect(consumeCorpusCleanupSkip(context, 50)).toBe(true)
    // Consumed: a later delete of the same id in the same request cleans up.
    expect(consumeCorpusCleanupSkip(context, 50)).toBe(false)
  })

  it('is created once and shared, so concurrent bulk hooks write to the same map', () => {
    const req = { context: {} } as never
    const a = corpusCleanupSkipList(req)
    const b = corpusCleanupSkipList(req)
    expect(a).toBe(b)
  })
})

describe('after commit: the irreversible half', () => {
  const plan = (over: Partial<UploadCleanupPlan> = {}): UploadCleanupPlan => ({
    sessionId: SESSION,
    xid: '777',
    documents: [{ id: 50, organization: ECO, uploadedBy: OWNER }],
    mediaIds: [70, 71],
    ...over,
  })

  /** `present` = document id → media id, for documents that still exist after commit. */
  function afterCommitPayload(
    opts: { present?: Record<number, number>; failMedia?: number; sessionSurvives?: boolean } = {},
  ) {
    const warn = vi.fn()
    const info = vi.fn()
    const present = opts.present ?? {}
    const mediaDeletes: Array<Record<string, unknown>> = []
    const goneMedia = new Set<number>()
    const payload = {
      logger: { info, warn, error: warn, debug: () => {} },
      findByID: async (args: { collection: string; id: number }) => {
        if (args.collection === 'sessions') return opts.sessionSurvives ? { id: args.id } : null
        // A media row exists until a delete of it succeeds.
        if (args.collection === 'media') return goneMedia.has(args.id) ? null : { id: args.id }
        return args.collection === 'documents' && args.id in present ? { id: args.id } : null
      },
      count: async (args: { where: { mediaFile: { equals: number } } }) => ({
        totalDocs: Object.values(present).filter((m) => m === args.where.mediaFile.equals).length,
      }),
      delete: async (args: Record<string, unknown>) => {
        mediaDeletes.push(args)
        if (args.id === opts.failMedia) throw new Error('bucket unreachable')
        goneMedia.add(args.id as number)
        return { id: args.id }
      },
    } as unknown as Payload
    const deleteDocument = vi.fn(async () => ({ deleted: true }))
    const client = { admin: { deleteDocument, setDocumentValidity: vi.fn() } }
    return { payload, warn, info, mediaDeletes, deleteDocument, client }
  }

  const status = (...answers: Array<string | null>) => {
    let i = 0
    return vi.fn(async () => answers[Math.min(i++, answers.length - 1)] ?? null)
  }

  it('waits for "committed", then deletes the ai-service document and the files', async () => {
    const t = afterCommitPayload()
    const txStatus = status('in progress', 'in progress', 'committed')

    const outcome = await finishUploadCleanupAfterCommit(plan(), {
      payload: t.payload,
      corpusClient: () => t.client as never,
      txStatus,
      intervalMs: 1,
    })

    expect(outcome).toBe('committed')
    expect(txStatus).toHaveBeenCalledWith('777')
    expect(t.deleteDocument.mock.calls).toEqual([
      [`eco-${ECO}`, '50'],
      [`eco-${ECO}-draft-${OWNER}`, '50'],
    ])
    expect(t.mediaDeletes.map((a) => a.id)).toEqual([70, 71])
    for (const call of t.mediaDeletes) {
      expect(call).toMatchObject({ collection: 'media', overrideAccess: true })
      // A fresh transaction: the session delete's own one is over.
      expect(call.req).toBeUndefined()
    }
  })

  it('🔴 an aborted transaction runs nothing, even if the rows are gone by now', async () => {
    // "Row gone" is what a later, successful retry looks like. Only the
    // transaction's own outcome says this plan belongs to the failed attempt.
    const t = afterCommitPayload()

    const outcome = await finishUploadCleanupAfterCommit(plan(), {
      payload: t.payload,
      corpusClient: () => t.client as never,
      txStatus: status('aborted'),
      intervalMs: 1,
    })

    expect(outcome).toBe('aborted')
    expect(t.deleteDocument).not.toHaveBeenCalled()
    expect(t.mediaDeletes).toEqual([])
  })

  it('gives up after its budget and logs every document and media id', async () => {
    const t = afterCommitPayload()

    const outcome = await finishUploadCleanupAfterCommit(plan(), {
      payload: t.payload,
      corpusClient: () => t.client as never,
      txStatus: status('in progress'),
      attempts: 3,
      intervalMs: 1,
    })

    expect(outcome).toBe('gave-up')
    expect(t.deleteDocument).not.toHaveBeenCalled()
    expect(t.mediaDeletes).toEqual([])
    expect(t.warn).toHaveBeenCalledWith(
      { sessionId: String(SESSION), documentIds: ['50'], mediaIds: ['70', '71'] },
      expect.stringContaining('NOT cleaned up'),
    )
  })

  it('🔴 committed but the SESSION survived (its own row delete failed in a bulk): nothing is cleaned', async () => {
    // Payload 3.88 bulk delete commits the other rows when one row's delete
    // throws; that conversation's upload rows are gone, but it still exists.
    const t = afterCommitPayload({ sessionSurvives: true })

    const outcome = await finishUploadCleanupAfterCommit(plan(), {
      payload: t.payload,
      corpusClient: () => t.client as never,
      txStatus: status('committed'),
      intervalMs: 1,
    })

    expect(outcome).toBe('session-survived')
    expect(t.deleteDocument).not.toHaveBeenCalled()
    expect(t.mediaDeletes).toEqual([])
    expect(t.warn).toHaveBeenCalledWith(
      { sessionId: String(SESSION), documentIds: ['50'], mediaIds: ['70', '71'] },
      expect.stringContaining('survived'),
    )
  })

  it('the closing log says what was DONE, not what was planned', async () => {
    // Document 50 survived; media 70 is still in use; only 71 goes.
    const t = afterCommitPayload({ present: { 50: 70 } })

    await finishUploadCleanupAfterCommit(plan(), {
      payload: t.payload,
      corpusClient: () => t.client as never,
      txStatus: status('committed'),
      intervalMs: 1,
    })

    expect(t.info).toHaveBeenCalledWith(
      expect.objectContaining({ cleanedDocumentIds: [], deletedMediaIds: ['71'] }),
      expect.stringContaining('finished'),
    )
  })

  it('logs every planned id at SCHEDULE time, before the wait', async () => {
    const t = afterCommitPayload()

    scheduleUploadCleanup(t.payload, plan())

    // Synchronous: a restart during the wait must still leave this trace.
    expect(t.info).toHaveBeenCalledWith(
      { sessionId: String(SESSION), xid: '777', documentIds: ['50'], mediaIds: ['70', '71'] },
      expect.stringContaining('scheduled'),
    )
  })

  it('committed but the row survived (a failed bulk row): its ai-service doc and file stay', async () => {
    const t = afterCommitPayload({ present: { 50: 70 } })

    await finishUploadCleanupAfterCommit(plan(), {
      payload: t.payload,
      corpusClient: () => t.client as never,
      txStatus: status('committed'),
      intervalMs: 1,
    })

    expect(t.deleteDocument).not.toHaveBeenCalled()
    // 70 is still used by document 50; 71 is used by nothing.
    expect(t.mediaDeletes.map((a) => a.id)).toEqual([71])
  })

  it('a failed file delete is logged with ids only, and the rest still runs', async () => {
    const t = afterCommitPayload({ failMedia: 70 })

    await expect(
      finishUploadCleanupAfterCommit(plan(), {
        payload: t.payload,
        corpusClient: () => t.client as never,
        txStatus: status('committed'),
        intervalMs: 1,
      }),
    ).resolves.toBe('committed')

    expect(t.mediaDeletes.map((a) => a.id)).toEqual([70, 71])
    expect(JSON.stringify(t.warn.mock.calls)).toContain('"mediaId":"70"')
  })

  it('a document deleted on its own (no session): deletes its file, with no session check', async () => {
    const t = afterCommitPayload({ sessionSurvives: true })

    const outcome = await finishUploadCleanupAfterCommit(
      { sessionId: null, documentId: 50, xid: '777', documents: [], mediaIds: [70] },
      { payload: t.payload, txStatus: status('committed'), intervalMs: 1 },
    )

    expect(outcome).toBe('committed')
    expect(t.mediaDeletes.map((a) => a.id)).toEqual([70])
    expect(t.info).toHaveBeenCalledWith(
      { documentId: '50', documentIds: [], mediaIds: ['70'], cleanedDocumentIds: [], deletedMediaIds: ['70'] },
      expect.stringContaining('[documents]'),
    )
  })

  it('a file another plan already deleted (404) is not reported as an orphan', async () => {
    const t = afterCommitPayload()
    const gone = t.payload as unknown as { delete: (a: Record<string, unknown>) => Promise<unknown> }
    gone.delete = async () => {
      throw Object.assign(new Error('Not Found'), { status: 404 })
    }

    await finishUploadCleanupAfterCommit(plan({ mediaIds: [70] }), {
      payload: t.payload,
      corpusClient: () => t.client as never,
      txStatus: status('committed'),
      intervalMs: 1,
    })

    expect(t.warn).not.toHaveBeenCalled()
  })

  it('🔴 an object the storage plugin failed to delete is logged with ids', async () => {
    // `@payloadcms/plugin-cloud-storage` 3.88.0 catches the S3 error, so the
    // media delete "succeeds" and the object stays.
    const t = afterCommitPayload()
    const objectStillStored = vi.fn(async () => true)

    await finishUploadCleanupAfterCommit(plan({ mediaIds: [70] }), {
      payload: t.payload,
      corpusClient: () => t.client as never,
      txStatus: status('committed'),
      objectStillStored,
      intervalMs: 1,
    })

    expect(objectStillStored).toHaveBeenCalledTimes(1)
    expect(t.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: String(SESSION), mediaId: '70', documentIds: ['50'] }),
      expect.stringContaining('still in the bucket'),
    )
  })

  it('with no transaction (autocommit), runs at once on the rows that are gone', async () => {
    const t = afterCommitPayload()
    const txStatus = status('committed')

    const outcome = await finishUploadCleanupAfterCommit(plan({ xid: null }), {
      payload: t.payload,
      corpusClient: () => t.client as never,
      txStatus,
      intervalMs: 1,
    })

    expect(outcome).toBe('no-transaction')
    expect(txStatus).not.toHaveBeenCalled()
    expect(t.mediaDeletes.map((a) => a.id)).toEqual([70, 71])
  })
})
