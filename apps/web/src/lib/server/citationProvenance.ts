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

import { citedProvenance, parseCitedOrdinals, type Provenance } from '@edc/chat-engine/core';
import { isConversationTurnChunk } from '$lib/turnChunks';
import { DRAFT_PROVENANCE_FLAG } from '$lib/publication';
import type { TitledDoc } from '$lib/server/titleMatch';
import { excerptFrom, parseSkipIntro } from '$lib/biblioteca';
import { env } from '$env/dynamic/private';
import {
  GENERAL_KNOWLEDGE_LEAD,
  NO_ANSWER_REPLY,
  answersFromGeneralKnowledge,
  parseCiteVariant,
  type CiteVariant,
} from '$lib/server/engine/prompt';

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
 *   · `edcIsDraft`  — the "borrador, solo tú lo ves" label (`markDraftCitations`);
 *   · `excerpt`     — a testimonio's short line (`chatSourceTitle`), cut HERE
 *     from the chunk's own text ({@link testimonioExcerpt}), never sent in;
 *   · `kind`        — only the value `testimonio`, the excerpt's marker.
 * Booleans: kept only when exactly `true`.
 */
const METADATA_STRING_KEYS = ['title', 'publication'] as const;
const METADATA_TRUE_KEYS = [DRAFT_PROVENANCE_FLAG] as const;

type Chunk = Provenance['chunks'][number];

/**
 * 🔴 A TESTIMONIO SOURCE'S EXCERPT: THE FIRST PROSE LINE OF ITS OWN PASSAGE.
 *
 * Why the passage and not the document's opening: the passage is what the
 * answer drew on, it is already in the browser payload (`text` above), and a
 * `published` chunk is cut from the gate's redacted text (backend
 * `corpusTextFor`). So the excerpt adds no new data and needs no extra read.
 * Only `published` chunks: a draft-corpus copy may not be redacted (see
 * {@link titleMatchSource}). Recomputed on every pass, so a stored value is
 * never trusted, and a persisted turn gets one on read.
 *
 * 🔴 ONLY ON A KNOWN KIND (`kind === 'testimonio'`), never on the title: a
 * documento may be titled "Testimonio". No other metadata key is unique to
 * testimonios, so the browser copy now keeps `kind: 'testimonio'` (that value
 * only). Turns saved before this have no `kind`: they keep their "Testimonio"
 * title and get no excerpt.
 */
function testimonioExcerpt(src: Record<string, unknown>, meta: Record<string, unknown> | null): string | null {
  if (meta?.kind !== 'testimonio' || meta.publication !== 'published') return null;
  return excerptFrom(src.text, { skipIntro: parseSkipIntro(env.BIBLIOTECA_EXCERPT_SKIP_INTRO) });
}

