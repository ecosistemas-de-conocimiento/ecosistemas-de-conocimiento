/**
 * 🔴 THE REVIEW SURFACE FOR DOCUMENTS THE ANONYMISATION GATE HELD.
 *
 * ── WHY A REVIEW EXISTS AT ALL, GIVEN THE GATE HAS NO OVERRIDE ───────────────
 *
 * `lib/anonymise/gate.ts` says, correctly, that there is no "ingest anyway".
 * That is a statement about the AUTOMATED path: no `force` flag, no confidence
 * score a caller can decide to ignore at 5pm on a Friday, no retry that
 * eventually gets lucky. It was never a statement that a hold is permanent —
 * holds are common (one of two real test testimonies held), and a pipeline whose
 * only answer is "no" gets worked around rather than used.
 *
 * So the override exists, and every property that makes it acceptable is in this
 * file:
 *
 *   · A HUMAN performs it, holding `holds:review` in that ecosistema.
 *   · It is RECORDED before the text moves — who, when, and a COPY of the exact
 *     gate report they were looking at. An unaudited override is the same as no
 *     gate.
 *   · It is the ONLY path. Renaming a held row does not re-gate it, retry
 *     refuses a reviewed row, and the gate's own columns cannot be written
 *     through the API at all (`gateWritesOnly` in `collections/Documents.ts`).
 *
 * ── 🔴 WHAT A REVIEWER SEES, AND WHAT THEY DO NOT ────────────────────────────
 *
 * They see `heldText` — the gate's own refused output — and the offsets of what
 * verify found still standing. They do NOT see `extractedText`, the raw
 * original, and that is a deliberate narrowing rather than an oversight: the
 * job is to judge the REDACTION, and the redaction is judged against the
 * redacted text. Handing over the original would make every review a second full
 * disclosure of material the gate exists to protect.
 *
 * ⚠ AND NOTHING HERE IDENTIFIES THE SPEAKER, because nothing anywhere does.
 * There is no `subject`, `speaker`, `onBehalf` or `consent` on `documents` and
 * none is invented here. `uploadedBy` is not returned either — a testimony's
 * uploader is the Investigador who collected it, and pairing "who filed it" with
 * "what it says" is a re-identification aid we can simply decline to build.
 *
 * ── REFUSALS ARE 404-SHAPED ──────────────────────────────────────────────────
 *
 * Unknown document, deactivated ecosistema, not a member, member without
 * `holds:review`, and "that document is not held" all produce one
 * indistinguishable {@link HoldNotVisibleError}. Same rule as
 * `lib/ecosystemMetrics.ts`: a 403 confirms the row exists and turns any
 * id-taking endpoint into an enumeration oracle.
 */

import type { Payload, Where } from 'payload'

import { isActiveUser, isPlatformAdminUser } from '../access'
import { organizationIdsForUserWithPermission, PERMISSIONS, relationId } from './permissions'
import type { GateReport, SurvivorSpan } from './anonymise/types'
import { contentKindOf, type ContentKind } from './contentKind'
import { markNotGraphable } from './graph/schedule'
import type { PublicFigureLogEntry } from './publicFigures'

type Id = number | string

// ---------------------------------------------------------------------------
// The wire shape
// ---------------------------------------------------------------------------

/**
 * One row in the review queue.
 *
 * ⚠ NO HELD TEXT. A queue is a list of things to open, and a list endpoint that
 * carried every held transcript would put the unredacted-ish material of a whole
 * ecosistema in one response, cached by whatever sits in front of it. The text
 * arrives one document at a time, from {@link heldDocument}.
 *
 * ⚠ The ONE string derived from it is `generatedTitle`: a few words made from
 * the redacted `heldText`, refused by `cleanTitle` when it carries a flagged
 * span, a placeholder or a proper noun that is not a town, state or language
 * (`lib/testimonioTitle.ts`), and never made by a hosted model for a held row.
 */
