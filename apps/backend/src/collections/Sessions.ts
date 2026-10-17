import type {
  Access,
  CollectionBeforeDeleteHook,
  CollectionBeforeValidateHook,
  CollectionConfig,
  Endpoint,
  Payload,
  PayloadRequest,
  Where,
} from 'payload'
import { Forbidden, ValidationError } from 'payload'

import { CONTEXT_REF_RELATION_TO } from '../lib/contextRefs'
import {
  corpusCleanupSkipList,
  deleteConversationUploadRows,
  KEEP_CONVERSATION_UPLOADS,
  scheduleUploadCleanup,
  type UploadCleanupPlan,
} from '../lib/conversationUploads'
import { organizationIdsForUser, relationId } from '../lib/permissions'
import type { CorpusMover } from '../lib/publishDocument'

/**
 * Per-user chat sessions over the knowledgebase.
 *
 * ⚠ ACCESS IS PER USER, NOT PER ORGANIZATION. A session is private to the
 * person who opened it — colleagues in the same organization cannot read each
 * other's conversations. `organization` below is a TENANT TAG for scoping and
 * attribution, not a sharing mechanism. Do not "fix" `ownOnly` into an
 * organization filter; that would publish everyone's chat history to their
 * coworkers.
 *
 * `panelState` is an opaque JSON blob mirroring the frontend's UI state
 * (sidebar collapsed, docs panel open, …). The backend does not interpret it;
 * the frontend round-trips it so a reload on another device lands in the same
 * layout.
 */

const ownOnly: Access = ({ req: { user } }) => {
  if (!user) return false
  return { user: { equals: user.id } } satisfies Where
}

/**
 * ⚠ Owner and ecosistema come from the SERVER, never from the request body.
 *
 * A client-supplied `user` would let anyone create a session owned by someone
 * else and then read it back through `ownOnly`. A client-supplied
 * `organization` would let them point a conversation at an ecosistema they do
 * not belong to — and every corpus name that conversation produces is derived
 * from it, so that is a direct route into another ecosistema's documents.
 */
const stampOwnerAndEcosystem: CollectionBeforeValidateHook = async ({
  data,
  operation,
  originalDoc,
  req,
}) => {
  const next = { ...(data ?? {}) } as Record<string, unknown>
  const user = req.user
  if (!user) return next

  if (operation !== 'create') {
    // Both are immutable: re-homing an existing conversation would change which
    // corpora it searches, silently, for messages already in it.
    const original = (originalDoc ?? {}) as Record<string, unknown>
    next.user = original.user
    next.organization = original.organization
    return next
  }

  next.user = user.id

  const organizationIds = await organizationIdsForUser(req.payload, user.id)
  const declared = next.organization

  if (declared !== undefined && declared !== null && declared !== '') {
    // ⚠ A declared ecosistema is CHECKED, never trusted. This is the branch a
    // cross-ecosistema attempt actually takes.
    const allowed = new Set(organizationIds.map(String))
    if (!allowed.has(String(relationId(declared) ?? declared))) {
      throw new ValidationError({
        collection: 'sessions',
        errors: [{ path: 'organization', message: 'You do not belong to that ecosistema.' }],
        req,
      })
    }
    next.organization = relationId(declared) ?? declared
    return next
  }

  // Nothing declared. Fill it in only when there is exactly one candidate —
  // guessing between two would file the conversation, its documents and every
  // rating derived from it under the wrong ecosistema, silently.
  if (organizationIds.length === 1) {
    next.organization = organizationIds[0]
    return next
  }

  throw new ValidationError({
    collection: 'sessions',
    errors: [
      {
        path: 'organization',
        message:
          organizationIds.length === 0
            ? 'You do not belong to an ecosistema yet, so there is nothing to search.'
            : 'You belong to several ecosistemas — say which one this conversation is for.',
      },
    ],
    req,
  })
}

// ---------------------------------------------------------------------------
// Deleting a conversation
// ---------------------------------------------------------------------------

