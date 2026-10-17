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
export function titleFor(contentKind: ContentKind, name?: string | null): string {
  if (contentKind === 'testimonio') return 'Testimonio'
  if (contentKind === 'conversacion') return 'Conversación'
  const trimmed = typeof name === 'string' ? name.trim() : ''
  return trimmed === '' ? 'Documento sin título' : trimmed
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
   * Only set for `conversacion`. `assistant` marks a chunk that is a PREVIOUS
   * ANSWER rather than a source — see the header.
   */
  authoredBy?: 'user' | 'assistant'
  /** Only set for `conversacion`: which thread the turn came from. */
  sessionId?: string | number
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
    title: titleFor(args.contentKind, args.title),
    ...(args.authoredBy ? { authoredBy: args.authoredBy } : {}),
    ...(args.sessionId === undefined ? {} : { sessionId: String(args.sessionId) }),
    ...(lengua ? { lengua } : {}),
  }
}
