/**
 * 🔴 A STUDENT'S IN-APP NOTE FEEDS THE STUDENT VIEW WHEN THE STUDENT PUBLISHES IT.
 *
 * A note written in the app (`kind: 'markdown'`, no file, text in
 * `bodyMarkdown`) is created at `ingestStatus: 'n/a'`, which keeps it out of
 * every pipeline (`isIngestable` in `collections/Documents.ts`). So a student
 * who only wrote notes had no topics, no authors, no peers in /estudiante.
 *
 * Owner ruling (2026-10-28): a note is processed ONLY when its author presses
 * "Publicar". Never on autosave, never on a timer. In an ecosistema with
 * `studentView` on, a STUDENT's draft note then goes the upload path:
 *
 *   POST /api/documents/:id/publish  ({@link publishStudentNote})
 *     → `ingestStatus: 'pending'` + `extractedText` + `anonymise: true`
 *     → `extractAndIngestHook` → `runExtractAndIngest`
 *     → the anonymisation gate → the draft ingest → the corpus graph
 *       (the redacted text only, wikilink seeds per `WIKILINK_SEED_ORGS`)
 *     → the ingest callback → `autoPublishParticipantDocument`
 *       (the ecosistema's `autoPublishMembers`) → published
 *
 * Nothing here gates, ingests, graphs or publishes by itself. It writes one row
 * update and the existing pipeline does the rest, with every rule it has.
 *
 * ── COST (inferred from the code, not measured) ─────────────────────────────
 * Each "Publicar" on new text = 1 anonymisation gate run (the detector is a
 * model call; `enqueueIngestForDoc` counts a gate run as "two model calls") +
 * 1 draft embedding ingest + ceil(text / `GRAPH_EXTRACT_WINDOW_CHARS`) `deep`
 * graph windows + 1 re-embed into the shared corpus. "Publicar" on text that
 * already went through skips the gate, ingest and graph.
 *
 * ── RULES ───────────────────────────────────────────────────────────────────
 * 🔴 DRAFTS ONLY. A published note is not re-processed. Unpublish → edit →
 * Publicar runs it again, gated from scratch (the text changed).
 * 🔴 `rejected` IS TERMINAL, as everywhere else. `held` / `ready` / `approved`
 * on CHANGED text: the gate state is cleared and the new text is gated from
 * scratch (`gateResetForTextEdit`'s rule). Unchanged text never re-gates.
 * 🔴 `anonymise: true` ALWAYS. A student's work is gated (owner ruling
 * 2026-10-26); a note filed before that rule had `false`.
 * 🔴 AUTOPUBLISH STILL DECIDES. With `autoPublishMembers` off the note stays a
 * draft for staff, exactly like a student's upload; "Publicar" does not
 * bypass the switch.
 *
 * 🔴 PRIVACY: logs carry ids only.
 */

import type { Payload } from 'payload'

import { isPlatformAdminUser } from '../access'
import { autoPublishParticipantDocument, type AutoPublishSkip } from './autoPublish'
import { errSummary } from './errorSummary'
import { featureEnabled } from './features'
import { relationId, roleInOrganization } from './permissions'
import type { CorpusMover } from './publishDocument'

type Id = number | string

/** Same floor as the graph's (`lib/graph/schedule.ts` `MIN_TEXT_CHARS`). */
export const MIN_NOTE_CHARS = 200

/** A note written in the app: markdown with no stored file. */
export function isAppNote(row: { kind?: unknown; mediaFile?: unknown }): boolean {
  return row.kind === 'markdown' && relationId(row.mediaFile) === null
}

/** States in which a pipeline run owns the row. */
const IN_FLIGHT = new Set(['pending', 'extracting', 'embedding', 'transcribing', 'transcribed'])

export type NoteProcessSkip =
  | 'not-a-note'
  | 'not-documento'
  | 'not-draft'
  | 'rejected'
  | 'in-flight'
  | 'too-short'
  | 'unchanged'