/**
 * 🔴 DELETING A CONVERSATION DELETES ITS RATINGS AND ITS MESSAGES, and retires
 * the turns that already reached the ecosistema's corpus, and deletes the
 * uploads that belong to this conversation alone. It never deletes a corpus.
 *
 * ── WHY THIS IS APPLICATION CODE AND NOT A MIGRATION ─────────────────────────
 *
 * Payload generates every `required: true` relationship as a NOT NULL column
 * whose foreign key says `ON DELETE SET NULL`. Those two rules contradict each
 * other, so Postgres refuses the parent delete outright:
 *
 *   ERROR: null value in column "session_id" of relation "messages"
 *          violates not-null constraint
 *
 * Verified against the dev database (`messages.session_id`,
 * `ratings.session_id`). Until this hook existed, `DELETE /api/sessions/:id`
 * failed for every conversation that had a single message, and
 * `lib/sessionJanitor.ts` reaped almost nothing.
 *
 * ⚠ DO NOT "FIX" IT BY ALTERING THE FOREIGN KEY.
 *
 *   · Payload regenerates the FK behaviour from the field config, so a
 *     hand-altered constraint is silently reverted by the next
 *     `payload migrate:create`. `src/migrations/README.md` records the time the
 *     migration chain was already broken by exactly that kind of hand-editing.
 *   · Every real delete path goes through `payload.delete` — the BFF route, the
 *     janitor and the admin panel. One hook covers all three.
 *
 * ── ORDER IS LOAD-BEARING ────────────────────────────────────────────────────
 *
 *   1. RETIRE the ingested turns FIRST. Their external ids are derived from the
 *      `messages` row ids (`msg-<id>`, `lib/conversationIngest.ts`). Once the
 *      rows are gone nothing points at the corpus copies any more and they are
 *      stranded, answering colleagues' questions from a conversation the owner
 *      believes is deleted.
 *   2. RATINGS BEFORE MESSAGES. `ratings.message_id` is NOT NULL with the same
 *      `ON DELETE SET NULL` foreign key, so deleting a message that carries a
 *      rating fails in exactly the same way. This is not guessable from reading
 *      the code — the two deletes look independent and are not.
 *   3. Messages last.
 *
 * ── FAILURE POLICY: ABORT, DO NOT LIMP ───────────────────────────────────────
 *
 * Anything that fails throws, and the session survives. A half-deleted
 * conversation — rows gone, corpus copy still retrievable, or ratings orphaned
 * — is the exact silent state this hook exists to prevent, and a failed delete
 * is something the user can retry. `beforeDelete`, not `afterDelete`, for the
 * same reason: by `afterDelete` the parent delete has already failed.
 *
 * ⚠ Payload's bulk `delete({ where })` does NOT throw on a per-row failure; it
 * collects them into `result.errors`. `assertNoBulkErrors` below turns that
 * back into an exception, which is the only reason the policy above is real.
 *
 * ── WHAT THIS MUST NEVER TOUCH ───────────────────────────────────────────────
 *
 * 🔴 NO CORPUS IS EVER DELETED. See the note on `hooks` below. The corpora are
 * shared across an entire ecosistema; `deleteCorpus` here would wipe a
 * knowledgebase. `Sessions.cascade.test.ts` and `lib/sessionJanitor.test.ts`
 * both guard it.
 *
 * ⚠ ONLY THE UPLOADS THAT BELONG TO THIS CONVERSATION ALONE ARE DELETED —
 * document row in the transaction; stored file and ai-service chunks only
 * once `txid_status` says this transaction committed (`scheduleUploadCleanup`).
 * The rule (attached nowhere else, a `documento` or `testimonio` draft —
 * held ones included —, the owner's, uploaded in this conversation,
 * referenced by nothing else) lives in `lib/conversationUploads.ts`.
 * Conversaciones are never cascade-deleted. Every other document
 * keeps standing: `documents.session` is `hasMany`, the attachment lives in the
 * `documents_rels` join table, and `documents_rels_sessions_fk` is
 * `ON DELETE CASCADE` (re-verified against the live schema on 2026-08-28), so
 * only the ATTACHMENT ROW goes.
 *
 * Until 2026-10-17 no document was ever deleted here, and every file uploaded
 * in a chat outlived the chat in "Mis documentos". Rodrigo ruled that a bug.
 * The session janitor still keeps uploads (`KEEP_CONVERSATION_UPLOADS`).
 */

