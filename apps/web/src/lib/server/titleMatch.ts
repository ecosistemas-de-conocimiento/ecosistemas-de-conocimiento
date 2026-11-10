/**
 * "Tell me about <document title>" — pin that document for the turn (UX
 * backlog #35).
 *
 * Chunk text carries no title (only `metadata.title`), so retrieval cannot
 * find a document by its name, and a question naming one came back with many
 * unrelated sources. When the user's message names exactly one of the
 * ecosistema's PUBLISHED documentos or testimonios (below), that document rides the turn as an inline
 * ref, the same way a pinned document does (`routes/api/generate/pinned.ts`):
 * the adapter's `resolveEntity` reads it with the caller's own access, fences
 * it and clamps it.
 *
 * ── THE MATCH RULE ───────────────────────────────────────────────────────────
 *
 *   1. Fold both sides: strip a file extension from the title (`.pdf`), drop
 *      accents (NFD, no combining marks), lower-case, turn every run of
 *      non-letters/digits into one space, and drop leading zeros from numbers.
 *      "Plan_de_Riego-2025.PDF" and "plan de riego 2025" fold to the same
 *      thing; so do "Carta … (03)" and "carta … 3".
 *   2. A title is eligible only if it folds to at least
 *      {@link MIN_TITLE_WORDS} words AND {@link MIN_TITLE_CHARS} characters, so
 *      a short, common title ("Acta", "Informe 2", "La casa") never matches a
 *      sentence that merely uses those words.
 *   3. It matches when the folded title appears in the folded message as whole
 *      words.
 *   4. A matched title that is part of another matched title is dropped
 *      ("plan de riego" inside "plan de riego 2025"): the longer one is the
 *      one the user named.
 *   5. Exactly one document must remain. Two documents with the same folded
 *      title, or two different titles named in one message, pin nothing.
 *
 * Numbered series ("Carta de presentación — traducción en salud (01)" … (21)):
 * the number is part of every title, so a message without it contains none of
 * them as whole words and pins nothing. Only "… salud 3" or "… (03)" pins one.
 *
 * ── TESTIMONIOS ──────────────────────────────────────────────────────────────
 *
 * 🔴 A published testimonio can match, under three locks:
 *   · the backend returns a testimonio's `name` only to its uploader and a
 *     platform admin (`mayReadGatedOriginal`, apps/backend
 *     `collections/Documents.ts`). For anyone else the name is absent, so
 *     nothing matches: the match never confirms a name the caller cannot read;
 *   · it must be `published` AND `anonymisationStatus` `ready` or `approved`,
 *     the same rule as the backend's `corpusTextFor`. A draft or held one never
 *     matches;
 *   · what gets inlined is the adapter's `resolveEntity`, which sends a
 *     testimonio's `redactedText` only, and only with that same status
 *     (`$lib/server/engine/adapter`). Never `extractedText` or the original.
 * The ref's label is the neutral "Testimonio", never the name.
 *
 * ⚠ `select` carries `contentKind` and `uploadedBy` beside `name`: the backend
 * applies the projection before field access, and without them it hides
 * `name` on every gated row, even from the uploader.
 *
 * ── ONLY THAT DOCUMENT IS RETRIEVED ──────────────────────────────────────────
 *
 * The inline ref carries no `[N]`, so an answer grounded in it alone cited
 * nothing, and the retrieved chunks of OTHER documents (measured on dev: doc
 * 79 beside a pinned doc 71) were the only citable sources. On a match the
 * turn's retrieval is therefore narrowed to that document
 * ({@link titleRetrievalFilter}, ai-service metadata `docId`), and the
 * GraphRAG leg is skipped: its widened retrieve and its block cover the whole
 * ecosistema. The document's own chunks become `[1]…[k]`, so the answer can
 * cite it and its source card shows. No match: retrieval is unchanged.
 *
 * 🔴 "CAN cite" is not "does": the model may still answer from the inline ref
 * alone, with no `[N]`, or the filtered retrieve may return nothing. So the
 * matched document is ALWAYS added to the turn's sources when no cited source
 * is it (`citedBrowserProvenance` in `$lib/server/citationProvenance`).
 *
 * ⚠ At most {@link TITLE_SCAN_LIMIT} documents, newest first (one Payload
 * page). An older document in a larger ecosistema is not matched.
 */

