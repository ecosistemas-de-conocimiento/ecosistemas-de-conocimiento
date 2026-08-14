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
 * Resolve a citation to a link that opens the original asset. Uploaded docs are
 * ingested into the per-session corpus with each chunk's metadata tagged
 * `docId`; that document id is also the provenance `documentId`. There is no
 * file-download UI route yet, so we return null and the card simply omits the
 * "open" link — the quoted passage still renders. Wiring a real download route
 * here is a one-line change.
 */
export function chatCitationHref(_citation: CitationLike): string | null {
  return null;
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