/** The row-only half, before any text is extracted. */
export function noteProcessBlocker(row: Record<string, unknown>): NoteProcessSkip | null {
  if (!isAppNote(row)) return 'not-a-note'
  if (row.contentKind !== 'documento') return 'not-documento'
  if (row.publicationStatus !== 'draft') return 'not-draft'
  if (row.anonymisationStatus === 'rejected') return 'rejected'
  if (IN_FLIGHT.has(String(row.ingestStatus))) return 'in-flight'
  return null
}

/**
 * The whole decision, pure. `text` is the note's extracted text (what the
 * extractor makes of `bodyMarkdown` now). Returns the update to write, or why
 * not. Who wrote it and the ecosistema's switch are asked separately.
 */
export function planNoteProcessing(
  row: Record<string, unknown>,
  text: string,
): { data: Record<string, unknown> } | { skip: NoteProcessSkip } {
  const blocked = noteProcessBlocker(row)
  if (blocked) return { skip: blocked }
  if (text.trim().length < MIN_NOTE_CHARS) return { skip: 'too-short' }
  // Already went through with this very text: no re-gate. A held note with the
  // same text stays held.
  if ((row.ingestStatus ?? 'n/a') !== 'n/a' && text === row.extractedText) return { skip: 'unchanged' }
  return {
    data: {
      anonymise: true,
      extractedText: text,
      ingestStatus: 'pending',
      ingestId: null,
      ingestError: null,
      // The new text is gated from scratch (`planIngestRetry` / `gateResetForTextEdit`).
      anonymisationStatus: 'n/a',
      anonymisationError: null,
      anonymisationReport: null,
      redactedText: null,
      heldText: null,
      anonymisationSurvivors: null,
    },
  }
}

/**
 * Is this a STUDENT's note in a `studentView` ecosistema — the only notes this
 * file handles? Anything else keeps today's behaviour.
 */
export async function isStudentNote(payload: Payload, row: Record<string, unknown>): Promise<boolean> {
  if (!isAppNote(row)) return false
  const organizationId = relationId(row.organization)
  const uploaderId = relationId(row.uploadedBy)
  if (organizationId === null || uploaderId === null) return false
  if (!(await featureEnabled(payload, organizationId, 'studentView'))) return false
  const user = await payload
    .findByID({ collection: 'users', id: uploaderId as never, depth: 0, overrideAccess: true })
    .catch(() => null)
  if (!user || isPlatformAdminUser(user)) return false
  return (await roleInOrganization(payload, uploaderId, organizationId)) === 'estudiante'
}

export type StudentNotePublish =
  /** The pipeline was started (or is already running): gate → ingest → graph → publish. */
  | { status: 202; processing: true; ingestStatus: string }
  /** Same text, already cleared: published straight away. */
  | { status: 202; processing: false; publicationStatus: 'publishing' }
  | { status: 409; reason: NoteProcessSkip | AutoPublishSkip }

/**
 * "Publicar" on a student's draft note. The caller has checked the author and
 * {@link isStudentNote}.
 *
 * ⚠ Unchanged text that already cleared the gate (an unpublished note, or one
 * left a draft because the callback's publish did not run) goes straight to
 * `autoPublishParticipantDocument`, which re-checks the gate and the switch.
 */
export async function publishStudentNote(args: {
  payload: Payload
  row: Record<string, unknown>
  clientFor: (organizationId: Id) => CorpusMover
  callbackUrl?: string
  /** The note's text as the pipeline will see it. Test seam. */
  extract?: (body: string) => Promise<string>
}): Promise<StudentNotePublish> {
  const { payload, row } = args
  const blocked = noteProcessBlocker(row)
  if (blocked === 'in-flight') return { status: 202, processing: true, ingestStatus: String(row.ingestStatus) }
  if (blocked) return { status: 409, reason: blocked }

  const body = typeof row.bodyMarkdown === 'string' ? row.bodyMarkdown.trim() : ''
  const text = body ? await (args.extract ?? defaultExtract)(body) : ''
  const plan = planNoteProcessing(row, text)

  if ('skip' in plan) {
    if (plan.skip !== 'unchanged') return { status: 409, reason: plan.skip }
    const out = await autoPublishParticipantDocument({
      payload,
      documentId: row.id as Id,
      clientFor: args.clientFor,
      ...(args.callbackUrl ? { callbackUrl: args.callbackUrl } : {}),
    })
    return out.published ? { status: 202, processing: false, publicationStatus: 'publishing' } : { status: 409, reason: out.reason }
  }

  return startProcessing(payload, row, { ...plan.data, processedBody: row.bodyMarkdown })
}

