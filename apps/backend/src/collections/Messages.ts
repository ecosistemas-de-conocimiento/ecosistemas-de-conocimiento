import type {
  Access,
  CollectionAfterChangeHook,
  CollectionBeforeValidateHook,
  CollectionConfig,
  Where,
} from 'payload'
import { ValidationError } from 'payload'

import { isActiveUser } from '../access'
import { MESSAGE_CORPUS_STATES } from '../lib/conversationIngest'
import { CONTEXT_REF_RELATION_TO } from '../lib/contextRefs'
import { assertSessionOwnedBy, SessionNotOwnedError } from '../lib/corpus'
import { relationId } from '../lib/permissions'

/**
 * Chat messages — one per turn (user, assistant, or system). Replaces the
 * localStorage-backed `messages` previously stored in `chat.app-state.v1`.
 *
 * Access: per-user via the parent `session.user` relation. Payload's where
 * filter on a related-field path applies on read/update/delete.
 *
 * `generationMeta` is for ai-service telemetry — `traceId`, `modelUsed`,
 * `costUsd`, etc. — that the SvelteKit BFF wants to round-trip without
 * inventing first-class columns per field.
 */

const ownViaSession: Access = ({ req: { user } }) => {
  // See `ownOnly` in Sessions.ts: a deactivated account reads nothing.
  if (!user || !isActiveUser(user)) return false
  return { 'session.user': { equals: user.id } } satisfies Where
}

/** Admin-panel labels. Exhaustive by type, so a new state forces a label. */
const CORPUS_STATE_LABELS: Record<(typeof MESSAGE_CORPUS_STATES)[number], string> = {
  pending: 'Pending — not yet considered',
  'held-drafts': 'HELD — the conversation cites an unpublished draft',
  'held-gate': 'HELD — the anonymisation gate refused this turn',
  embedding: 'Embedding — enqueued at ai-service',
  ingested: 'Ingested — in the ecosistema corpus',
  failed: 'Failed — will be retried on the next run',
  skipped: 'Skipped — not eligible (system turn, empty, or predates conversation ingest)',
}

/**
 * 🔴 THE WRITE GATE. Without it, `POST /api/messages` IS A CORPUS WRITE.
 *
 * ── THE HOLE THIS CLOSES, CONCRETELY ────────────────────────────────────────
 *
 * `create` access on this collection is "any signed-in user", because Payload's
 * create-time check has no document to constrain against. That was harmless
 * while a `messages` row was inert. It stopped being harmless the moment the
 * `afterChange` hook below started pushing turns into the ecosistema's SHARED
 * corpus, because two separate gaps then compose into one injection:
 *
 *   1. Nothing checked that `session` belonged to the caller. Session ids are
 *      sequential integers, so ANOTHER ECOSISTEMA'S corpus is guessable.
 *   2. `redactedText` and `corpusStatus` were `admin: { readOnly: true }` only —
 *      a UI affordance, not access control. A request body could supply both.
 *
 * So `POST /api/messages { session: <someone else's>, role: 'assistant',
 * content: 'x', redactedText: '<anything at all>' }` put attacker-chosen text
 * into a stranger's shared corpus, labelled as a previous assistant answer,
 * UNGATED — into a corpus with no per-document delete. Same class of bug as the
 * one `bindDocumentToEcosystem` exists to close for `documents`, and worse,
 * because there is no publish step in front of it.
 *
 * ⚠ IT IS A HOOK, NOT A UI RULE, for the same reason as everywhere else here:
 * the REST API is the whole surface, and a `beforeValidate` hook runs on every
 * write path Payload has.
 *
 * ⚠ Server-side writes (`overrideAccess: true`, no `req.user`) pass straight
 * through. That is the ingest pipeline writing its own state, and there is
 * nobody to impersonate.
 */