function browserMetadata(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  // 🔴 A testimonio is titled "Testimonio", whatever its metadata says.
  // `kind` leaves only as this one value: the marker the excerpt and the
  // label key on (`testimonioExcerpt`, `chatSourceTitle`).
  if (src.kind === 'testimonio') {
    out.title = 'Testimonio';
    out.kind = 'testimonio';
  }
  for (const k of METADATA_STRING_KEYS) {
    const v = src[k];
    if (typeof v === 'string' && !(k === 'title' && out.title)) out[k] = v;
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
  const metadata = browserMetadata(src.metadata);
  const excerpt = testimonioExcerpt(src, meta);
  out.metadata = metadata && excerpt ? { ...metadata, excerpt } : metadata;
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
 * 🔴 AN ANSWER WITH NO `[N]` AT ALL LISTS THE TOP RETRIEVED SOURCES (owner's
 * overnight rule, 2026-10-21). Measured on dev: a broad question ("dengue", 3
 * runs) got long answers with no marker, so cited-only showed 0 sources. Then
 * the {@link FALLBACK_SOURCES} best chunks by score ({@link topRetrieved}) are
 * the sources. An answer with at least one marker stays cited-only, even when
 * every marker points past the end. With a title match too, the matched
 * document is added once if the top ones do not already include it: at most
 * {@link FALLBACK_SOURCES} + 1 entries.
 *
 * 🔴 A NO-ANSWER REPLY LISTS NO RETRIEVED SOURCE, CITED OR NOT (owner's
 * overnight rule, 2026-10-21). Measured on dev after 9285305: an off-topic
 * question (3/3 runs) said the documents do not cover it, then cited
 * [1, 2, 3, 4, 5]. An answer containing {@link NO_ANSWER_REPLY} or one of
 * {@link NO_ANSWER_VARIANTS} ({@link isNoAnswer}, accent- and case-folded)
 * drops its `[N]` sources and gets no fallback. A title-matched document is
 * still added: the person named it, so it stays one click away.
 * WITH `[N]`, only the FIRST sentence counts: an answer that covers part of
 * the question and later says "los documentos no mencionan X" keeps its
 * cited sources.
 * WITHOUT `[N]`, a refusal cue ANYWHERE ({@link hasRefusalCue}) skips the
 * fallback. Measured on dev after 5fe43ff: "Los documentos de la Red
 * Comunitaria de Salud no hablan de la capital …" (no `[N]`) slipped past the
 * first-sentence net and listed 3 fallback sources; an Educación hedge "… no
 * contienen testimonios directos de familias" (no `[N]`) did too. The cost:
 * an uncited partial answer that names one gap shows no sources. An answer
 * that wants its sources cites them.
 *
 * 🔴 AT MOST {@link MAX_SOURCES} SOURCES. Measured on dev after 9285305: dengue
 * answers cited 29–31 times. Cited sources keep citation order (first `[N]`
 * first) and the first ones win. A title-matched document not among them
 * takes the last slot, so the total never passes {@link MAX_SOURCES}.
 *
 * 🔴 THE NO-`[N]` FALLBACK SKIPS A PASSAGE THE RERANKER CALLED IRRELEVANT
 * ({@link fallbackMinRerank}). Measured on dev at 7b2e27e (variant E):
 * "¿Cuál es la capital de Francia?" got "París es la capital de Francia." with
 * no `[N]` and no general-knowledge lead, so the fallback listed 3 chunks with
 * rerank scores near 1e-4.
 *
 * 🔴 VARIANT E (the default since 2026-10-22; owner ruling 2026-10-21: answers
 * may come "from the docs, the corpus, or the training weights") swaps the
 * no-[N] and refusal rules above for {@link generalKnowledgeSources}. A–D keep
 * the rules above unchanged. `variant` defaults to the env value, read per
 * call like the system prompt (`chatCiteVariant` in `./engine/config`).
 *
 * ⚠ Run it on the full answer text, never on a partial stream.
 */
export function citedBrowserProvenance(
  provenance: Provenance | null | undefined,
  answer: string,
  titleMatch: TitledDoc | null = null,
  variant: CiteVariant = parseCiteVariant(env.CHAT_CITE_VARIANT),
): Provenance | null {
  const text = answer ?? '';
  let cited: Array<Chunk & { ordinal?: number }> = answersFromGeneralKnowledge(variant)
    ? generalKnowledgeSources(provenance, text)
    : parseCitedOrdinals(text).length > 0
      ? isNoAnswer(text)
        ? []
        : citedProvenance(provenance, text).map(({ relevance: _r, ...c }) => c)
      : hasRefusalCue(text)
        ? []
        : topRetrieved(provenance);
  cited = cited.slice(0, MAX_SOURCES);
  if (titleMatch && !cited.some((c) => chunkDocId(c) === titleMatch.id)) {
    cited = cited.slice(0, MAX_SOURCES - 1);
    cited.push(titleMatchSource(provenance, titleMatch));
  }
  const out = toBrowserProvenance({ chunks: cited });
  return out && out.chunks.length > 0 ? out : null;
}

/** The most sources one answer shows, title-matched document included. */
export const MAX_SOURCES = 7;

/**
 * Close wordings of {@link NO_ANSWER_REPLY} the model uses instead, already
 * folded ({@link fold}). Short and explicit on purpose: each one says the
 * documents lack the answer. A sentence that only mentions "documentos" is not
 * one.
 */
export const NO_ANSWER_VARIANTS = [
  'los documentos no hablan de',
  'los documentos no mencionan',
  'los documentos no tratan',
  'los documentos no dicen nada',
  'los documentos no contienen informacion',
  'los documentos no incluyen informacion',
  'no encontre informacion sobre',
  'no encontre informacion en los documentos',
  'no hay informacion en los documentos',
  'no hay informacion sobre esto en los documentos',
] as const;

/** Lowercase, accents stripped, runs of whitespace collapsed. */
function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ');
}

/**
 * The answer OPENS by saying the documents do not answer the question: its
 * first sentence (trimmed, up to the first `.`, `!`, `?` or line break)
 * contains {@link NO_ANSWER_REPLY} or a variant. A later sentence that says
 * "los documentos no mencionan X" is a partial answer, not a no-answer reply.
 */
export function isNoAnswer(answer: string): boolean {
  const first = fold((answer ?? '').trim().split(/[.!?\n]/, 1)[0] ?? '');
  const reply = fold(NO_ANSWER_REPLY).replace(/[.!?]+$/, '');
  return first.includes(reply) || NO_ANSWER_VARIANTS.some((v) => first.includes(v));
}

/**
 * Short refusal cues, already folded ({@link fold}). Read ANYWHERE in an answer
 * with no `[N]` ({@link hasRefusalCue}); never on an answer with markers.
 */
export const REFUSAL_CUES = [
  'no hablan',
  'no mencionan',
  'no contienen',
  'no tratan',
  'no incluyen',
  'no encontre',
] as const;

/**
 * The answer says, anywhere, that the documents lack the answer: the
 * no-answer reply, one of {@link NO_ANSWER_VARIANTS}, or one of
 * {@link REFUSAL_CUES}, accent- and case-folded. Only for an answer with no
 * `[N]` (see {@link citedBrowserProvenance}).
 */
export function hasRefusalCue(answer: string): boolean {
  const all = fold(answer ?? '');
  const reply = fold(NO_ANSWER_REPLY).replace(/[.!?]+$/, '');
  return (
    all.includes(reply) ||
    NO_ANSWER_VARIANTS.some((v) => all.includes(v)) ||
    REFUSAL_CUES.some((c) => all.includes(c))
  );
}

/**
 * {@link GENERAL_KNOWLEDGE_LEAD} as the model writes it: any case, Markdown
 * emphasis after it, and a colon or dash (not a comma: "lo que pasa fuera de
 * los documentos, \u2026" is prose). The lead has no accented letter, so no
 * folding is needed and indexes stay those of the answer.
 */
const GENERAL_KNOWLEDGE_RE = new RegExp(
  `(?<!\\p{L})${GENERAL_KNOWLEDGE_LEAD.replace(/[:\s]+$/, '').replace(/ /g, '\\s+')}[*_]*\\s*[:\u2013\u2014-]`,
  'iu',
);

/**
 * Variant E's answer split in two: `documents`, the text before the first
 * {@link GENERAL_KNOWLEDGE_LEAD}, and whether that lead occurs at all.
 * Everything from the lead on is general knowledge: the prompt puts that part
 * last.
 */
export function splitGeneralKnowledge(answer: string): { documents: string; general: boolean } {
  const text = answer ?? '';
  const m = GENERAL_KNOWLEDGE_RE.exec(text);
  return m ? { documents: text.slice(0, m.index), general: true } : { documents: text, general: false };
}

/**
 * The first sentence of the answer (same cut as {@link isNoAnswer}) carries a
 * refusal: the no-answer reply, a variant or a {@link REFUSAL_CUES} cue. A
 * later "los documentos no hablan de X" never counts.
 */
export function opensWithRefusal(answer: string): boolean {
  const first = (answer ?? '').trim().split(/[.!?\n]/, 1)[0] ?? '';
  return hasRefusalCue(first);
}

/**
 * Variant E's sources, designed as one rule with its fallback and its
 * no-answer guard (lesson: "every source rule needs a fallback; every fallback
 * needs a no-answer guard"). Only the part before
 * {@link GENERAL_KNOWLEDGE_LEAD} counts; the general-knowledge part never
 * lists a source, even when it carries a stray `[N]`.
 *
 *   · Nothing before the lead (an off-topic question): no sources. The answer
 *     is general knowledge, and a fallback would attribute it to documents.
 *   · `[N]` before the lead: those sources (cited-only), unless the answer
 *     opens with the no-answer reply or a {@link NO_ANSWER_VARIANTS} wording
 *     ({@link isNoAnswer}, A's rule for an answer with `[N]`). NOT the wider
 *     {@link REFUSAL_CUES}: measured on dev (A/B run 13, Discapacidad Q2), an
 *     E answer opening "Los documentos no contienen testimonios específicos
 *     sobre …" then citing 2 `[N]` groups showed 0 sources, because the bare
 *     cue "no contienen" fired on a hedge that went on to answer.
 *   · No `[N]` and a lead: no sources. The model was told to cite what came
 *     from the passages, and the part it chose to mark as general knowledge
 *     sits next to it, so a fallback would blur the two.
 *   · No `[N]` and no lead: the top-{@link FALLBACK_SOURCES} fallback (a
 *     passage-based answer that forgot `[N]`), unless the FIRST sentence is a
 *     refusal ({@link opensWithRefusal}); a later "no hablan" keeps it.
 */
function generalKnowledgeSources(
  provenance: Provenance | null | undefined,
  answer: string,
): Array<Chunk & { ordinal?: number }> {
  const { documents, general } = splitGeneralKnowledge(answer);
  if (!/\p{L}/u.test(documents)) return [];
  if (parseCitedOrdinals(documents).length > 0) {
    if (isNoAnswer(documents)) return [];
    return citedProvenance(provenance, documents).map(({ relevance: _r, ...c }) => c);
  }
  if (opensWithRefusal(documents)) return [];
  return general ? [] : topRetrieved(provenance);
}

/** How many retrieved sources an answer with no `[N]` lists. */
export const FALLBACK_SOURCES = 3;

/**
 * The lowest cross-encoder score a chunk needs to be a no-`[N]` fallback
 * source (`CHAT_FALLBACK_MIN_RERANK`).
 *
 * Default {@link DEFAULT_FALLBACK_MIN_RERANK} = 0.1, INFERRED from a small
 * sample (measured 2026-10-21 on the DGX Spark, Qwen3-Reranker-0.6B Q8 via
 * llama.cpp; DeepInfra serves the same model): relevant Spanish passages
 * scored 0.99–1.0, irrelevant ones 1e-6 to 1e-4. Any floor between 1e-3 and
 * 0.9 splits that sample; 0.1 sits three orders of magnitude above the
 * irrelevant ones and ten times below the relevant ones. Recalibrate from the
 * `[sources] fallback rerank` log line ({@link topRetrieved}).
 *
 * 🔴 FAILS OPEN. Only a chunk carrying `rerankScore` is tested: ai-service
 * sets that field only when the rerank ran (`./engine/rerank`). A chunk
 * without it (rerank off, timed out, errored, or the GraphRAG leg) is kept,
 * never read as 0. `0` turns the floor off; blank or invalid is the default.
 */
export const DEFAULT_FALLBACK_MIN_RERANK = 0.1;

export function fallbackMinRerank(raw: string | undefined = env.CHAT_FALLBACK_MIN_RERANK): number {
  const v = Number((raw ?? '').trim());
  return (raw ?? '').trim() !== '' && Number.isFinite(v) && v >= 0 ? v : DEFAULT_FALLBACK_MIN_RERANK;
}

/** The chunk has a rerank score and it is below the floor. Unscored: false. */
function belowRerankFloor(c: Chunk, floor: number): boolean {
  return typeof c.rerankScore === 'number' && c.rerankScore < floor;
}

/** The rerank score when present, else the retrieval score. */
function rankScore(c: Chunk): number {
  if (typeof c.rerankScore === 'number') return c.rerankScore;
  return typeof c.score === 'number' ? c.score : 0;
}

/**
 * Reranked chunks first (0), unscored after (1). The two scores are on
 * different scales (cross-encoder 0–1 vs cosine or RRF), so they are never
 * compared to each other.
 */
function rerankTier(c: Chunk): number {
  return typeof c.rerankScore === 'number' ? 0 : 1;
}

/**
 * The {@link FALLBACK_SOURCES} best retrieved chunks, highest score first,
 * each with its prompt ordinal. Ties keep prompt order.
 *
 * 🔴 A PARTIAL RERANK. ai-service can rerank only part of a list: on a
 * `backfilled` degradation (ai-service `src/services/rag/retrieve.ts`,
 * `RerankDegradation`) the reranker returned fewer than `topK` results and the
 * tail is fused order with no `rerankScore`; the GraphRAG leg's own chunks are
 * never reranked either. Then, with the floor on ({@link fallbackMinRerank}):
 *   · a scored chunk below the floor is dropped;
 *   · a scored chunk at or above it ranks FIRST, by rerank score;
 *   · an unscored chunk is kept (fails open) and ranks AFTER every scored one,
 *     by its retrieval score. Never read as 0, never compared to a rerank score.
 *
 * Skipped before ranking, so they never take a slot: conversation turns, a
 * chunk the reranker scored below {@link fallbackMinRerank}, and
 * 🔴 a testimonio chunk that is not from the `published` corpus (only that
 * corpus holds the gate's redacted text, see {@link titleMatchSource}). A
 * kept testimonio chunk is titled "Testimonio", whatever its metadata says.
 */
function topRetrieved(provenance: Provenance | null | undefined): Array<Chunk & { ordinal: number }> {
  const candidates = (provenance?.chunks ?? [])
    .map((c, i) => ({ c, ordinal: i + 1 }))
    .filter(({ c }) => c && typeof c === 'object' && !isConversationTurnChunk(c.metadata))
    .filter(({ c }) => !isTestimonioChunk(c) || c.metadata?.publication === 'published')
    .sort(
      (a, b) =>
        rerankTier(a.c) - rerankTier(b.c) || rankScore(b.c) - rankScore(a.c) || a.ordinal - b.ordinal,
    );
  const floor = fallbackMinRerank();
  const kept = candidates.filter(({ c }) => !belowRerankFloor(c, floor));
  const reranked = candidates.filter(({ c }) => typeof c.rerankScore === 'number');
  if (reranked.length > 0) {
    // Scores only, never text: calibration data for the floor.
    const top = reranked.slice(0, 5).map(({ c }) => Number(c.rerankScore).toExponential(2));
    console.info(
      `[sources] fallback rerank floor=${floor} top=[${top.join(', ')}] kept=${Math.min(kept.length, FALLBACK_SOURCES)}`,
    );
  }
  return kept
    .slice(0, FALLBACK_SOURCES)
    .map(({ c, ordinal }) => ({
      ...c,
      ...(isTestimonioChunk(c) ? { metadata: { ...c.metadata, title: 'Testimonio' } } : {}),
      ordinal,
    }));
}

function isTestimonioChunk(c: Chunk): boolean {
  return c.metadata?.kind === 'testimonio' || c.metadata?.title === 'Testimonio';
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
