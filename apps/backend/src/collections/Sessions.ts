import type {
  Access,
  CollectionBeforeValidateHook,
  CollectionConfig,
  Endpoint,
  Where,
} from 'payload'
import { ValidationError } from 'payload'

import { CONTEXT_REF_RELATION_TO } from '../lib/contextRefs'
import { organizationIdsForUser, relationId } from '../lib/permissions'

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
     * 🔴 DELETING A SESSION MUST NOT TOUCH ANY CORPUS. This hook used to call
     * `deleteCorpus(threadCorpus(sessionId))`, back when there was one corpus
     * per conversation.
     *
     * Under the ecosistema model the corpora are `eco-{orgId}` and
     * `eco-{orgId}-draft-{userId}` — SHARED across every session. Deleting one
     * because a conversation was deleted would wipe the whole ecosistema's
     * knowledgebase, or every draft that person has. Do not re-add it.
     *
     * ⚠ `documents` do NOT go with the session: a document belongs to the
     * ecosistema and to its uploader, and `documents.session` is optional
     * precisely so a deleted conversation leaves the uploaded material
     * standing.
     *
     * `documents.session` is `hasMany`, so the attachment lives in the
     * `documents_rels` join table. Deleting a conversation cascades that JOIN
     * ROW away — the attachment, not the document. Same guarantee as before,
     * now expressed on the table that holds the fact.
     *
     * ⚠ `messages` and `ratings` do NOT cascade either, despite what
     * `lib/sessionJanitor.ts` used to claim: their FKs are `ON DELETE SET
     * NULL`, so they are orphaned rather than removed. Verified against the
     * live schema; see the corrected note in that file.
     *
     * 📝 Per-document corpus cleanup on document delete is a separate, still
     * unbuilt problem — see the note on `Documents.hooks`.
     */
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