/**
 * The turn states whose text has reached, or is on its way to, the shared
 * corpus.
 *
 * ⚠ `embedding` is in this list on purpose. That turn is mid-flight at
 * ai-service: the ingest will land after we delete the row, so if we skip it
 * the chunk arrives with nothing left pointing at it — unreachable garbage that
 * still answers questions. Retiring it is idempotent and a 404 (it never
 * arrived) is treated as success, so retiring one turn too many costs nothing.
 */
export const RETIRABLE_TURN_STATES = ['ingested', 'embedding'] as const

export interface ConversationCascadeDeps {
  payload: Payload
  /** Passed through so every child delete joins the parent's transaction. */
  req?: PayloadRequest
  /**
   * Acquired LAZILY and only when there is something to retire. A local run
   * with no `AI_SERVICE_ADMIN_API_KEY` throws on construction, and a
   * conversation that never reached the corpus must still be deletable there.
   */
  corpusClient?: (organizationId: number | string) => Promise<CorpusMover>
  now?: Date
  /** Skip the uploads step. The janitor sets it, via `KEEP_CONVERSATION_UPLOADS`. */
  keepUploads?: boolean
  /** Receives the post-commit plan for the uploads; the hook schedules it. */
  onUploadPlan?: (plan: UploadCleanupPlan) => void
}

/**
 * 🔴 THE OWNERSHIP CHECK `beforeDelete` DOES NOT GET FROM PAYLOAD.
 *
 * Payload 3.88.0 `collections/operations/deleteByID.js` runs `beforeDelete`
 * (lines 44-52) BEFORE it matches the row against the `ownOnly` where-filter
 * (lines 56-72). Without this check, user A sending `DELETE /api/sessions/<B's
 * id>` — ids are sequential — ran the whole cascade on B's conversation first
 * and got a 403 only afterwards. Reproduced on a real Postgres:
 * `Sessions.ownerGuard.pg.test.ts`.
 *
 * A signed-in caller must own the conversation. There is no admin exception
 * because `ownOnly` has none either: Payload would refuse a platform admin's
 * delete of someone else's session anyway, so letting the cascade run for one
 * would only reproduce the same hole. A caller with NO user is server code
 * (the janitor), which already chose `overrideAccess`.
 */
async function assertMayDeleteConversation(
  sessionId: number | string,
  { payload, req }: ConversationCascadeDeps,
): Promise<void> {
  const user = req?.user
  if (!user) return
  const session = await payload.findByID({
    collection: 'sessions',
    id: sessionId,
    depth: 0,
    overrideAccess: true,
    disableErrors: true,
    req,
  })
  // Missing: nothing to cascade, and Payload answers 404 itself.
  if (!session) return
  if (String(relationId((session as { user?: unknown }).user)) !== String(user.id)) {
    throw new Forbidden(req?.t)
  }
}

/** The admin client of the conversation's ecosistema: its corpus lives in that org. */
async function adminCorpusClient(organizationId: number | string): Promise<CorpusMover> {
  const { getAdminAIClient } = await import('@/lib/aiClient')
  return getAdminAIClient(organizationId) as unknown as CorpusMover
}

/**
 * The cascade itself. Exported so it can be tested against a fake payload
 * without booting Payload — see `Sessions.cascade.test.ts`.
 */