/**
 * Claim the row and hand it to the pipeline.
 *
 * 🔴 CLAIM FIRST, IN ONE GUARDED `UPDATE` (audit 2026-10-28). Two clicks (two
 * tabs, a double tap) both read the row in the same state; without the claim
 * both would write `pending` and the gate would run twice, billed twice. Only
 * the click whose `WHERE` still matches the state it read moves the row; the
 * other answers "already running".
 */
async function startProcessing(
  payload: Payload,
  row: Record<string, unknown>,
  data: Record<string, unknown>,
): Promise<StudentNotePublish> {
  const { updateDocumentColumns } = await import('./documentColumns')
  const claimed = await updateDocumentColumns(payload as never, {
    id: row.id as Id,
    data: { ingestStatus: 'pending' },
    where: [
      { publicationStatus: { equals: 'draft' } },
      { ingestStatus: { equals: (row.ingestStatus as string | null | undefined) ?? null } },
      { anonymisationStatus: { not_in: ['rejected'] } },
    ],
  })
  if (claimed === 0) return { status: 202, processing: true, ingestStatus: 'pending' }

  // 🔴 NO `__skipDocsExtract` and NO user: `extractAndIngestHook` takes it from
  // here, exactly as for an upload or a retry.
  await payload.update({
    collection: 'documents',
    id: row.id as never,
    data: data as never,
    overrideAccess: true,
  })
  return { status: 202, processing: true, ingestStatus: 'pending' }
}

// ---------------------------------------------------------------------------
// "Publicar cambios": a PUBLISHED note whose body changed (owner ruling 2026-10-28)
// ---------------------------------------------------------------------------

/**
 * 🔴 THE NEW TEXT GOES THROUGH A HIDDEN REVISION ROW; THE PUBLISHED ROW IS NOT
 * TOUCHED UNTIL IT CLEARS.
 *
 * The gate never runs on a shared row (`GATE_CLAIM_GUARD`: "Unpublish first"),
 * and the owner rule is that peers keep the last published version until the
 * change is through. So the change is a second `documents` row, `revisionOf`
 * the note, a private draft of the same author:
 *
 *   Publicar cambios → revision row (`pending`, the new body)
 *     → gate from scratch → draft ingest → graph (draft: own view only)
 *     → ingest callback → `autoPublishParticipantDocument` → {@link promoteRevision}
 *       → the shared corpus re-embedded with the revision's gated text
 *         (ai-service upserts on (corpus, id): the old chunks are replaced)
 *       → the gate columns and the graph rows move onto the note
 *       → the revision row is deleted
 *
 * ⚠ A HELD or REJECTED revision changes nothing for peers: the note keeps its
 * published text. Pressing again re-gates only CHANGED text.
 * ⚠ HIDDEN FROM EVERY USER READ (`hideRevisions` in `collections/Documents.ts`),
 * so it never shows as a second document. One per note (`revisionOf` is unique):
 * a concurrent second click loses the insert and answers "already running".
 */
