import type { ContextRef } from '@edc/chat-engine/core';
import type { SessionDocs } from '$lib/server/sessionDocs';
import { namesTitle, type TitledDoc, type TurnAttachment } from '$lib/server/titleMatch';

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
 * Order: the user's own `@`-mentions first (they asked for those THIS turn;
 * the caller appends a document named by title, `$lib/server/titleMatch`),
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

/**
 * 🔴 THE TURN'S ATTACHMENTS, AS THE BROWSER MAY NAME THEM (owner ruling
 * 2026-10-24: an attachment the answer uses gets a source card;
 * `citedBrowserProvenance` decides "uses").
 *
 * One entry per document ref actually sent (`refs`, after
 * {@link withPinnedRefs} cut it to {@link MAX_TURN_REFS}), in that order. The
 * card shows only what the caller could already see, so each ref is looked
 * up, never taken from the browser's own `label`:
 *   · a document of THIS conversation (the caller's own upload): its session
 *     row, whose name is already neutral for gated kinds (`libraryTitleFor`);
 *   · else a published title the backend let the caller read
 *     (`fetchPublishedTitles`; a testimonio is "Testimonio").
 * Anything else (another conversation's draft, an unreadable list) gets no
 * card, and so does a `conversacion` (chat cites documents only).
 *
 * `named`: the person asked for it this turn: an `@`-mention (`userRefs`),
 * the title match, or a documento whose title the message names.
 */
export function turnAttachments(args: {
  refs: readonly ContextRef[];
  userRefs?: readonly ContextRef[];
  titleMatch: TitledDoc | null;
  userMessage: string;
  sessionDocs: SessionDocs;
  published: readonly TitledDoc[];
}): TurnAttachment[] {
  const mentioned = new Set(
    (args.userRefs ?? []).filter((r) => r.kind === 'document' && r.id != null).map((r) => String(r.id)),
  );
  if (args.titleMatch) mentioned.add(args.titleMatch.id);
  const out: TurnAttachment[] = [];
  for (const ref of args.refs) {
    if (ref.kind !== 'document' || ref.id == null) continue;
    const id = String(ref.id);
    const row = args.sessionDocs.ok ? args.sessionDocs.docs.find((d) => String(d.id) === id) : undefined;
    const pub = args.published.find((d) => d.id === id);
    let doc: Omit<TurnAttachment, 'named'> | null = null;
    if (row && (row.contentKind === 'documento' || row.contentKind === 'testimonio')) {
      doc = {
        id,
        name: row.contentKind === 'testimonio' ? 'Testimonio' : row.name,
        contentKind: row.contentKind,
        publication: row.publicationStatus ?? null,
      };
    } else if (!row && pub) {
      doc = {
        id,
        name: pub.contentKind === 'testimonio' ? 'Testimonio' : pub.name,
        contentKind: pub.contentKind ?? 'documento',
        publication: 'published',
      };
    }
    if (!doc) continue;
    const named =
      mentioned.has(id) || (doc.contentKind === 'documento' && namesTitle(args.userMessage, doc.name));
    out.push({ ...doc, named });
  }
  return out;
}
