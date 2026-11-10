/**
 * 🔴 WHAT A CHUNK *IS*, as opposed to what FILE it came out of.
 *
 * ── TWO DIFFERENT "KIND"S, AND CONFUSING THEM IS THE BUG THIS FILE PREVENTS ──
 *
 * `documents.kind` already existed and means the FORMAT: `markdown | pdf | docx
 * | audio`. It answers "how do we get text out of this". It is useless for the
 * three questions the product actually asks of a retrieved chunk.
 *
 * `contentKind` — this file — answers those:
 *
 *   · `documento`    — a source. A real document somebody uploaded.
 *   · `testimonio`   — a Voz. Someone's words, recorded by an Investigador.
 *   · `conversacion` — a chat turn that was ingested back into the corpus.
 *
 * ⚠ IT IS LOAD-BEARING, NOT BOOKKEEPING. Questions AND assistant answers are
 * ingested (owner's decision), so without this field the assistant retrieves its
 * OWN PRIOR ANSWERS and presents them as sources — its errors become
 * "documented" over time, silently. `conversacion` + `authoredBy: 'assistant'`
 * is what lets a citation say *"this came from a previous answer"* instead. It
 * is also what any "show me only real documents" filter keys off.
 *
 * ⚠ IT MUST SURVIVE PUBLISHING. Publishing RE-EMBEDS a document into a
 * different corpus (`lib/publishDocument.ts`), building fresh chunk metadata
 * from the row. A `contentKind` written only on the draft ingest would be lost
 * at exactly the moment the document becomes visible to the whole ecosistema.
 * That is why {@link chunkMetadata} below is shared by every ingest path rather
 * than each one assembling its own object.
 */

export const CONTENT_KINDS = ['documento', 'testimonio', 'conversacion'] as const

export type ContentKind = (typeof CONTENT_KINDS)[number]

/**
 * A plain upload is a `documento`. The other two are never a default: a
 * `testimonio` is chosen explicitly by an Investigador at upload time, and a
 * `conversacion` is produced by the conversation-ingest path, which has no user
 * form behind it at all.
 */
export const DEFAULT_CONTENT_KIND: ContentKind = 'documento'

export function isContentKind(value: unknown): value is ContentKind {
  return typeof value === 'string' && (CONTENT_KINDS as readonly string[]).includes(value)
}

/**
 * The `contentKind` of a row, defaulting rather than throwing on junk.
 *
 * ⚠ Defaults to `documento`, the LEAST privileged reading: an unknown value is
 * treated as an ordinary source document, never as a testimony. Getting that
 * backwards would let a row with a typo'd value skip the anonymisation gate.
 */
export function contentKindOf(row: { contentKind?: unknown } | null | undefined): ContentKind {
  return isContentKind(row?.contentKind) ? row.contentKind : DEFAULT_CONTENT_KIND
}

/**
 * The row's kind when it is a known one, else `null` — NO default. For
 * {@link titleFor}: `contentKindOf` maps an unknown kind to `documento`, whose
 * title is the free-text filename, which is the fail-open direction.
 */
export function knownContentKind(row: { contentKind?: unknown } | null | undefined): ContentKind | null {
  return isContentKind(row?.contentKind) ? row.contentKind : null
}

/**
 * 🔴 EVERY CHUNK THAT ENTERS ANY CORPUS GETS ITS METADATA FROM HERE.
 *
 * Three callers: the draft ingest (`collections/Documents.ts`), the publish and
 * unpublish moves (`lib/publishDocument.ts`), and conversation ingest
 * (`lib/conversationIngest.ts`). They used to each build the object inline,
 * which is how `kind` would have gone missing on the publish move.
 *
 * ⚠ `kind` ON THE WIRE IS THE CONTENT KIND, NOT THE FILE FORMAT. The format
 * moved to `format`. Nothing downstream read the old `kind` — `@edc/chat-engine`
 * reads only `metadata.title` — but it is a rename on a live contract and is
 * recorded here so nobody re-derives the old meaning from an old chunk.
 *
 * ⚠ NOTHING IDENTIFYING A PERSON GOES IN HERE. No `uploadedBy`, no author id,
 * no speaker. For a `testimonio` that is the whole point (see
 * `lib/anonymise/`); for a `conversacion` it is the structural stage of the
 * gate. `organizationId` is a TENANT id, not a person.
 *
 * 🔴 …AND THAT INCLUDES THE TITLE, WHICH IS THE ONE THAT ALMOST GOT THROUGH.
 * `documents.name` is free text typed by the uploader and `sessions.title` is
 * derived from the first thing somebody asked. "Testimonio de María López.mp3"
 * would have carried that name into the shared corpus and onto the citation
 * card, past all four stages of a gate whose entire job is to remove it —
 * because the gate reads the TEXT and never looked at the metadata. So gated
 * content gets a NEUTRAL title here; see {@link titleFor}.
 */
