/**
 * Chunks that are CONVERSATION TURNS, not documents.
 *
 * 🔴 Owner ruling 2026-10-21 (#4, choice A): "store, never cite in chat".
 * Every turn, question and answer, is ingested (anonymised) into the
 * ecosistema's corpus (`apps/backend/src/lib/conversationIngest.ts`), but a
 * turn is NEVER a source. Before a4643cb the chat cited the user's own
 * question as source [1] "Conversación".
 *
 * So every turn chunk is dropped from the sources, regardless of any flag:
 *   · at retrieval, on every sources leg (`$lib/server/engine/chunkFence`);
 *   · at the browser boundary, for answers saved before this
 *     (`$lib/server/citationProvenance`).
 * Turns reach the model only as background, in the orientation block
 * (`$lib/server/engine/orientation`), which never carries an `[N]`.
 *
 * A turn is recognised by ANY of the marks the backend wrote on it
 * (`chunkMetadata`, `apps/backend/src/lib/contentKind.ts`): `kind:
 * 'conversacion'`, a `msg-…` docId, or an `authoredBy` role. Any one is enough,
 * so a chunk missing one field is still caught.
 *
 * Client-safe (no `$lib/server` import); relative imports only, because the
 * eval harness in apps/backend imports `chunkFence`.
 */

/** Is this RAW chunk metadata a conversation turn (question or answer)? */
export function isConversationTurnChunk(metadata: Record<string, unknown> | null | undefined): boolean {
  if (!metadata) return false;
  if (metadata.kind === 'conversacion') return true;
  if (metadata.authoredBy === 'assistant' || metadata.authoredBy === 'user') return true;
  return typeof metadata.docId === 'string' && /^msg-/i.test(metadata.docId.trim());
}