export async function publishStudentNoteChanges(args: {
  payload: Payload
  row: Record<string, unknown>
  clientFor: (organizationId: Id) => CorpusMover
  callbackUrl?: string
  extract?: (body: string) => Promise<string>
}): Promise<StudentNotePublish> {
  const { payload, row } = args
  if (!isAppNote(row) || row.contentKind !== 'documento') return { status: 409, reason: 'not-a-note' }
  if (row.publicationStatus !== 'published') return { status: 409, reason: 'not-draft' }
  const body = typeof row.bodyMarkdown === 'string' ? row.bodyMarkdown : ''
  if (body === row.processedBody) return { status: 409, reason: 'unchanged' }
  const text = body.trim() ? await (args.extract ?? defaultExtract)(body.trim()) : ''
  if (text.trim().length < MIN_NOTE_CHARS) return { status: 409, reason: 'too-short' }

  const found = await payload.find({
    collection: 'documents',
    where: { revisionOf: { equals: row.id } },
    depth: 0,
    limit: 1,
    overrideAccess: true,
  })
  let revision = found.docs[0] as unknown as Record<string, unknown> | undefined

  if (revision) {
    // Gated, ingested, graphed or being promoted right now: wait for it.
    if (IN_FLIGHT.has(String(revision.ingestStatus)) || revision.publicationStatus !== 'draft') {
      return { status: 202, processing: true, ingestStatus: String(revision.ingestStatus) }
    }
    if (revision.processedBody === body) {
      // The same text again: a verdict stands, a cleared one is promoted now
      // (e.g. `autoPublishMembers` was off when its ingest landed).
      if (revision.anonymisationStatus === 'rejected') return { status: 409, reason: 'rejected' }
      if (revision.ingestStatus !== 'ready') return { status: 409, reason: 'unchanged' }
      const out = await autoPublishParticipantDocument({
        payload,
        documentId: revision.id as Id,
        clientFor: args.clientFor,
        ...(args.callbackUrl ? { callbackUrl: args.callbackUrl } : {}),
      })
      return out.published
        ? { status: 202, processing: false, publicationStatus: 'publishing' }
        : { status: 409, reason: out.reason }
    }
    /**
     * 🔴 CHANGED TEXT STARTS OVER (audit 2026-10-28, item 7). Whatever the old
     * revision ended as — held, rejected, failed — it described other words,
     * so it is discarded and the new text gets a fresh revision and a fresh
     * gate. Its review rows move onto the note first: the audit trail stays.
     */
    await discardRevision(payload, revision, relationId(row.id)!)
    revision = undefined
  }

  try {
    // 🔴 Server-side create, no user: `extractAndIngestHook` runs it now.
    await payload.create({
      collection: 'documents',
      data: {
        organization: relationId(row.organization),
        uploadedBy: relationId(row.uploadedBy),
        name: row.name,
        kind: 'markdown',
        mode: row.mode ?? 'full-text',
        contentKind: 'documento',
        anonymise: true,
        // 🔴 The note's own switches: the revision is gated under them (X9).
        keepPublicFigures: row.keepPublicFigures ?? null,
        keepDocumentAuthor: row.keepDocumentAuthor ?? null,
        keepCitedAuthors: row.keepCitedAuthors ?? null,
        bodyMarkdown: body,
        processedBody: body,
        extractedText: text,
        isPinned: false,
        publicationStatus: 'draft',
        ingestStatus: 'pending',
        revisionOf: row.id,
      } as never,
      overrideAccess: true,
    })
  } catch (err) {
    // The unique `revisionOf`: another click created it first.
    if (isUniqueViolation(err)) return { status: 202, processing: true, ingestStatus: 'pending' }
    throw err
  }
  return { status: 202, processing: true, ingestStatus: 'pending' }
}

type Sql = ReturnType<typeof import('@payloadcms/db-postgres').sql>
type Tx = { execute(q: Sql): Promise<unknown> }
const drizzleOf = (payload: Payload) =>
  (payload.db as unknown as { drizzle: Tx & { transaction<T>(f: (tx: Tx) => Promise<T>): Promise<T> } }).drizzle

/** 🔴 Review rows are the audit trail: they follow the text onto the note. */
async function moveReviews(tx: Tx, from: Id, to: Id): Promise<void> {
  const { sql } = await import('@payloadcms/db-postgres')
  await tx.execute(sql`UPDATE anonymisation_reviews SET document_id = ${Number(to)} WHERE document_id = ${Number(from)}`)
}

async function discardRevision(payload: Payload, revision: Record<string, unknown>, noteId: Id): Promise<void> {
  await moveReviews(drizzleOf(payload), revision.id as Id, noteId)
  await payload.delete({ collection: 'documents', id: revision.id as never, overrideAccess: true }).catch((err) => {
    // Already gone (a concurrent click discarded it): nothing to do.
    payload.logger?.warn?.({ err, docId: String(revision.id) }, '[student-notes] revision already removed')
  })
}