/**
 * 🔴 A GATED CHUNK GETS A NEUTRAL TITLE. Not a stylistic choice.
 *
 * A `documento` is somebody's own material filed under their own name, so its
 * title is theirs and travels with it. A `testimonio` is anonymous by design and
 * a `conversacion` was written by someone who believed it was private — and both
 * of those titles are FREE TEXT that never went through the gate:
 * `documents.name` is whatever the Investigador typed on the upload form,
 * `sessions.title` is generated from the first question somebody asked.
 *
 * Either one routinely contains exactly what the gate exists to remove, and it
 * would land in the shared corpus and on the citation card looking official.
 *
 * ⚠ THE COST IS REAL AND WAS ACCEPTED: every Voz cites as "Testimonio", so a
 * reader cannot tell two testimonies apart from the citation alone. That is the
 * correct trade for anonymous material — a distinguishable title is, by
 * definition, a handle on which person it came from. `metadata.docId` still
 * identifies the row for anyone with access to it.
 */
export function titleFor(
  contentKind: ContentKind | null | undefined,
  name?: string | null,
  /**
   * 🔴 THE ROW'S GATE COLUMNS, for a `documento` (P-13/I-07/C-10, owner
   * decision 2026-11-10). A `documento` with `anonymise` set is gated, and so
   * is its TITLE: it carries the gate's redacted title
   * (`anonymisationReport.redactedTitle`, {@link redactedTitleOf}), never
   * `name`. No redacted title yet → the neutral {@link GATED_DOCUMENT_TITLE}.
   *
   * ⚠ Absent = ungated: a caller that does not pass the row keeps the old
   * rule. Every path that ships a title passes it. A NULL column is gated for
   * the title ({@link titleIsGated}), unlike the body's {@link anonymiseRequested}.
   */
  gate?: TitleGateColumns | null,
): string {
  if (contentKind === 'testimonio') return 'Testimonio'
  if (contentKind === 'conversacion') return 'Conversación'
  // 🔴 FAILS CLOSED. Only a `documento` carries its own name. A kind this code
  // does not know yet — a new one added to `CONTENT_KINDS`, or a raw column
  // value nobody validated — gets a neutral title, not the filename.
  if (contentKind !== 'documento') return 'Documento'
  if (gate && titleIsGated(gate.anonymise)) {
    return redactedTitleOf(gate.anonymisationReport) ?? GATED_DOCUMENT_TITLE
  }
  const trimmed = typeof name === 'string' ? name.trim() : ''
  return trimmed === '' ? 'Documento sin título' : trimmed
}

/**
 * The title of a gated `documento` the gate has not titled (yet): a row gated
 * before 2026-11-10, a title the gate could not clear, or a run that crashed.
 * 🔴 Never the filename instead.
 */
export const GATED_DOCUMENT_TITLE = 'Documento'

/** The columns {@link titleFor} reads to know a `documento`'s title is gated. */
export interface TitleGateColumns {
  /** The raw `documents.anonymise` ({@link anonymiseRequested}). */
  anonymise?: unknown
  /** The raw `documents.anonymisationReport`; the title is its `redactedTitle`. */
  anonymisationReport?: unknown
}

/**
 * 🔴 A `documento` FILED FOR ANONYMISATION (owner rulings 2026-10-26).
 *
 * ⚠ FAILS CLOSED ON A PRESENT VALUE: anything but `false`/`null`/absent gates.
 * Absent is ungated so rows assembled in code keep today's documento rule.
 * Lives here (re-exported by `anonymiseDocument.ts`, which documents it) so the
 * title rule reads the same function as the gate without importing the gate.
 */
export function anonymiseRequested(rawAnonymise: unknown): boolean {
  return rawAnonymise !== undefined && rawAnonymise !== null && rawAnonymise !== false
}

