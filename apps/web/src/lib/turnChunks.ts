/**
 * Chunks that are CONVERSATION TURNS, not documents.
 *
 * 🔴 Owner ruling 2026-10-21: chat searches DOCUMENTS ONLY, never conversation
 * turns, neither the user's questions nor the assistant's answers. The backend
 * no longer ingests turns (`apps/backend/src/collections/Messages.ts`), but
 * turns ingested before that still sit in each ecosistema's corpus. On dev the
 * chat cited the user's own question as source [1] "Conversación".
 *
 * So every turn chunk is dropped, regardless of any flag:
 *   · at retrieval, on every leg (`$lib/server/engine/chunkFence`);
 *   · at the browser boundary, for answers saved before this
 *     (`$lib/server/citationProvenance`).
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