export const protectMessageCorpusState: CollectionBeforeValidateHook = async ({
  data,
  operation,
  originalDoc,
  req,
}) => {
  const next = { ...(data ?? {}) } as Record<string, unknown>
  const user = req.user
  if (!user) return next

  const original = (originalDoc ?? {}) as Record<string, unknown>

  /**
   * 🔴 SERVER-OWNED, ALWAYS. Every one of these is either the gate's verdict or
   * the corpus cursor. A client that can set `redactedText` skips the
   * anonymisation gate outright; a client that can set `corpusStatus` decides
   * what gets embedded and what gets re-embedded.
   */
  /**
   * What each of these is worth at CREATE time, server-side.
   *
   * 🔴 `corpusStatus` is SET, not deleted, and that distinction broke every
   * message write in the product.
   *
   * The comment that used to sit here said deleting the key "lets Payload apply
   * the default". It does not: Payload resolves field defaults BEFORE the
   * collection `beforeValidate` hook runs, so by the time we get here the
   * default is already on `data` — and deleting it hands validation a
   * `required` field with nothing in it. `POST /api/messages` answered
   * `400 "Corpus Status is required"` for EVERY caller, which is the route the
   * web BFF writes every chat turn through. Measured against the running
   * backend, not inferred.
   *
   * ⚠ The lesson worth keeping: a comment that names its assumption is only
   * half the work. This one named it and was still wrong for months of hook
   * ordering. Anything relying on when a framework runs its own machinery needs
   * a test that would fail if the order changed — see the create tests below.
   *
   * `null` here means "clear it"; a string means "force it to this".
   */
  const SERVER_OWNED_ON_CREATE = {
    redactedText: null,
    // The only correct starting point: this turn has not been offered to the
    // corpus yet. `skipped` would silently exclude it forever.
    corpusStatus: 'pending',
    corpusIngestId: null,
    corpusError: null,
    anonymisationReport: null,
  } as const

  const SERVER_OWNED = Object.keys(SERVER_OWNED_ON_CREATE) as Array<
    keyof typeof SERVER_OWNED_ON_CREATE
  >

  for (const key of SERVER_OWNED) {
    if (operation === 'create') {
      const initial = SERVER_OWNED_ON_CREATE[key]
      // Assigning `null` rather than deleting is deliberate for the optional
      // ones too: it overwrites whatever a client sent instead of trusting that
      // an absent key and a null are handled the same way downstream.
      next[key] = initial
    } else if (key in original) {
      // ⚠ Pinned to the stored value rather than deleted: `corpusStatus` is
      // `required`, and deleting it on an update fails validation on every
      // ordinary PATCH. Same shape and same reason as `publicationStatus` in
      // `collections/Documents.ts`.
      next[key] = original[key]
    } else {
      delete next[key]
    }
  }

  // ⚠ THE SESSION IS PROVEN, NEVER TRUSTED. On update it is immutable outright:
  // re-homing a turn would move which ecosistema's corpus it feeds, for a
  // message that may already be embedded somewhere else.
  const sessionId =
    operation === 'create'
      ? relationId(next.session)
      : (relationId(original.session) ?? relationId(next.session))

  if (sessionId === null) {
    throw new ValidationError({
      collection: 'messages',
      errors: [{ path: 'session', message: 'A message must belong to a conversation.' }],
      req,
    })
  }

  try {
    await assertSessionOwnedBy(req.payload, sessionId, user.id)
  } catch (err) {
    if (err instanceof SessionNotOwnedError) {
      // Same message for "not yours" and "does not exist" — see `lib/corpus.ts`.
      throw new ValidationError({
        collection: 'messages',
        errors: [{ path: 'session', message: err.message }],
        req,
      })
    }
    throw err
  }
  next.session = sessionId

  /**
   * ⚠ EDITING THE TEXT INVALIDATES THE REDACTION. `redactedText` is the gate's
   * output for the OLD content; keeping it would embed a redaction of something
   * the person no longer said.
   *
   * ⚠ Only while the turn is still ours to hold. Once it is `embedding` or
   * `ingested` the chunk exists and there is no per-document delete, so
   * resetting the cursor would append a SECOND copy rather than replacing the
   * first. The honest outcome there is that the corpus keeps the older text;
   * that is a property of retirement-not-deletion, not something this hook can
   * fix.
   */
  if (
    operation !== 'create' &&
    'content' in next &&
    next.content !== original.content &&
    original.corpusStatus !== 'embedding' &&
    original.corpusStatus !== 'ingested'
  ) {
    next.redactedText = null
    next.corpusStatus = 'pending'
    next.corpusError = null
  }

  return next
}

