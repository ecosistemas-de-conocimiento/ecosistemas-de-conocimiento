/**
 * Document publication state — the contract, the copy, and the pure rules.
 *
 * ## The model
 *
 * An **ecosistema** is a group of users who together build a corpus. A user
 * only ever sees content from their own ecosistema. Within it, a document has
 * a publication state:
 *
 *   draft      → visible ONLY to the person who uploaded it.
 *   publishing → being re-indexed into the shared corpus. Slow. Can fail.
 *   published  → part of the ecosistema's shared corpus; everyone in it sees it.
 *   failed     → publishing did not complete. Retryable.
 *
 * A user CAN chat against their own drafts (upload → try it → publish), so an
 * answer may cite a document nobody else can open. `draftDocumentIds` +
 * `markDraftCitations` exist to make that visible rather than silent.
 *
 * ## Backend contract — ASSUMPTIONS, flagged
 *
 * Settled with the backend agent:
 *   - `documents.publicationStatus` is one of the four strings above.
 *   - there is an endpoint to publish one document.
 *
 * NOT settled when this was written; each is isolated to one line so a
 * correction is cheap:
 *   1. The publish endpoint is `POST /api/documents/:id/publish` on the
 *      backend. Only `routes/api/documents/[id]/publish/+server.ts` names it.
 *   2. Retrying after `failed` is the SAME call — publish is idempotent per
 *      document, not a separate `retry` verb.
 *   3. A failure reason may ride on the document as `publicationError`
 *      (string). Read defensively; absence just means no detail to show.
 *   4. The publish response returns the updated document, i.e. `publishing`.
 *      We never assume that — `parsePublicationStatus` reads whatever came
 *      back, and an unreadable answer leaves the local state untouched.
 */

export const PUBLICATION_STATUSES = [
  'draft',
  'publishing',
  'published',
  'failed',
] as const;

export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