import type { ContextRef } from '@edc/chat-engine/core';
import { backendFetch } from '$lib/server/auth';
import { libraryTitleOf } from '$lib/biblioteca';
import { isClearedForLibrary } from '$lib/server/biblioteca';

export const MIN_TITLE_WORDS = 2;
export const MIN_TITLE_CHARS = 12;
/** Payload's list ceiling, quoted from `$lib/server/biblioteca`. */
export const TITLE_SCAN_LIMIT = 100;

export interface TitledDoc {
  id: string;
  name: string;
  /** `testimonio` rows get the neutral label on the ref. Default `documento`. */
  contentKind?: 'documento' | 'testimonio';
}

/**
 * A document that rode THIS turn's prompt as an attachment (`<fuente
 * tipo="adjunto">`, no number): an `@`-mention, the title-named document, or
 * a pinned document of the conversation (`routes/api/generate/pinned.ts`,
 * `turnAttachments`). `citedBrowserProvenance` gives it a source card when
 * the answer uses it (owner ruling 2026-10-24).
 *
 * `name` is already browser-safe: a session row's name went through
 * `libraryTitleFor`, a published title is one the backend let the caller read.
 */
export interface TurnAttachment extends TitledDoc {
  /**
   * The person named it this turn: an `@`-mention, the title match, or a
   * pinned document whose title the message names. Listed whatever the
   * answer says, as the title match always was (owner rule 2026-10-21).
   */
  named: boolean;
  /** The row's `publicationStatus`. Only `published` gets a library link. */
  publication: string | null;
}

/**
 * The text names this title: the folded title (extension stripped, or the
 * whole file name) appears as whole words, and it has at least
 * {@link MIN_TITLE_WORDS} words. Fewer words never match ("Acta" in prose).
 * Looser than {@link matchDocumentTitle} (no character floor): "nota de
 * voz.webm" is 11 characters, and only the turn's own attachments are tested.
 */
export function namesTitle(text: string, name: string): boolean {
  const hay = ` ${foldTitle(text ?? '')} `;
  return [foldDocName(name ?? ''), foldTitle(name ?? '')].some(
    (t) => t !== '' && t.split(' ').length >= MIN_TITLE_WORDS && hay.includes(` ${t} `),
  );
}

/** The gate verdicts that let gated text be shared (backend `corpusTextFor`). */
export const GATE_CLEARED = ['ready', 'approved'] as const;

export function gateCleared(status: unknown): boolean {
  return (GATE_CLEARED as readonly unknown[]).includes(status);
}

/** Accent- and case-folded, punctuation collapsed to single spaces. */
export function foldTitle(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/(^| )0+(?=\d)/g, '$1');
}

/** A document name as a title: its file extension removed, then folded. */
function foldDocName(name: string): string {
  return foldTitle(name.trim().replace(/\.[a-z0-9]{2,5}$/i, ''));
}

function eligible(folded: string): boolean {
  return folded.length >= MIN_TITLE_CHARS && folded.split(' ').length >= MIN_TITLE_WORDS;
}

/** The one document the message names by title, or `null`. See the header. */
export function matchDocumentTitle(message: string, docs: readonly TitledDoc[]): TitledDoc | null {
  const haystack = ` ${foldTitle(message)} `;
  const hits = docs
    .map((doc) => ({ doc, folded: foldDocName(doc.name) }))
    .filter(({ folded }) => eligible(folded) && haystack.includes(` ${folded} `));
  const kept = hits.filter(
    (h) => !hits.some((o) => o.folded !== h.folded && ` ${o.folded} `.includes(` ${h.folded} `)),
  );
  return kept.length === 1 ? kept[0]!.doc : null;
}