/**
 * 🔴 THE TRIGGER. A new turn arrives; whatever is outstanding gets appended.
 *
 * Owner ruling 2026-10-21 (#4, choice A, "store, never cite in chat"): every
 * turn, question and answer, goes into the ecosistema's corpus through the
 * anonymisation gate, for orientation only. Chat never cites one (web
 * `lib/turnChunks.ts`, `lib/server/engine/orientation.ts`). This reverses the
 * removal in a4643cb.
 *
 * ⚠ `create` ONLY, AND GUARDED. Conversation ingest writes back to `messages`
 * (status, `redactedText`), and those writes re-fire this hook. Without both the
 * operation check and the context flag, one message would start a run that
 * writes a status that starts a run — and each of those runs costs model calls.
 *
 * ⚠ Fired-and-forgotten through `setImmediate`, like the document ingest hook,
 * for the same two reasons: the chat response must not wait on an embedding
 * round trip, and the row has to be committed before a fresh Payload handle can
 * read it back.
 *
 * ⚠ IT APPENDS. It does not re-ingest the thread — see `lib/conversationIngest.ts`,
 * where that property is structural rather than a promise.
 */
const ingestConversationHook: CollectionAfterChangeHook = ({ doc, req, operation }) => {
  const ctx = req.context as { __skipConversationIngest?: boolean } | undefined
  if (ctx?.__skipConversationIngest) return doc
  if (operation !== 'create') return doc

  const sessionId = (doc as { session?: unknown }).session
  const id =
    typeof sessionId === 'number' || typeof sessionId === 'string'
      ? sessionId
      : sessionId && typeof sessionId === 'object'
        ? ((sessionId as { id?: number | string }).id ?? null)
        : null
  if (id === null) return doc

  setImmediate(() => {
    void (async () => {
      const { getPayload } = await import('payload')
      const config = (await import('@payload-config')).default
      const payload = await getPayload({ config })

      const { getAppAIClient } = await import('@/lib/aiClient')
      const { ingestConversationTurns } = await import('@/lib/conversationIngest')
      const { ingestCallbackUrl } = await import('@/lib/callbackConfig')

      // Probe once so a bare local run (no ai-service) returns quietly; the
      // ingest itself resolves the session's own ecosistema client.
      try {
        getAppAIClient()
      } catch {
        // No ai-service configured — a normal state for a bare local run. The
        // turns stay `pending` and the next run picks them up.
        return
      }

      await ingestConversationTurns({
        payload,
        sessionId: id,
        client: ((organizationId: number | string) => getAppAIClient(organizationId)) as never,
        ...(ingestCallbackUrl() ? { callbackUrl: ingestCallbackUrl() as string } : {}),
      })
    })().catch((err) => {
      console.error('[messages] background conversation ingest failed for session', id, err)
    })
  })

  return doc
}