export interface HeldSummary {
  id: string
  /**
   * ⚠ The gate's NEUTRAL title, never `documents.name`.
   *
   * `documents.name` is free text the uploader typed and it never went through
   * the gate — "Testimonio de María López.mp3" is the exact failure
   * `lib/contentKind.ts` documents. A queue screen listing raw names would leak
   * on the index page, before anyone opened anything.
   */
  title: string
  /**
   * The neutral kind label ("Testimonio retenido"), shown as the secondary
   * line when `title` is a generated one; equal to `title` otherwise.
   */
  label: string
  /**
   * 🔴 The system-proposed title (`documents.testimonioTitle`), made from the
   * gate's REDACTED held output, never `name`. `null` ⇒ `title` is the label.
   */
  generatedTitle: string | null
  contentKind: ContentKind
  /** Which stage refused. `structural | deterministic | content | verify`. */
  stage: string | null
  /** The gate's own words. ⚠ Counts only — it never quotes what it found. */
  reason: string | null
  /** How many things verify found still standing. A number, for triage. */
  survivorCount: number
  /** ISO timestamp of the row's last write. When it landed in the queue. */
  updatedAt: string | null
}

/** Everything a reviewer needs to decide, for one document. */
export interface HeldDetail extends HeldSummary {
  /**
   * 🔴 THE GATE'S REFUSED OUTPUT. Not `extractedText`, ever — see the header.
   * `null` for a `structural` hold, which produced nothing to read.
   */
  heldText: string | null
  /**
   * Offsets into `heldText` where verify found something. ⚠ Positions, not
   * strings, and meaningful ONLY against the `heldText` in this same response.
   */
  survivors: SurvivorSpan[]
  /** Per-stage counts and rule names. ⚠ No removed text. */
  report: GateReport | null
  /**
   * Names the gate KEPT as public figures (owner rulings 2026-10-27), with
   * the model's reason, the model and the time. ⚠ Nothing here was removed:
   * each name is in `heldText` already. `[]` when none.
   */
  publicFiguresKept: PublicFigureLogEntry[]
}

/**
 * ⚠ ONE ERROR FOR EVERY REFUSAL, ON PURPOSE. See the file header — the caller
 * cannot tell "no such document" from "not yours" from "you may not review", and
 * that is the point, so nothing may log or return a distinguishing `reason`.
 */
export class HoldNotVisibleError extends Error {
  constructor(message = 'No such held document.') {
    super(message)
    this.name = 'HoldNotVisibleError'
  }
}

/** Raised when the request itself is malformed. Safe to distinguish — it names no row. */
export class HoldReviewInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HoldReviewInputError'
  }
}

/**
 * 🔴 THE HOLD WAS MADE UNDER OTHER SWITCHES (audit 2026-11-07, E2). Its text
 * keeps or hides names by settings that no longer apply; approving it would
 * ingest a verdict nobody would get today. The way out is
 * `PATCH /api/documents/:id/anonimizacion`, which re-gates it. Only raised
 * for a reviewer who may already see the row.
 */
export class HoldSettingsChangedError extends HoldReviewInputError {
  constructor() {
    super('Las opciones de anonimización de este documento cambiaron después de la retención. Vuelve a anonimizarlo antes de aprobarlo.')
    this.name = 'HoldSettingsChangedError'
  }
}

/**
 * 🔴 A `content` HOLD IS NEVER APPROVED AS-IS (audit 2026-11-10, P-01). The
 * model did not finish stage 3 there, or reported a name it could not find in
 * the text: nothing vouches for what `heldText` still carries. The reviewer
 * must send a text that differs from it, or reject. Same for a `verify`
 * hold whose verification never finished (ola 4, `verifyNeverFinished`), and
 * "differs" means in its words (`substantivelyEdited`).
 */
export class HoldContentAsIsError extends HoldReviewInputError {
  constructor() {
    super('Esta retención no se puede aprobar tal cual. Corrige el texto antes de aprobarlo, o recházalo.')
    this.name = 'HoldContentAsIsError'
  }
}

/**
 * True when the switches the hold was made under (its report's `settings`,
 * read by `verdictSettings`) differ from what the row would run with now —
 * every switch in `ANONYMISE_SWITCHES`, `keepPublicFigures` included
 * (`verdictMismatch`, the same test the re-gate uses).
 */