/**
 * 🔴 IS A `documento`'S TITLE GATED? Like {@link anonymiseRequested}, but a
 * NULL column counts as gated (coordinator ruling 2026-11-10: conservative,
 * the same as `mayReadGatedOriginal` in `collections/Documents.ts`). Only an
 * explicit `false` shows `name`. 🔴 FAILS CLOSED on an absent column too: a
 * partial row (`?select[anonymise]=false`, a `select` that forgot it, a row
 * built in code) is gated — measured 2026-11-10, a colleague's partial read
 * returned the raw filename. A caller that wants an open title must read
 * `anonymise`.
 *
 * ⚠ TITLE ONLY. {@link anonymiseRequested} still decides whether the BODY
 * passes the gate (`rowMustPassGate`, `Documents.ts`, `graph/schedule.ts`):
 * flipping NULL there would gate, hold or stop auto-publishing rows that today
 * go through ungated.
 */
export function titleIsGated(rawAnonymise: unknown): boolean {
  return rawAnonymise !== false
}

/**
 * The gate's redacted title on a report, or null. Written by
 * `anonymiseDocument.ts` from `GateResult.redactedTitle` (same allocator as
 * the body: "Entrevista a [Persona A].pdf" when the body calls him
 * `[Persona A]`).
 */
export function redactedTitleOf(report: unknown): string | null {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return null
  const t = (report as { redactedTitle?: unknown }).redactedTitle
  return typeof t === 'string' && t.trim() !== '' ? t.trim() : null
}

/**
 * {@link titleFor} over a `documents` row: its known kind (no default), its
 * `name`, and its gate columns. The one call every title that leaves the
 * backend should make.
 */
export function documentTitleFor(
  row: { contentKind?: unknown; name?: unknown } & TitleGateColumns,
): string {
  return titleFor(knownContentKind(row), typeof row.name === 'string' ? row.name : null, row)
}

export function chunkMetadata(args: {
  /** The `documents` row id, or the synthetic id of a conversation turn. */
  docId: string
  organizationId: string | number
  contentKind: ContentKind
  /** `markdown | pdf | docx | audio` for a document; `chat` for a turn. */
  format?: string | null
  /** Which corpus this copy lives in. `draft` is private to one person. */
  publication: 'draft' | 'published'
  /**
   * The citation's human name, as the uploader typed it.
   *
   * 🔴 Without it `chat-engine` falls back to the CORPUS NAME and a source card
   * reads "eco-1-draft-1". The top-level `title` on an ingest document is NOT
   * echoed back on retrieve; only `metadata` survives the round trip.
   *
   * ⚠ USED ONLY FOR `documento`. For gated content it is REPLACED — see
   * {@link titleFor}.
   */
  title?: string | null
  /**
   * 🔴 The row's gate columns (`anonymise`, `anonymisationReport`). A gated
   * `documento` then carries its redacted title, never `title` (P-13).
   */
  gate?: TitleGateColumns | null
  /**
   * Only set for `conversacion`. `assistant` marks a chunk that is a PREVIOUS
   * ANSWER rather than a source — see the header.
   */
  authoredBy?: 'user' | 'assistant'
  /** Only set for `conversacion`: which thread the turn came from. */
  sessionId?: string | number
  /**
   * Only set for `conversacion`: the conversation's owner. Lets chat's
   * orientation leg keep to the asker's own turns (`CHAT_ORIENT_SCOPE=own`).
   * Never reaches a browser (the web's provenance allowlist).
   */
  userId?: string | number
  /**
   * `documents.lengua` — the language of the PEOPLE a document is about. Lets
   * retrieval take ai-service's metadata `filter: { lengua }`.
   *
   * 🔴 KEPT ON A `documento` ONLY, whatever the caller passes. On a testimonio
   * it is a re-identification key (`enforceLenguaDocumentoOnly` in
   * `collections/Documents.ts`), and the corpus has no per-document delete.
   * This is the third enforcement of that rule, and the one that guards the
   * corpus rather than the row.
   */
  lengua?: string | null
}): Record<string, unknown> {
  const lengua =
    args.contentKind === 'documento' && typeof args.lengua === 'string' ? args.lengua.trim() : ''
  return {
    docId: args.docId,
    organizationId: String(args.organizationId),
    kind: args.contentKind,
    format: args.format ?? 'unknown',
    publication: args.publication,
    title: titleFor(args.contentKind, args.title, args.gate),
    ...(args.authoredBy ? { authoredBy: args.authoredBy } : {}),
    ...(args.sessionId === undefined ? {} : { sessionId: String(args.sessionId) }),
    ...(args.userId === undefined ? {} : { userId: String(args.userId) }),
    ...(lengua ? { lengua } : {}),
  }
}