export async function deleteConversationChildren(
  sessionId: number | string,
  deps: ConversationCascadeDeps,
): Promise<UploadCleanupPlan | null> {
  const { payload, req } = deps
  const now = deps.now ?? new Date()

  // 🔴 FIRST, before anything that reaches ai-service or deletes a row.
  await assertMayDeleteConversation(sessionId, deps)

  await retireIngestedTurns(sessionId, deps, now)

  // ⚠ RATINGS FIRST. `ratings.message_id` is NOT NULL + ON DELETE SET NULL, so
  // deleting a rated message before its rating fails the same way the session
  // delete used to. Do not reorder these two.
  assertNoBulkErrors(
    'ratings',
    sessionId,
    await payload.delete({
      collection: 'ratings',
      where: { session: { equals: sessionId } },
      depth: 0,
      // ⚠ REQUIRED. The janitor runs as a system task with no `req.user`, and
      // the default access on both collections is per-user — without this the
      // delete would quietly match nothing and leave the session undeletable.
      overrideAccess: true,
      req,
    }),
  )

  assertNoBulkErrors(
    'messages',
    sessionId,
    await payload.delete({
      collection: 'messages',
      where: { session: { equals: sessionId } },
      depth: 0,
      overrideAccess: true,
      req,
    }),
  )

  // ⚠ AFTER the messages: a message still citing an upload must be one from
  // another conversation. BEFORE the session row: the `documents_rels` rows
  // that say which uploads are this conversation's cascade away with it.
  // Rows only: files and ai-service documents go after commit (see
  // `lib/conversationUploads.ts`), from the plan this returns.
  if (deps.keepUploads) return null
  return deleteConversationUploadRows(sessionId, { payload, req, onPlan: deps.onUploadPlan })
}

/**
 * Close the validity window on every turn of this conversation that reached the
 * ecosistema's SHARED corpus (`eco-{orgId}`).
 *
 * ⚠ THIS IS NOT AN ERASURE, and the comment says so because the UI word is
 * "delete". ai-service has no per-document delete; retirement stamps
 * `validTo: now` and the chunk stops being RETURNED because every retrieve in
 * this repo carries `asOf` (`retrievalOptionsFor()`, handed to the client by
 * `GET /api/sessions/:id/corpora`). The vector and its text stay in the corpus.
 * A future retrieve that forgets `asOf` would see them again. See the header of
 * `lib/publishDocument.ts` — that is the weakest link in this design, not a
 * detail of this hook.
 */
async function retireIngestedTurns(
  sessionId: number | string,
  deps: ConversationCascadeDeps,
  now: Date,
): Promise<void> {
  const { payload, req } = deps

  const turns = await payload.find({
    collection: 'messages',
    where: {
      and: [
        { session: { equals: sessionId } },
        { corpusStatus: { in: [...RETIRABLE_TURN_STATES] } },
      ],
    },
    depth: 0,
    overrideAccess: true,
    pagination: false,
    req,
  })

  if (turns.docs.length === 0) return

  const session = await payload.findByID({
    collection: 'sessions',
    id: sessionId,
    depth: 0,
    overrideAccess: true,
    req,
  })
  const organizationId = relationId((session as { organization?: unknown })?.organization)

  if (organizationId == null) {
    // Unreachable in practice — `organization` is required and the column is
    // NOT NULL. Refusing beats guessing: without the ecosistema id there is no
    // corpus name, so we cannot retire, and deleting anyway would leave the
    // turns retrievable forever with nothing pointing at them.
    throw new Error(
      `[sessions] refusing to delete session ${String(sessionId)}: it has ${turns.docs.length} ` +
        'ingested turn(s) but no ecosistema, so no corpus name can be derived to retire them.',
    )
  }

  const { publishedCorpus } = await import('@/lib/corpus')
  const { turnExternalId } = await import('@/lib/conversationIngest')
  const { retireFrom } = await import('@/lib/publishDocument')

  const corpus = publishedCorpus(organizationId)
  const client = await (deps.corpusClient ?? adminCorpusClient)(organizationId)

  for (const turn of turns.docs) {
    // ⚠ Throws on anything but a 404. A 404 means "ai-service has no such
    // corpus or document", which is the property we asked for, and `retireFrom`
    // already tolerates it — see `isAlreadyAbsent` in `lib/publishDocument.ts`.
    await retireFrom(client, corpus, turnExternalId(turn.id), now, payload.logger)
  }
}

