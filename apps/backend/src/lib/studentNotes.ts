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
  const revision = found.docs[0] as unknown as Record<string, unknown> | undefined

  if (!revision) {
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

  const plan = planNoteProcessing(revision, text)
  if ('skip' in plan) {
    if (plan.skip === 'in-flight') return { status: 202, processing: true, ingestStatus: String(revision.ingestStatus) }
    if (plan.skip !== 'unchanged') return { status: 409, reason: plan.skip }
    // Same text, already cleared (e.g. `autoPublishMembers` was off): promote now.
    const out = await autoPublishParticipantDocument({
      payload,
      documentId: revision.id as Id,
      clientFor: args.clientFor,
      ...(args.callbackUrl ? { callbackUrl: args.callbackUrl } : {}),
    })
    return out.published ? { status: 202, processing: false, publicationStatus: 'publishing' } : { status: 409, reason: out.reason }
  }
  return startProcessing(payload, revision, { ...plan.data, bodyMarkdown: body, processedBody: body })
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

/**
 * The revision cleared the gate and its draft ingest landed: make it the
 * note's published text. Called by `autoPublishParticipantDocument` in place
 * of `beginPublish`, after every one of its checks (gate, participant,
 * `autoPublishMembers`).
 *
 * 🔴 ORDER. The shared-corpus re-embed is enqueued FIRST: if ai-service refuses
 * it, nothing moved and the next "Publicar cambios" retries. Only then do the
 * gate columns and graph rows move, in one transaction, and the revision go.
 * The note stays `published` throughout: peers never see it vanish, and the
 * old chunks stay until ai-service swaps them.
 * ⚠ The old text is not kept anywhere peers read: its graph rows are deleted,
 * its redaction overwritten, its chunks replaced.
 */
export async function promoteRevision(args: {
  payload: Payload
  revision: Record<string, unknown>
  client: CorpusMover
}): Promise<void> {
  const { payload, revision, client } = args
  const noteId = relationId(revision.revisionOf)
  if (noteId === null) return
  const note = (await payload
    .findByID({ collection: 'documents', id: noteId as never, depth: 0, overrideAccess: true })
    .catch(() => null)) as Record<string, unknown> | null
  const removeRevision = () =>
    payload.delete({ collection: 'documents', id: revision.id as never, overrideAccess: true })
  if (!note) {
    await removeRevision()
    return
  }
  const organizationId = relationId(note.organization)!
  const { corpusTextFor } = await import('./anonymiseDocument')
  const cleared = corpusTextFor(revision)
  if (!cleared.ok) return

  const published = note.publicationStatus === 'published'
  if (published) {
    const { chunkMetadata, contentKindOf, knownContentKind, titleFor } = await import('./contentKind')
    const { publishedCorpus } = await import('./corpus')
    const { withRateLimitRetry } = await import('./aiRetry')
    await withRateLimitRetry(
      () =>
        client.ingest.enqueue({
          corpus: publishedCorpus(organizationId),
          documents: [
            {
              id: String(note.id),
              text: cleared.text,
              title: titleFor(knownContentKind(note as never), note.name as string),
              metadata: chunkMetadata({
                docId: String(note.id),
                organizationId,
                contentKind: contentKindOf(note as never),
                format: note.kind as string,
                publication: 'published',
                title: note.name as string,
                lengua: (note.lengua as string | null | undefined) ?? null,
              }),
            },
          ],
          language: process.env.CORPUS_LANGUAGE?.trim() || 'spanish',
        }),
      { label: `republish note ${String(note.id)}` },
    )
  }

  const { sql } = await import('@payloadcms/db-postgres')
  const db = (payload.db as unknown as { drizzle: { transaction<T>(f: (tx: { execute(q: unknown): Promise<unknown> }) => Promise<T>): Promise<T> } }).drizzle
  const r = revision
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE documents SET
        extracted_text = ${r.extractedText as string},
        redacted_text = ${r.redactedText as string},
        anonymisation_status = ${r.anonymisationStatus as string},
        anonymisation_report = ${r.anonymisationReport == null ? null : JSON.stringify(r.anonymisationReport)}::jsonb,
        anonymisation_error = NULL,
        anonymisation_survivors = NULL,
        held_text = NULL,
        public_figures_kept = ${r.publicFiguresKept == null ? null : JSON.stringify(r.publicFiguresKept)}::jsonb,
        processed_body = ${r.processedBody as string},
        anonymise = true,
        wiki_links = ${r.wikiLinks == null ? null : JSON.stringify(r.wikiLinks)}::jsonb,
        graph_status = ${(r.graphStatus as string | null) ?? 'n/a'},
        graph_error = ${(r.graphError as string | null) ?? null},
        graph_prompt_version = ${(r.graphPromptVersion as string | null) ?? null},
        updated_at = ${new Date().toISOString()}
      WHERE id = ${note.id as number}`)
    await tx.execute(sql`DELETE FROM graph_mentions WHERE document_id = ${note.id as number} AND organization_id = ${organizationId as number}`)
    await tx.execute(sql`DELETE FROM graph_relations WHERE document_id = ${note.id as number} AND organization_id = ${organizationId as number}`)
    await tx.execute(sql`UPDATE graph_mentions SET document_id = ${note.id as number} WHERE document_id = ${r.id as number} AND organization_id = ${organizationId as number}`)
    await tx.execute(sql`UPDATE graph_relations SET document_id = ${note.id as number} WHERE document_id = ${r.id as number} AND organization_id = ${organizationId as number}`)
  })
  await removeRevision()
  const { pruneSeedsIfEnabled } = await import('./graph/schedule')
  await pruneSeedsIfEnabled(payload as never, organizationId)
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
