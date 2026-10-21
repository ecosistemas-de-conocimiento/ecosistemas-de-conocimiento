/**
 * Citation provenance as the BROWSER receives it: an allowlist (Fable audit #8).
 *
 * Retrieved chunks carry free-form ai-service metadata. For a conversation
 * turn the backend writes `sessionId` (which thread it came from) and
 * `authoredBy` (`chunkMetadata`, apps/backend/src/lib/contentKind.ts). The
 * engine copies that metadata onto the provenance, and the provenance reaches
 * the browser of the conversation's owner (conversations are owner-only). An
 * answer retrieved from ANOTHER conversation, possibly another member's, then
 * handed its owner that conversation's id (and its `msg-…` docId).
 *
 * Every server→browser path goes through here:
 *   · `POST /api/generate` — the sync JSON, the stream's `done` frame, and what
 *     it saves (`messages.provenance`);
 *   · `GET /api/sessions/[id]/messages` — persisted turns, which may predate
 *     this and still hold the raw fields;
 *   · `POST /api/sessions/[id]/messages` — the created row it echoes back.
 * `POST /api/sessions/[id]/ratings` drops the populated message from its echo
 * instead (collapsed to an id), so no provenance rides there at all.
 *
 * Only the fields the citation card reads survive.
 *
 * 🔴 CONVERSATION TURNS NEVER LEAVE (owner ruling 2026-10-21: chat cites
 * documents only). Retrieval already drops them (`engine/chunkFence`); this
 * drops them from answers saved BEFORE that too, so no "Conversación" source
 * can reach a card. See `$lib/turnChunks`.
 *
 * 🔴 EACH CHUNK KEEPS ITS PROMPT ORDINAL. `ordinal` is the `[N]` the model
 * wrote: the 1-based position in the prompt's chunk list. It is stamped here
 * BEFORE anything is dropped (or kept from {@link citedBrowserProvenance}), so
 * dropping a chunk never renumbers the others, and `[3]` in the answer still
 * opens source 3. `$lib/citations` reads it back.
 *
 * ⚠ Adding a field the browser needs means adding it to an allowlist below.
 * That is the point: a new metadata key stays on the server until someone
 * decides it may leave.
 */

import { citedProvenance, type Provenance } from '@edc/chat-engine/core';
import { isConversationTurnChunk } from '$lib/turnChunks';
import { DRAFT_PROVENANCE_FLAG } from '$lib/publication';
import type { TitledDoc } from '$lib/server/titleMatch';

/** Chunk fields the browser receives. Everything else is dropped. */
const CHUNK_FIELDS = [
  'chunkId',
  'documentId',
  'score',
  'corpus',
  'denseScore',
  'lexicalScore',
  'rerankScore',
  'text',
] as const;

/**
 * Metadata keys the browser reads, and who reads them:
 *   · `title`       — the card's source name (`provenanceToCitations`);
 *   · `docId` (numeric only), `publication` — the "open the source" link
 *     (`chatCitationHref`);
 *   · `edcIsDraft`  — the "borrador, solo tú lo ves" label (`markDraftCitations`).
 * Booleans: kept only when exactly `true`.
 */
const METADATA_STRING_KEYS = ['title', 'publication'] as const;
const METADATA_TRUE_KEYS = [DRAFT_PROVENANCE_FLAG] as const;

type Chunk = Provenance['chunks'][number];

function browserMetadata(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of METADATA_STRING_KEYS) {
    const v = src[k];
    if (typeof v === 'string') out[k] = v;
  }
  // `docId` only when it is a `documents` row id. A conversation turn's docId
  // is a synthetic `msg-…` id that names a message in ANOTHER conversation,
  // the same leak as `sessionId`; the link resolver ignores it anyway.
  const docId = typeof src.docId === 'number' ? String(src.docId) : src.docId;
  if (typeof docId === 'string' && /^\d+$/.test(docId.trim())) out.docId = docId.trim();
  for (const k of METADATA_TRUE_KEYS) {
    if (src[k] === true) out[k] = true;
  }
  return out;
}