function isUniqueViolation(err: unknown): boolean {
  const seen = new Set<unknown>()
  let e: unknown = err
  while (e && typeof e === 'object' && !seen.has(e)) {
    seen.add(e)
    const o = e as { code?: unknown; cause?: unknown; message?: unknown; data?: { errors?: Array<{ message?: unknown }> } }
    if (o.code === '23505') return true
    if (typeof o.message === 'string' && /unique|duplicate key|already exists/i.test(o.message)) return true
    if (o.data?.errors?.some((x) => typeof x.message === 'string' && /unique|already exists/i.test(x.message))) return true
    e = o.cause
  }
  return false
}

/** Why a promotion did not happen now. `null` = promoted. */
export type PromoteSkip = 'graph-pending' | 'busy' | 'not-cleared' | 'withdrawn'

/** Graph states after which the revision's rows are final. */
const GRAPH_SETTLED = new Set(['ready', 'skipped', 'failed'])

/**
 * The revision cleared the gate, its draft ingest landed and its graph is
 * final: make it the note's published text. Called by
 * `autoPublishParticipantDocument` in place of `beginPublish`, after every one
 * of its checks (gate, participant, `autoPublishMembers`) — from the ingest
 * callback, and again when the revision's graph run ends
 * ({@link onGraphSettled}), whichever comes last.
 *
 * 🔴 THE RULES (audit 2026-10-28):
 *   · GRAPH FIRST (item 2). Not promoted while the revision's graph is still
 *     running: the swap would move no rows, the note would end with none.
 *   · ONE PROMOTION (item 4). The revision is claimed `draft → publishing` in
 *     one guarded UPDATE; a duplicate callback, or the callback and the graph
 *     run together, find it taken and stop. A failure hands it back.
 *   · STILL PUBLISHED, BEFORE AND AFTER (item 1). A note no longer `published`
 *     (withdrawn, mid-move) gets no re-index: the change is discarded and the
 *     student's next "Publicar" on the draft gates it afresh. The re-index
 *     carries a callback (`reindexIngestId`): ai-service's upsert clears a
 *     retirement, so a note withdrawn while it ran is retired again when it
 *     lands (`callback/route.ts`), and checked again right after the swap.
 *   · REVIEW ROWS MOVE (item 3), with the gate columns and the graph rows, in
 *     one transaction.
 * ⚠ The old text is not kept anywhere peers read: its graph rows are deleted,
 * its redaction overwritten, its chunks replaced (ai-service upserts on
 * (corpus, id)).
 */