export async function holdSettingsChanged(payload: Payload, row: Record<string, unknown>): Promise<boolean> {
  const { effectiveSwitches, switchesApply, verdictMismatch } = await import('./publicFigures')
  if (!switchesApply(row.contentKind)) return false
  const org = relationId(row.organization)
  if (org === null) return true
  return verdictMismatch(row, await effectiveSwitches(payload, org, row)).length > 0
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * 🔴 WHICH ECOSISTEMAS THIS CALLER MAY REVIEW HOLDS IN.
 *
 * ⚠ ASKED BY PERMISSION, NOT BY RANK. `holds:review` is a property of the role,
 * and phrasing it as `minRole: 'investigador'` would bake today's rank order
 * into this call site — see the note on
 * `organizationIdsForUserWithPermission`.
 *
 * ⚠ EMPTY LIST ⇒ REFUSE, never an unconstrained query. Same rule as
 * `access/index.ts`: `{ in: [] }` is the kind of thing an ORM optimises into "no
 * constraint", and the failure mode is every tenant's holds returned to somebody
 * entitled to none.
 */
async function reviewableOrganizationIds(payload: Payload, user: unknown): Promise<Id[] | 'all'> {
  if (!isActiveUser(user)) throw new HoldNotVisibleError()
  if (isPlatformAdminUser(user)) return 'all'

  const id = (user as { id?: Id } | null)?.id
  if (id === undefined || id === null) throw new HoldNotVisibleError()

  const ids = await organizationIdsForUserWithPermission(payload, id, PERMISSIONS.holdsReview)
  if (ids.length === 0) throw new HoldNotVisibleError()
  return ids
}

/**
 * What "held" means as a query.
 *
 * ⚠ `held` ONLY. A `rejected` row is not in the queue — somebody already decided
 * — and an `approved` one is on its way into the corpus. Listing them here would
 * turn the queue into a log and invite a second decision on a settled row.
 */
const HELD: Where = { anonymisationStatus: { equals: 'held' } }

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null

type DocumentRow = {
  id: Id
  name?: unknown
  organization?: unknown
  contentKind?: unknown
  anonymisationStatus?: unknown
  anonymisationError?: unknown
  anonymisationReport?: unknown
  anonymisationSurvivors?: unknown
  heldText?: unknown
  publicFiguresKept?: unknown
  testimonioTitle?: unknown
  redactedText?: unknown
  extractedText?: unknown
  updatedAt?: unknown
}

/**
 * Split `"verify: La verificación encontró…"` back into stage and reason.
 *
 * ⚠ The column is a single string because it is also what an operator reads in
 * the admin panel. Parsing it here rather than adding a second column keeps one
 * source of truth; a mismatch between two columns would be a worse bug than a
 * stage that occasionally comes back `null`.
 */
function splitError(raw: unknown): { stage: string | null; reason: string | null } {
  const value = text(raw)
  if (value === null) return { stage: null, reason: null }
  const at = value.indexOf(': ')
  if (at === -1) return { stage: null, reason: value }
  return { stage: value.slice(0, at), reason: value.slice(at + 2) }
}

function publicFiguresOf(raw: unknown): PublicFigureLogEntry[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (e): e is PublicFigureLogEntry =>
      Boolean(e) &&
      typeof e === 'object' &&
      typeof (e as PublicFigureLogEntry).name === 'string' &&
      typeof (e as PublicFigureLogEntry).motivo === 'string',
  )
}

function survivorsOf(raw: unknown): SurvivorSpan[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (s): s is SurvivorSpan =>
      Boolean(s) &&
      typeof s === 'object' &&
      typeof (s as SurvivorSpan).start === 'number' &&
      typeof (s as SurvivorSpan).end === 'number',
  )
}

/** ⚠ The NEUTRAL title. Never `documents.name` — see {@link HeldSummary.title}. */
function neutralTitle(kind: ContentKind): string {
  if (kind === 'testimonio') return 'Testimonio retenido'
  if (kind === 'conversacion') return 'Conversación retenida'
  return 'Documento retenido'
}

