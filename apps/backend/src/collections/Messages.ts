import type { Access, CollectionAfterChangeHook, CollectionConfig, Where } from 'payload'
import { MESSAGE_CORPUS_STATES } from '../lib/conversationIngest'
import { CONTEXT_REF_RELATION_TO } from '../lib/contextRefs'

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
  if (!user) return false
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
  skipped: 'Skipped — never eligible (system turn, or empty)',
}

/**
 * 🔴 THE TRIGGER. A new turn arrives; whatever is outstanding gets appended.
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

      let client
      try {
        client = getAppAIClient()
      } catch {
        // No ai-service configured — a normal state for a bare local run. The
        // turns stay `pending` and the next run picks them up.
        return
      }

      await ingestConversationTurns({
        payload,
        sessionId: id,
        client: client as never,
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
    create: ({ req: { user } }) => Boolean(user),
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
    afterChange: [ingestConversationHook],
  },
}
