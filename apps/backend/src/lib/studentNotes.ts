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

  // 🔴 NO `__skipDocsExtract` and NO user: `extractAndIngestHook` takes it from
  // here, exactly as for an upload or a retry.
  await payload.update({
    collection: 'documents',
    id: row.id as never,
    data: plan.data as never,
    overrideAccess: true,
  })
  return { status: 202, processing: true, ingestStatus: 'pending' }
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