function summarize(row: DocumentRow): HeldSummary {
  const { stage, reason } = splitError(row.anonymisationError)
  const kind = contentKindOf(row)
  const generated =
    kind === 'testimonio' && typeof row.testimonioTitle === 'string' && row.testimonioTitle.trim()
      ? row.testimonioTitle.trim()
      : null
  return {
    id: String(row.id),
    title: generated ?? neutralTitle(kind),
    label: neutralTitle(kind),
    generatedTitle: generated,
    contentKind: kind,
    stage,
    reason,
    survivorCount: survivorsOf(row.anonymisationSurvivors).length,
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : null,
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The review queue for ONE ecosistema.
 *
 * 🔴 THE READ IS ELEVATED, and the membership-plus-permission check above is the
 * only thing that makes that safe — same structure, and the same warning, as
 * `lib/ecosystemMetrics.ts`. Do not move the check into the route: everything
 * after it reads rows the caller's own access rules would not return.
 */
export async function listHeldDocuments(args: {
  payload: Payload
  organizationId: Id
  user: unknown
  limit?: number
}): Promise<{ ecosystem: { id: string }; holds: HeldSummary[] }> {
  const { payload, organizationId, user } = args

  const allowed = await reviewableOrganizationIds(payload, user)
  if (allowed !== 'all' && !new Set(allowed.map(String)).has(String(organizationId))) {
    // ⚠ Compared as strings: Postgres hands ids back as `7` or `'7'` depending
    // on the path, and `7 !== '7'` would refuse a legitimate reviewer.
    throw new HoldNotVisibleError()
  }

  // ⚠ `.catch` is about MALFORMED IDS, not about swallowing outages. Postgres
  // raises a cast error on `id = 'abc'`; letting that become a 500 while a
  // valid-but-unknown id 404s would make the two distinguishable.
  const found = await payload
    .find({
      collection: 'documents',
      where: { and: [{ organization: { equals: organizationId } }, HELD] },
      // ⚠ Bounded. A queue screen pages; an unbounded read of every held
      // transcript in a busy ecosistema is a memory event, not a feature.
      limit: Math.min(Math.max(args.limit ?? 50, 1), 200),
      sort: '-updatedAt',
      depth: 0,
      overrideAccess: true,
    })
    .catch(() => null)

  if (!found) throw new HoldNotVisibleError()

  return {
    ecosystem: { id: String(organizationId) },
    holds: (found.docs as unknown as DocumentRow[]).map(summarize),
  }
}

/**
 * 🔴 P-01 / 1129: a `content` hold whose model never ran (`gate.ts`, "La
 * revisión automática no pudo terminar"). No model checked its text: a row
 * from before P-01 still stores stage 2's near-raw output in `heldText`, with
 * every third-party name in it. Its text is never shown and it is never
 * approved, with or without an "edit": the only way out is to reject it.
 */
export const MODEL_NEVER_RAN = 'La revisión automática no pudo terminar'
function modelNeverRan(stage: string | null, reason: string | null): boolean {
  return stage === 'content' && typeof reason === 'string' && reason.startsWith(MODEL_NEVER_RAN)
}

/**
 * 🔴 A `verify` hold whose verification never finished (`gate.ts`, round
 * `catch`: "La segunda revisión automática no pudo terminar", transport,
 * invalid JSON, timeout). Stage 3 DID run, so `heldText` is its redacted
 * output and is shown; but no model checked it afterwards. Like a `content`
 * hold: approved only with a real edit, never as-is.
 */
const VERIFY_NEVER_FINISHED = 'La segunda revisión automática no pudo terminar'
function verifyNeverFinished(stage: string | null, reason: string | null): boolean {
  return stage === 'verify' && typeof reason === 'string' && reason.startsWith(VERIFY_NEVER_FINISHED)
}

/**
 * 🔴 A `verify` hold where the model reported a name it could not place in the
 * text (`gate.ts` `unlocatableSentence`, ola 11 item 5): nothing says where, or
 * whether, that name is still in `heldText`. Like an unfinished verify: approved
 * only with a real edit. Matched on the exact wording `gate.ts` writes (singular
 * and plural); kept in step with `apps/web/src/lib/holds.ts`.
 */
const VERIFY_UNLOCATED = /^La revisión automática señaló (?:un dato que no se pudo|\d+ datos que no se pudieron) ubicar en el texto\./
function verifyUnlocated(stage: string | null, reason: string | null): boolean {
  return stage === 'verify' && typeof reason === 'string' && VERIFY_UNLOCATED.test(reason)
}

/** True when this hold may only leave with an edited text (or a rejection). */
function mustEditToApprove(stage: string | null, reason: string | null): boolean {
  return stage === 'content' || verifyNeverFinished(stage, reason) || verifyUnlocated(stage, reason)
}

/**
 * The text as it reads: words and numbers only, case- and width-folded.
 * 🔴 "EDITED" MEANS THIS CHANGED (carril D, gap 2): a space, a line break, a
 * zero-width character, a full stop or a capital letter does not remove
 * anything that identifies a person, so it does not count as a correction.
 */
function readingOf(value: string): string {
  return (value.normalize('NFKC').replace(/\p{Cf}/gu, '').toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? []).join(' ')
}

/** True when `supplied` changes what `gateOutput` says, not only how it is spaced or punctuated. */
export function substantivelyEdited(supplied: string, gateOutput: string | null): boolean {
  return gateOutput === null || readingOf(supplied) !== readingOf(gateOutput)
}

/** One held document, with the text and the flags a reviewer acts on. */
export async function heldDocument(args: {
  payload: Payload
  documentId: Id
  user: unknown
}): Promise<HeldDetail> {
  const row = await loadHeldRow(args)
  const { stage, reason } = splitError(row.anonymisationError)
  const unchecked = modelNeverRan(stage, reason)
  return {
    ...summarize(row),
    heldText: unchecked ? null : text(row.heldText),
    survivors: unchecked ? [] : survivorsOf(row.anonymisationSurvivors),
    report: (row.anonymisationReport as GateReport | null) ?? null,
    publicFiguresKept: publicFiguresOf(row.publicFiguresKept),
  }
}

/**
 * Load a HELD row this caller may review, or throw the one indistinguishable
 * error. Shared by the read and the decision so the two cannot drift.
 */
async function loadHeldRow(args: {
  payload: Payload
  documentId: Id
  user: unknown
}): Promise<DocumentRow> {
  const { payload, documentId, user } = args

  const allowed = await reviewableOrganizationIds(payload, user)

  const found = await payload
    .find({
      collection: 'documents',
      where: { and: [{ id: { equals: documentId } }, HELD] },
      limit: 1,
      depth: 0,
      overrideAccess: true,
    })
    .catch(() => null)

  const row = (found?.docs[0] ?? null) as DocumentRow | null
  // ⚠ "Not held" is folded into "no such document" deliberately. Answering
  // differently would let anyone with the permission in ANY ecosistema probe
  // whether a given id is held elsewhere.
  if (!row) throw new HoldNotVisibleError()

  const organizationId = relationId(row.organization)
  if (organizationId === null) throw new HoldNotVisibleError()
  if (allowed !== 'all' && !new Set(allowed.map(String)).has(String(organizationId))) {
    throw new HoldNotVisibleError()
  }

  return row
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export interface ReviewOutcome {
  id: string
  decision: 'approved' | 'rejected'
  /** The audit row's id. Returned so a UI can link to what it just recorded. */
  reviewId: string
  anonymisationStatus: 'approved' | 'rejected'
}

/** Ceiling on an edited redaction. Generous — a testimony is long. */
const MAX_APPROVED_TEXT = 2_000_000

/**
 * 🔴 APPROVE OR REJECT A HOLD. THE ONLY WAY OUT OF ONE.
 *
 * ── THE ORDER OF WRITES IS THE AUDIT GUARANTEE ───────────────────────────────
 *
 * The review row is written FIRST, before the document row is touched. If the
 * second write fails, the trail has an entry for a release that did not happen —
 * confusing, and harmless. The other order fails the other way: a document
 * released into a permanent corpus with no record of who released it, which is
 * indistinguishable from the gate having been bypassed. Given ai-service has no
 * per-document delete, that is not a state worth risking to tidy up a log.
 *
 * ── EDITING THE REDACTION ────────────────────────────────────────────────────
 *
 * A reviewer MAY correct the text before approving, and this is the point of the
 * screen rather than a nicety: verify holds because something survived, and the
 * fix for "a name is still in paragraph four" is to take it out. What they send
 * becomes `redactedText` and is the ONLY thing that gets embedded.
 *
 * 🔴 THE ORIGINAL IS NEVER EMBEDDED, WHATEVER HAPPENS HERE. `extractedText` is
 * untouched — it stays in Postgres as the record of what was actually said — and
 * the ingest path reads `redactedText`. An approval with no edit releases the
 * gate's own output, not the original; there is no code path in this function
 * that can put `extractedText` on a wire.
 *
 * ⚠ AN EMPTY APPROVED TEXT IS REFUSED. Approving an empty string would ingest a
 * chunk that matches nothing and can never be found or corrected — the same
 * silent permanent hole the gate's structural stage holds on.
 */
export async function decideOnHold(args: {
  payload: Payload
  documentId: Id
  user: unknown
  decision: 'approve' | 'reject'
  /** The corrected redaction. Omitted = approve the gate's own output as-is. */
  text?: string
  /** ⚠ Free text a human types, and NOT private. See `AnonymisationReviews.note`. */
  note?: string
}): Promise<ReviewOutcome> {
  const { payload, documentId, user, decision } = args

  if (decision !== 'approve' && decision !== 'reject') {
    throw new HoldReviewInputError('`decision` must be "approve" or "reject".')
  }

  const row = await loadHeldRow({ payload, documentId, user })
  const organizationId = relationId(row.organization)
  const reviewerId = (user as { id?: Id }).id
  if (organizationId === null || reviewerId === undefined) throw new HoldNotVisibleError()

  const { stage, reason } = splitError(row.anonymisationError)

  let approvedText: string | null = null
  let textEdited = false

  if (decision === 'approve') {
    if (modelNeverRan(stage, reason)) throw new HoldContentAsIsError()
    if (await holdSettingsChanged(payload, row as unknown as Record<string, unknown>)) throw new HoldSettingsChangedError()
    const supplied = typeof args.text === 'string' ? args.text : null
    // The gate's own refused output is the default, so "approve as-is" needs no
    // client round trip of a string the server already has — and cannot be
    // turned into an upload of arbitrary text by omitting a field.
    const gateOutput = text(row.heldText)

    if (supplied !== null) {
      if (supplied.length > MAX_APPROVED_TEXT) {
        throw new HoldReviewInputError('That text is too long to be a redaction of this document.')
      }
      if (supplied.trim().length === 0) {
        throw new HoldReviewInputError(
          'An approved redaction cannot be empty — an empty chunk can never be found or corrected.',
        )
      }
      // `textEdited` on the audit row records ANY change; the gate below asks
      // for one that changes the words.
      textEdited = supplied !== gateOutput
      if (mustEditToApprove(stage, reason) && !substantivelyEdited(supplied, gateOutput)) {
        throw new HoldContentAsIsError()
      }
      approvedText = supplied
    } else {
      if (mustEditToApprove(stage, reason)) throw new HoldContentAsIsError()
      if (gateOutput === null) {
        // A `structural` hold produced no output, so there is nothing to approve
        // as-is. Refusing is right: the alternative is silently reaching for
        // `extractedText`, which is the raw original.
        throw new HoldReviewInputError(
          'This hold produced no redacted text, so there is nothing to approve. Send a corrected version, or reject it.',
        )
      }
      approvedText = gateOutput
    }
  }

  /**
   * 🔴 THE AUDIT ROW, FIRST, AND CARRYING A COPY OF THE REPORT.
   *
   * A copy, not a pointer: the document's `anonymisationReport` is overwritten
   * by the next gate run, and an audit entry that resolves to "whatever the row
   * says today" records nothing about the decision that was actually made.
   */
  const review = await payload.create({
    collection: 'anonymisation-reviews',
    data: {
      // 🔴 `row.id`, NOT `documentId`. `documentId` arrives from the URL, so an
      // HTTP caller hands us the string `'86'`; `documents` has integer ids and
      // Payload's relationship validation rejects a string outright. That made
      // EVERY real approve and reject fail with a 500 while the unit tests
      // passed, because they call this function with a number. `row.id` is the
      // id Payload itself returned for the row we just validated — the right
      // type by construction, and the right ROW by construction too.
      document: row.id,
      organization: organizationId,
      reviewer: reviewerId,
      decision: decision === 'approve' ? 'approved' : 'rejected',
      gateStage: stage,
      gateReason: reason,
      gateReport: (row.anonymisationReport as Record<string, unknown> | null) ?? null,
      textEdited,
      note: typeof args.note === 'string' ? args.note.slice(0, 1000) : null,
    } as never,
    // The collection refuses `create` to everyone (see its access): the write is
    // server-side only, from here, so the audit row and the release cannot be
    // produced separately.
    overrideAccess: true,
  })

  /**
   * ⚠ THE WRITE IS CONDITIONAL ON THE ROW STILL BEING HELD.
   *
   * Two reviewers can both pass `loadHeldRow` and then both write. The terminal
   * state is the same either way, so this is not a correctness hole — but a
   * `where` that still names `anonymisationStatus: 'held'` makes the SECOND
   * write a no-op instead of silently overwriting the first reviewer's decision
   * with a different one (approve racing reject).
   *
   * ⚠ The audit rows are NOT deduplicated, and that is the safe direction: two
   * entries for one release is confusing, one release with no entry is the thing
   * this whole file exists to prevent.
   */
  const settle = (data: Record<string, unknown>, context?: Record<string, unknown>) =>
    payload.update({
      collection: 'documents',
      where: { and: [{ id: { equals: documentId } }, HELD] },
      data: data as never,
      overrideAccess: true,
      ...(context ? { context } : {}),
    })

  if (decision === 'reject') {
    const settled = (await settle(
      {
        anonymisationStatus: 'rejected',
        // 🔴 CLEARED. A rejected row can still be carrying a `redactedText` from
        // an earlier run that cleared the gate (ready → ingest failed → retry →
        // held → rejected). Leaving it there makes "never ingested" false: the
        // publish path reads that column, and the gate does not run on it.
        redactedText: null,
        // ⚠ `heldText` is CLEARED on a rejection. Somebody decided this text
        // should not exist in a reviewable form; keeping it around for the next
        // curious reviewer would make the rejection cosmetic.
        heldText: null,
        anonymisationSurvivors: null,
        // 🔴 Made from the `heldText` this rejection discards.
        testimonioTitle: null,
        ingestError: 'anonymisation_rejected: a reviewer refused this document.',
      },
      // ⚠ Suppress the extract+ingest hook. `rejected` is terminal and the hook
      // would refuse anyway, but a re-entrant run that does nothing still costs a
      // read and muddies the logs.
      { __skipDocsExtract: true },
    )) as { docs?: unknown[] } | null

    // 🔴 THE GRAPH ROWS GO TOO. A row held on a re-gate can still carry rows an
    // earlier `ready` run built. Only when OUR write landed (see `settle`).
    if (!Array.isArray(settled?.docs) || settled.docs.length > 0) {
      await markNotGraphable(payload as never, row.id as Id, organizationId, 'rejected by a reviewer')
    }

    return {
      id: String(documentId),
      decision: 'rejected',
      reviewId: String(review.id),
      anonymisationStatus: 'rejected',
    }
  }

  /**
   * ⚠ NO `__skipDocsExtract` HERE, AND THAT IS THE MECHANISM.
   *
   * The ordinary `afterChange` hook picks this up, sees `anonymisationStatus:
   * 'approved'`, skips the gate (see `anonymiseDocumentText`'s `approvedText`)
   * and enqueues `redactedText`. The approval path and the first-upload path are
   * the same code, which is why there is no second, subtly-different ingest to
   * keep correct.
   */
  await settle({
    redactedText: approvedText,
    anonymisationStatus: 'approved',
    anonymisationError: null,
    heldText: null,
    anonymisationSurvivors: null,
    // 🔴 Made from the `heldText` this approval replaces. The ingest hook this
    // write triggers re-titles from the approved `redactedText`
    // (`collections/Documents.ts`, `scheduleTestimonioTitle`).
    testimonioTitle: null,
    ingestStatus: 'pending',
    ingestError: null,
    ingestId: null,
  })

  return {
    id: String(documentId),
    decision: 'approved',
    reviewId: String(review.id),
    anonymisationStatus: 'approved',
  }
}
