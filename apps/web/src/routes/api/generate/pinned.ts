import type { ContextRef } from '@edc/chat-engine/core';
import type { SessionDocs } from '$lib/server/sessionDocs';

/**
 * The engine resolves at most this many inline refs per turn
 * (`resolveInlineRefs` in packages/chat-engine/src/core/respond.ts slices to 8,
 * quoted from that file 2026-10-21). Going past it here would only drop refs
 * silently, so the list is cut here, where the order is decided.
 */
export const MAX_TURN_REFS = 8;

/**
 * 🔴 "FIJAR" MEANS SENT. The docs panel tells the user "Los documentos fijados
 * se envían como contexto en cada mensaje", and until this existed the pin was
 * stored and then ignored by generation. A pinned document now rides every
 * turn the same way an `@`-mention does: through the adapter's
 * `resolveEntity`, which already fences the text, gates testimonios to their
 * redacted text and clamps the size.
 *
 * Order: the user's own `@`-mentions first (they asked for those THIS turn),
 * then the pinned documents in the order the conversation got them. A document
 * both mentioned and pinned is sent once.
 *
 * Only documents read off THIS conversation's list are added, so a pin cannot
 * reach outside the conversation. An unreadable list adds nothing.
 */
export function withPinnedRefs(
  userRefs: ContextRef[] | undefined,
  sessionDocs: SessionDocs,
): ContextRef[] {
  const out: ContextRef[] = [...(userRefs ?? [])];
  if (!sessionDocs.ok) return out.slice(0, MAX_TURN_REFS);
  const seen = new Set(
    out.filter((r) => r.kind === 'document' && r.id != null).map((r) => String(r.id)),
  );
  for (const d of sessionDocs.docs) {
    if (d.isPinned === false) continue;
    const id = String(d.id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ kind: 'document', id, label: d.name });
  }
  return out.slice(0, MAX_TURN_REFS);
}