/** Turn Payload's silent per-row bulk-delete failures back into an exception. */
function assertNoBulkErrors(
  collection: string,
  sessionId: number | string,
  result: unknown,
): void {
  const errors =
    (result as { errors?: Array<{ id?: unknown; message?: string }> } | null)?.errors ?? []
  if (errors.length === 0) return
  const detail = errors
    .map((e) => `${String(e?.id ?? '?')}: ${e?.message ?? 'unknown error'}`)
    .join('; ')
  throw new Error(
    `[sessions] could not delete ${errors.length} ${collection} row(s) for session ` +
      `${String(sessionId)}; the conversation was left intact. ${detail}`,
  )
}

// Lives with the rest of the machinery; `Documents.beforeDelete` schedules
// through it too. Re-exported for `Sessions.cascade.test.ts`.
export { scheduleUploadCleanup }

const cascadeConversationDelete: CollectionBeforeDeleteHook = async ({ context, id, req }) => {
  // ⚠ Synchronously, before any `await`: concurrent bulk-delete hooks must
  // share ONE skip-list object (see `corpusCleanupSkipList`).
  corpusCleanupSkipList(req)
  await deleteConversationChildren(id, {
    payload: req.payload,
    req,
    keepUploads: context?.[KEEP_CONVERSATION_UPLOADS] === true,
    onUploadPlan: (plan) => scheduleUploadCleanup(req.payload, plan),
  })
}

