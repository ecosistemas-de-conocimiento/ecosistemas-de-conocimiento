/**
 * Chunks that are EARLIER ASSISTANT ANSWERS, not sources.
 *
 * The backend ingests every chat turn back into the ecosistema's corpus and
 * marks the assistant's own answers with chunk metadata `authoredBy:
 * 'assistant'` (`apps/backend/src/lib/contentKind.ts`). Retrieval then returns
 * them next to real documents: audit 2026-10-17 measured them as the top-1
 * source in 6 of 14 chat turns, about 10 s after they were written. Unlabelled,
 * an earlier mistake reads as a documented fact.
 *
 * Client-safe (no `$lib/server` import): the prompt fence
 * (`$lib/server/engine/chunkFence`) and the citation card (`Message.svelte`)
 * share these strings so the model and the reader see the same words.
 */

/** Is this chunk (or citation) one of the assistant's own earlier answers? */
export function isAssistantAuthored(metadata: Record<string, unknown> | null | undefined): boolean {
  return metadata?.authoredBy === 'assistant';
}

/** The label, in the prompt fence and on the citation card. Spanish: content the model may echo. */
export const ASSISTANT_CHUNK_LABEL = 'respuesta anterior del asistente, no es fuente primaria';

/** Suffix appended to an assistant-authored citation's title in the card. */
export const ASSISTANT_CITATION_SUFFIX = ` · ${ASSISTANT_CHUNK_LABEL}`;

interface CitationTitleLike {
  title?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Suffix the title of each assistant-authored citation. Same mechanism as
 * `markDraftCitations` (`$lib/publication`): `CitationCard` is a shared package
 * component whose only per-source text is `title`.
 */
export function markAssistantCitations<T extends CitationTitleLike>(citations: readonly T[]): T[] {
  return citations.map((c) =>
    isAssistantAuthored(c.metadata)
      ? // `as T`: see the same cast in `markDraftCitations`.
        ({ ...c, title: `${c.title ?? 'Fuente sin título'}${ASSISTANT_CITATION_SUFFIX}` } as T)
      : c,
  );
}