export async function promoteRevision(args: {
  payload: Payload
  revision: Record<string, unknown>
  client: CorpusMover
  callbackUrl?: string
}): Promise<PromoteSkip | null> {
  const { payload, client } = args
  if (!GRAPH_SETTLED.has(String(args.revision.graphStatus))) return 'graph-pending'
  const revisionId = args.revision.id as Id

  const { updateDocumentColumns } = await import('./documentColumns')
  const claimed = await updateDocumentColumns(payload as never, {
    id: revisionId,
    data: { publicationStatus: 'publishing' },
    where: [{ publicationStatus: { equals: 'draft' } }],
  })
  if (claimed === 0) return 'busy'
  const release = () =>
    updateDocumentColumns(payload as never, { id: revisionId, data: { publicationStatus: 'draft' } }).catch(() => 0)

  try {
    // The row as claimed, not as the caller read it.
    const revision = (await payload.findByID({
      collection: 'documents',
      id: revisionId as never,
      depth: 0,
      overrideAccess: true,
    })) as unknown as Record<string, unknown>
    const noteId = relationId(revision.revisionOf)
    const note = noteId === null ? null : await readNote(payload, noteId)
    if (!note) {
      await payload.delete({ collection: 'documents', id: revisionId as never, overrideAccess: true })
      return 'withdrawn'
    }
    const { corpusTextFor } = await import('./anonymiseDocument')
    const cleared = corpusTextFor(revision)
    if (!cleared.ok) {
      await release()
      return 'not-cleared'
    }
    if (note.publicationStatus !== 'published') {
      await discardRevision(payload, revision, note.id as Id)
      return 'withdrawn'
    }
    const organizationId = relationId(note.organization)!

    // 1. The shared corpus, first: a refusal here moves nothing.
    const { chunkMetadata, contentKindOf, knownContentKind, titleFor } = await import('./contentKind')
    const { publishedCorpus } = await import('./corpus')
    const { withRateLimitRetry } = await import('./aiRetry')
    // A revision is always gated (the swap below sets `anonymise = true`).
    const revisionGate = { anonymise: true, anonymisationReport: revision.anonymisationReport }
    const result = await withRateLimitRetry(
      () =>
        client.ingest.enqueue({
          corpus: publishedCorpus(organizationId),
          documents: [
            {
              id: String(note.id),
              text: cleared.text,
              // 🔴 P-13: the REVISION's redacted title (its report replaces the note's below).
              title: titleFor(knownContentKind(note as never), note.name as string, revisionGate),
              metadata: chunkMetadata({
                docId: String(note.id),
                organizationId,
                contentKind: contentKindOf(note as never),
                format: note.kind as string,
                publication: 'published',
                title: note.name as string,
                gate: revisionGate,
                lengua: (note.lengua as string | null | undefined) ?? null,
              }),
            },
          ],
          language: process.env.CORPUS_LANGUAGE?.trim() || 'spanish',
          ...(args.callbackUrl ? { callbackUrl: args.callbackUrl } : {}),
        }),
      { label: `republish note ${String(note.id)}` },
    )

    // 2. The swap, in one transaction, only while the note is still published.
    const { sql } = await import('@payloadcms/db-postgres')
    const r = revision
    const json = (v: unknown) => (v == null ? null : JSON.stringify(v))
    const swapped = await drizzleOf(payload).transaction(async (tx) => {
      const res = (await tx.execute(sql`
        UPDATE documents SET
          extracted_text = ${r.extractedText as string},
          redacted_text = ${r.redactedText as string},
          anonymisation_status = ${r.anonymisationStatus as string},
          anonymisation_report = ${json(r.anonymisationReport)}::jsonb,
          anonymisation_error = NULL,
          anonymisation_survivors = NULL,
          held_text = NULL,
          public_figures_kept = ${json(r.publicFiguresKept)}::jsonb,
          authors_kept = ${json(r.authorsKept)}::jsonb,
          cited_authors_kept = ${json(r.citedAuthorsKept)}::jsonb,
          processed_body = ${r.processedBody as string},
          anonymise = true,
          wiki_links = ${json(r.wikiLinks)}::jsonb,
          graph_status = ${(r.graphStatus as string | null) ?? 'n/a'},
          graph_error = ${(r.graphError as string | null) ?? null},
          graph_prompt_version = ${(r.graphPromptVersion as string | null) ?? null},
          reindex_ingest_id = ${result.ingestId ?? null},
          updated_at = ${new Date().toISOString()}
        WHERE id = ${Number(note.id)} AND publication_status = 'published'
        RETURNING id`)) as { rows?: unknown[]; rowCount?: number }
      if ((res.rows?.length ?? res.rowCount ?? 0) === 0) return false
      const n = Number(note.id)
      const o = Number(organizationId)
      await tx.execute(sql`DELETE FROM graph_mentions WHERE document_id = ${n} AND organization_id = ${o}`)
      await tx.execute(sql`DELETE FROM graph_relations WHERE document_id = ${n} AND organization_id = ${o}`)
      await tx.execute(sql`UPDATE graph_mentions SET document_id = ${n} WHERE document_id = ${Number(r.id)} AND organization_id = ${o}`)
      await tx.execute(sql`UPDATE graph_relations SET document_id = ${n} WHERE document_id = ${Number(r.id)} AND organization_id = ${o}`)
      await moveReviews(tx, r.id as Id, n)
      return true
    })

    if (!swapped) {
      // Withdrawn between the check and the swap: take the re-index back out.
      const { retireFrom } = await import('./publishDocument')
      await retireFrom(client, publishedCorpus(organizationId), note.id as Id, new Date())
      await discardRevision(payload, revision, note.id as Id)
      return 'withdrawn'
    }
    await payload.delete({ collection: 'documents', id: revisionId as never, overrideAccess: true })

    // 3. After: withdrawn while we swapped? Retire again (the callback re-checks too).
    const after = await readNote(payload, note.id as Id)
    if (!after || after.publicationStatus !== 'published') {
      const { retireFrom } = await import('./publishDocument')
      await retireFrom(client, publishedCorpus(organizationId), note.id as Id, new Date())
    }
    const { pruneSeedsIfEnabled } = await import('./graph/schedule')
    await pruneSeedsIfEnabled(payload as never, organizationId)
    return null
  } catch (err) {
    await release()
    throw err
  }
}