export const Messages: CollectionConfig = {
  slug: 'messages',
  admin: {
    useAsTitle: 'role',
    defaultColumns: ['role', 'session', 'createdAt'],
  },
  access: {
    read: ownViaSession,
    update: ownViaSession,
    delete: ownViaSession,
    // Membership and ecosistema switches are checked per session in the
    // write gate (`assertSessionOwnedBy`); the account's own switch here.
    create: ({ req: { user } }) => isActiveUser(user),
  },
  fields: [
    {
      name: 'session',
      type: 'relationship',
      relationTo: 'sessions',
      required: true,
      index: true,
    },
    {
      name: 'role',
      type: 'select',
      required: true,
      options: [
        { label: 'User', value: 'user' },
        { label: 'Assistant', value: 'assistant' },
        { label: 'System', value: 'system' },
      ],
    },
    {
      name: 'content',
      type: 'textarea',
      required: true,
    },
    {
      name: 'generationMeta',
      type: 'json',
      admin: {
        description:
          'ai-service telemetry from /v1/generate/sync — traceId, modelUsed, provider, costUsd.',
      },
    },
    {
      name: 'provenance',
      type: 'json',
      admin: {
        description:
          'Citation provenance for assistant turns (chat-engine): retrieved chunks ' +
          '({chunkId, documentId, score, corpus, metadata}). Drives the rendered ' +
          'citation card on the FE.',
      },
    },
    {
      // CANONICAL ref-field contract: the entities @-mentioned in THIS user turn
      // (the engine's `contextRefs`), stored as a polymorphic hasMany relationship
      // — same shape as `sessions.contextScope`. The FE Domain Adapter maps these
      // `{relationTo,value}` rows ↔ the engine's neutral `{kind,id}`. Empty for
      // turns without @-mentions (and for assistant/system turns).
      name: 'contextRefs',
      type: 'relationship',
      relationTo: [...CONTEXT_REF_RELATION_TO],
      hasMany: true,
      admin: {
        description:
          'Domain entities @-mentioned in this user turn (polymorphic refs). ' +
          'Mirrors sessions.contextScope; empty when the turn cited nothing.',
      },
    },
    {
      /**
       * 🔴 THE CURSOR THAT MAKES INGESTION APPEND-ONLY.
       *
       * "What is left to embed" is a query over this column, not a diff against
       * something we remember. That is what stops turn 41 from re-embedding
       * turns 1-40 — see `lib/conversationIngest.ts` for why that would be a
       * 40x bill AND a worse corpus.
       */
      name: 'corpusStatus',
      type: 'select',
      required: true,
      defaultValue: 'pending',
      index: true,
      options: MESSAGE_CORPUS_STATES.map((value) => ({
        value,
        label: CORPUS_STATE_LABELS[value],
      })),
      admin: { readOnly: true, position: 'sidebar' },
    },
    {
      name: 'corpusIngestId',
      type: 'text',
      index: true,
      admin: { readOnly: true, description: 'ai-service ingestId for this turn. Join-back key.' },
    },
    {
      name: 'corpusError',
      type: 'textarea',
      admin: {
        readOnly: true,
        description:
          'Why this turn is not in the corpus. ⚠ Counts and codes only — a hold never quotes the text that caused it.',
      },
    },
    {
      /**
       * What the anonymisation gate produced for this turn.
       *
       * ⚠ BESIDE `content`, never over it. `content` stays exactly as the person
       * typed it — it is their conversation and it is what the UI shows them.
       * Only this is ever embedded.
       */
      name: 'redactedText',
      type: 'textarea',
      admin: {
        readOnly: true,
        description: 'The gate\'s output. This — not `content` — is what enters the corpus.',
      },
    },
    {
      /**
       * 🔴 COUNTS AND RULE NAMES ONLY, never a removed string and never a map
       * from `[Persona A]` back to anyone. See `lib/anonymise/types.ts`.
       */
      name: 'anonymisationReport',
      type: 'json',
      admin: {
        readOnly: true,
        description: 'Per-stage counts of what the gate removed. No removed text.',
      },
    },
  ],
  hooks: {
    // 🔴 FIRST AND ALWAYS. Without it the afterChange hook below is a corpus
    // write anybody with an account can aim at anybody's ecosistema.
    beforeValidate: [protectMessageCorpusState],
    afterChange: [ingestConversationHook],
  },
}
