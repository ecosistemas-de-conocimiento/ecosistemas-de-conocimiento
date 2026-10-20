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
 * Owner ruling 2026-10-20: chat retrieval drops them by default
 * (`CHAT_RETRIEVE_ASSISTANT_CHUNKS`, `$lib/server/engine/chunkFence`). The
 * label stays for the revert and for turns saved before the ruling.
 *
 * Client-safe (no `$lib/server` import): the prompt fence
 * (`$lib/server/engine/chunkFence`) and the citation card (`Message.svelte`)
 * share these strings so the model and the reader see the same words.
 */

/**
 * Is this RAW chunk metadata one of the assistant's own earlier answers?
 * Server-side in practice: the browser never receives `authoredBy`
 * (`$lib/server/citationProvenance`).
 */
export function isAssistantAuthored(metadata: Record<string, unknown> | null | undefined): boolean {
  return metadata?.authoredBy === 'assistant';
}

/**
 * The boolean the server derives from `authoredBy` and puts on browser-bound
 * citation metadata in place of the raw field (Fable audit #8).
 */
export const ASSISTANT_ANSWER_FLAG = 'isAssistantAnswer';

/** Did the server flag this citation as an earlier assistant answer? */
export function isAssistantAnswerCitation(metadata: Record<string, unknown> | null | undefined): boolean {
  return metadata?.[ASSISTANT_ANSWER_FLAG] === true;
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
 * Suffix the title of each citation the server flagged `isAssistantAnswer`.
 * Same mechanism as `markDraftCitations` (`$lib/publication`): `CitationCard`
 * is a shared package component whose only per-source text is `title`.
 */
export function markAssistantCitations<T extends CitationTitleLike>(citations: readonly T[]): T[] {
  return citations.map((c) =>
    isAssistantAnswerCitation(c.metadata)
      ? // `as T`: see the same cast in `markDraftCitations`.
        ({ ...c, title: `${c.title ?? 'Fuente sin título'}${ASSISTANT_CITATION_SUFFIX}` } as T)
      : c,
  );
}