/** The query for the ecosistema's published documentos and testimonios, names only. */
export function publishedTitlesQuery(organizationId: string): string {
  const qs = new URLSearchParams();
  qs.set('where[organization][equals]', organizationId);
  qs.set('where[publicationStatus][equals]', 'published');
  qs.set('where[contentKind][in]', 'documento,testimonio');
  qs.set('depth', '0');
  qs.set('limit', String(TITLE_SCAN_LIMIT));
  qs.set('sort', '-createdAt');
  qs.set('select[name]', 'true');
  qs.set('select[contentKind]', 'true');
  qs.set('select[uploadedBy]', 'true');
  qs.set('select[anonymisationStatus]', 'true');
  qs.set('select[anonymise]', 'true');
  // 🔴 P-13: a gated documento is named by its report's redacted title.
  qs.set('select[anonymisationReport]', 'true');
  qs.set('select[publicationStatus]', 'true');
  return qs.toString();
}

/** {@link fetchPublishedTitles} plus whether the read hit {@link TITLE_SCAN_LIMIT} (raw rows, before filtering). */
export interface PublishedTitleScan {
  docs: TitledDoc[];
  truncated: boolean;
}

/**
 * The ecosistema's published documentos, and the published, gate-cleared
 * testimonios whose name the backend let this caller read. 🔴 Only rows the
 * library itself would show (`isClearedForLibrary`, audit 2026-10-28): a
 * documento filed for anonymisation and not cleared is never named, pinned or
 * listed. Best-effort: any failure is `[]`, and the turn runs without a title pin.
 */
export async function fetchPublishedTitleScan(
  token: string | undefined,
  organizationId: string | number | null | undefined,
): Promise<PublishedTitleScan> {
  const none = { docs: [], truncated: false };
  if (organizationId == null || organizationId === '') return none;
  try {
    const res = await backendFetch(token, `/api/documents?${publishedTitlesQuery(String(organizationId))}`, {
      method: 'GET',
    });
    if (!res.ok) return none;
    const body = (await res.json().catch(() => ({}))) as { docs?: unknown };
    const rows = (Array.isArray(body.docs) ? body.docs : []) as Array<Record<string, unknown>>;
    const docs = rows
      .filter((r) => r.publicationStatus === 'published')
      .filter((r) => r.contentKind === 'documento' || (r.contentKind === 'testimonio' && gateCleared(r.anonymisationStatus)))
      .filter((r) => isClearedForLibrary(r))
      .filter((r) => typeof r.name === 'string' && r.name.trim())
      .map((r) => ({
        id: String(r.id),
        // 🔴 P-13: a documento by `libraryTitleOf` — a gated one by its redacted
        // title (else "Documento", too short to match), so its raw filename is
        // never matched, pinned or listed.
        name: r.contentKind === 'documento' ? libraryTitleOf(r) : (r.name as string).trim(),
        contentKind: r.contentKind as 'documento' | 'testimonio',
      }));
    return { docs, truncated: rows.length >= TITLE_SCAN_LIMIT };
  } catch {
    return none;
  }
}

/** {@link fetchPublishedTitleScan}'s documents alone. */
export async function fetchPublishedTitles(
  token: string | undefined,
  organizationId: string | number | null | undefined,
): Promise<TitledDoc[]> {
  return (await fetchPublishedTitleScan(token, organizationId)).docs;
}

/**
 * The user's refs plus the title-matched document, after them and only if it
 * is not already there. `withPinnedRefs` then adds the pinned documents and
 * applies the per-turn cap.
 */
export function withTitleRef(userRefs: ContextRef[] | undefined, match: TitledDoc | null): ContextRef[] {
  const out = [...(userRefs ?? [])];
  if (!match) return out;
  if (out.some((r) => r.kind === 'document' && String(r.id) === match.id)) return out;
  // 🔴 Never a testimonio's name on the ref: it is free text the gate never saw.
  out.push({ kind: 'document', id: match.id, label: match.contentKind === 'testimonio' ? 'Testimonio' : match.name });
  return out;
}

/**
 * The turn's retrieval filter: the lengua filter (if any) plus, on a title
 * match, `docId` = that document. `docId` is a STRING in chunk metadata
 * (`chunkMetadata`) and ai-service compares by type. `undefined` = unfiltered.
 */
export function titleRetrievalFilter(
  base: Record<string, string> | undefined,
  match: TitledDoc | null,
): Record<string, string> | undefined {
  if (!match) return base;
  return { ...(base ?? {}), docId: String(match.id) };
}
