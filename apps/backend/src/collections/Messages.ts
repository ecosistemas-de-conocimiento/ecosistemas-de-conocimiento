import type { Access, CollectionConfig, Where } from 'payload'
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
  ],
}
