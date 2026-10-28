/**
 * Document publication state — the contract, the copy, and the pure rules.
 *
 * ## The model
 *
 * An **ecosistema** is a group of users who together build a corpus. A user
 * only ever sees content from their own ecosistema. Within it, a document has
 * a publication state:
 *
 *   draft        → visible ONLY to the person who uploaded it.
 *   publishing   → being re-indexed into the shared corpus. Slow. Can fail.
 *   published    → part of the ecosistema's shared corpus; everyone in it sees it.
 *   unpublishing → being taken back out of the shared corpus. Slow. Can fail.
 *   failed       → publishing did not complete. Retryable.
 *
 * A user CAN chat against their own drafts (upload → try it → publish), so an
 * answer may cite a document nobody else can open. `draftDocumentIds` +
 * `markDraftCitations` exist to make that visible rather than silent.
 *
 * ## Backend contract — ASSUMPTIONS, flagged
 *
 * Settled with the backend agent:
 *   - `documents.publicationStatus` is one of the strings above.
 *   - there is an endpoint to publish one document.
 *
 * ⚠ HOW THIS UNION LINES UP WITH THE BACKEND'S. The backend's authoritative
 * list is `PUBLICATION_STATES` in `apps/backend/src/lib/publishDocument.ts`:
 * `draft`, `publishing`, `published`, `unpublishing`. Every one of those is
 * here, in that order.
 *
 * `failed` is the one member the backend column cannot currently hold, and it
 * is kept ON PURPOSE. The backend records a failed publish as
 * `publicationStatus: 'publishing'` PLUS a populated `publicationError`
 * (`failPublish`), so nothing writes the literal string today — but this app
 * models a failed publish as its own state in `types.ts`, the docs panel and
 * the publish poller, and dropping it would delete a real UI state to match a
 * storage detail that is expected to change. An extra member costs a badge
 * string; a missing one costs a wrong write gate, which is Gap 1 itself.
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
  // The backend's four, in the backend's order…
  'draft',
  'publishing',
  'published',
  'unpublishing',
  // …then the one this app models and the backend column does not yet hold.
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

/**
 * The two in-flight states are the ones we poll on.
 *
 * ⚠ `unpublishing` IS NON-TERMINAL TOO, and forgetting it is not cosmetic: the
 * poller in `$lib/stores/app.svelte.ts` stops at the first terminal read, so
 * calling `unpublishing` terminal would freeze the row on "dejando de
 * compartir…" and never repaint it when the backend settles it to `draft`.
 */
export function isTerminalPublication(status: PublicationStatus): boolean {
  return status !== 'publishing' && status !== 'unpublishing';
}

/**
 * Is this document private to its uploader right now?
 *
 * `failed` counts: a publish that did not complete leaves the document exactly
 * where it was — private. Saying otherwise would be the dangerous direction.
 * `publishing` also counts, because until the backend says `published` we do
 * not know that anyone else can see it yet.
 *
 * `unpublishing` counts as private, and this matches the backend exactly:
 * `isSharedWithEcosystem` in `lib/publishDocument.ts` is `state === 'published'`
 * and nothing else. The backend also retires the shared copy FIRST when
 * unpublishing, so the row stops being shared before it stops saying
 * `unpublishing` — the reading here is the conservative one either way.
 *
 * 🔴 THIS IS NOT THE PREDICATE FOR A WRITE GATE. "Nobody else can see it" is a
 * much wider set than "still editable": a `publishing`, `unpublishing` or
 * `failed` document is private but has a copy in flight, so overwriting its
 * text would desync the embedded copy from the row. A gate wants
 * `=== 'draft'`. See the transcript route.
 */
export function isPrivateToUploader(status: PublicationStatus): boolean {
  return status !== 'published';
}

// ── Can this document be published right now? ──────────────────────────────

export type PublishBlockedReason =
  | 'already-published'
  | 'in-progress'
  | 'not-ingested'
  | 'ingest-failed'
  /** A participant's draft: the system publishes it once the gate clears it. */
  | 'automatic';

export interface PublishGateInput {
  publicationStatus: PublicationStatus;
  /** The ingest pipeline's state. `n/a` for markdown notes, which need none. */
  ingestStatus: string;
  /**
   * `false` for a participant (owner rule, 2026-10-24): they never publish by
   * hand. The backend publishes what the gate clears (`lib/autoPublish.ts`);
   * only a FAILED publish keeps its retry. Default `true`.
   */
  manual?: boolean;
  /**
   * A student's own in-app note in a `studentView` ecosistema. "Publicar" runs
   * the backend's gate → corpus → graph → publish (`lib/studentNotes.ts`), so
   * it is offered on a draft, except while a run is going and except on a
   * FAILED run whose text was not edited since (`editedSinceFailure`): the same
   * text would fail the same way, so the failure box's "Reintentar" is the way.
   */
  note?: boolean;
  /** Note mode only: the body changed since this browser saw the run fail. */
  editedSinceFailure?: boolean;
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
  // ⚠ BOTH in-flight states block, not just `publishing`. Publishing a document
  // that is halfway out of the shared corpus queues two opposite re-embeds
  // against the same row, and whichever callback lands last decides the state.
  if (input.publicationStatus === 'publishing' || input.publicationStatus === 'unpublishing') {
    return { canPublish: false, reason: 'in-progress' };
  }
  if (input.note) {
    const running = ['pending', 'extracting', 'embedding', 'transcribing', 'transcribed'].includes(input.ingestStatus);
    if (running) return { canPublish: false, reason: 'not-ingested' };
    if (input.ingestStatus === 'failed' && !input.editedSinceFailure) {
      return { canPublish: false, reason: 'ingest-failed' };
    }
    return { canPublish: true, reason: null };
  }
  if (input.ingestStatus === 'failed') {
    return { canPublish: false, reason: 'ingest-failed' };
  }
  if (input.manual === false && input.publicationStatus !== 'failed') {
    return { canPublish: false, reason: 'automatic' };
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
    case 'unpublishing':
      return {
        // ⚠ THE COPY DOES NOT PROMISE PRIVACY YET, and that is the careful
        // direction HERE. For every other state the risk is claiming something
        // is shared when it is not; on this one it is the reverse — telling
        // someone their document is already private while a copy may still be
        // answering questions in the ecosistema is the harmful reading.
        label: 'Dejando de compartir…',
        description:
          'Se está quitando del corpus compartido de tu ecosistema y volviendo a tus borradores. Tarda varios minutos; hasta que termine, puede seguir apareciendo en algunas respuestas.',
        tone: 'progress',
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

/**
 * Why the publish button is unavailable — one short line, or `''` when the
 * card already shows it (the "Publicado" / "Publicando…" badge). No
 * explainer sentences (UX backlog #33).
 */
export function publishBlockedCopy(reason: PublishBlockedReason): string {
  switch (reason) {
    case 'already-published':
    case 'in-progress':
    case 'automatic':
      return '';
    case 'not-ingested':
      return 'Se podrá publicar cuando esté listo.';
    case 'ingest-failed':
      return 'No se pudo procesar.';
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

/**
 * Has a note's body changed since its run was seen to fail? `failedBody` is
 * the body the store held when it first saw `ingestStatus: 'failed'` (load or
 * poll).
 *
 * ⚠ Conservative after a reload: edits made before the reload count as
 * unchanged until the next keystroke. The failure box's retry stays available.
 */
export function editedSinceFailure(d: { body: string; failedBody?: string }): boolean {
  return d.failedBody !== undefined && d.body !== d.failedBody;
}
