/**
 * Client-side helpers for the chat-engine surfaces: context-search (powers the
 * `@`-mention typeahead) and the citation-card copy. Same-origin fetch to the
 * BFF — no bearer in the browser.
 */

import type { CitationLike, ContextSearchResult } from '@edc/chat-engine/core';

/**
 * Spanish UI copy for the engine's canonical `CitationCard`. Injected as props
 * (the engine hard-codes no product strings).
 */
export const CHAT_CITATION_LABELS = {
  sourcesTitle: 'Fuentes consultadas',
  openSource: 'Abrir documento',
  relevance: 'Relevancia',
  untitledSource: 'Fuente sin título',
  citationMarker: 'Ver fuente',
} as const;

/**
 * Resolve a citation to a link that opens the cited source, or `null` to leave
 * the card's "Abrir documento" link off. The quoted passage renders either way.
 *
 * The target is `/biblioteca/[id]`, the ecosistema's reader for one published
 * document. Every chunk that enters any corpus is tagged by the backend's
 * single `chunkMetadata` builder (`apps/backend/src/lib/contentKind.ts`), so
 * both retrieval legs — the shared published corpus and the per-session draft
 * corpus — carry the same keys. We read two of them.
 *
 * 🔴 `publication` IS A GATE, NOT DECORATION. `/biblioteca/[id]` answers 404 for
 * anything whose row is not `published` (`isLibraryVisible`, and deliberately
 * so — a draft on a shared-library page reads as shared). The draft corpus is
 * retrieved on EVERY turn, so a user citing their own just-uploaded document is
 * the ordinary case, not the edge one. Linking those unconditionally would put a
 * dead link under the most common citation in the product. A missing link is
 * better than a broken one, so a `draft` chunk keeps today's behaviour.
 *
 * 🔴 `docId` IS OVERLOADED and a digits-only id is what disambiguates it. For a
 * document it is the Payload `documents` row id — a Postgres serial, so always
 * all-digits. For a `conversacion` chunk it is a SYNTHETIC turn id (`msg-42`,
 * `turnExternalId`), which names a `messages` row and would 404 in the library.
 * The backend draws the same line the same way (`documentIdFrom` in the
 * ai-service callback route tests `/^\d+$/`). That test is also what makes the
 * interpolation below injection-safe without encoding.
 *
 * ⚠ Unpublishing re-embeds the chunk as `draft`, so the tag follows the row —
 * but not atomically. A citation retrieved in the gap can still say `published`
 * after the row flipped, and the link then lands on the reader's "no
 * encontrado" state. That is a transient, already-handled miss, not a reason to
 * drop links everywhere else.
 */
export function chatCitationHref(citation: CitationLike): string | null {
  const metadata = citation.metadata;
  if (!metadata) return null;
  if (metadata.publication !== 'published') return null;

  const raw = metadata.docId;
  const docId = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d+$/.test(docId)) return null;

  return `/biblioteca/${docId}`;
}

export async function searchContext(args: {
  q: string;
  kind?: string;
  sessionId: string;
  signal?: AbortSignal;
}): Promise<ContextSearchResult[]> {
  const qs = new URLSearchParams({ q: args.q, sessionId: args.sessionId });
  if (args.kind) qs.set('kind', args.kind);
  try {
    const res = await fetch(`/api/context-search?${qs.toString()}`, {
      credentials: 'same-origin',
      signal: args.signal,
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { results?: ContextSearchResult[] };
    return body.results ?? [];
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    return [];
  }
}
