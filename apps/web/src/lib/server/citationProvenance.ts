/**
 * Citation provenance as the BROWSER receives it: an allowlist (Fable audit #8).
 *
 * Retrieved chunks carry free-form ai-service metadata. For a conversation
 * turn the backend writes `sessionId` (which thread it came from) and
 * `authoredBy` (`chunkMetadata`, apps/backend/src/lib/contentKind.ts). The
 * engine copies that metadata onto the provenance, and the provenance reaches
 * every member who opens the conversation. So a member could read which other
 * conversation a cited answer came from.
 *
 * Every server→browser path goes through here:
 *   · `POST /api/generate` — the sync JSON, the stream's `done` frame, and what
 *     it saves (`messages.provenance`);
 *   · `GET /api/sessions/[id]/messages` — persisted turns, which may predate
 *     this and still hold the raw fields;
 *   · `POST /api/sessions/[id]/messages` — the created row it echoes back.
 *
 * Only the fields the citation card reads survive. `authoredBy: 'assistant'`
 * becomes `isAssistantAnswer: true`, derived here, so the card can still say
 * "respuesta anterior del asistente".
 *
 * ⚠ Adding a field the browser needs means adding it to an allowlist below.
 * That is the point: a new metadata key stays on the server until someone
 * decides it may leave.
 */

import type { Provenance } from '@edc/chat-engine/core';
import { isAssistantAuthored, ASSISTANT_ANSWER_FLAG } from '$lib/assistantChunks';
import { DRAFT_PROVENANCE_FLAG } from '$lib/publication';

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
const METADATA_TRUE_KEYS = [DRAFT_PROVENANCE_FLAG, ASSISTANT_ANSWER_FLAG] as const;

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
  if (isAssistantAuthored(src)) out[ASSISTANT_ANSWER_FLAG] = true;
  return out;
}

function browserChunk(raw: unknown): Chunk | null {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of CHUNK_FIELDS) {
    if (src[k] !== undefined) out[k] = src[k];
  }
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

/** A message row with its provenance made browser-safe. Other fields untouched. */
export function toBrowserMessage<T extends Record<string, unknown>>(row: T): T {
  if (!row || typeof row !== 'object' || !('provenance' in row)) return row;
  return { ...row, provenance: toBrowserProvenance(row.provenance) };
}