export const Sessions: CollectionConfig = {
  slug: 'sessions',
  admin: {
    useAsTitle: 'title',
    defaultColumns: ['title', 'user', 'lastUsedAt', 'createdAt'],
  },
  access: {
    read: ownOnly,
    update: ownOnly,
    delete: ownOnly,
    create: ({ req: { user } }) => Boolean(user),
  },
  fields: [
    {
      name: 'user',
      type: 'relationship',
      relationTo: 'users',
      required: true,
      index: true,
      admin: { readOnly: true },
    },
    {
      /**
       * ⚠ WHICH ECOSISTEMA THIS CONVERSATION SEARCHES. Required, because the
       * corpus names a chat turn retrieves from are derived from it
       * (`lib/corpus.ts`): a session with no ecosistema can search nothing, so
       * allowing one would just move the failure to a confusing place.
       *
       * The client does not have to send it. `stampOwnerAndEcosystem` below
       * fills it in when the answer is unambiguous — which is the common case,
       * because most people belong to exactly one. Someone who belongs to
       * several MUST choose, and gets a clear error saying so.
       *
       * ⚠ Filled in `beforeValidate`, not `beforeChange`. Payload runs field
       * validation between the two, so a `required` field populated in
       * `beforeChange` fails validation before the value is ever written.
       *
       * `ratings` reads this to stamp a rating with the right ecosistema.
       */
      name: 'organization',
      type: 'relationship',
      relationTo: 'organizations',
      required: true,
      index: true,
      admin: {
        readOnly: true,
        description:
          'The ecosistema this conversation searches. Auto-filled when you belong to exactly one.',
      },
    },
    { name: 'title', type: 'text', defaultValue: 'New chat' },
    {
      name: 'lastUsedAt',
      type: 'date',
      admin: { date: { pickerAppearance: 'dayAndTime' } },
    },
    {
      name: 'panelState',
      type: 'json',
      admin: {
        description:
          'Opaque per-user UI state (sidebar/docs-panel toggles). Mirrors localStorage shape from chat.app-state.v1.',
      },
    },
    {
      // CANONICAL ref-field contract: the per-thread context scope is a
      // polymorphic hasMany relationship over the domain entities (org/team/
      // project/membership/document). Empty = whole org (tenant-wide). The FE
      // Domain Adapter maps these `{relationTo,value}` rows ↔ the engine's
      // neutral `{kind,id}` via the single kind↔collection map (lib/contextRefs).
      // Supersedes the legacy `context_scope` json column (migrated + dropped in
      // 20260609_040000); the `org` sentinel is NOT stored — empty IS org-wide.
      name: 'contextScope',
      type: 'relationship',
      relationTo: [...CONTEXT_REF_RELATION_TO],
      hasMany: true,
      admin: {
        description:
          'chat-engine context scope (polymorphic refs). Org/Team/Project/Member/' +
          'Document selection that scopes retrieval + the deterministic summary. ' +
          'Empty = whole organization.',
      },
    },
  ],
  hooks: {
    beforeValidate: [stampOwnerAndEcosystem],
    /**
     * 🔴 DELETING A SESSION MUST NOT TOUCH ANY CORPUS. There used to be an
     * `afterDelete` here calling `deleteCorpus(threadCorpus(sessionId))`, back
     * when there was one corpus per conversation.
     *
     * Under the ecosistema model the corpora are `eco-{orgId}` and
     * `eco-{orgId}-draft-{userId}` — SHARED across every session. Deleting one
     * because a conversation was deleted would wipe the whole ecosistema's
     * knowledgebase, or every draft that person has. DO NOT RE-ADD IT. That
     * prohibition still stands in full, and it is not weakened by the
     * `beforeDelete` below: retiring a turn closes ONE document's validity
     * window; deleting a corpus destroys everyone's. They are not the same
     * operation and the second one has no caller in this repo.
     *
     * ── WHAT `beforeDelete` DOES, AND WHY IT EXISTS ─────────────────────────
     *
     * `cascadeConversationDelete` (defined above this config, with the long
     * rationale) runs three steps, in this order:
     *
     *   1. RETIRES every turn whose `corpusStatus` is `ingested` or
     *      `embedding` from `eco-{orgId}` — the ecosistema's SHARED corpus, the
     *      one every member retrieves from — by stamping `validTo: now` on
     *      external id `msg-<messageId>`. Without this, "delete" would be a
     *      lie: the rows would go and the anonymised turns would keep answering
     *      colleagues' questions. ⚠ Retirement is NOT erasure; the chunk stops
     *      being returned only because every retrieve carries `asOf`.
     *   2. Deletes the session's `ratings`.
     *   3. Deletes the session's `messages`.
     *   0. FIRST refuses a signed-in caller who does not own the conversation
     *      (`assertMayDeleteConversation` — Payload checks `ownOnly` only
     *      after this hook has run).
     *   4. Deletes the `documents` rows of the uploads that belong to this
     *      conversation ALONE. Their files and ai-service documents go after
     *      commit, scheduled from this hook. See `lib/conversationUploads.ts`
     *      for the rule and its one blind spot (legacy rows only).
     *
     * ⚠ Steps 2 and 3 are in that order because `ratings.message_id` is NOT
     * NULL with an `ON DELETE SET NULL` foreign key. Reversing them breaks the
     * delete.
     *
     * It exists because NOTHING cascades at the database level: `messages` and
     * `ratings` both hold NOT NULL columns whose FKs say `ON DELETE SET NULL`,
     * a contradiction Postgres resolves by refusing the delete. Every real
     * delete path goes through `payload.delete`, so this hook covers the BFF
     * route, the janitor and the admin panel alike.
     *
     * ⚠ `beforeDelete`, NOT `afterDelete`. By `afterDelete` the parent delete
     * has already failed on the foreign key, so an `afterDelete` cascade can
     * never run at all.
     *
     * ⚠ Any OTHER document survives: attached elsewhere, published, a
     * conversación, uploaded in another conversation (or, on rows older than
     * `uploadedInSession`, older than this one), someone else's, or referenced
     * elsewhere. A held testimonio's review rows go with it. For those,
     * `documents_rels_sessions_fk` is `ON DELETE CASCADE` (re-verified against
     * the live schema, 2026-08-28), so deleting a conversation removes only the
     * JOIN ROW — the attachment, not the document.
     *
     * The session janitor passes `context[KEEP_CONVERSATION_UPLOADS]` and so
     * keeps every upload, as before.
     */
    beforeDelete: [cascadeConversationDelete],
  },
  endpoints: [sessionCorporaEndpoint()],
}

