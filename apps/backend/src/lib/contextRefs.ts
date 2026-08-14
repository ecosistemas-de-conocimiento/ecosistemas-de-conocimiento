/**
 * CANONICAL ref-field contract (chat-leap consolidation).
 *
 * `sessions.contextScope` and `messages.contextRefs` are polymorphic `hasMany`
 * Payload relationships over the domain entities a turn can point at. The
 * engine speaks a neutral `{ kind, id }`; Payload stores `{ relationTo, value }`.
 * This module owns the SINGLE kind↔collection map both sides share — the same
 * map the FE kind registry uses (registry kind ids ↔ these collection slugs).
 *
 * Keep this list identical to the FE `CHAT_KIND_REGISTRY` kinds and to the
 * `relationTo` array on the two relationship fields. Adding an entity kind =
 * one line here + the field's `relationTo` + a `_rels` FK column in the
 * migration.
 */

/** Collections a context ref may point at. Order is the canonical `relationTo`. */
export const CONTEXT_REF_RELATION_TO = [
  'organizations',
  'teams',
  'projects',
  'memberships',
  'documents',
] as const

export type ContextRefCollection = (typeof CONTEXT_REF_RELATION_TO)[number]

/** engine kind ⇄ Payload collection slug. The one map both directions read. */
export const KIND_TO_COLLECTION: Record<string, ContextRefCollection> = {
  org: 'organizations',
  team: 'teams',
  project: 'projects',
  member: 'memberships',
  document: 'documents',
}

export const COLLECTION_TO_KIND: Record<ContextRefCollection, string> = Object.fromEntries(
  Object.entries(KIND_TO_COLLECTION).map(([kind, collection]) => [collection, kind]),
) as Record<ContextRefCollection, string>
