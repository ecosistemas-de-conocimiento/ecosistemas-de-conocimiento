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

type Id = number | string

// ---------------------------------------------------------------------------
// The wire shape
// ---------------------------------------------------------------------------

/**
 * One row in the review queue.
 *
 * ⚠ NO TEXT. A queue is a list of things to open, and a list endpoint that
 * carried every held transcript would put the unredacted-ish material of a whole
 * ecosistema in one response, cached by whatever sits in front of it. The text
 * arrives one document at a time, from {@link heldDocument}.
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

/** One held document, with the text and the flags a reviewer acts on. */
export async function heldDocument(args: {
  payload: Payload
  documentId: Id
  user: unknown
}): Promise<HeldDetail> {
  const row = await loadHeldRow(args)
  return {
    ...summarize(row),
    heldText: text(row.heldText),
    survivors: survivorsOf(row.anonymisationSurvivors),
    report: (row.anonymisationReport as GateReport | null) ?? null,
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
      textEdited = supplied !== gateOutput
      approvedText = supplied
    } else {
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
    await settle(
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
    )

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