async function readNote(payload: Payload, id: Id): Promise<Record<string, unknown> | null> {
  return (await payload
    .findByID({ collection: 'documents', id: id as never, depth: 0, overrideAccess: true })
    .catch(() => null)) as Record<string, unknown> | null
}

/**
 * A graph run ended. If it was a revision's, try the promotion now: the ingest
 * callback may have landed first and deferred it (`graph-pending`).
 * ⚠ Never throws; runs detached from the graph queue.
 */
export async function onGraphSettled(docId: Id): Promise<void> {
  try {
    const { getPayload } = await import('payload')
    const config = (await import('@payload-config')).default
    const payload = await getPayload({ config })
    const row = await readNote(payload, docId)
    if (!row || relationId(row.revisionOf) === null) return
    const { getAdminAIClient } = await import('./aiClient')
    const { ingestCallbackUrl } = await import('./callbackConfig')
    const callbackUrl = ingestCallbackUrl()
    await autoPublishParticipantDocument({
      payload,
      documentId: docId,
      clientFor: (org) => getAdminAIClient(org) as never,
      ...(callbackUrl ? { callbackUrl } : {}),
    })
  } catch (err) {
    console.error('[student-notes] promotion after graph run failed for doc', String(docId), errSummary(err))
  }
}

async function defaultExtract(body: string): Promise<string> {
  const { extractInWorker } = await import('./extract/sandbox')
  const { DOCUMENT_TEXT_MAX_LENGTH } = await import('../collections/Documents')
  return extractInWorker('markdown', Buffer.from(body, 'utf8'), { maxChars: DOCUMENT_TEXT_MAX_LENGTH })
}

// ---------------------------------------------------------------------------
// The note editor's autosave: a narrow column write
// ---------------------------------------------------------------------------

/**
 * 🔴 WHY AUTOSAVE IS NOT A `payload.update`. Audit 2026-10-28.
 *
 * `payload.update` writes the whole row back as it read it, and
 * `bindDocumentToEcosystem` / `enforceVocesUploadRights` pin
 * `publicationStatus` and `anonymise` to the values read at the START of the
 * request. A note is editable while "Publicar" runs (gate, ingest, publish:
 * minutes), and the editor autosaves every 400 ms. One autosave overlapping a
 * pipeline write put the stale `draft` / `n/a` / `extracting` back over
 * `publishing` / `ready` / `embedding` (`studentNotes.pg.test.ts` reproduces
 * it). This write names only the columns a person types into.
 *
 * ⚠ It skips Payload's hooks on purpose: none of them applies to these three
 * fields, and the one that matters (`extractAndIngestHook`) must not run on an
 * autosave anyway. Validation is redone here.
 */
export type NoteEdit = { name?: string; bodyMarkdown?: string; isPinned?: boolean }

export function parseNoteEdit(
  body: Record<string, unknown>,
  maxBody: number,
): { ok: true; data: NoteEdit } | { ok: false; message: string } {
  const data: NoteEdit = {}
  for (const key of Object.keys(body)) {
    if (key !== 'name' && key !== 'bodyMarkdown' && key !== 'isPinned') {
      return { ok: false, message: `Field "${key}" cannot be edited here.` }
    }
  }
  if ('name' in body) {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 500) {
      return { ok: false, message: 'Invalid name.' }
    }
    data.name = body.name
  }
  if ('bodyMarkdown' in body) {
    if (typeof body.bodyMarkdown !== 'string' || body.bodyMarkdown.length > maxBody) {
      return { ok: false, message: 'Invalid body.' }
    }
    data.bodyMarkdown = body.bodyMarkdown
  }
  if ('isPinned' in body) {
    if (typeof body.isPinned !== 'boolean') return { ok: false, message: 'Invalid isPinned.' }
    data.isPinned = body.isPinned
  }
  if (Object.keys(data).length === 0) return { ok: false, message: 'Nothing to save.' }
  return { ok: true, data }
}