export function isPublicationStatus(value: unknown): value is PublicationStatus {
  return (
    typeof value === 'string' &&
    (PUBLICATION_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Read a publication status off a backend row.
 *
 * ⚠ Unknown / missing / malformed reads as `draft`, and that direction is
 * deliberate. The two ways to be wrong are not symmetric: calling a published
 * document "solo tú lo ves" is a confusing but harmless under-claim, while
 * calling a draft "published" tells someone their document is shared when it
 * is not. Fail toward the private reading.
 */
export function parsePublicationStatus(raw: unknown): PublicationStatus {
  return isPublicationStatus(raw) ? raw : 'draft';
}

/** `publishing` is the only non-terminal state — it is what we poll on. */
export function isTerminalPublication(status: PublicationStatus): boolean {
  return status !== 'publishing';
}

/**
 * Is this document private to its uploader right now?
 *
 * `failed` counts: a publish that did not complete leaves the document exactly
 * where it was — private. Saying otherwise would be the dangerous direction.
 * `publishing` also counts, because until the backend says `published` we do
 * not know that anyone else can see it yet.
 */
export function isPrivateToUploader(status: PublicationStatus): boolean {
  return status !== 'published';
}

// ── Can this document be published right now? ──────────────────────────────

export type PublishBlockedReason =
  | 'already-published'
  | 'in-progress'
  | 'not-ingested'
  | 'ingest-failed';

export interface PublishGateInput {
  publicationStatus: PublicationStatus;
  /** The ingest pipeline's state. `n/a` for markdown notes, which need none. */
  ingestStatus: string;
}

/**
 * Whether the publish action is available, and if not, why.
 *
 * The ingest gate is a UI-level judgement, not a backend rule: publishing
 * re-indexes the document, and a document whose text has not been extracted
 * yet has nothing to index. Offering the button anyway would spend the user's
 * time and the ecosistema's tokens on a call that cannot succeed.
 */
export function publishGate(input: PublishGateInput): {
  canPublish: boolean;
  reason: PublishBlockedReason | null;
} {
  if (input.publicationStatus === 'published') {
    return { canPublish: false, reason: 'already-published' };
  }
  if (input.publicationStatus === 'publishing') {
    return { canPublish: false, reason: 'in-progress' };
  }
  if (input.ingestStatus === 'failed') {
    return { canPublish: false, reason: 'ingest-failed' };
  }
  // `n/a` is a markdown note (no pipeline); `ready` is an extracted upload.
  if (input.ingestStatus !== 'ready' && input.ingestStatus !== 'n/a') {
    return { canPublish: false, reason: 'not-ingested' };
  }
  return { canPublish: true, reason: null };
}

// ── Copy ───────────────────────────────────────────────────────────────────

export type BadgeTone = 'private' | 'progress' | 'shared' | 'error';

export interface PublicationBadge {
  label: string;
  /** Longer explanation, for `title=` and for the expanded row. */
  description: string;
  tone: BadgeTone;
}

/**
 * Badge copy per state.
 *
 * ⚠ The draft label says "solo tú" ON THE BADGE, not only in a tooltip. A user
 * who has to hover to learn that nobody else can see their document will not
 * hover, and the misreading runs both ways: believing you have shared
 * something you have not, or the reverse.
 */
export function publicationBadge(status: PublicationStatus): PublicationBadge {
  switch (status) {
    case 'draft':
      return {
        label: 'Borrador · solo tú',
        description:
          'Solo tú puedes ver este documento. Puedes usarlo en el chat, pero nadie más de tu ecosistema lo verá hasta que lo publiques.',
        tone: 'private',
      };
    case 'publishing':
      return {
        label: 'Publicando…',
        description:
          'Todavía solo tú lo ves. Se está agregando al corpus compartido de tu ecosistema; tarda varios minutos, puedes seguir trabajando y volver después.',
        tone: 'progress',
      };
    case 'published':
      return {
        label: 'Publicado',
        description: 'Visible para todas las personas de tu ecosistema.',
        tone: 'shared',
      };
    case 'failed':
      return {
        label: 'No se pudo publicar',
        description:
          'La publicación no se completó. El documento sigue siendo privado: solo tú lo ves. Puedes reintentar.',
        tone: 'error',
      };
  }
}

/** Why the publish button is unavailable, in words the user can act on. */
export function publishBlockedCopy(reason: PublishBlockedReason): string {
  switch (reason) {
    case 'already-published':
      return 'Ya está publicado en tu ecosistema.';
    case 'in-progress':
      return 'Ya se está publicando.';
    case 'not-ingested':
      return 'Espera a que termine de procesarse el documento para publicarlo.';
    case 'ingest-failed':
      return 'No se pudo procesar el documento, así que no puede publicarse. Bórralo y súbelo de nuevo.';
  }
}

// ── Draft citations ────────────────────────────────────────────────────────

/** The narrow slice of a document these helpers need. */
export interface PublicationDocLike {
  id: string;
  publicationStatus: PublicationStatus;
}

/**
 * The ids of documents that are still private to this user.
 *
 * Ownership needs no separate field: a draft is visible ONLY to the person who
 * uploaded it, so any draft present in this user's own document list is, by
 * construction, theirs. That is the whole invariant this relies on — if the
 * backend ever shows a user someone else's draft, this labelling goes wrong.
 */
export function draftDocumentIds(docs: readonly PublicationDocLike[]): Set<string> {
  const out = new Set<string>();
  for (const d of docs) {
    if (d && d.id && isPrivateToUploader(d.publicationStatus)) out.add(String(d.id));
  }
  return out;
}

/** The minimum of a citation these helpers touch (a `CitationLike` subset). */
export interface CitationDocRef {
  title?: string | null;
  documentId?: string | number | null;
  /** Chunk metadata; carries `DRAFT_PROVENANCE_FLAG` when we stamped it. */
  metadata?: Record<string, unknown> | null;
}

/**
 * Metadata key stamped on a provenance chunk that came from the caller's own
 * draft corpus.
 *
 * ⚠ Why this exists in addition to the session document list. Three reasons,
 * and none of them went away when retrieval stopped reading the caller's whole
 * draft corpus (`$lib/server/engine/aiClient` now narrows the draft leg to the
 * documents attached to the current conversation):
 *
 *   1. RELOAD-PROOF. The stamp is written server-side, at generation time,
 *      onto the persisted turn. The reader's later session document list is
 *      irrelevant — an old answer keeps its labels.
 *   2. A DOCUMENT CAN BE ATTACHED TO SEVERAL CONVERSATIONS. Reading an answer
 *      from conversation A while sitting in conversation B, the local list
 *      would not contain the cited draft and the citation would go unlabelled.
 *   3. EXACT, not inferred. The corpus name says "this chunk came from the
 *      caller's private drafts". Nothing else in the citation does.
 *
 * A draft cited with no label at all is the silent failure this labelling
 * exists to prevent, so the signal that does not depend on the reader's current
 * context is the one worth keeping.
 */
export const DRAFT_PROVENANCE_FLAG = 'edcIsDraft';

/** Chunks as they ride on a persisted assistant turn. */
interface ProvenanceLike {
  chunks?: Array<{ corpus?: string | null; metadata?: Record<string, unknown> | null }>;
}

/**
 * Stamp `DRAFT_PROVENANCE_FLAG` on every chunk that came from `draftCorpus`.
 *
 * Server-side, before the turn is persisted, so the label survives a reload and
 * does not depend on the reader's current session. Returns the provenance
 * unchanged when there is no draft corpus to compare against — an unstamped
 * chunk is simply "unknown", which the UI leaves unlabelled rather than
 * claiming it is shared.
 */
export function stampDraftProvenance<T>(provenance: T, draftCorpus: string | null): T {
  if (!draftCorpus || !provenance || typeof provenance !== 'object') return provenance;
  // `as unknown as`: `provenance` is an unconstrained type parameter, so a
  // direct assertion is not always accepted. The runtime guards above make it safe.
  const chunks = (provenance as unknown as ProvenanceLike).chunks;
  if (!Array.isArray(chunks)) return provenance;
  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== 'object') continue;
    if (chunk.corpus !== draftCorpus) continue;
    chunk.metadata = { ...(chunk.metadata ?? {}), [DRAFT_PROVENANCE_FLAG]: true };
  }
  return provenance;
}

/** Did the server stamp this citation as coming from the caller's drafts? */
export function isStampedDraftCitation(citation: CitationDocRef): boolean {
  return citation.metadata?.[DRAFT_PROVENANCE_FLAG] === true;
}

/** Suffix appended to a cited draft's title, inside the citation card. */
export const DRAFT_CITATION_SUFFIX = ' · borrador, solo tú lo ves';

/**
 * Marks citations that point at one of this user's private documents.
 *
 * The suffix goes on `title` because `CitationCard` is a shared package
 * component with no slot for an annotation, and `title` is the one field it
 * renders next to every source. Not elegant; it is the only place the label
 * lands where the source is actually named.
 *
 * A citation matching NEITHER signal is left ALONE rather than marked
 * "published" — retrieval may reach documents we cannot classify, and we must
 * not claim a visibility we cannot verify.
 */
export function markDraftCitations<T extends CitationDocRef>(
  citations: readonly T[],
  draftIds: ReadonlySet<string>,
): { citations: T[]; draftCount: number } {
  let draftCount = 0;
  const marked = citations.map((c) => {
    const id = c.documentId == null ? '' : String(c.documentId);
    // Two independent signals, either one is enough:
    //  - the server stamped the chunk as coming from this user's draft corpus
    //    (exact, and holds whichever conversation the answer is read in — a
    //    document can be attached to more than one);
    //  - the document is in THIS session's list and is not published (the
    //    fallback for turns generated before the stamp existed).
    if (!isStampedDraftCitation(c) && (!id || !draftIds.has(id))) return c;
    draftCount += 1;
    // `as T`: spreading a generic and overriding one property yields a type
    // TypeScript will not prove assignable back to `T` on its own, even though
    // it is. The cast keeps callers' concrete citation types (extra fields and
    // all) instead of widening everything to `CitationDocRef`.
    return {
      ...c,
      // Matches `CHAT_CITATION_LABELS.untitledSource`, the card's own
      // fallback — the suffix lands inside that card, so use its vocabulary.
      title: `${c.title ?? 'Fuente sin título'}${DRAFT_CITATION_SUFFIX}`,
    } as T;
  });
  return { citations: marked, draftCount };
}

/** One-line warning above a citation card that quotes the user's drafts. */
export function draftCitationNotice(draftCount: number): string | null {
  if (draftCount <= 0) return null;
  if (draftCount === 1) {
    return 'Esta respuesta cita 1 documento en borrador. Solo tú puedes verlo: si compartes la respuesta, nadie más podrá abrir esa fuente.';
  }
  return `Esta respuesta cita ${draftCount} documentos en borrador. Solo tú puedes verlos: si compartes la respuesta, nadie más podrá abrir esas fuentes.`;
}