// ---------------------------------------------------------------------------
// GET /api/sessions/:id/corpora
// ---------------------------------------------------------------------------

/**
 * 🔴 THE ONE PLACE A CLIENT LEARNS WHICH CORPORA A CHAT TURN MAY SEARCH.
 *
 * ⚠ THIS ENDPOINT EXISTS SO THE FRONTEND NEVER DERIVES A CORPUS NAME. The names
 * are `eco-{orgId}` and `eco-{orgId}-draft-{userId}`, and both are trivially
 * guessable — ids are sequential. If the frontend built them from values it
 * holds, a modified client could ask for `eco-{someoneElsesOrgId}` and
 * ai-service would faithfully answer, because ai-service cannot tell our
 * tenants apart (see `lib/corpus.ts`). Deriving them here, from a session whose
 * ownership is proven, is the whole boundary.
 *
 * Returns both names. Retrieval should be ONE `POST /v1/retrieve/multi` over
 * both:
 *
 *   · a missing corpus contributes zero chunks instead of failing the call, so
 *     someone with no drafts needs no special-casing;
 *   · each returned chunk is tagged with the corpus it came from, which is what
 *     lets a citation say "from your draft" versus "from the ecosistema".
 *
 * ⚠ `retrieveMulti` forwards ONE `filter` to every leg — there are no per-corpus
 * filters. That is fine here precisely because the names already do the
 * scoping, and it is the reason not to collapse this into one corpus plus a
 * filter.
 *
 * ⚠ Callers must also spread `retrievalOptionsFor()` (an `asOf` timestamp).
 * Documents promoted out of drafts are retired by closing a validity window,
 * not by deletion, so a retrieve without `asOf` can still return them. See
 * `lib/publishDocument.ts`.
 */
function sessionCorporaEndpoint(): Endpoint {
  return {
    path: '/:id/corpora',
    method: 'get',
    handler: async (req) => {
      const json = (body: unknown, status: number): Response =>
        new Response(JSON.stringify(body), {
          status,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            // Per-session, per-user. Never cache in a shared proxy.
            'Cache-Control': 'no-store',
          },
        })

      const user = req.user
      if (!user) return json({ errors: [{ message: 'Authentication required.' }] }, 401)

      const id = (req.routeParams as { id?: string } | undefined)?.id
      if (!id) return json({ errors: [{ message: 'Missing session id.' }] }, 400)

      const { corporaForSession, SessionHasNoEcosystemError, SessionNotOwnedError } = await import(
        '@/lib/corpus'
      )
      const { retrievalOptionsFor } = await import('@/lib/publishDocument')

      try {
        const corpora = await corporaForSession(req.payload, id, user.id)
        return json(
          {
            corpora: corpora.all,
            published: corpora.published,
            draft: corpora.draft,
            // Handed over rather than documented, so a caller cannot forget it.
            ...retrievalOptionsFor(),
          },
          200,
        )
      } catch (err) {
        if (err instanceof SessionNotOwnedError) {
          // ⚠ 404, not 403. "Not yours" and "does not exist" must be the same
          // answer, or this becomes an oracle for which session ids exist.
          return json({ errors: [{ message: err.message }] }, 404)
        }
        if (err instanceof SessionHasNoEcosystemError) {
          return json({ errors: [{ message: err.message }] }, 409)
        }
        throw err
      }
    },
  }
}