function isOrdinal(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/** `null` for an unreadable chunk AND for a conversation turn. */
function browserChunk(raw: unknown, index: number): Chunk | null {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw as Record<string, unknown>;
  const meta = src.metadata && typeof src.metadata === 'object' ? (src.metadata as Record<string, unknown>) : null;
  if (isConversationTurnChunk(meta)) return null;
  const out: Record<string, unknown> = {};
  for (const k of CHUNK_FIELDS) {
    if (src[k] !== undefined) out[k] = src[k];
  }
  out.ordinal = isOrdinal(src.ordinal) ? src.ordinal : index + 1;
  out.metadata = browserMetadata(src.metadata);
  return out as unknown as Chunk;
}

/**
 * The browser-safe copy of a provenance. `{ chunks }` or a bare chunk array
 * (an older persisted shape); anything unreadable is `null`, which the card
 * renders as "no sources".
 */
export function toBrowserProvenance(provenance: unknown): Provenance | null {
  if (!provenance || typeof provenance !== 'object') return null;
  const chunks = Array.isArray(provenance)
    ? provenance
    : (provenance as { chunks?: unknown }).chunks;
  if (!Array.isArray(chunks)) return null;
  return { chunks: chunks.map(browserChunk).filter((c): c is Chunk => c !== null) };
}

/**
 * 🔴 ONLY THE SOURCES THE ANSWER CITES (UX backlog #35). The engine puts every
 * retrieved chunk on the provenance (`buildChatTurn`), cited or not, so a
 * question about one document listed many unrelated ones. This keeps the
 * chunks the COMPLETE answer marks with `[N]` (`citedProvenance`), each with
 * its prompt ordinal, then applies the browser allowlist. An answer that cites
 * nothing gets `null`: no sources shown.
 *
 * 🔴 EXCEPT THE DOCUMENT NAMED BY TITLE. On a unique title match
 * (`$lib/server/titleMatch`) that document also rides the turn as an inline
 * ref, which carries no `[N]`. The model can answer from it alone and cite
 * nothing: measured on dev (doc 71), an answer about the document with no
 * source list. So when no cited source is that document, it is added once
 * ({@link titleMatchSource}). Every other uncited chunk is still dropped.
 *
 * ⚠ Run it on the full answer text, never on a partial stream.
 */
export function citedBrowserProvenance(
  provenance: Provenance | null | undefined,
  answer: string,
  titleMatch: TitledDoc | null = null,
): Provenance | null {
  const cited: Array<Chunk & { ordinal?: number }> = citedProvenance(provenance, answer ?? '').map(
    ({ relevance: _r, ...c }) => c,
  );
  if (titleMatch && !cited.some((c) => chunkDocId(c) === titleMatch.id)) {
    cited.push(titleMatchSource(provenance, titleMatch));
  }
  const out = toBrowserProvenance({ chunks: cited });
  return out && out.chunks.length > 0 ? out : null;
}

function chunkDocId(c: { metadata?: Record<string, unknown> | null }): string | null {
  const v = c.metadata?.docId;
  return typeof v === 'string' || typeof v === 'number' ? String(v).trim() : null;
}

/**
 * The source entry for a title-matched document the answer did not cite.
 *
 *   · Its best-ranked retrieved chunk, with its own prompt ordinal. The answer
 *     has no `[N]` for it, so no marker in the text points anywhere else.
 *   · Otherwise a document-level entry: no passage, `docId` for the "open the
 *     source" link, and an ordinal past every prompt chunk, so it collides with
 *     none.
 *
 * 🔴 TESTIMONIO: only a `published` chunk. The published corpus holds the
 * gate's redacted text (backend `corpusTextFor`); a draft-corpus copy may not.
 * The document-level entry carries no text at all, and the neutral title
 * "Testimonio", never the name (`titleFor`, apps/backend `lib/contentKind.ts`).
 */
function titleMatchSource(
  provenance: Provenance | null | undefined,
  match: TitledDoc,
): Chunk & { ordinal: number } {
  const chunks = provenance?.chunks ?? [];
  const testimonio = match.contentKind === 'testimonio';
  const own = chunks
    .map((c, i) => ({ c, ordinal: i + 1 }))
    .filter(({ c }) => chunkDocId(c) === match.id && !isConversationTurnChunk(c.metadata));
  const published = own.find(({ c }) => c.metadata?.publication === 'published');
  const pick = published ?? (testimonio ? undefined : own[0]);
  if (pick) return { ...pick.c, ordinal: pick.ordinal };
  return {
    chunkId: `document:${match.id}`,
    documentId: '',
    score: 0,
    corpus: '',
    metadata: {
      docId: match.id,
      title: testimonio ? 'Testimonio' : match.name,
      publication: 'published',
    },
    ordinal: chunks.length + 1,
  };
}

/** A message row with its provenance made browser-safe. Other fields untouched. */
export function toBrowserMessage<T extends Record<string, unknown>>(row: T): T {
  if (!row || typeof row !== 'object' || !('provenance' in row)) return row;
  return { ...row, provenance: toBrowserProvenance(row.provenance) };
}
