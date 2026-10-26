import type {
  Access,
  CollectionAfterChangeHook,
  CollectionAfterDeleteHook,
  CollectionBeforeDeleteHook,
  CollectionBeforeOperationHook,
  CollectionBeforeValidateHook,
  CollectionConfig,
  Endpoint,
  FieldAccess,
  Where,
} from 'payload'
import { Forbidden, ValidationError } from 'payload'

import { isPlatformAdminUser } from '../access'
import {
  ANONYMISATION_STATES,
  GATE_UNAVAILABLE_INGEST_CODE,
  anonymiseRequested,
} from '../lib/anonymiseDocument'
import {
  CONTENT_KINDS,
  chunkMetadata,
  contentKindOf,
  knownContentKind,
  titleFor,
  DEFAULT_CONTENT_KIND,
  isContentKind,
  type ContentKind,
} from '../lib/contentKind'
import { assertSessionOwnedBy, SessionNotOwnedError } from '../lib/corpus'
import {
  organizationIdsForUser,
  organizationIdsForUserWithPermission,
  PERMISSIONS,
  relationId,
  roleInOrganization,
} from '../lib/permissions'
import { anonymiseParticipantUpload, fileParticipantAudioAsTestimonio } from '../lib/autoPublish'
import {
  consumeCorpusCleanupSkip,
  planDocumentMediaCleanup,
  scheduleUploadCleanup,
} from '../lib/conversationUploads'
import {
  beginPublish,
  NotPublishableError,
  PUBLICATION_STATES,
  unpublish,
  type PublicationState,
} from '../lib/publishDocument'

/**
 * Session-scoped documents. Unifies markdown working-docs (M4) and uploaded
 * PDF/DOCX corpora (M6). Plan §D2.
 *
 * For markdown (`kind: 'markdown'`), `bodyMarkdown` holds the source text
 * and `mode` defaults to `full-text` (the chat-FE BFF inlines it as prompt
 * context when `isPinned` is true).
 *
 * For PDF/DOCX (`kind: 'pdf' | 'docx'`), the `afterChange` hook below:
 *   1. extracts text via `unpdf` / `mammoth` (inline; v1 size limit ~10MB);
 *   2. persists the result to `extractedText`;
 *   3. enqueues an ingest with ai-service via @edc/ai-client, passing
 *      a `callbackUrl` so the receiver at /api/ai-service/callback (M5)
 *      flips `ingestStatus` to `ready` / `failed` as events arrive.
 *
 * The hook is idempotent on extraction (skipped if `extractedText` already
 * set) and on enqueue (skipped if `ingestId` already set). To force a
 * re-run, clear both fields then save the doc.
 *
 * ── AUDIO (`kind: 'audio'`) ──────────────────────────────────────────────────
 *
 * 🔴 AUDIO IS NOT A SECOND PIPELINE. It is a slower way of producing
 * `extractedText` on the SAME row. Step 1 above is replaced by a round-trip to
 * `services/audio-service`; steps 2 and 3 are the identical code. The
 * `transcribe.completed` callback only persists the transcript and marks the
 * row `transcribed`; the `ingestRecovery` sweep then runs the gate and the
 * enqueue (`lib/ingestRecovery.ts:driveTranscribedDocuments`):
 *
 *   afterChange → startTranscription → audio-service → transcribe.completed
 *                                                    → extractedText, `transcribed`
 *   ingestRecovery sweep → driveTranscribedDocuments → enqueueIngestForDoc  ← same fn
 *
 * Everything the ecosistema model already does to a document — draft privacy,
 * publish (which re-embeds into the shared corpus), unpublish, retrieval
 * scoping — therefore works on a transcript for free. If you find yourself
 * writing a second function that talks to `/v1/ingest`, or naming a second
 * corpus, stop: that is the wrong turn this design exists to prevent.
 *
 * ⚠ Transcription runs at roughly REAL TIME on CPU. A one-hour recording is a
 * one-hour job. Nothing in this file may imply otherwise, and no state may be
 * left dangling with no terminal transition — see the `ingestStatus` field.
 */

/**
 * 🔴 THE VISIBILITY RULE, and the only place it is written.
 *
 *   · A DRAFT is visible to the person who uploaded it, and to nobody else.
 *     Membership in the ecosistema is NOT enough — same-ecosistema,
 *     cross-person leakage is the risk this model introduces that a purely
 *     per-tenant scheme did not have.
 *   · A PUBLISHED document is visible to every member of its ecosistema.
 *
 * ⚠ THE UPLOADER CLAUSE COMES FIRST AND IS UNCONDITIONAL, so a document
 * mid-transition (`publishing` / `unpublishing`) never disappears from the
 * person who owns it. Only `published` is shared; every other state is private.
 * That is what makes a crash between publish steps safe rather than a data-loss
 * report.
 *
 * ⚠ Returns a WHERE CONSTRAINT, never a boolean, so it reaches the query: a
 * list comes back already filtered, and asking for a document by id that you
 * may not see 404s instead of 403-ing.
 */
export const visibleToCaller: Access = async ({ req }) => {
  const user = req.user
  if (!user) return false
  if (isPlatformAdminUser(user)) return true

  const organizationIds = await organizationIdsForUser(req.payload, user.id)

  const mine: Where = { uploadedBy: { equals: user.id } }
  // ⚠ No memberships ⇒ only your own documents. NOT an empty `in: []`, which
  // an ORM may optimise away into "no constraint" — and the failure mode there
  // is every ecosistema's documents returned to someone in none.
  if (organizationIds.length === 0) return mine

  return {
    or: [
      mine,
      {
        and: [
          { publicationStatus: { equals: 'published' } },
          { organization: { in: organizationIds } },
        ],
      },
    ],
  } satisfies Where
}

/** Only the uploader edits or removes a document. */
/** Admin-panel labels. Exhaustive by type, so a new state forces a label. */
/** Admin-panel labels. Exhaustive by type, so a new content kind forces one. */
const CONTENT_KIND_LABELS: Record<ContentKind, string> = {
  documento: 'Documento — una fuente subida por su autor',
  testimonio: 'Testimonio (Voz) — palabras de otra persona, siempre anónimas',
  conversacion: 'Conversación — un turno de chat ingerido al corpus',
}

/** Admin-panel labels for the gate's states. See the field for what they mean. */
const ANONYMISATION_LABELS: Record<(typeof ANONYMISATION_STATES)[number], string> = {
  'n/a': 'N/A — not gated content',
  pending: 'Pending — the gate is running',
  held: 'HELD — refused, not ingested',
  approved: 'APPROVED — a human released a hold (audited)',
  rejected: 'REJECTED — a human refused it; never ingested',
  ready: 'Ready — cleared the gate',
}

const PUBLICATION_LABELS: Record<PublicationState, string> = {
  draft: 'Draft — only you can see it',
  publishing: 'Publishing…',
  published: 'Published — shared with the ecosistema',
  unpublishing: 'Unpublishing…',
}

/**
 * 🔴 THE GATE'S OWN COLUMNS ARE NOT WRITABLE THROUGH THE API. BY ANYONE.
 *
 * ── THE HOLE THIS CLOSES ─────────────────────────────────────────────────────
 *
 * `documents.update` is `uploaderOnly`, so the person who uploaded a testimony
 * may PATCH their own row. `admin: { readOnly: true }` on these fields is an
 * ADMIN-PANEL hint and enforces nothing over REST. So without this, the uploader
 * of a HELD Voz could send:
 *
 *     PATCH /api/documents/42
 *     { "anonymisationStatus": "approved", "redactedText": "<the raw original>" }
 *
 * …and the afterChange hook would sail past every guard — `held` no longer
 * matches, the approval branch is taken, the gate is skipped — and ingest the
 * unredacted testimony into a corpus with no per-document delete. Every other
 * control in this design (the fail-closed policy, the terminal `rejected`, the
 * audit row) would still be exactly as written, and completely bypassed.
 *
 * ⚠ NOT EVEN A PLATFORM ADMIN, THROUGH THIS COLLECTION. `false` for everybody,
 * with no role bypass. Server-side writes use `overrideAccess: true` and are
 * unaffected — that is the ONE path, and it runs through
 * `lib/anonymiseDocument.ts` and `lib/holdReview.ts`.
 *
 * ⚠ WHAT THIS DOES *NOT* CLAIM, so nobody reads a guarantee that is not here: a
 * platform admin can still hand-edit a redaction and release it, because
 * `holds:review` resolves to every ecosistema for them and `decideOnHold`
 * accepts a corrected `text`. That is a REVIEW — deliberate, and written to
 * `anonymisation-reviews` with their name on it. The property this lock provides
 * is narrower and is the one that matters: no route reaches these columns
 * WITHOUT an audit row.
 *
 * ⚠ `read` IS LEFT ALONE ON MOST OF THEM. These fields are how the uploader
 * sees why their upload is stuck, and `visibleToCaller` already decides who
 * sees the row at all. The exceptions are `heldText` and
 * `anonymisationSurvivors`, which carry what still identified someone — see
 * `mayReadGatedOriginal`.
 *
 * ⚠ ALSO LOCKS `tema` AND `lengua`, for a different reason. Those are ground
 * truth copied from the corpus manifest by `seed/corpus.ts` and
 * `seed/backfillCorpusLabels.cli.ts` (both `overrideAccess: true`), not opinions
 * somebody types — and `apps/web/src/routes/api/documents/[id]/+server.ts`
 * PATCHes the request body through UNMODIFIED, so "editable" would mean free
 * text on a column a facet groups by. On `lengua`, in a collection whose privacy
 * design is about not storing attributes of the people in it, the obvious thing
 * to type there is a name. Reversible for `tema` the day an upload form collects
 * a theme; `lengua` stays shut.
 */
const gateWritesOnly: FieldAccess = () => false

/**
 * 🔴 `lengua` IS READABLE ONLY ON A `documento`. The read-side half of the same
 * rule the write hook enforces — see `enforceLenguaDocumentoOnly`.
 *
 * ⚠ NOTE THE EXACT COMPARISON, AND THAT IT FAILS CLOSED. `=== 'documento'`, not
 * `!== 'testimonio'`, exactly as `personaAllowed` and `snippetAllowed` in
 * `lib/graph/types.ts` are written. An unknown, null or missing `contentKind`
 * therefore hides the field. The cost of being wrong that way is a blank in the
 * UI; the other way is a re-identification key.
 *
 * ── WHY THE FIELD NEEDS TWO MECHANISMS AND NOT ONE ──────────────────────────
 *
 * The hook already guarantees the column is NULL for anything that is not a
 * `documento`, so this check is redundant TODAY. It is here for the same reason
 * ADR §5.3 enforces the person rule twice: the hook is the efficient mechanism,
 * this is the one that still holds if the hook is edited wrongly, if a row is
 * written by a path that bypasses hooks (raw SQL, a future `db.execute`), or if
 * a document is reclassified after the fact.
 *
 * ⚠ COSTS NO QUERY. It reads a column already on the row being returned, unlike
 * `canReadRatingComment` in `collections/Ratings.ts`, which has to resolve a
 * permission and therefore memoizes on `req`. Nothing to memoize here.
 *
 * 🔴 A QUERY THAT SELECTS `lengua` MUST ALSO SELECT `contentKind`. Measured on
 * `payload@3.88.0`: the projection is applied BEFORE field access runs, so a
 * `select` that omits `contentKind` hands this function a row with no kind on
 * it, it fails closed, and `lengua` disappears from EVERY row — including the
 * `documento` rows that are allowed to have it.
 *
 *     select: { name: true, tema: true, lengua: true }                  → always hidden
 *     select: { name: true, tema: true, lengua: true, contentKind: true } → correct
 *
 * That is the safe direction to be wrong in, and it is still a trap: the symptom
 * is a blank column with no error anywhere. `/biblioteca` and `/admin` both
 * enumerate their fields (`LIBRARY_LIST_FIELDS`, `DOC_FIELDS` in `apps/web`), so
 * whoever adds `lengua` to either list has to add `contentKind` beside it.
 *
 * ⚠ `doc` ONLY, WITH NO FALLBACK TO `data` / `siblingData`. Measured on
 * `payload@3.88.0`: `fields/hooks/afterRead/promise.js` calls field `read`
 * access with `doc` (and `data` set to the same object) on every read, so there
 * is nothing to fall back TO. If `doc` is ever absent this fails closed, which
 * is the direction above.
 *
 * ⚠ `read` IS NOT GATED ON `tema`, deliberately. Four values, ~60 documents
 * each, no personal content — and for every seeded row the theme is already
 * spelled out in Spanish in `documents.name`. Gating it would hide a label from
 * the people the library exists for and protect nothing.
 */
export const lenguaReadable: FieldAccess = ({ doc }) =>
  (doc as { contentKind?: unknown } | undefined)?.contentKind === 'documento'

/**
 * 🔴 A PUBLISHED TESTIMONY'S ORIGINAL IS THE UPLOADER'S, NOT THE ECOSISTEMA'S.
 *
 * `visibleToCaller` shares a PUBLISHED row with every member — correct for the
 * row, wrong for three of its columns when the row is gated content:
 *
 *   · `extractedText` / `bodyMarkdown` — the UNREDACTED original. For a
 *     `testimonio` that is the very text the gate exists to keep out of shared
 *     view; what members get is `redactedText`.
 *   · `name` — free text the uploader typed, usually the filename. `titleFor`
 *     already keeps it out of the corpus for the same reason
 *     ("Testimonio de María López.mp3").
 *   · `heldText` / `anonymisationSurvivors` — the gate's refused output and the
 *     offsets of what still identified someone in it.
 *   · `audioMeta` — its detected `language` (see `enforceLenguaDocumentoOnly`).
 *   · `uploadedBy` / `session` — who recorded it and in which conversation
 *     (see {@link gatedQueryableReadable}).
 *
 * The recording itself is closed in `collections/Media.ts` by the same rule.
 *
 * Found by the 2026-10-17 audit: before this, any member of the ecosistema could
 * `GET /api/documents/:id` on a published testimonio and read the raw original.
 *
 * Readable by: a platform admin, the uploader, or anyone when the row is a
 * `documento`.
 *
 * ⚠ `=== 'documento'`, FAILING CLOSED, as `lenguaReadable` is written. An
 * unknown or missing `contentKind` hides the field from everyone but the
 * uploader and a platform admin.
 *
 * 🔴 A QUERY THAT SELECTS THESE MUST ALSO SELECT `contentKind` AND
 * `uploadedBy`. Same trap as `lenguaReadable`: the projection runs before field
 * access, so a `select` that omits them hides the field on every row.
 *
 * ⚠ NO ROW ⇒ REFUSED. Payload checks a `where` / `sort` path with no row (see
 * `endpoints/lenguas.ts`), so `where[extractedText]` is refused for every
 * non-override caller. Nothing in the product queries these columns that way;
 * the graph backfill uses `overrideAccess`. `name` is the exception — see
 * {@link gatedQueryableReadable}.
 */
export function mayReadGatedOriginal(
  user: unknown,
  doc: { contentKind?: unknown; anonymise?: unknown; uploadedBy?: unknown } | undefined,
  /**
   * `identity` is `name` / `uploadedBy` / `session`: on a `documento` filed for
   * anonymisation they stay readable (it keeps its own title, owner ruling
   * 2026-10-26). `original` is the TEXT, which such a row shares only redacted.
   */
  scope: 'original' | 'identity' = 'original',
): boolean {
  if (!user) return false
  if (isPlatformAdminUser(user)) return true
  if (!doc) return false
  // 🔴 `=== false`, FAILING CLOSED on an absent `anonymise`. `forceSelect` does
  // NOT cover an exclude-mode select on `payload@3.88.0`: `?select[anonymise]=false`
  // hands this a row without the column, and `!anonymiseRequested(undefined)`
  // opened the raw original of a gated documento to every member (2026-10-26
  // audit; `Documents.selectProjection.pg.test.ts`). NULL is gated too, as in
  // `mediaVisibleToCaller`.
  if (doc.contentKind === 'documento' && (scope === 'identity' || doc.anonymise === false)) {
    return true
  }
  const callerId = (user as { id?: unknown }).id
  const uploader = relationId(doc.uploadedBy)
  return uploader !== null && callerId != null && String(uploader) === String(callerId)
}

export const gatedOriginalReadable: FieldAccess = ({ req, doc }) =>
  mayReadGatedOriginal(req.user, doc as Parameters<typeof mayReadGatedOriginal>[1])

/**
 * 🔴 `testimonioTitle` ON A ROW THE GATE HAS NOT CLEARED IS MADE FROM `heldText`
 * (owner ruling 2026-10-24: Revisión lists titles), so it follows `heldText`'s
 * rule there: uploader / platform admin only. Reviewers read it through
 * `lib/holdReview.ts` (overrideAccess). On a `ready`/`approved` row it is made
 * from `redactedText` and readable like it.
 *
 * ⚠ FAILS CLOSED on a missing status: a `select` that names `testimonioTitle`
 * must name `anonymisationStatus` too, or the title vanishes for colleagues.
 */
export function mayReadTestimonioTitle(
  user: unknown,
  doc: { contentKind?: unknown; uploadedBy?: unknown; anonymisationStatus?: unknown } | undefined,
): boolean {
  if (doc && (doc.anonymisationStatus === 'ready' || doc.anonymisationStatus === 'approved')) return true
  return mayReadGatedOriginal(user, doc)
}

const testimonioTitleReadable: FieldAccess = ({ req, doc }) =>
  mayReadTestimonioTitle(req.user, doc as Parameters<typeof mayReadTestimonioTitle>[1])

/**
 * The fields in {@link GATED_QUERYABLE_FIELDS} follow {@link mayReadGatedOriginal}
 * on every ROW, but let a `where` or `sort` on them through, because the
 * product queries them:
 *
 *   · `name` — `/biblioteca` and the `@`-mention picker search by title;
 *   · `uploadedBy` — "Mis documentos" and the session picker filter on
 *     `uploadedBy = me`, and `visibleToCaller` itself is that clause;
 *   · `session` — every conversation lists its documents by `session`;
 *   · `uploadedInSession` — the conversation cascade reads it (with
 *     `overrideAccess`). Nothing in the product queries it through the API,
 *     but it names the same conversation `session` does.
 *
 * 🔴 `uploadedBy` AND `session` ARE WHO RECORDED A TESTIMONIO. The first names
 * the investigador, the second links their conversation. A colleague who reads
 * either on a published testimonio learns who was in the room, which is what
 * the biblioteca hides on purpose (`contributorIdsToResolve` in the web app).
 *
 * ⚠ LETTING THE QUERY THROUGH WOULD BE AN ORACLE ON ITS OWN: search
 * `where[name][like]=María` — or `where[uploadedBy][equals]=<colleague>` — and
 * see whether a testimonio row comes back. {@link constrainGatedQueries} closes
 * that by narrowing any query that names one of these fields to rows on which
 * the caller may read it.
 */
export const GATED_QUERYABLE_FIELDS = ['name', 'uploadedBy', 'session', 'uploadedInSession'] as const

export const gatedQueryableReadable: FieldAccess = ({ req, doc }) =>
  doc === undefined
    ? Boolean(req.user)
    : mayReadGatedOriginal(req.user, doc as Parameters<typeof mayReadGatedOriginal>[1], 'identity')

/**
 * Does a Payload `where` mention this field anywhere, at any depth?
 *
 * 🔴 IT WALKS EVERY NESTED OBJECT, NOT ONLY `and` / `or`. Payload matches the
 * combinators case-insensitively (`OR`, `And` work), so a check that looked for
 * the lowercase keys alone let `where[OR][0][name][like]=Mar` straight past the
 * narrowing — and `/api/documents/count` then leaked a hidden filename prefix by
 * prefix. Over-matching only narrows a query; under-matching leaks.
 */
export function whereMentions(where: unknown, field: string): boolean {
  if (!where || typeof where !== 'object') return false
  if (Array.isArray(where)) return where.some((w) => whereMentions(w, field))
  for (const [key, value] of Object.entries(where as Record<string, unknown>)) {
    if (key === field || key.startsWith(`${field}.`)) return true
    if (whereMentions(value, field)) return true
  }
  return false
}

/** The parts of a Payload `sort` (`'a,-b'` or `['a', '-b']`). */
function sortParts(sort: unknown): string[] {
  if (typeof sort === 'string') return sort.split(',').map((s) => s.trim()).filter(Boolean)
  if (Array.isArray(sort)) return sort.filter((s): s is string => typeof s === 'string')
  return []
}

const sortsOn = (part: string, field: string): boolean => {
  const path = part.replace(/^[-+]/, '')
  return path === field || path.startsWith(`${field}.`)
}

/** The same sort with every part on `field` removed; `undefined` when nothing is left. */
function stripSort(sort: unknown, field: string): unknown {
  const kept = sortParts(sort).filter((p) => !sortsOn(p, field))
  if (kept.length === 0) return undefined
  return Array.isArray(sort) ? kept : kept.join(',')
}

/**
 * Is `where` already limited to rows whose gated fields the caller may read? True when
 * a top-level clause (through any `and`) pins the uploader to the caller or the
 * kind to `documento`.
 */
function narrowedToReadable(where: unknown, prefix: string, userId: unknown): boolean {
  if (!where || typeof where !== 'object' || Array.isArray(where)) return false
  for (const [key, value] of Object.entries(where as Record<string, unknown>)) {
    if (key.toLowerCase() === 'and' && Array.isArray(value)) {
      if (value.some((w) => narrowedToReadable(w, prefix, userId))) return true
      continue
    }
    const equals = (value as { equals?: unknown } | null)?.equals
    if (key === `${prefix}contentKind` && equals === 'documento') return true
    if (key === `${prefix}uploadedBy` && equals != null && String(equals) === String(userId)) {
      return true
    }
  }
  return false
}

/**
 * 🔴 A QUERY ON A GATED FIELD ONLY MATCHES ROWS ON WHICH THE CALLER MAY READ
 * IT. The other half of {@link gatedQueryableReadable}; the fields are
 * {@link GATED_QUERYABLE_FIELDS}.
 *
 *   · a `where` naming one is narrowed to readable rows;
 *   · a `sort` on one is STRIPPED unless the query is already narrowed. Sorting
 *     is a full oracle, not a small leak: a colleague who controls a few probe
 *     rows named "M", "Ma", "Mb"… reads where the hidden title falls between
 *     them and binary-searches it out letter by letter. The same works on
 *     `uploadedBy` with probe rows of known uploaders. Nothing in the product
 *     sorts documents by any of these.
 *
 * ⚠ `where[uploadedBy][equals]=<me>` IS ALREADY NARROWED, so "Mis documentos"
 * passes through untouched. A `session` filter on the caller's own
 * conversation is narrowed but loses nothing: only the uploader can attach a
 * document to a session (`uploaderOnly`, `bindDocumentToEcosystem`).
 *
 * `prefix` is the relationship path from another collection (`'document.'` on
 * `anonymisation-reviews`), whose where/sort reach the same column.
 */
export function constrainGatedQueriesAt(prefix: string): CollectionBeforeOperationHook {
  const fields = GATED_QUERYABLE_FIELDS.map((f) => `${prefix}${f}`)
  return ({ args, operation, req }) => {
    if (operation !== 'read' && operation !== 'count' && operation !== 'readDistinct') return args
    const a = args as { overrideAccess?: boolean; where?: Where; sort?: unknown }
    // REST leaves it undefined (= access applies); the local API defaults it to true.
    if (a.overrideAccess === true) return args
    const user = req.user
    if (!user || isPlatformAdminUser(user)) return args

    let next = args as typeof args & { where?: Where; sort?: unknown }
    let narrowed = narrowedToReadable(a.where, prefix, user.id)
    if (!narrowed && fields.some((field) => whereMentions(a.where, field))) {
      const readable: Where = {
        or: [
          { [`${prefix}contentKind`]: { equals: 'documento' } },
          { [`${prefix}uploadedBy`]: { equals: user.id } },
        ],
      }
      next = { ...next, where: { and: [a.where as Where, readable] } }
      narrowed = true
    }
    if (!narrowed) {
      let sort = a.sort
      for (const field of fields) {
        if (sortParts(sort).some((p) => sortsOn(p, field))) sort = stripSort(sort, field)
      }
      if (sort !== a.sort) next = { ...next, sort }
    }
    return next as typeof args
  }
}

export const constrainGatedQueries: CollectionBeforeOperationHook =
  constrainGatedQueriesAt('')

const uploaderOnly: Access = ({ req: { user } }) => {
  if (!user) return false
  if (isPlatformAdminUser(user)) return true
  return { uploadedBy: { equals: user.id } } satisfies Where
}

/**
 * 🔴 THE UPLOAD GATE. Bind a new document to an ecosistema and an uploader,
 * both derived server-side, and refuse anything the caller may not touch.
 *
 * ⚠ THIS CLOSES A REAL CROSS-TENANT WRITE. `create` access on this collection
 * is "any signed-in user", because Payload's create-time access check has no
 * document to constrain against and cannot express "…and this session is
 * yours". Without this hook, ANY authenticated user could POST a document
 * naming SOMEONE ELSE'S session id — and the ingest hook would then derive a
 * corpus from that row.
 *
 * Note what kind of hole that is: they could not READ it back
 * (`visibleToCaller` covers reads), so it was not disclosure. It was
 * INJECTION, which in a knowledgebase is worse — the victim's assistant answers
 * from a document the attacker chose and cites it as the victim's own source.
 *
 * ⚠ `update` is checked too. Re-pointing an existing document at another
 * session or another ecosistema is the same attack in two steps.
 *
 * ⚠ Writes with `overrideAccess: true` and no user — the seed, the ingest
 * hook's own status updates, the publish state machine — pass through
 * untouched. They are server-side by definition and have no session to
 * impersonate.
 */
export const bindDocumentToEcosystem: CollectionBeforeValidateHook = async ({
  data,
  operation,
  originalDoc,
  req,
}) => {
  const next = { ...(data ?? {}) } as Record<string, unknown>
  const user = req.user
  if (!user) return next

  const original = (originalDoc ?? {}) as Record<string, unknown>

  if (operation === 'create') {
    // ⚠ Always the caller. A client-supplied `uploadedBy` would let one person
    // file a draft as another — and drafts are private PER PERSON, so that is
    // both an impersonation and a way to plant a document in someone's private
    // corpus.
    next.uploadedBy = user.id
    // Everything starts private. Sharing is a deliberate, separate act.
    next.publicationStatus = 'draft'
    // Never the body's. Set below from the one conversation the upload names.
    next.uploadedInSession = null
  } else {
    // ⚠ Immutable after creation. Both are corpus-name inputs: letting either
    // change would leave the embedded copy in one corpus while the row claims
    // another, and the mismatch is invisible until search stops working.
    next.uploadedBy = original.uploadedBy
    // Where it was uploaded is a fact of its creation, never re-pointed.
    next.uploadedInSession = original.uploadedInSession ?? null
    // `publicationStatus` moves ONLY through `lib/publishDocument.ts`, which
    // writes with `overrideAccess: true` and therefore never reaches this
    // branch. A client PATCHing it directly would mark a document shared
    // without any of its content being in the shared corpus.
    //
    // 🔴 PIN IT TO THE STORED VALUE — DO NOT `delete` IT. Payload merges the
    // incoming body over the stored row BEFORE `beforeValidate` runs, so `data`
    // already carries the row's own `publicationStatus`. Deleting the key does
    // not "ignore the client's value", it removes the field from the document
    // being validated — and `publicationStatus` is `required: true`. The result
    // was that EVERY authenticated PATCH on a document, including a plain
    // rename, failed with `400 The following field is invalid: Publication
    // Status`. Found by `e2e/documents.e2e.ts`.
    //
    // ⚠ Same shape as `uploadedBy` above, and for the same reason: an immutable
    // field is held at its stored value, not erased. The `else` branch keeps a
    // client-supplied value from surviving in the (Payload-internal) case where
    // no original row was handed to the hook.
    if (typeof original.publicationStatus === 'string') {
      next.publicationStatus = original.publicationStatus
    } else {
      delete next.publicationStatus
    }
  }

  const sessionError = (message: string): ValidationError =>
    new ValidationError({
      collection: 'documents',
      errors: [{ path: 'session', message }],
      req,
    })

  // On update Payload sends only what changed, so fall back to the stored row.
  //
  // ⚠ `session` IS PLURAL NOW, and the wire shape is not: Payload hands this
  // hook a scalar id, an array, populated objects, or nulls, depending on
  // whether the write came from the REST API, the admin panel or a
  // `payload.update` call. Normalise before deciding anything.
  const sessionIds = resolveIdList(next.session ?? original.session)

  if (sessionIds.length > 0) {
    // ⚠ EVERY id is checked. A single unowned session anywhere in the list is
    // the same injection this hook exists to stop — see the header. Checking
    // only the first, or only the ones that are new, would leave the hole open
    // for the price of one extra array element.
    let organizationId: string | number | null = null
    let sawOne = false

    for (const sessionId of sessionIds) {
      let resolved: string | number | null
      try {
        ;({ organizationId: resolved } = await assertSessionOwnedBy(
          req.payload,
          sessionId,
          user.id,
        ))
      } catch (err) {
        if (err instanceof SessionNotOwnedError) throw sessionError(err.message)
        throw err
      }

      // 🔴 ONE DOCUMENT, ONE ECOSISTEMA. `organization` is half of every corpus
      // name this document touches, so a document attached to conversations in
      // two ecosistemas has no single correct answer — and whichever one we
      // picked, the other ecosistema's members would be chatting against a
      // document filed under someone else's tenant.
      if (!sawOne) {
        organizationId = resolved
        sawOne = true
      } else if (String(organizationId ?? '') !== String(resolved ?? '')) {
        throw sessionError(
          'These conversations belong to different ecosistemas, so one document cannot be attached to both.',
        )
      }
    }

    next.session = sessionIds

    if (operation === 'create') {
      // ⚠ The ORIGIN, derived like `uploadedBy`: the one conversation the
      // upload names, already checked as the caller's above. A create naming
      // several has no single origin and records none.
      next.uploadedInSession = sessionIds.length === 1 ? sessionIds[0] : null
      // ⚠ The ecosistema is DERIVED, never accepted from the body. A
      // client-supplied `organization` would let a document be filed under a
      // tenant it does not belong to — and then published into that tenant's
      // shared corpus.
      if (organizationId != null) {
        next.organization = organizationId
      } else {
        // A conversation with no ecosistema derives nothing. Drop whatever the
        // body sent rather than letting it stand in: `organization` is
        // `required: true`, so this fails the write with a readable error
        // instead of filing the document under a tenant the caller chose.
        delete next.organization
      }
    } else {
      // 🔴 THE TWO-STEP ATTACK, CLOSED. `organization` is immutable, so
      // attaching a conversation from ANOTHER ecosistema to an existing
      // document must be refused outright — silently pinning the old value
      // would leave the row attached to a conversation whose members are not in
      // its ecosistema, and the frontend would then retrieve across the
      // boundary.
      //
      // A conversation with no ecosistema (`resolved === null`) carries no
      // tenant to disagree with, and `organization` is pinned below regardless,
      // so it cannot smuggle anything.
      const storedOrganizationId = resolveId(original.organization)
      if (
        organizationId != null &&
        storedOrganizationId != null &&
        String(organizationId) !== String(storedOrganizationId)
      ) {
        throw sessionError(
          'That conversation belongs to a different ecosistema than this document.',
        )
      }
      next.organization = original.organization
    }
  } else if (operation === 'create') {
    // No session — an upload straight into the ecosistema, with no conversation
    // attached (Mis documentos).
    const organizationIds = await organizationIdsForUser(req.payload, user.id)
    // 🔴 A NAMED ECOSISTEMA IS A REQUEST, CHECKED AGAINST MEMBERSHIP. The web
    // app sends the one selected in its switcher, so a person in several
    // ecosistemas can upload without a conversation. A tenant the caller is
    // not a member of is refused (403), never silently replaced: filing the
    // document somewhere else than asked is the bug this branch guards against.
    const requested = resolveId(next.organization)
    if (requested != null) {
      if (!organizationIds.some((id) => String(id) === String(requested))) {
        throw new Forbidden(req.t)
      }
      next.organization = organizationIds.find((id) => String(id) === String(requested))
    } else if (organizationIds.length === 1) {
      next.organization = organizationIds[0]
    } else {
      throw new ValidationError({
        collection: 'documents',
        errors: [
          {
            path: 'organization',
            message:
              organizationIds.length === 0
                ? 'You do not belong to an ecosistema yet, so there is nowhere to put this document.'
                : 'You belong to several ecosistemas — attach this upload to a conversation so it is clear which one it is for.',
          },
        ],
        req,
      })
    }
  } else {
    // Update with no session on either side: keep the stored ecosistema, and
    // never let the body redefine it.
    next.organization = original.organization
  }

  // Needs neither the ecosistema nor the contentKind — only the STORED
  // publication status — so it runs before the two that do.
  enforceDraftOnlyTextEdits({ next, original, operation, req })
  if (operation !== 'create') Object.assign(next, gateResetForTextEdit(next, original) ?? {})

  // ⚠ LAST, because it needs the ecosistema this hook just derived. A permission
  // is held IN an organization, so the check is meaningless before we know which
  // one the row belongs to.
  await enforceVocesUploadRights({ next, original, operation, req })

  return next
}

/**
 * 🔴 NEW TEXT ON A GATED ROW RE-RUNS THE GATE. Audit 2026-10-17.
 *
 * The transcript editor (`apps/web/.../documents/[id]/transcript`) writes a
 * corrected `extractedText` and re-queues the ingest. On an APPROVED testimonio
 * `enqueueIngestForDoc` then passes the stored `redactedText` as `approvedText`
 * — the text a reviewer cleared for the OLD transcript — and ingests that, so
 * the correction never reached the corpus. Worse, the approval stood for words
 * nobody reviewed. On a `ready` row a gate run that then HOLDS would leave last
 * time's `redactedText` behind for `corpusTextFor`, the bug `planIngestRetry`
 * documents.
 *
 * So a changed text clears the gate state exactly the way `planIngestRetry`
 * does, and the next ingest gates the new text from scratch.
 *
 * ⚠ `rejected` IS LEFT ALONE. A reviewer's "no" is terminal; editing the text
 * is not a way round it (`enqueueIngestForDoc` refuses a rejected row).
 *
 * ⚠ USER WRITES ONLY. It runs inside `bindDocumentToEcosystem`, which returns
 * early for server-side writes — the extractor and the transcription callback
 * write `extractedText` themselves and must not reset the gate they feed.
 *
 * Returns the fields to merge into `next`, or null when nothing changes.
 */
export function gateResetForTextEdit(
  next: Record<string, unknown>,
  original: Record<string, unknown>,
): Record<string, unknown> | null {
  // `contentKind` is immutable after create; the stored value is the truth.
  const kind = original.contentKind ?? next.contentKind
  // `anonymise` is immutable after create too (`enforceVocesUploadRights`).
  if (kind === 'documento' && !anonymiseRequested(original.anonymise ?? next.anonymise)) return null
  if (!('extractedText' in next)) return null
  const asText = (v: unknown): string => (typeof v === 'string' ? v : '')
  if (asText(next.extractedText) === asText(original.extractedText)) return null
  const status = original.anonymisationStatus
  if (status !== 'approved' && status !== 'ready' && status !== 'held') return null
  return {
    anonymisationStatus: 'n/a',
    anonymisationError: null,
    anonymisationReport: null,
    redactedText: null,
    heldText: null,
    anonymisationSurvivors: null,
  }
}

/**
 * 🔴 ONLY A DRAFT'S TEXT MAY BE REWRITTEN. The authoritative copy of that rule.
 *
 * A reviewer may correct a machine transcript — audio comes back from Whisper
 * with names and numbers mangled — but only while the document is still a
 * draft, i.e. still private to its uploader. The moment it is published, its
 * text also exists as EMBEDDED CHUNKS in the ecosistema's shared corpus, and
 * `extractedText` is no longer the only copy. Rewriting the column then does
 * not correct anything: it desyncs the row from the chunks that retrieval
 * actually reads, so the assistant keeps quoting the old text while the
 * document page shows the new one, and the citation looks like a fabrication.
 *
 * ⚠ WHERE THIS RULE ALSO LIVES, AND WHICH ONE IS AUTHORITATIVE. The SvelteKit
 * BFF checks the same thing in
 * `apps/web/src/routes/api/documents/[id]/transcript/+server.ts` and returns a
 * 409 `already_published`, which is a far better error than a validation
 * failure. That check STAYS — defence in depth, and it is the one users see.
 * THIS ONE IS AUTHORITATIVE: the BFF is one caller of the REST API, not a wall
 * around it, and nothing stopped a direct `PATCH /api/documents/:id` before.
 *
 * ⚠ THE STORED STATUS, NEVER THE INCOMING ONE. Payload merges the request body
 * over the stored row BEFORE `beforeValidate` runs, so `next.publicationStatus`
 * can be whatever the caller typed. Reading it would make the gate
 * self-defeating: one PATCH carrying `{ publicationStatus: 'draft',
 * extractedText: '…' }` would walk straight through. (The caller's value is
 * pinned back to the stored one earlier in this hook — but that happens for
 * `publicationStatus` specifically, and depending on the order of two edits in
 * one file is not a guarantee. `original` is.)
 *
 * ⚠ NOT `'extractedText' in next` EITHER, for the same merge reason: the key is
 * present on EVERY authenticated PATCH, including a plain rename, carrying the
 * row's own text. Only a CHANGE of value counts as an edit.
 *
 * ⚠ EVERY SERVER-SIDE WRITER IS UNAFFECTED, because they all reach Payload with
 * `overrideAccess: true` and no user, and the enclosing hook returns early on
 * `!req.user`. Checked one by one: `runExtractAndIngest` (this file, the PDF /
 * DOCX extraction write), the `transcribe.completed` callback
 * (`app/api/ai-service/callback/route.ts`, which writes the transcript on rows
 * in any state), `lib/holdReview.ts` (which settles a held row and never writes
 * this column at all), `lib/anonymiseDocument.ts` and `lib/publishDocument.ts`
 * (both write `redactedText` / status, never `extractedText`) and
 * `lib/transcriptionJanitor.ts` (documented as never touching it). A rule that
 * stops the ingest pipeline would be worse than the gap it closes.
 *
 * ⚠ PLATFORM ADMINS ARE NOT EXEMPT, deliberately. The invariant is about the
 * row and its chunks agreeing, not about authority — an admin editing a
 * published document's text desyncs the corpus exactly as much as anyone else
 * would. Unpublish, edit, publish again is the supported route, and it re-embeds.
 */
function enforceDraftOnlyTextEdits(args: {
  next: Record<string, unknown>
  original: Record<string, unknown>
  operation: string
  req: Parameters<CollectionBeforeValidateHook>[0]['req']
}): void {
  const { next, original, operation, req } = args
  // A new row is created as `draft` unconditionally (see the branch above), so
  // there is no published text to protect yet.
  if (operation === 'create') return

  // A partial write that never names the column is not a text edit. ⚠ This is
  // NOT the check that decides anything on the REST path — Payload's merge puts
  // the key on every body — it is only so a hand-built `payload.update` that
  // omits the field is not read as clearing it.
  if (!('extractedText' in next)) return

  // ⚠ Compared as TEXT, and non-strings never compare equal to the stored
  // value. An HTTP caller can put a number, an array or an object in this field;
  // treating "unreadable" as "unchanged" would be the fail-open reading.
  const asText = (v: unknown): string | null =>
    typeof v === 'string' ? v : v === null || v === undefined ? '' : null
  const incoming = asText(next.extractedText)
  const stored = asText(original.extractedText)
  if (incoming !== null && incoming === stored) return

  const storedStatus = original.publicationStatus
  if (storedStatus === 'draft') return

  /**
   * 🔴 FAILS CLOSED WHEN THE STORED STATUS IS UNREADABLE. Reaching here with no
   * `originalDoc` means we cannot tell whether this document is shared, and
   * "we do not know" resolves to "no" for a WRITE gate — the opposite direction
   * from the badge in `apps/web/src/lib/publication.ts`, which fails toward the
   * private-looking READ. Refusing costs the uploader one retry; allowing costs
   * a shared corpus that disagrees with its own rows.
   */
  throw new ValidationError({
    collection: 'documents',
    errors: [
      {
        path: 'extractedText',
        message:
          'Solo puede corregirse el texto de un documento en borrador. Este ya no lo es: quítalo del corpus compartido de tu ecosistema, corrígelo y vuelve a publicarlo.',
      },
    ],
    req,
  })
}

/**
 * 🔴 `lengua` IS NULL ON ANYTHING THAT IS NOT A `documento`. NO EXCEPTIONS,
 * INCLUDING FOR SERVER-SIDE WRITERS.
 *
 * ── WHY THIS IS A PRIVACY RULE AND NOT A DATA-QUALITY ONE ────────────────────
 *
 * In the corpus this field exists to record, `lengua` is an attribute of the
 * PERSON a document is about — it sits in `MANIFEST.csv` in the same row as
 * `nombre`, `edad`, `rol`, `origen` and `residencia`, and `seed/corpusSource.ts`
 * refuses to even read those five. It is not the language the document is
 * written in; every document in that corpus is in Spanish.
 *
 * For a `documento` that costs nothing: the material is filed by its own author
 * under their own name, and the text says which language they speak. Recording
 * it in a column adds no fact the document does not already state openly.
 *
 * 🔴 FOR A `testimonio` IT IS A RE-IDENTIFICATION KEY, and a strong one. Counted
 * over the seeded corpus: of the 34 `(tema, lengua)` cells the 59 testimonios
 * fall into, **18 contain exactly one testimonio**. So a filter on two labels
 * would point at ONE anonymous voice more often than not. That is precisely the
 * scenario `plan/adr-corpus-graph.md` §7.3 answers for the graph with
 * `GRAPH_MIN_SUPPORT` — and a plain column on `documents` has no such threshold,
 * because a `where` clause is not a support count.
 *
 * The design already refuses every other handle back to that person: there is no
 * `subject` column (`contentKind`'s own header), the citation title is replaced
 * (`titleFor`), no snippet is stored (`snippetAllowed`), no person node is
 * extracted (`personaAllowed`), and `seed/corpus.ts` deliberately keeps the
 * corpus's `SIM_xxxx` id OFF a testimonio's title because that id is a join key
 * into the manifest's `nombre` column. `lengua` would be the first attribute of
 * the speaker ever stored on the row, and the most identifying available.
 *
 * ── WHY IT IS ITS OWN HOOK ───────────────────────────────────────────────────
 *
 * 🔴 IT IS NOT FOLDED INTO `bindDocumentToEcosystem`, WHICH RETURNS EARLY ON
 * `!req.user`. Every server-side write — the seed, the backfill, the callbacks,
 * the janitors — reaches Payload with `overrideAccess: true` and no user, so a
 * rule living in that hook would be skipped by exactly the writers that populate
 * this column. Same reasoning, and the same wording, as
 * `invalidateGraphOnContentKindChange` in the `afterChange` list: a privacy rule
 * must not be skippable by an internal write path.
 *
 * ⚠ IT READS THE RAW COLUMN, NOT `contentKindOf()`. `contentKindOf` defaults an
 * unreadable value to `documento`, which is the right default for the ingest
 * path and the WRONG one here — it would open the field on a row whose kind we
 * cannot read. `=== 'documento'` fails closed, matching `personaAllowed`.
 *
 * ⚠ ON UPDATE, THE STORED KIND WINS. Payload merges the request body over the
 * stored row before `beforeValidate`, so `data.contentKind` can be whatever a
 * caller typed. `contentKind` is immutable anyway (`enforceVocesUploadRights`),
 * but depending on the order of two hooks in one file is not a guarantee —
 * `originalDoc` is.
 *
 * ⚠ ONE CONSEQUENCE OF FAILING CLOSED, STATED SO IT IS NOT DEBUGGED TWICE. A
 * server-side CREATE that sets `lengua` but omits `contentKind` — relying on the
 * field's `defaultValue: 'documento'`, which Payload applies AFTER this hook —
 * loses the language. The row is a `documento` and could have kept it. That is
 * the correct direction (a missing label costs a blank; the other direction
 * stores a re-identification key on a row whose kind we could not read), and no
 * caller hits it today: `seed/corpus.ts` names the kind on every create, and the
 * backfill only ever updates. Name `contentKind` explicitly and it works.
 */
export const enforceLenguaDocumentoOnly: CollectionBeforeValidateHook = ({
  data,
  operation,
  originalDoc,
}) => {
  const next = { ...(data ?? {}) } as Record<string, unknown>
  // A partial write that never names the column cannot set it, and blanking it
  // here would clear a correctly-stored value on every unrelated PATCH.
  if (!('lengua' in next)) return next

  const original = (originalDoc ?? {}) as Record<string, unknown>
  const kind = operation === 'create' ? next.contentKind : (original.contentKind ?? next.contentKind)
  if (kind === 'documento') return next

  next.lengua = null
  return next
}

/**
 * 🔴 WHO MAY FILE SOMEBODY ELSE'S WORDS.
 *
 * A `testimonio` — a Voz — is not the uploader's own material. It is a person's
 * testimony, collected offline by an Investigador and filed under the
 * Investigador's `uploadedBy`. Every one of them goes through the anonymisation
 * gate and lands in the ecosistema's shared corpus as an anonymous voice.
 *
 * That is a different act from uploading a PDF you own, so it needs its own
 * permission (`voces:upload`, held by Investigador and up) rather than riding on
 * `documents:write`. A participant who set `contentKind: 'testimonio'` in a
 * request body would otherwise be publishing an unattributable document into the
 * shared corpus of their ecosistema.
 *
 * ⚠ `contentKind` IS IMMUTABLE AFTER CREATION, and that is the other half of the
 * rule. Without it the check is a formality: create a `documento`, then PATCH it
 * to `testimonio` and the gate has already been skipped, because the gate runs
 * on the ingest that already happened. Worse, the ingested chunk would keep
 * saying `kind: 'documento'` while the row claimed otherwise — and the chunk is
 * the copy retrieval actually reads.
 *
 * ⚠ `conversacion` is NEVER accepted from a request body at all. Conversation
 * chunks are produced by `lib/conversationIngest.ts` from `messages` rows; a
 * `documents` row claiming to be one would be a hand-written chunk wearing the
 * "this came from a previous answer" label that citations trust.
 */
async function enforceVocesUploadRights(args: {
  next: Record<string, unknown>
  original: Record<string, unknown>
  operation: string
  req: Parameters<CollectionBeforeValidateHook>[0]['req']
}): Promise<void> {
  const { next, original, operation, req } = args
  const user = req.user
  if (!user) return

  const refuse = (message: string): never => {
    throw new ValidationError({
      collection: 'documents',
      errors: [{ path: 'contentKind', message }],
      req,
    })
  }

  if (operation !== 'create') {
    // 🔴 `anonymise` is fixed at upload: un-setting it on a held row would let
    // the next publish send the raw original.
    if (typeof original.anonymise === 'boolean') next.anonymise = original.anonymise
    else delete next.anonymise
    // Pinned to the stored value, not deleted — `contentKind` is `required`, and
    // deleting the key fails validation on every PATCH. Same shape and same
    // reason as `publicationStatus` above.
    if (isContentKind(original.contentKind)) {
      next.contentKind = original.contentKind
      return
    }
    /**
     * ⚠ NO STORED VALUE TO PIN TO. Payload merges the incoming body over the
     * stored row BEFORE `beforeValidate`, so on a real update `next` already
     * carries the row's own `contentKind` even when no `originalDoc` was handed
     * to the hook. Falling back to it keeps ordinary edits working.
     *
     * 🔴 WHAT IT MUST NOT DO IS FALL BACK TO `documento`. That was the previous
     * behaviour and it is fail-OPEN in the worst place in the design: a
     * testimony silently reclassified as an ungated document makes
     * `corpusTextFor` select `extractedText` instead of `redactedText`, and the
     * next publish promotes the unredacted original into the shared corpus.
     * With neither a stored value nor a usable merged one, we do not know what
     * this row is — and "we do not know" resolves to "not yet", like every other
     * uncertainty here.
     */
    if (isContentKind(next.contentKind)) return
    // Neither side holds a readable kind. Write NOTHING and let the column keep
    // whatever it has: this hook's job is to stop a client CHANGING the value,
    // not to invent one. `contentKind` is a NOT NULL enum, so the database is
    // the backstop, and the ingest and publish paths read the kind off the
    // stored row rather than from anything decided here.
    delete next.contentKind
    return
  }

  const declared = isContentKind(next.contentKind) ? next.contentKind : DEFAULT_CONTENT_KIND
  next.contentKind = declared
  // Anyone may ASK for the gate (the safe direction); only `true` counts.
  next.anonymise = next.anonymise === true || next.anonymise === 'true'

  /**
   * 🔴 A PARTICIPANT'S DOCUMENTO GOES THROUGH THE GATE (owner ruling
   * 2026-10-26). It auto-publishes (`lib/autoPublish.ts`), so it is gated like
   * a testimonio but stays a `documento`.
   *
   * 🔴 WHATEVER `kind` IT DECLARES. `kind` is the client's word, not the file's:
   * keyed on `pdf`/`docx` (until the 2026-10-26 audit), a PDF sent as
   * `kind: 'markdown'` skipped the gate. Audio is excluded only because the
   * branch below files it as a `testimonio`, which is gated anyway.
   */
  if (declared === 'documento' && !next.anonymise && next.kind !== 'audio') {
    const organizationId = relationId(next.organization)
    const role =
      organizationId === null ? null : await roleInOrganization(req.payload, user.id, organizationId)
    if (anonymiseParticipantUpload({ role, platformAdmin: isPlatformAdminUser(user) })) next.anonymise = true
  }

  /**
   * 🔴 A PARTICIPANT'S AUDIO GOES THROUGH THE GATE (owner rule, 2026-10-24).
   * Their uploads are published by the system (`lib/autoPublish.ts`), and a
   * `documento` skips the gate, so their recordings are filed as `testimonio`.
   * The system decides this, so the Voz permission below does not apply.
   */
  if (declared === 'documento' && next.kind === 'audio') {
    const organizationId = relationId(next.organization)
    const role =
      organizationId === null ? null : await roleInOrganization(req.payload, user.id, organizationId)
    if (fileParticipantAudioAsTestimonio({ declared, kind: next.kind, role, platformAdmin: isPlatformAdminUser(user) })) {
      next.contentKind = 'testimonio'
      return
    }
  }

  if (declared === 'documento') return

  if (declared === 'conversacion') {
    refuse(
      'Las conversaciones entran al corpus solas, desde el chat. No se pueden subir como documento.',
    )
  }

  if (isPlatformAdminUser(user)) return

  const organizationId = relationId(next.organization)
  if (organizationId === null) {
    refuse('No se puede registrar una Voz sin saber a qué ecosistema pertenece.')
  }

  const allowed = await organizationIdsForUserWithPermission(
    req.payload,
    user.id,
    PERMISSIONS.vocesUpload,
  )
  if (!allowed.some((id) => String(id) === String(organizationId))) {
    refuse(
      'Solo una persona con el rol de Investigador puede registrar una Voz en este ecosistema.',
    )
  }
}

interface DocumentRow {
  id: number | string
  kind?: string | null
  /**
   * ⚠ NOT `kind`. `kind` is the FILE FORMAT (pdf/docx/audio/markdown);
   * `contentKind` is what the material IS (documento/testimonio/conversacion).
   * See `lib/contentKind.ts` — confusing the two is how a testimony gets
   * ingested without passing the anonymisation gate.
   *
   * ⚠ THE CORPUS GRAPH KEYS ITS PERSON RULE OFF THIS COLUMN TOO, so it is a
   * privacy control for two features now, not one. A `testimonio` never
   * produces `persona` entity nodes and never stores a snippet. That rule is
   * a column lookup precisely so it can be audited rather than trusted —
   * "is this a testimony?" is a SELECT, where "is this person public?" is a
   * question to a model that fails open. See `lib/graph/` and
   * `plan/adr-corpus-graph.md` §5.3.
   */
  contentKind?: string | null
  /** 🔴 A `documento` with this set is gated (`anonymiseRequested`). */
  anonymise?: boolean | null
  /** The gate's output. The ONLY text a gated document is ever embedded from. */
  redactedText?: string | null
  heldText?: string | null
  anonymisationStatus?: string | null
  mode?: string | null
  name?: string | null
  /**
   * ⚠ PLURAL. A document can be attached to several conversations at once —
   * attaching SHARES it, it never moves it. Payload returns an array for a
   * `hasMany` relationship (populated rows at `depth >= 1`, bare ids at
   * `depth: 0`); the scalar arm is only there for the half-built rows a hook
   * can be handed mid-write. Use {@link resolveIdList}, never `resolveId`.
   */
  session?:
    | (number | string | { id: number | string } | null)[]
    | number
    | string
    | { id: number | string }
    | null
  organization?: number | string | { id: number | string } | null
  uploadedBy?: number | string | { id: number | string } | null
  publicationStatus?: string | null
  mediaFile?: number | string | { id: number | string } | null
  extractedText?: string | null
  ingestId?: string | null
  ingestStatus?: string | null
  ingestError?: string | null
  transcribeId?: string | null
  transcribeAttempt?: number | null
  audioMeta?: AudioMeta | null
  /** Stamped by Payload on every write. `runExtractAndIngest` reads it to spot a stale read. */
  updatedAt?: string | Date | null
}

/** A Payload timestamp as epoch ms, or null when absent or unparseable. */
function timestampMs(value: unknown): number | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null
  if (typeof value !== 'string' || !value) return null
  const t = Date.parse(value)
  return Number.isFinite(t) ? t : null
}

/**
 * What we know about the recording behind an audio document.
 *
 * `durationSeconds` is populated at SUBMIT time (audio-service runs ffprobe
 * inline and returns it on the 202), not at completion — which is what lets the
 * UI say "esto tarda más o menos lo que dura la grabación" while the job is
 * still running instead of after it finishes. The rest arrives with
 * `transcribe.completed`.
 *
 * ⚠ `languageProbability` is the only visible signal of ASR confidence. The
 * product's mitigation for "a transcript can contain errors presented as fact"
 * is a label in the UI; this is the data behind it.
 */
export interface AudioMeta {
  durationSeconds?: number | null
  language?: string | null
  languageProbability?: number | null
  segmentCount?: number | null
  model?: string | null
  chunks?: number | null
}

/**
 * Postgres text-search config for new corpora — a `regconfig` name, not a
 * locale code. Overridable for a deployment in another language; the product
 * itself is Spanish end to end (UI, prompts, and `WHISPER_LANGUAGE=es`).
 */
const CORPUS_LANGUAGE = process.env.CORPUS_LANGUAGE?.trim() || 'spanish'

/** The kinds whose text arrives through the extract → ingest pipeline. */
const INGESTABLE_KINDS = new Set(['pdf', 'docx', 'audio'])

/**
 * 🔴 THE CAP ON EVERY COLUMN THAT HOLDS A WHOLE DOCUMENT: `extractedText`,
 * `redactedText`, `heldText`, `bodyMarkdown`.
 *
 * Without it Payload applies `defaultMaxTextLength` (40,000 chars), and a PDF
 * past that failed its `extractedText` save with a 400 (measured on dev
 * 2026-10-26). The real corpus has PDFs of ~750k chars (quoted from the owner).
 * 2,000,000 leaves room for those and still refuses a runaway value.
 *
 * ⚠ Per field, not `defaultMaxTextLength` in `payload.config.ts`: that would
 * lift the guard on every name, title and comment in every collection too.
 * Validation only — the columns are unbounded `varchar`, so no migration.
 */
export const DOCUMENT_TEXT_MAX_LENGTH = 2_000_000

/**
 * Why a background extract+ingest threw, SAFE TO STORE ON THE ROW.
 *
 * 🔴 NEVER `err.message` AS IS. A drizzle query error quotes its parameters,
 * which for the `extractedText` write is the document itself, and `ingestError`
 * is shown to every member on a published row. A Payload ValidationError gives
 * its field paths; anything else gives only its class name. The full error
 * stays in the log.
 */
export function extractIngestErrorReason(err: unknown): string {
  const paths = (err as { data?: { errors?: Array<{ path?: unknown }> } } | null)?.data?.errors
    ?.map((e) => (typeof e?.path === 'string' ? e.path : null))
    .filter((p): p is string => Boolean(p))
  const detail =
    paths && paths.length > 0
      ? `invalid field ${paths.join(', ')}`
      : err instanceof Error
        ? err.name
        : typeof err
  return `extract_ingest_failed: ${detail}`.slice(0, 500)
}

/**
 * 🔴 THE BACKSTOP FOR A THROW `runExtractAndIngest` DID NOT HANDLE ITSELF.
 *
 * It used to only log, so a row left at `extracting` stayed there forever and
 * publish answered 409 (measured on dev 2026-10-26: the `extractedText` save
 * failed validation). Now the row goes `failed`, which the UI shows and
 * `POST /api/documents/:id/retry` re-runs.
 *
 * ⚠ GUARDED on `pending`/`extracting`, the only states this path leaves a row
 * in mid-flight. A row a concurrent run already moved on (`embedding`, `ready`,
 * an audio row at `transcribing`) is not this failure's to overwrite.
 */
async function markExtractIngestFailed(row: DocumentRow, err: unknown): Promise<void> {
  const docId = resolveId(row.id)
  if (docId == null) return
  try {
    const { getPayload } = await import('payload')
    const configPromise = (await import('@payload-config')).default
    const payload = await getPayload({ config: configPromise })
    const { updateDocumentColumns } = await import('@/lib/documentColumns')
    await updateDocumentColumns(payload as never, {
      id: docId,
      data: { ingestStatus: 'failed', ingestError: extractIngestErrorReason(err) },
      where: [{ ingestStatus: { in: ['pending', 'extracting'] } }],
    })
  } catch (writeErr) {
    console.error('[documents] could not mark doc', docId, 'failed after extract+ingest threw', writeErr)
  }
}

function resolveId(raw: unknown): string | number | null {
  if (typeof raw === 'string' || typeof raw === 'number') return raw
  if (raw && typeof raw === 'object' && 'id' in raw) {
    return resolveId((raw as { id: unknown }).id)
  }
  return null
}

/**
 * Normalise a `hasMany` relationship value into a deduped list of ids.
 *
 * ⚠ A SINGLE FIELD, FIVE WIRE SHAPES. `documents.session` reaches this code as
 * a bare id (a REST body written by hand, or a row from before it went plural),
 * an array of ids (`depth: 0`), an array of populated rows (`depth >= 1`), a
 * lone populated row, or null. Reading it with `resolveId` alone quietly
 * returns null for every array form — which on this field would mean skipping
 * the ownership check entirely.
 *
 * Nulls are dropped and duplicates collapse, compared as STRINGS so `1` and
 * `'1'` are one session rather than two. Order is preserved.
 */
function resolveIdList(raw: unknown): (string | number)[] {
  const items = Array.isArray(raw) ? raw : [raw]
  const seen = new Set<string>()
  const out: (string | number)[] = []
  for (const item of items) {
    const id = resolveId(item)
    if (id == null) continue
    const key = String(id)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(id)
  }
  return out
}

/**
 * afterChange hook — runs BEFORE the save commits (Payload 3.88 has no
 * after-commit hook). `extractAndIngest` re-fetches and retries until the read
 * is at least as new as this save's `updatedAt`, so it never acts on the
 * pre-save row.
 */
const extractAndIngestHook: CollectionAfterChangeHook = async ({
  doc,
  req,
  operation,
}) => {
  // Re-entrancy guard: when we update the same row below (to persist
  // extractedText / ingestId), Payload re-fires the afterChange hook. Skip
  // if the recursive call set the flag.
  const ctx = req.context as { __skipDocsExtract?: boolean }
  if (ctx?.__skipDocsExtract) return doc

  const row = doc as DocumentRow
  if (operation !== 'create' && operation !== 'update') return doc
  if (!INGESTABLE_KINDS.has(String(row.kind))) return doc

  // Run async to avoid blocking the Payload response, AND defer one tick
  // so the create transaction is fully committed before we re-read the row
  // (Payload uses transactions internally for create/update; the row isn't
  // visible to a fresh `findByID` until commit).
  setImmediate(() => {
    void runExtractAndIngest(row).catch(async (err) => {
      console.error('[documents] background extract+ingest failed', row.id, err)
      await markExtractIngestFailed(row, err)
    })
  })

  return doc
}

/**
 * 🔴 RECLASSIFYING A DOCUMENT MUST DESTROY THE GRAPH IT ALREADY PRODUCED.
 *
 * `contentKind` is a PRIVACY CONTROL, and the person rule and the snippet rule
 * are applied AT EXTRACTION TIME. That leaves one obvious and entirely ordinary
 * sequence unprotected:
 *
 *     upload as `documento`  →  extraction writes `persona` nodes and verbatim
 *                               `snippet`s  →  someone corrects the field to
 *                               `testimonio`
 *
 * Nothing in the extraction pipeline reacts to a column edit, and the backfill
 * selects on `graphPromptVersion` and `graphStatus`, neither of which changes.
 * So the person nodes and the quotations would simply STAY, on a row that is now
 * a testimony — the exact state ADR §5.3 and §7.3.4 forbid, reached by a state
 * change rather than by an extraction bug. ADR §10 names this as a residual risk
 * whose "mitigation is that re-extraction after correcting the field removes
 * them — but only if someone notices." This hook is the "someone notices" part.
 *
 * It does TWO things, and the order matters:
 *
 *   1. DELETES this document's mentions and relations IMMEDIATELY. That is the
 *      part that actually removes the leaked snippets and person edges, and it
 *      happens without waiting for anyone to run anything.
 *   2. Clears `graphPromptVersion` and sets `graphStatus: 'pending'`, which
 *      makes the row STALE so the backfill re-extracts it under the new rules.
 *
 * ⚠ IT DOES NOT RE-EXTRACT ON THE SPOT. Re-extraction is `deep`-tier inference,
 * and a field edit is not a good trigger to spend money on — especially for a
 * bulk correction over an Investigador's batch. Deleting is free, immediate and
 * fail-safe; re-extracting is deliberate. The graph is briefly poorer, never
 * briefly wrong.
 *
 * ⚠ Orphan entities left behind are swept by the backfill, not here, for the
 * same reason the writer does not sweep: another document may still use them.
 */
const invalidateGraphOnContentKindChange: CollectionAfterChangeHook = async ({
  doc,
  previousDoc,
  operation,
  req,
}) => {
  if (operation !== 'update') return doc
  const before = (previousDoc ?? {}) as { contentKind?: unknown }
  const after = doc as { id?: unknown; contentKind?: unknown; organization?: unknown }
  if (before.contentKind === undefined) return doc
  if (before.contentKind === after.contentKind) return doc

  const docId = resolveId(after.id)
  const organizationId = resolveId(after.organization)
  if (docId == null || organizationId == null) return doc

  // Detached, like every other graph write: reclassifying a document must not
  // fail because the graph cleanup did.
  setImmediate(() => {
    void (async () => {
      // 🔴 Tenancy named explicitly on both deletes, as everywhere else.
      const where: Where = {
        and: [
          { organization: { equals: organizationId } },
          { document: { equals: docId } },
        ],
      }
      await req.payload.delete({ collection: 'graphMentions', where, overrideAccess: true })
      await req.payload.delete({ collection: 'graphRelations', where, overrideAccess: true })
      await req.payload.update({
        collection: 'documents',
        id: docId as never,
        data: {
          graphStatus: 'pending',
          graphError: null,
          // Null makes the row match the backfill's staleness predicate.
          graphPromptVersion: null,
        },
        overrideAccess: true,
        context: { __skipDocsExtract: true },
      })
      console.log(
        `[graph] doc ${docId} reclassified ${String(before.contentKind)} → ` +
          `${String(after.contentKind)}: graph rows dropped, marked for re-extraction`,
      )
    })().catch((err) => {
      console.error('[graph] could not invalidate the graph for reclassified doc', docId, err)
    })
  })

  return doc
}

/** A document row read at `depth: 1`, so `mediaFile` is the resolved row. */
type DocumentRowWithMedia = DocumentRow & {
  mediaFile?: {
    id: number | string
    filename?: string | null
    mimeType?: string | null
    filesize?: number | null
  } | null
}

/**
 * Retire a deleted document from its corpora.
 *
 * Runs AFTER the row is gone, so it can neither block nor undo the delete —
 * that is the point. It reports, and never throws: turning a successful delete
 * into an error the user cannot act on would be worse than the leak it is
 * trying to close, and the leak is already logged with the corpus and id so it
 * can be retried by hand.
 */
const retireDeletedDocumentHook: CollectionAfterDeleteHook = async ({ context, doc, req }) => {
  const row = doc as { id?: unknown; organization?: unknown; uploadedBy?: unknown }
  if (row?.id == null) return doc
  // A conversation delete removes this row inside ITS transaction and does the
  // ai-service half itself, after commit (`lib/conversationUploads.ts`).
  // One-shot, by id: the entry is consumed here, so it cannot reach any other
  // delete in the same request.
  if (consumeCorpusCleanupSkip(context, row.id)) return doc

  try {
    const { getAdminAIClient } = await import('@/lib/aiClient')
    const { retireDeletedDocument } = await import('@/lib/publishDocument')
    // The document's corpora live in its ecosistema's ai-service org. No
    // ecosistema on the row means it never reached a corpus we could name.
    const organizationId = relationId(row.organization)
    if (organizationId == null) return doc
    await retireDeletedDocument(
      { payload: req.payload, client: getAdminAIClient(organizationId) as never },
      row as never,
    )
  } catch (err) {
    // Includes "the AI service is not configured at all", which is a normal
    // state for a local run with no admin key. Never fatal here.
    req.payload.logger.warn(
      { documentId: String(row.id), err: String(err) },
      '[delete] could not retire the deleted document; its chunks may stay retrievable.',
    )
  }
  return doc
}

/**
 * 🔴 A DELETED DOCUMENT TAKES ITS STORED FILE WITH IT — AFTER COMMIT.
 *
 * Until 2026-10-17 deleting a document on its own (Mis documentos, the admin
 * panel) left its `media` row and its object in the bucket, owned by nobody's
 * document. Rodrigo ruled that a bug.
 *
 * The object delete cannot be rolled back, so this hook only PLANS it, in the
 * transaction: it reads the document's file, checks it is the uploader's, and
 * captures the transaction id. The delete runs once `txid_status` says the
 * transaction committed, and only when no surviving document points at the
 * file. Same machinery as a conversation delete, in
 * `lib/conversationUploads.ts` (`planDocumentMediaCleanup`).
 *
 * ⚠ A document that a conversation delete is removing is skipped there: that
 * plan already covers its file.
 *
 * ⚠ `beforeDelete`, not `afterDelete`: a bulk delete runs the row hooks
 * concurrently, and each row schedules its own plan in its own closure.
 */
const scheduleMediaCleanupHook: CollectionBeforeDeleteHook = async ({ id, req }) => {
  const plan = await planDocumentMediaCleanup(id, { payload: req.payload, req })
  if (plan) scheduleUploadCleanup(req.payload, plan)
}

async function runExtractAndIngest(row: DocumentRow): Promise<void> {
  const docId = resolveId(row.id)
  if (docId == null) return

  // Acquire a fresh Payload instance (no transaction context). The `req`
  // passed into afterChange carries the in-flight transaction; once the
  // setImmediate runs the original transaction has closed, so reads on
  // `req.payload` may 404. The top-level `getPayload({ config })` returns
  // the singleton on the no-tx connection.
  const { getPayload } = await import('payload')
  const configPromise = (await import('@payload-config')).default
  const payload = await getPayload({ config: configPromise })

  // Re-fetch with depth: 1 so `mediaFile` includes filename + mimeType.
  // Don't trust the partial `doc` passed to afterChange on `update` paths.
  //
  // 🔴 THIS RETRIES, AND THE RETRY IS THE WHOLE FIX. Read this before
  // "simplifying" it back to a single findByID.
  //
  // `afterChange` fires INSIDE Payload's create transaction. `setImmediate`
  // defers one tick, which is not remotely enough — the transaction commits
  // when the HTTP response completes, several ticks and one network round trip
  // later. So the first read routinely lands before the row is visible on the
  // no-transaction connection and `findByID` THROWS `Not Found` (it throws; it
  // does not return null, which is why the `if (!fresh)` guard below never
  // caught this).
  //
  // The symptom was total and silent: EVERY pdf/docx/audio upload logged
  // "background extract+ingest failed <id> Not Found" once and stopped there.
  // The row sat at `ingestStatus: 'pending'` forever, nothing was ever
  // enqueued, ai-service never saw a single job, and the UI showed "en cola"
  // with no error. Found by the first end-to-end run against the live stack;
  // no unit test could see it, because they all pass a row that already exists.
  //
  // Payload has no after-commit hook, so a bounded retry is the honest fix.
  // ~2.5s total is far longer than a commit needs and still fails loudly if the
  // row genuinely does not exist.
  //
  // 🔴 ON AN UPDATE THE READ DOES NOT THROW — IT RETURNS THE OLD ROW. A create's
  // uncommitted row is invisible, so `findByID` throws and the loop retries. An
  // update's uncommitted row is not invisible: the PREVIOUS version is, and the
  // read succeeds with it. That is how approving a hold sometimes never ingested
  // (measured by `e2e/holds.e2e.ts`, 1 of 3 runs at load 8): the read returned
  // the pre-approval row, still `held`, and the held guard below returned.
  // So a row older than the write that fired this hook counts as "not visible
  // yet", exactly like a throw. `updatedAt` is the clock: Payload stamps it on
  // every write, and the hook's `doc` carries the stamp of THIS write.
  // `Documents.approvalRace.test.ts`.
  const RETRY_DELAYS_MS = [25, 50, 100, 250, 500, 750, 800]
  const writtenAt = timestampMs(row.updatedAt)
  let fresh: DocumentRowWithMedia | null = null
  let lastError: unknown = null

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const read = (await payload.findByID({
        collection: 'documents',
        id: docId as never,
        depth: 1,
        overrideAccess: true,
      })) as DocumentRowWithMedia
      const readAt = timestampMs(read?.updatedAt)
      if (read && (writtenAt === null || (readAt !== null && readAt >= writtenAt))) {
        fresh = read
        break
      }
      lastError = 'the row read back is older than the write that fired this hook'
    } catch (err) {
      lastError = err
    }
    if (attempt < RETRY_DELAYS_MS.length) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]))
    }
  }
  if (!fresh) {
    // ⚠ Left `pending`. `sweepStalledPending` in `lib/embeddingJanitor.ts` is
    // the backstop for a row this loop gives up on.
    console.error(
      '[documents] doc',
      docId,
      `still not readable after ${RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)}ms —`,
      'giving up on extract+ingest',
      lastError,
    )
    return
  }
  if (!INGESTABLE_KINDS.has(String(fresh.kind))) return

  /**
   * 🔴 A HELD ROW IS NOT RE-GATED BY AN ORDINARY SAVE.
   *
   * `afterChange` fires on every update, and the only other guard here is
   * `if (fresh.ingestId)` — which a held document never has, because it never
   * reached the enqueue. So RENAMING a held testimony used to re-run the whole
   * gate: two more model calls, billed, and — because the detector IS a model —
   * a chance of a DIFFERENT verdict. Rename it enough times and one of those
   * runs comes back `ready`. That is an "ingest anyway" button nobody meant to
   * build, and it made the header's promise ("re-running it will say no again")
   * a claim the code did not keep.
   *
   * ⚠ The way out is `POST /api/documents/:id/retry`, which clears
   * `anonymisationStatus` deliberately. One explicit path, not a side effect of
   * editing a field.
   */
  if (fresh.anonymisationStatus === 'held') {
    console.warn(
      '[documents] doc',
      docId,
      'is HELD by the anonymisation gate — skipping. Review it at POST /api/holds/:id, or',
      'POST /api/documents/:id/retry to re-run the gate on a fixed source.',
    )
    return
  }

  /**
   * 🔴 A REJECTION IS TERMINAL, AND IT IS TERMINAL HERE FOR THE SAME REASON A
   * HOLD IS.
   *
   * A human looked at this text and said no. Without this guard the next
   * ordinary save — a rename, a session change, anything at all — would re-run
   * the gate, and a probabilistic detector re-run enough times eventually
   * answers `ready`. That is the "ingest anyway" button nobody meant to build,
   * one state along from the one it was already closed for.
   *
   * ⚠ There is deliberately no way out of `rejected` in this file. Reversing a
   * rejection is a second REVIEW, through `lib/holdReview.ts`, which writes a
   * second audit row.
   */
  if (fresh.anonymisationStatus === 'rejected') {
    console.warn(
      '[documents] doc',
      docId,
      'was REJECTED by a reviewer — skipping. Only a new review can change that.',
    )
    return
  }

  // ⚠ The corpus is keyed on (ecosistema, uploader), NOT on the session. A
  // document outlives the conversation it was uploaded into, and drafts are
  // private to their uploader rather than to a thread.
  const organizationId = resolveId(fresh.organization)
  const uploadedById = resolveId(fresh.uploadedBy)
  if (organizationId == null || uploadedById == null) {
    console.warn(
      '[documents] doc',
      docId,
      'has no organization/uploadedBy — cannot derive a corpus, skipping ingest',
    )
    return
  }

  // 1. Extract — skip if already cached on the row (idempotent re-saves).
  let extractedText = fresh.extractedText ?? ''
  if (!extractedText || !extractedText.trim()) {
    const mediaId = resolveId(fresh.mediaFile)
    if (mediaId == null) {
      console.warn('[documents] no mediaFile on', fresh.kind, 'doc', docId, '— cannot extract')
      return
    }

    // 🔴 THE AUDIO FORK, AND THE `return` IS THE POINT OF IT.
    //
    // There is no text yet and there will not be for minutes-to-hours, so
    // control must NOT reach `enqueueIngestForDoc` on this pass. The
    // `transcribe.completed` callback persists the transcript and marks the row
    // `transcribed`; the `ingestRecovery` sweep (`driveTranscribedDocuments`)
    // then calls this very function. Falling through here would enqueue
    // an empty document: ai-service would happily embed nothing, the row would
    // go `ready`, and search would silently never find the recording.
    if (fresh.kind === 'audio') {
      await startTranscription({ payload, docId, fresh })
      return
    }

    await payload.update({
      collection: 'documents',
      id: docId as never,
      data: { ingestStatus: 'extracting' },
      overrideAccess: true,
      context: { __skipDocsExtract: true },
    })

    try {
      extractedText = await extractText(
        payload,
        mediaId,
        fresh.kind === 'docx' ? 'docx' : 'pdf',
      )
    } catch (err) {
      console.error('[documents] extraction failed for doc', docId, err)
      await payload.update({
        collection: 'documents',
        id: docId as never,
        data: {
          ingestStatus: 'failed',
          ingestError: `extraction_failed: ${err instanceof Error ? err.message : String(err)}`.slice(
            0,
            500,
          ),
        },
        overrideAccess: true,
        context: { __skipDocsExtract: true },
      })
      return
    }

    if (!extractedText.trim()) {
      console.warn('[documents] extraction yielded empty text for doc', docId)
      await payload.update({
        collection: 'documents',
        id: docId as never,
        data: {
          ingestStatus: 'failed',
          ingestError: 'empty_extraction: the file produced no text',
        },
        overrideAccess: true,
        context: { __skipDocsExtract: true },
      })
      return
    }

    await payload.update({
      collection: 'documents',
      id: docId as never,
      data: { extractedText },
      overrideAccess: true,
      context: { __skipDocsExtract: true },
    })
  }

  // 2. Enqueue ingest — skip if already enqueued (idempotent re-saves).
  //
  // ⚠ `ingestStatus` TOO, not only `ingestId`. `ingestId` is written AFTER the
  // enqueue returns, so for that window a row that is already `embedding` (or
  // already `ready`, when the callback beat the response) carries no id. Any
  // save in that window would otherwise enqueue the document twice and move a
  // `ready` row back to `embedding`. A retry resets the row to `pending`, so
  // this never blocks a deliberate re-run. `Documents.callbackRace.test.ts`.
  if (fresh.ingestId || fresh.ingestStatus === 'embedding' || fresh.ingestStatus === 'ready') return
  // ⚠ An audio transcript is driven by `driveTranscribedDocument` only, behind
  // its claim. A rename here would otherwise drive it a second time.
  if (fresh.kind === 'audio' && (fresh.ingestStatus === 'transcribed' || fresh.ingestStatus === 'extracting')) return
  // Cached text skipped the `extracting` write above; `enqueueIngestForDoc`
  // sends only from `extracting`.
  if (fresh.ingestStatus !== 'extracting' && extractedText === fresh.extractedText) {
    await payload.update({
      collection: 'documents',
      id: docId as never,
      data: { ingestStatus: 'extracting' },
      overrideAccess: true,
      context: { __skipDocsExtract: true },
    })
  }

  await enqueueIngestForDoc({
    payload,
    docId,
    organizationId,
    uploadedById,
    // ⚠ Spread and then PIN the gate fields. `fresh` has them optional, and the
    // parameter deliberately requires the key — see `enqueueIngestForDoc`. This
    // spelling is what makes "did this caller think about the gate state?"
    // visible at the call site instead of inferred from a structural match.
    fresh: {
      ...fresh,
      anonymise: fresh.anonymise ?? null,
      anonymisationStatus: fresh.anonymisationStatus ?? null,
      redactedText: fresh.redactedText ?? null,
    },
    extractedText,
  })

  // 3. The corpus graph, for the pdf/docx path. The audio path reaches the same
  //    function from the `ingestRecovery` sweep (`driveTranscribedDocuments`),
  //    after its enqueue of a `transcribed` row — there is no text to extract from
  //    on this pass for audio, which is why the fork above `return`s.
  //
  //    🔴 FIRE-AND-FORGET, AND IT NEVER AFFECTS THIS FUNCTION'S OUTCOME. See
  //    `lib/graph/schedule.ts`: it arms a `setImmediate` and returns.
  await scheduleGraphExtractionForDoc({ payload, docId, organizationId, fresh })
}

/**
 * `GRAPH_EXTRACT` — ON unless set to `off`, `false`, `0` or `no` (any case).
 * Anything else, junk included, keeps the default: the graph is a feature an
 * install opts out of, not one a typo should switch off.
 */
export function graphExtractDisabled(): boolean {
  const raw = (process.env.GRAPH_EXTRACT ?? '').trim().toLowerCase()
  return raw === 'off' || raw === 'false' || raw === '0' || raw === 'no'
}

/**
 * Hand one document to the corpus-graph pipeline, without letting it touch the
 * ingest path. `plan/adr-corpus-graph.md` §5.1.
 *
 * 🔴 EVERY FAILURE MODE ENDS HERE. A missing module, an unconfigured
 * ai-service, a thrown constructor — all of it is caught and logged. Ingest
 * already succeeded by the time this runs, and turning a successful upload into
 * an error the user cannot act on would be strictly worse than a document with
 * no graph.
 *
 * Exported so the audio path (`lib/ingestRecovery.ts:driveTranscribedDocuments`)
 * can call exactly this, rather than reimplementing the guard.
 */
export async function scheduleGraphExtractionForDoc(args: {
  payload: Awaited<ReturnType<typeof import('payload').getPayload>>
  docId: string | number
  organizationId: string | number
  fresh: Pick<DocumentRow, 'name' | 'contentKind'>
}): Promise<void> {
  const { payload, docId, organizationId, fresh } = args
  // `GRAPH_EXTRACT=off` (also `false`/`0`/`no`): this install does not build
  // the corpus graph on upload. Nothing is written, so the row keeps whatever
  // `graphStatus` it had; `lib/graph/backfill.cli.ts` can still build it later.
  if (graphExtractDisabled()) return
  try {
    const { corpusTextFor } = await import('@/lib/anonymiseDocument')
    const { scheduleGraphExtraction } = await import('@/lib/graph/schedule')
    const { updateDocumentColumns } = await import('@/lib/documentColumns')

    /**
     * 🔴 THE GRAPH READS THE SAME TEXT THE CORPUS GOT. NOT `extractedText`.
     *
     * This is the single most important line in the graph pipeline, and it used
     * to be wrong. Callers have `extractedText` in hand and passing it here is
     * the obvious thing to do — but for a `testimonio` that is the RAW,
     * UN-SCRUBBED transcript. Extracting entities from it would put the names,
     * places and organisations the anonymisation gate exists to remove into
     * `graph_entities`, in a queryable table, permanently.
     *
     * The person rule would NOT have saved us: it only blocks `persona` nodes.
     * A `lugar` and an `organizacion` from an un-scrubbed Voz identify someone
     * just as well in a small ecosistema — which is the whole premise of the
     * minimum-support threshold.
     *
     * `corpusTextFor` is the same helper `lib/publishDocument.ts` embeds from,
     * so the graph and the corpus can never disagree about what a document
     * says. It FAILS CLOSED: a gated document whose scrub has not cleared has
     * no text to give, and we skip rather than reach for the original.
     *
     * ⚠ Ordering makes this safe: the gate runs and persists `redactedText`
     * synchronously inside `enqueueIngestForDoc`, which every caller awaits
     * before reaching here.
     */
    const row = (await payload.findByID({
      collection: 'documents',
      id: docId as never,
      depth: 0,
      overrideAccess: true,
    })) as {
      contentKind?: unknown
      anonymise?: unknown
      extractedText?: unknown
      redactedText?: unknown
      /**
       * 🔴 CONSULTED, NOT DECORATIVE. `corpusTextFor` requires `ready` or
       * `approved` for gated content — a row that cleared the gate once and was
       * later held or rejected has a stale `redactedText`, and publishing it
       * would be exactly the bug that check exists to stop. The graph reads the
       * same text as the corpus, so it inherits the same condition.
       */
      anonymisationStatus?: unknown
      publicationStatus?: unknown
    }

    const corpusText = corpusTextFor(row)
    if (!corpusText.ok) {
      // Not a failure — a document we deliberately do not graph. `skipped` is
      // terminal and truthful; `failed` would invite a retry that cannot help.
      // 🔴 `markNotGraphable` also DROPS the rows an earlier run left: a gated
      // row held or rejected after a `ready` run kept them (graph-retry, 10-26).
      const { markNotGraphable } = await import('@/lib/graph/schedule')
      await markNotGraphable(payload as never, docId, organizationId, corpusText.reason)
      return
    }

    // 🔴 GRAPH COLUMNS ONLY. This runs right after the ingest enqueue, which is
    // exactly when the ai-service callback lands; a whole-row `payload.update`
    // here wrote the stale `embedding` back over the callback's `ready`.
    // `lib/documentColumns.ts`.
    await updateDocumentColumns(payload as never, {
      id: docId,
      data: { graphStatus: 'pending', graphError: null },
    })
    scheduleGraphExtraction({
      payload: payload as never,
      docId,
      organizationId,
      // 🔴 The column verbatim, with NO `?? 'documento'` fallback. The person
      // rule compares `=== 'documento'` and therefore fails CLOSED on a missing
      // value; defaulting here would turn that safe direction into the unsafe
      // one.
      contentKind: fresh.contentKind ?? null,
      // 🔴 Fingerprints of the row as queued. The run re-reads the row and
      // aborts if any of these changed (`lib/graph/schedule.ts`).
      anonymise: row.anonymise,
      publicationStatus: row.publicationStatus,
      text: corpusText.text,
      /**
       * 🔴 NEVER `documents.name` FOR GATED CONTENT. It is free text the
       * uploader typed, it never went through the gate, and "Testimonio de
       * María López.mp3" is the case `lib/contentKind.ts` records as having
       * nearly reached the shared corpus. `titleFor` gives gated material a
       * neutral title; the graph surfaces titles, so it needs the same rule.
       */
      title: titleFor(knownContentKind(fresh), fresh.name),
    })
  } catch (err) {
    console.error('[graph] could not schedule extraction for doc', docId, err)
  }
}

/**
 * The enqueue half of the pipeline, split out from `runExtractAndIngest` so it
 * can be exercised directly in tests without standing up Payload or the
 * `@payload-config` module graph. Same code that runs in production.
 */
export async function enqueueIngestForDoc(args: {
  payload: Pick<Awaited<ReturnType<typeof import('payload').getPayload>>, 'update'>
  docId: string | number
  /** Ecosistema the document belongs to. Half of the corpus name. */
  organizationId: string | number
  /** Who uploaded it. The other half — drafts are PRIVATE per person. */
  uploadedById: string | number
  /**
   * 🔴 `anonymisationStatus` IS A REQUIRED KEY, NOT AN OPTIONAL ONE, AND THAT IS
   * ⚠ `contentKind` IS ALSO PART OF THIS SLICE, and it now decides two
   * things rather than one: whether the anonymisation gate runs, and
   * whether the corpus graph may extract `persona` nodes from this
   * document. See `lib/graph/`.
   *
   * A BUG FIX.
   *
   * The terminal-state guards used to live in `runExtractAndIngest`, one level
   * ABOVE this function — but the audio path calls THIS function directly and
   * builds its `fresh` slice by hand (then the `transcribe.completed` callback,
   * now `lib/ingestRecovery.ts:driveTranscribedDocuments`). With the key
   * optional, it simply omitted the field, and a replayed
   * `transcribe.completed` re-ran the gate on a REJECTED document and discarded
   * the text of an APPROVED one. That is precisely the failure
   * `lib/anonymiseDocument.ts` warns about: "the one that got forgotten would be
   * the audio path".
   *
   * So the guard moved down here, to the choke point every path actually
   * converges on, and the type makes supplying the field unavoidable. `null` and
   * `undefined` are both accepted values — the KEY is what is mandatory, so
   * adding a fourth caller is a compile error until someone decides what it
   * should pass.
   *
   * ⚠ Both columns are locked against API writes (`gateWritesOnly`), which is
   * what makes trusting a value read off the stored row safe here.
   */
  fresh: Pick<DocumentRow, 'name' | 'kind' | 'contentKind'> & {
    /** 🔴 The raw column (`anonymiseRequested`). Both real callers pass it. */
    anonymise?: unknown
    anonymisationStatus: string | null | undefined
    redactedText?: string | null
    /** For the retrieval filter. `chunkMetadata` keeps it on a documento only. */
    lengua?: string | null
  }
  extractedText: string
  /** Test seam for the anonymisation gate's model call. */
  detector?: import('@/lib/anonymise/types').PersonDetector
}): Promise<void> {
  const { payload, docId, organizationId, uploadedById, fresh, extractedText } = args
  const contentKind = contentKindOf(fresh)

  /**
   * 🔴 A SETTLED ROW NEVER REACHES THE GATE, AND THE CHECK LIVES HERE BECAUSE
   * HERE IS WHERE EVERY PATH CONVERGES.
   *
   *   held      the gate refused and no human has looked yet
   *   rejected  a human looked and said no
   *
   * `runExtractAndIngest` refuses these too, but it is only ONE of the callers.
   * The audio path reaches this function directly from the `ingestRecovery`
   * sweep (`driveTranscribedDocuments`), which picks up any `transcribed` row
   * with no `ingestId` — a held row never got one — and would otherwise re-run
   * a PROBABILISTIC gate on a rejected document, where a `ready` verdict would
   * ingest it. Rename it, re-drive it, retry it: same accidental "ingest
   * anyway" button, three different doors.
   *
   * ⚠ The way out of a hold is `POST /api/holds/:id` (audited) or, for a fixed
   * source, `POST /api/documents/:id/retry`. There is no way out of `rejected`
   * except a new review.
   */
  if (fresh.anonymisationStatus === 'held' || fresh.anonymisationStatus === 'rejected') {
    console.warn(
      '[documents] doc',
      docId,
      `is ${fresh.anonymisationStatus.toUpperCase()} — refusing to ingest. Only a review can change that.`,
    )
    return
  }

  /**
   * 🔴 THE ANONYMISATION GATE, AT THE ONE POINT EVERY PATH CONVERGES ON.
   *
   * PDF/DOCX extraction, the audio transcript arriving on a webhook, and the
   * manual retry all reach ai-service through this function and no other. Put
   * the gate anywhere upstream and the audio path — the slow asynchronous one
   * nobody watches — is the one that would get missed.
   *
   * ⚠ A HOLD RETURNS. It does not throw, and it does not fall through to a
   * "degraded" ingest. There is no per-document delete at ai-service, so
   * ingesting a testimony whose scrub we are not sure about is close to
   * permanent. The row keeps its `extractedText` and its reason; nothing is
   * lost, it is simply not embedded.
   */
  const { anonymiseDocumentText } = await import('@/lib/anonymiseDocument')
  const gated = await anonymiseDocumentText({
    // The live handle carries `db.drizzle`; the narrow type above does not say so.
    payload: payload as never,
    docId,
    organizationId,
    /**
     * 🔴 THE RAW COLUMN, NOT `contentKind` ABOVE.
     *
     * `contentKind` is `contentKindOf(fresh)`, which coerces anything
     * unreadable to `documento` — correct for the citation metadata further
     * down, fail-OPEN for this decision. `mustPassAnonymisationGate` reads the
     * raw value and gates everything it does not recognise. See it for the
     * argument.
     *
     * ⚠ The two cannot diverge for a row that came out of Postgres —
     * `documents.contentKind` is a NOT NULL enum. They diverge for objects
     * assembled in code, which is exactly where `corpusTextFor` gets used.
     */
    contentKind: fresh.contentKind,
    anonymise: fresh.anonymise,
    text: extractedText,
    /**
     * 🔴 THE HUMAN OVERRIDE, AND THE ONLY ONE.
     *
     * A reviewer approved this hold, so `redactedText` already holds the text
     * THEY cleared — possibly text they edited by hand. Re-running the gate over
     * `extractedText` would throw their decision away and, worse, could answer
     * `ready` on the raw original and ingest something nobody approved.
     *
     * ⚠ It is read from the STORED status, which only `lib/holdReview.ts` can
     * write (the field is locked against API updates — see its `access`). A
     * client cannot set it and cannot reach this branch.
     */
    ...(fresh.anonymisationStatus === 'approved' && typeof fresh.redactedText === 'string'
      ? { approvedText: fresh.redactedText }
      : {}),
    ...(args.detector ? { detector: args.detector } : {}),
    // ⚠ Empty on purpose for a testimony. The people a Voz names — the speaker,
    // their family, an official — are not users of this system, so no roster we
    // hold contains them. Testimony redaction rests on the content scrub.
    roster: [],
  })

  if (!gated.ok && gated.busy) {
    // 🔴 THE GATE DID NOT RUN: another run holds the row, a decision stands, or
    // the row is shared (`GATE_CLAIM_GUARD`). Nothing was written and nothing is
    // written here — stamping `failed` would clobber the run that owns it.
    console.warn(`[documents] doc ${docId}: gate not claimed (${gated.reason}) — leaving the row as it is.`)
    return
  }

  if (!gated.ok) {
    console.warn(
      gated.retryable
        ? `[documents] doc ${docId}: the anonymisation gate could not run (${gated.stage}) — not ingested, retryable.`
        : `[documents] doc ${docId} HELD at the ${gated.stage} stage of the anonymisation gate — not ingested.`,
    )
    /**
     * 🔴 SAY SO ON `ingestStatus` TOO, OR THE USER WATCHES A SPINNER FOREVER.
     *
     * `anonymisationStatus: 'held'` is the truthful record and an operator can
     * see it — but the row was left at `extracting` (or `transcribing`), which
     * is a NON-TERMINAL state with nothing left to move it. That breaks this
     * file's own rule and looks, to the person who uploaded a testimony,
     * exactly like an upload that is still working.
     *
     * ⚠ `failed`, so `planIngestRetry` will accept it. A hold is not something
     * to retry blindly — re-running the gate on identical bytes costs two model
     * calls for the same answer — but the person may well fix the source and
     * ask again, and `POST /:id/retry` is the ONE explicit path for that.
     * `runExtractAndIngest` refuses to re-gate a held row on any other save.
     */
    await payload.update({
      collection: 'documents',
      id: docId as never,
      data: {
        ingestStatus: 'failed',
        // ⚠ A gate that could not RUN gets its own code: `ingestRecovery.ts`
        // re-drives exactly these rows (`sweepUnavailableGateRuns`).
        ingestError: `${gated.retryable ? GATE_UNAVAILABLE_INGEST_CODE : 'anonymisation_held'}: ${gated.stage}: ${gated.reason}`.slice(0, 500),
      },
      overrideAccess: true,
      context: { __skipDocsExtract: true },
    })
    return
  }

  const corpusText = gated.text

  // 🔴 The testimonio's title, from the gate's OUTPUT (`gated.text` is the
  // redaction or the reviewer-approved text, never `extractedText`). Detached:
  // ingest and publish never wait on it. `lib/testimonioTitle.ts`.
  if (fresh.contentKind === 'testimonio') {
    const { scheduleTestimonioTitle } = await import('@/lib/testimonioTitle')
    scheduleTestimonioTitle({
      contentKind: fresh.contentKind,
      docId,
      organizationId,
      redactedText: corpusText,
      payload: payload as never,
    })
  }

  // From the UI's POV, the wait between enqueue and the ai-service callback
  // *is* the embedding phase (ai-service workers chunk + embed + upsert).
  //
  // 🔴 CONDITIONAL, AND IT IS THE LAST GATE BEFORE THE SEND. Only from
  // `extracting` with no `ingestId`: every caller runs at `extracting` (the
  // pdf/docx path writes it, the audio drive claims it). A run that hung long
  // enough for `lib/ingestRecovery.ts:recoverAbandonedClaims` to hand its row
  // back has lost the claim; its late write changes 0 rows and it sends
  // nothing. `ingestError: null` clears what a previous failed attempt left.
  const { updateDocumentColumns: writeColumns } = await import('@/lib/documentColumns')
  const stillOurs = await writeColumns(payload as never, {
    id: docId,
    where: [{ ingestStatus: { equals: 'extracting' } }, { ingestId: { exists: false } }],
    data: { ingestStatus: 'embedding', ingestError: null },
  })
  if (stillOurs === 0) {
    console.warn(`[documents] doc ${docId}: no longer \`extracting\` — this run lost it, nothing sent.`)
    return
  }

  // Lazy-import the client + helpers so we don't pull @edc/ai-client
  // into the payload-types-only `payload generate:types` build path.
  const { getAppAIClient } = await import('@/lib/aiClient')
  const { draftCorpus } = await import('@/lib/corpus')

  // ⚠ A NEW UPLOAD ALWAYS LANDS IN THE UPLOADER'S PRIVATE DRAFT CORPUS, never
  // in the ecosistema's shared one. That is the workflow: upload, try it in
  // chat, then publish deliberately. Ingesting straight into the shared corpus
  // would share every document the instant it finished uploading, which is the
  // opposite of what `publicationStatus: 'draft'` promises on the row.
  //
  // Both halves of the name come from the DATABASE ROW, which was itself
  // validated on write (`bindDocumentToEcosystem`). Nothing here is derived
  // from a request body.
  const corpus = draftCorpus(organizationId, uploadedById)

  let client
  try {
    client = getAppAIClient(organizationId)
  } catch (err) {
    console.error('[documents] ai-client unavailable; ingest skipped for doc', docId, err)
    return
  }

  // Single seam shared with the boot check in `payload.config.ts`, so the
  // warning an operator sees at boot cannot drift from what actually happens
  // here. Returns null unless BOTH the secret and a well-formed absolute base
  // URL are set — a malformed base URL degrades to "no callback" rather than
  // 400-ing the ingest call itself (ai-service validates `callbackUrl` with
  // `z.string().url()`, and that 400 would take ingestion down entirely, not
  // just the callback).
  const { ingestCallbackUrl, missingCallbackConfig } = await import('@/lib/callbackConfig')
  const callbackUrl = ingestCallbackUrl() ?? undefined
  if (!callbackUrl) {
    console.warn(
      '[documents] ai-service callbacks not configured (' +
        missingCallbackConfig().join(', ') +
        `) — doc ${docId} is being enqueued WITHOUT a callbackUrl and will stay in ` +
        'ingestStatus="embedding" until an operator fixes the config and it is re-uploaded',
    )
  }

  /**
   * 🔴 THE SAME RATE-LIMITED BUCKET AS THE PUBLISH MOVE, so the same backoff.
   *
   * ai-service caps `/v1` at 100 requests per minute per API key. A bulk upload
   * or a corpus seed pushes many documents through here at once and the refusals
   * land as `ingest_enqueue_failed: Rate limit exceeded` in the catch below —
   * visible, but requiring a human to press retry on every one of them.
   *
   * ⚠ WAITING IS ALMOST FREE HERE, unlike in `beginPublish`. This runs inside a
   * `setImmediate` after the request has already returned, so nobody is holding
   * a connection open while we sleep. The default budget still applies; raise
   * `AI_RETRY_TOTAL_WAIT_MS` for a bulk seed.
   *
   * ⚠ ONLY a 429 is retried — see `lib/aiRetry.ts`. A 500 might mean the ingest
   * was half-created, and re-sending would embed the document twice.
   */
  const { withRateLimitRetry } = await import('@/lib/aiRetry')

  try {
    const result = await withRateLimitRetry(
      () =>
        client.ingest.enqueue({
          corpus,
          documents: [
            {
              id: String(docId),
              // 🔴 THE GATE'S OUTPUT, NEVER `extractedText`. For a `documento` they
              // are the same string; for a `testimonio` they are not, and sending
              // the wrong one embeds the unredacted original into a corpus that has
              // no per-document delete.
              text: corpusText,
              // ⚠ `titleFor`, not `fresh.name`. The top-level title is not echoed
              // back on retrieve, but it IS stored at ai-service — and for a
              // testimony the uploader's filename is exactly the identifier the
              // gate just spent two model calls removing from the body.
              title: titleFor(knownContentKind(fresh), fresh.name),
              /**
               * ⚠ BUILT BY `chunkMetadata`, NOT INLINE. It is the same builder the
               * publish move uses, which is what stops `kind` from being silently
               * dropped when a document is re-embedded into the shared corpus. See
               * `lib/contentKind.ts`.
               */
              metadata: chunkMetadata({
                docId: String(docId),
                organizationId,
                contentKind,
                format: fresh.kind,
                publication: 'draft',
                title: fresh.name,
                // `chunkMetadata` drops it on anything but a documento.
                lengua: fresh.lengua,
              }),
            },
          ],
          /**
           * 🔴 THE LEXICAL LEG'S STEMMING, and it is only honoured when the corpus
           * is FIRST created.
           *
           * This is a Postgres text-search config name (`regconfig`), not an ISO
           * locale: `'spanish'`, not `'es'`. Without it the corpus is created as
           * `'simple'`, which does no stemming at all — so `acuerdo` does not match
           * `acuerdos`, and `firmamos` does not match `firmar`.
           *
           * ⚠ It costs more here than it would in an English product. This is a
           * Spanish-language repository, Spanish is heavily inflected, and half the
           * corpus is TRANSCRIBED SPEECH — where people conjugate freely and rarely
           * repeat a term in the exact form someone later searches for. Dense
           * retrieval papers over some of it; the hybrid mode's lexical half simply
           * misses.
           *
           * ⚠ APPLIED AT CREATION ONLY. A corpus that already exists keeps whatever
           * it was made with — setting this does not retro-fix one. Existing
           * corpora need `client.corpora.update`, or to be rebuilt.
           */
          language: CORPUS_LANGUAGE,
          ...(callbackUrl ? { callbackUrl } : {}),
        }),
      {
        label: `ingest document ${docId}`,
        // `console`, like every other log line in this function: the `payload`
        // handle here is the narrow no-transaction `Pick<BasePayload,'update'>`
        // and carries no logger.
        log: { warn: (obj, msg) => console.warn(msg, obj) },
      },
    )
    // 🔴 `ingestId` ONLY, as one narrow `UPDATE`. The ai-service callback can
    // land BEFORE this line (measured ~1 ms early on the fake provider), and a
    // whole-row `payload.update` would write back the `embedding` it had read,
    // erasing the callback's `ready`. `lib/documentColumns.ts`.
    const { updateDocumentColumns } = await import('@/lib/documentColumns')
    await updateDocumentColumns(payload as never, { id: docId, data: { ingestId: result.ingestId } })
    console.log(
      `[documents] enqueued ingest for doc ${docId} → ingestId=${result.ingestId} corpus=${corpus}`,
    )
  } catch (err) {
    console.error('[documents] ingest.enqueue failed for doc', docId, err)
    // Use the same no-transaction `payload` handle as every other write here.
    // This used to be `req.payload`, whose transaction has already committed by
    // the time this `setImmediate` body runs — so the one write that reports a
    // FAILURE was the one most likely to be silently dropped.
    await payload.update({
      collection: 'documents',
      id: docId as never,
      data: {
        ingestStatus: 'failed',
        ingestError: `ingest_enqueue_failed: ${err instanceof Error ? err.message : String(err)}`.slice(
          0,
          500,
        ),
      },
      overrideAccess: true,
      context: { __skipDocsExtract: true },
    })
  }
}

// ---------------------------------------------------------------------------
// Audio → transcript
// ---------------------------------------------------------------------------

/**
 * Hand one audio document to `services/audio-service` and record the job id.
 *
 * Split out and exported for the same reason as {@link enqueueIngestForDoc}: it
 * can then be exercised without booting Payload or the `@payload-config` module
 * graph, and the code under test is the code that runs.
 *
 * ⚠ THIS FUNCTION NEVER PRODUCES TEXT AND NEVER CALLS ai-service. It returns as
 * soon as audio-service has accepted the job (HTTP 202). Everything after that
 * arrives at `/api/ai-service/callback`.
 *
 * ⚠ NO RETRY LOOP HERE, deliberately. audio-service owns retries (its own
 * schedule, plus a reconciler that turns a killed job into a real
 * `transcribe.failed`). A retry from this side would pay for the same
 * CPU-hours twice. A human retry goes through `POST /api/documents/:id/retry`,
 * which bumps `transcribeAttempt` so the idempotency key changes.
 */
export async function startTranscription(args: {
  payload: Pick<
    Awaited<ReturnType<typeof import('payload').getPayload>>,
    'update' | 'findByID'
  >
  docId: string | number
  fresh: Pick<
    DocumentRow,
    'name' | 'kind' | 'mediaFile' | 'transcribeId' | 'transcribeAttempt' | 'organization' | 'uploadedBy'
  >
  /**
   * Test seam. Production STREAMS the recording from object storage or local
   * disk, never copying it into memory — see {@link openMediaStream}.
   */
  openMedia?: typeof openMediaStream
}): Promise<void> {
  const { payload, docId, fresh } = args

  // The afterChange hook re-fires on every save, including the saves this
  // function makes. One job per document per attempt.
  if (fresh.transcribeId) return

  const fail = async (code: string, message: string): Promise<void> => {
    console.error('[documents] transcription not started for doc', docId, code, message)
    await payload.update({
      collection: 'documents',
      id: docId as never,
      data: { ingestStatus: 'failed', ingestError: `${code}: ${message}`.slice(0, 500) },
      overrideAccess: true,
      context: { __skipDocsExtract: true },
    })
  }

  const mediaId = resolveId(fresh.mediaFile)
  if (mediaId == null) return void (await fail('no_media', 'this document has no audio file'))

  const { ingestCallbackUrl, missingCallbackConfig } = await import('@/lib/callbackConfig')
  const callbackUrl = ingestCallbackUrl()
  if (!callbackUrl) {
    // 🔴 FAIL, DO NOT DEGRADE — and this is the one place audio diverges from
    // the PDF path on purpose. A PDF with no callback still gets its text and
    // its chunks; only the final status flip is lost. For audio the callback IS
    // the delivery mechanism for the transcript, so without it the row would sit
    // in `transcribing` forever with nothing anywhere able to move it. A visible
    // failure the user can retry beats an honest-looking spinner that never ends.
    return void (await fail(
      'callbacks_not_configured',
      `transcription needs the callback round-trip (missing: ${missingCallbackConfig().join(', ')})`,
    ))
  }

  const { submitTranscription, TRANSCRIBE_LANGUAGE } = await import('@/lib/audioClient')

  let media: Awaited<ReturnType<typeof openMediaStream>>
  try {
    media = await (args.openMedia ?? openMediaStream)(payload, mediaId)
  } catch (err) {
    return void (await fail(
      'media_unreadable',
      err instanceof Error ? err.message : String(err),
    ))
  }

  const attempt = Number(fresh.transcribeAttempt ?? 0) || 0
  // ⚠ Released whatever happens below: an unread S3 body holds its socket.
  let result: Awaited<ReturnType<typeof submitTranscription>>
  try {
    // Visible BEFORE the network call, so a hanging audio-service still shows the
    // user something true rather than looking like nothing happened.
    await payload.update({
      collection: 'documents',
      id: docId as never,
      data: { ingestStatus: 'transcribing', ingestError: null },
      overrideAccess: true,
      context: { __skipDocsExtract: true },
    })

    result = await submitTranscription({
      body: media.body,
      filename: media.filename,
      contentType: media.contentType,
      // The join key back to this row. The callback echoes it as `externalId`.
      externalId: String(docId),
      title: fresh.name ?? null,
      // ⚠ The attempt number is IN the key. audio-service dedupes on it within our
      // (org, project), which is what makes a double-fire of the hook free — but
      // it also means a retry reusing the key would silently re-adopt the failed
      // job instead of transcribing again.
      idempotencyKey: `doc-${docId}-a${attempt}`,
      callbackUrl,
      language: TRANSCRIBE_LANGUAGE,
      // ⚠ DECORATIVE — log correlation only. audio-service does not and must not
      // scope anything on these; see the header of `lib/audioClient.ts`.
      metadata: {
        docId: String(docId),
        organizationId: String(resolveId(fresh.organization) ?? ''),
        uploadedById: String(resolveId(fresh.uploadedBy) ?? ''),
        kind: 'audio',
      },
    })
  } finally {
    media.close()
  }

  if (!result.ok) {
    return void (await fail(result.code, result.message))
  }

  await payload.update({
    collection: 'documents',
    id: docId as never,
    data: {
      transcribeId: result.transcribeId,
      transcribeAttempt: attempt,
      // Known already: audio-service runs ffprobe inline before it answers 202.
      // This is what lets the UI quote an honest wait instead of a spinner.
      audioMeta: { durationSeconds: result.durationSeconds },
    },
    overrideAccess: true,
    context: { __skipDocsExtract: true },
  })
  console.log(
    `[documents] transcription started for doc ${docId} → transcribeId=${result.transcribeId}` +
      (result.deduplicated ? ' (idempotency hit — re-adopted the existing job)' : ''),
  )
}

/**
 * Read a media row's bytes, from wherever that row's bytes actually live.
 *
 * 🔴 THE ONE PLACE THAT KNOWS WHERE UPLOADS ARE STORED. Both the text-extract
 * path and the audio-transcription path go through here, and they used to each
 * hardcode `path.resolve(process.cwd(), 'media', filename)` instead.
 *
 * That assumption silently stopped being true when uploads moved to
 * S3-compatible object storage: Payload no longer writes to `./media/`, so
 * every pdf/docx extraction failed with ENOENT and every audio upload failed
 * with "Unable to open file as blob". Neither had a test that could see it —
 * the unit tests inject their own reader, and nothing exercised a real upload
 * against a configured bucket until the first end-to-end run.
 *
 * ⚠ The S3 key is `${prefix}/${filename}`, NOT `filename`. The plugin writes
 * the per-document prefix (`eco_{orgId}/u_{uploaderId}`) onto the media row and
 * that is part of the key. Reading without it 404s on every object.
 *
 * Local disk remains supported and is still the no-config default, so a bare
 * `pnpm dev` with no S3 variables behaves exactly as before.
 */
async function loadMediaBytes(
  payload: Pick<Awaited<ReturnType<typeof import('payload').getPayload>>, 'findByID'>,
  mediaId: string | number,
): Promise<{ bytes: Buffer; filename: string; contentType: string | null }> {
  const { filename, contentType, key } = await locateMedia(payload, mediaId)
  const { isStorageConfigured } = await import('@/lib/storage/client')
  try {
    if (isStorageConfigured()) {
      const { getObjectBytes } = await import('@/lib/storage/client')
      const { bytes } = await getObjectBytes(key)
      return { bytes, filename, contentType }
    }

    const fs = await import('node:fs/promises')
    const bytes = await fs.readFile(await localMediaPath(filename))
    return { bytes, filename, contentType }
  } catch (err) {
    // 🔴 The callers write this message into `ingestError`, which every member
    // reads on a published row. See `storageErrorReason`.
    throw new Error(storageErrorReason(err, mediaId, filename, key))
  }
}

/**
 * Where a media row's bytes live: its filename, type, and S3 key.
 *
 * ⚠ The S3 key is `${prefix}/${filename}`, NOT `filename` — see
 * {@link loadMediaBytes}.
 */
async function locateMedia(
  payload: Pick<Awaited<ReturnType<typeof import('payload').getPayload>>, 'findByID'>,
  mediaId: string | number,
): Promise<{ filename: string; contentType: string | null; key: string }> {
  const media = (await payload.findByID({
    collection: 'media',
    id: mediaId as never,
    depth: 0,
    overrideAccess: true,
  })) as { filename?: string | null; mimeType?: string | null; prefix?: string | null } | null

  const filename = media?.filename
  if (!filename) throw new Error(`media ${mediaId} has no filename`)
  const prefix = (media?.prefix ?? '').replace(/^\/+|\/+$/g, '')
  return {
    filename,
    contentType: media?.mimeType ?? null,
    key: prefix ? `${prefix}/${filename}` : filename,
  }
}

/**
 * The local-disk path of an upload when no object storage is configured.
 *
 * ⚠ `./media/` is Payload's default `staticDir` — an existing assumption. It
 * also means the backend and audio-service must not be assumed to share a
 * filesystem: we read the bytes and POST them.
 */
async function localMediaPath(filename: string): Promise<string> {
  const path = await import('node:path')
  return path.resolve(process.cwd(), 'media', filename)
}

/**
 * A storage read failure as a message SAFE TO STORE ON THE ROW.
 *
 * 🔴 `ENOENT: …, open '/app/media/Testimonio de María López.pdf'` and
 * `object <bucket>/<key> returned no body` both quote the uploader's filename,
 * and `ingestError` is shown to every member of the ecosistema on a published
 * row — the same filename `gatedQueryableReadable` hides. The filename, the key
 * and any absolute path are cut out; the error code and the media id stay, so
 * an operator still knows what failed and where to look.
 */
export function storageErrorReason(
  err: unknown,
  mediaId: string | number,
  filename: string,
  key: string,
): string {
  const raw = err instanceof Error ? err.message : String(err)
  const code = (err as { code?: unknown; name?: unknown } | null)?.code ?? (err as Error)?.name
  let scrubbed = raw
  for (const secret of [key, filename].filter(Boolean)) scrubbed = scrubbed.split(secret).join('<archivo>')
  scrubbed = scrubbed
    // Absolute paths and bucket/key paths, quoted or bare.
    .replace(/'[^']*<archivo>[^']*'|"[^"]*<archivo>[^"]*"|\S*<archivo>\S*/g, '<archivo>')
    .replace(/(?:\/[\w.-]+)+/g, '<ruta>')
  const prefix = typeof code === 'string' && code && !scrubbed.includes(code) ? `${code}: ` : ''
  return `could not read the stored file for media ${mediaId}: ${prefix}${scrubbed}`.slice(0, 400)
}

/**
 * Open a media row's bytes FOR STREAMING, from wherever they are stored.
 *
 * 🔴 NO COPY OF THE RECORDING IS MADE IN MEMORY (audit I-10). The previous
 * version went through {@link loadMediaBytes} and then copied the Buffer into a
 * Uint8Array and that into a Blob, then undici's FormData read it again.
 * Measured 2026-10-17 with `scripts/measure-audio-upload-rss.mjs` on the dev
 * box, Node 22.23.2, a 200 MB file, a throwaway RustFS on tmpfs, fake
 * audio-service on localhost: peak RSS 1,213 MB from object storage and
 * 1,088 MB from local disk. The streaming path: 147 MB and 113 MB, the same
 * as with a 100 MB file (145 MB / 112 MB). Now:
 *
 *   · object storage → the S3 response stream (`openObjectStream`), read only
 *     as the upload to audio-service pulls it;
 *   · local disk → `fs.openAsBlob`, a FILE-BACKED blob read lazily as the
 *     request body streams.
 *
 * Either way the object is OPENED here, so a missing file fails before the row
 * is marked `transcribing` (`media_unreadable`), not halfway through the POST.
 *
 * ⚠ `close()` MUST be called once the upload is over, sent or not — an unread
 * S3 body holds its connection. `startTranscription` does it in a `finally`.
 */
export async function openMediaStream(
  payload: Pick<Awaited<ReturnType<typeof import('payload').getPayload>>, 'findByID'>,
  mediaId: string | number,
): Promise<{
  body: import('@/lib/audioClient').AudioBody
  filename: string
  contentType: string | null
  close(): void
}> {
  const { filename, contentType, key } = await locateMedia(payload, mediaId)
  const { isStorageConfigured } = await import('@/lib/storage/client')
  try {
    if (isStorageConfigured()) {
      const { openObjectStream } = await import('@/lib/storage/client')
      const object = await openObjectStream(key)
      return {
        body: { size: object.size, stream: object.stream },
        filename,
        contentType: contentType ?? object.contentType,
        close: object.close,
      }
    }

    const { openAsBlob } = await import('node:fs')
    const body = await openAsBlob(await localMediaPath(filename), {
      type: contentType ?? 'application/octet-stream',
    })
    return { body, filename, contentType, close: () => {} }
  } catch (err) {
    // 🔴 Written into `ingestError`. See `storageErrorReason`.
    throw new Error(storageErrorReason(err, mediaId, filename, key))
  }
}

async function extractText(
  payload: Awaited<ReturnType<typeof import('payload').getPayload>>,
  mediaId: string | number,
  kind: 'pdf' | 'docx',
): Promise<string> {
  // ⚠ Goes through `loadMediaBytes`, which knows whether this deployment keeps
  // uploads on local disk or in the bucket. This function used to resolve
  // `./media/<filename>` itself, which broke the moment object storage was
  // enabled — see the header on `loadMediaBytes`.
  const { bytes: buffer } = await loadMediaBytes(payload, mediaId)

  if (kind === 'pdf') {
    // Workaround for a known dev-only issue: `drizzle-kit` (transitive via
    // Payload's postgres adapter) defines `Array.prototype.random`, which
    // pdfjs's defensive `for...in` checks reject with "unexpected enumerable
    // property." We temporarily mark the property non-enumerable for the
    // duration of the extract, then restore it. No-op in production builds
    // where drizzle-kit isn't loaded into the runtime.
    const arrProto = Array.prototype as unknown as Record<string, unknown>
    const hadRandom = Object.prototype.hasOwnProperty.call(arrProto, 'random')
    let restore: (() => void) | null = null
    if (hadRandom) {
      const desc = Object.getOwnPropertyDescriptor(arrProto, 'random')
      if (desc?.enumerable) {
        Object.defineProperty(arrProto, 'random', { ...desc, enumerable: false })
        restore = () => Object.defineProperty(arrProto, 'random', desc)
      }
    }
    try {
      const { extractText: extractPdfText, getDocumentProxy } = await import('unpdf')
      const pdf = await getDocumentProxy(new Uint8Array(buffer))
      const { text } = await extractPdfText(pdf, { mergePages: true })
      return Array.isArray(text) ? text.join('\n\n') : text
    } finally {
      restore?.()
    }
  }
  // docx
  const mammoth = (await import('mammoth')).default ?? (await import('mammoth'))
  const result = await mammoth.extractRawText({ buffer })
  return result.value
}

export const Documents: CollectionConfig = {
  slug: 'documents',
  // 🔴 See the `anonymise` field: field access reads it off projected rows.
  forceSelect: { anonymise: true },
  admin: {
    useAsTitle: 'name',
    defaultColumns: ['name', 'publicationStatus', 'organization', 'uploadedBy', 'ingestStatus'],
  },
  access: {
    read: visibleToCaller,
    update: uploaderOnly,
    delete: uploaderOnly,
    create: ({ req: { user } }) => Boolean(user),
  },
  fields: [
    {
      /**
       * ⚠ THE ECOSISTEMA. Half of every corpus name this document touches, and
       * the scope of who may see it once published.
       *
       * Always derived — from the session it was uploaded into, or from the
       * uploader's sole membership. NEVER accepted from a request body; see
       * `bindDocumentToEcosystem`.
       */
      name: 'organization',
      type: 'relationship',
      relationTo: 'organizations',
      required: true,
      index: true,
      admin: {
        readOnly: true,
        description: 'Derived on upload. The ecosistema this document belongs to.',
      },
    },
    {
      /**
       * ⚠ THE OTHER HALF OF THE DRAFT CORPUS NAME, and the whole of the draft
       * visibility rule. Drafts are private PER PERSON, not per ecosistema.
       */
      name: 'uploadedBy',
      type: 'relationship',
      relationTo: 'users',
      required: true,
      index: true,
      // 🔴 Who recorded it. Hidden from colleagues on gated content, by row and
      // by query — see `gatedQueryableReadable` and `constrainGatedQueries`.
      access: { read: gatedQueryableReadable },
      admin: { readOnly: true, description: 'Taken from the session. Immutable.' },
    },
    {
      /**
       * ⚠ ONLY `published` IS SHARED. Everything else — `draft` and the two
       * in-flight states — is visible to `uploadedBy` alone.
       *
       * The in-flight states are not decoration. Publishing re-embeds the
       * document into a different corpus, which is slow and can fail, so a row
       * can legitimately sit in `publishing` for a while. Leaving it there with
       * `publicationError` populated is what makes a failure VISIBLE and
       * RETRYABLE instead of silently stuck. See `lib/publishDocument.ts`.
       *
       * ⚠ Moved ONLY by that state machine, which writes with
       * `overrideAccess: true`. A direct client PATCH is stripped in
       * `bindDocumentToEcosystem` — otherwise a document could be marked shared
       * without a single chunk of it being in the shared corpus.
       */
      name: 'publicationStatus',
      type: 'select',
      required: true,
      defaultValue: 'draft',
      index: true,
      // Derived from PUBLICATION_STATES so the column and the state machine
      // cannot fall out of step; the labels are the only hand-written part.
      options: PUBLICATION_STATES.map((value) => ({ value, label: PUBLICATION_LABELS[value] })),
      admin: { position: 'sidebar' },
    },
    {
      name: 'publicationError',
      type: 'textarea',
      admin: {
        readOnly: true,
        position: 'sidebar',
        description:
          'Why the last publish/unpublish did not finish. Populated with the status left at the in-flight value — that pair means "retryable", not "broken".',
      },
    },
    {
      /**
       * ⚠ SEPARATE FROM `ingestId`, deliberately. `ingestId` belongs to the
       * ORIGINAL draft ingest. If the publish re-ingest reused it, the draft's
       * own late `ingest.completed` callback would be read as "publish
       * confirmed" and would retire the draft copy before anything was actually
       * in the shared corpus.
       */
      name: 'publishIngestId',
      type: 'text',
      index: true,
      admin: { readOnly: true, description: 'ai-service ingestId of the in-flight publish move.' },
    },
    {
      /**
       * 🔴 WHICH CONVERSATIONS THIS DOCUMENT IS ATTACHED TO. Plural, and
       * OPTIONAL.
       *
       * ⚠ ATTACHING IS SHARING, NEVER MOVING. Adding a second conversation does
       * not detach the first — the same document can be in as many
       * conversations as its owner wants. That is what makes the retrieval rule
       * ("a DRAFT is only searchable from the conversations it is attached to")
       * expressible without ever hiding a document from a conversation that was
       * already using it.
       *
       * ⚠ Still OPTIONAL. Deleting a session leaves the row standing with one
       * fewer attachment, UNLESS the document belongs to that conversation
       * alone (a `documento` or `testimonio` draft uploaded there, attached
       * nowhere else and referenced by nothing else) — then it goes too. The
       * rule is `lib/conversationUploads.ts`.
       *
       * ⚠ EVERY attached conversation must belong to the caller AND to the SAME
       * ecosistema as the document. Both are enforced in
       * `bindDocumentToEcosystem`, not here — a `hasMany` relationship field
       * validates the target rows exist, nothing more.
       */
      name: 'session',
      type: 'relationship',
      relationTo: 'sessions',
      hasMany: true,
      index: true,
      // 🔴 The uploader's conversation. Same rule as `uploadedBy`.
      access: { read: gatedQueryableReadable },
      admin: {
        description:
          'The conversations this document is attached to, if any. Attaching shares it with another conversation; it never moves it out of the ones it is already in.',
      },
    },
    {
      /**
       * 🔴 THE CONVERSATION THIS DOCUMENT WAS UPLOADED IN. Singular, and only
       * ever set by the server.
       *
       * `session` above says where a document is attached NOW; attaching is
       * sharing, so it cannot say where the document came from. This field
       * does. A conversation delete takes a document with it only when this
       * names THAT conversation (`lib/conversationUploads.ts`), so a document
       * uploaded in conversation B and shared into A is never deleted with A.
       *
       * ⚠ Stamped in `bindDocumentToEcosystem` on a signed-in create that
       * names exactly one conversation (the chat upload,
       * `POST /api/sessions/:id/documents`), and IMMUTABLE afterwards, like
       * `uploadedBy`. A client-supplied value is overwritten on create and
       * pinned on update.
       *
       * ⚠ NULL means "not recorded": every row created before the column
       * existed, a server-side create, a create naming several conversations,
       * and every row whose origin conversation was deleted (the foreign key
       * is `ON DELETE SET NULL`). How the cascade reads a NULL is in
       * `lib/conversationUploads.ts`.
       */
      name: 'uploadedInSession',
      type: 'relationship',
      relationTo: 'sessions',
      // The `ON DELETE SET NULL` of every conversation delete looks rows up by
      // this column.
      index: true,
      // 🔴 Who recorded a testimonio, and in which conversation. Same rule as
      // `session`, and listed in GATED_QUERYABLE_FIELDS for the same reason.
      access: { read: gatedQueryableReadable },
      admin: {
        readOnly: true,
        description: 'The conversation this document was uploaded in. Set by the server. Immutable.',
      },
    },
    {
      name: 'kind',
      type: 'select',
      required: true,
      defaultValue: 'markdown',
      options: [
        { label: 'Markdown', value: 'markdown' },
        { label: 'PDF', value: 'pdf' },
        { label: 'DOCX', value: 'docx' },
        /**
         * ⚠ An audio document's TEXT is a machine transcription. It is a
         * first-class document — citable, publishable — and it can contain ASR
         * errors presented as fact. `kind` is what the UI keys the
         * "Transcripción automática" label off; do not let it be lost.
         */
        { label: 'Audio', value: 'audio' },
      ],
    },
    {
      /**
       * 🔴 WHAT THIS MATERIAL *IS* — as opposed to what file it arrived in.
       *
       *   documento    a source somebody uploaded under their own name
       *   testimonio   a Voz: someone's words, filed by an Investigador
       *   conversacion a chat turn ingested back into the corpus
       *
       * ⚠ NOT `kind`, WHICH IS THE FILE FORMAT. A `testimonio` is usually
       * `kind: 'audio'`; a `documento` is usually `kind: 'pdf'`. Reading one for
       * the other is how a testimony reaches a corpus unscrubbed.
       *
       * ⚠ AND THE CORPUS GRAPH READS IT. The person rule and the snippet rule
       * both key off this column and nothing else (`lib/graph/`). Changing its
       * values or its semantics silently weakens both.
       *
       * ⚠ IMMUTABLE, and gated on `voces:upload` at creation — see
       * `enforceVocesUploadRights`. It decides whether the anonymisation gate
       * runs, and the gate runs at ingest time, so a value that could change
       * afterwards would be a value that could be changed AFTER the gate was
       * skipped.
       *
       * 🔴 THERE IS NO SUBJECT FIELD NEXT TO THIS ONE, AND THAT IS DELIBERATE.
       * A testimony is anonymous, full stop. We do not store who it came from —
       * not a name, not a code, not a hidden column. The Investigador knows
       * offline; the system never does. A stored subject is a re-identification
       * map, which is the exact thing the anonymisation design refuses to keep,
       * just living in a column instead. There is no consent-level field either:
       * one rule means no default for a bulk upload to get wrong.
       */
      name: 'contentKind',
      type: 'select',
      required: true,
      defaultValue: DEFAULT_CONTENT_KIND,
      index: true,
      // Derived from CONTENT_KINDS so the column and the domain type cannot fall
      // out of step; the labels are the only hand-written part.
      options: CONTENT_KINDS.map((value) => ({ value, label: CONTENT_KIND_LABELS[value] })),
    },
    {
      /**
       * 🔴 A `documento` THAT MUST PASS THE ANONYMISATION GATE (owner rulings
       * 2026-10-26): every participant PDF/DOCX (set by
       * `enforceVocesUploadRights`), and staff material that names people when
       * the uploader ticks "Anonimizar" (or a script sends `anonymise: true`).
       *
       * It stays a `documento` — own title, own label, the documento graph rule
       * — but its text is gated like a testimonio's (`anonymiseRequested`,
       * `lib/anonymiseDocument.ts`). Fixed at create: un-setting it on a held
       * row would publish the raw original.
       *
       * ⚠ IN `forceSelect`: `mayReadGatedOriginal` reads it off projected rows.
       * That covers include-mode selects only — an exclude-mode select can still
       * drop it, which is why `mayReadGatedOriginal` requires `=== false`.
       */
      name: 'anonymise',
      type: 'checkbox',
      defaultValue: false,
      access: { update: gateWritesOnly },
      admin: { position: 'sidebar' },
    },
    {
      /**
       * The programme this document belongs to — `traduccion`, `dengue`,
       * `escuela`, `discapacidad` in the seeded corpus. The corpus's own
       * ground truth, which the product had nowhere to put until now.
       *
       * 🔴 THE MANIFEST CALLS THIS COLUMN `ecosistema` AND THIS FIELD DOES NOT,
       * DELIBERATELY. In this product an "ecosistema" IS an `organizations` row
       * (`lib/corpus.ts`), and tenant scoping is the single most load-bearing
       * rule in the codebase — `plan/adr-corpus-graph.md` §6 gate 1 is "name the
       * organization explicitly, always". A `documents.ecosistema` column
       * sitting next to `documents.organization` invites exactly one mistake:
       * `where: { ecosistema: … }` written by somebody who believes they have
       * just scoped a tenant, and who has not. `sprint0/00-context.md` already
       * carries the warning in prose — *"the corpus's four `ecosistema` values
       * are a column on the row, not separate tenants"* — which is evidence the
       * confusion has happened at least once. `tema` is the corpus's own word
       * for the same axis (`seed/corpus.ts` calls the map `THEME_LABELS`) and it
       * matches the graph's `tema` entity type, which means the same thing.
       *
       * ── WHY `text` AND NOT `select` ─────────────────────────────────────────
       *
       * It is a closed set of four TODAY, and a `select` would be the obvious
       * fit if these were product vocabulary. They are not — they are DATA, from
       * `corpus-generativo`, which is a separate repo regenerated by a script.
       * A `select` compiles to a Postgres enum, so a regenerated corpus with a
       * fifth programme fails the seed on row 1 with `invalid input value for
       * enum`, and adding the value means an `ALTER TYPE` migration. Nothing in
       * the product branches on the value either: unlike `contentKind`, `kind`
       * or `anonymisationStatus`, this is a label to group and filter by, not a
       * state anything switches on. `text` costs a typo-catching dropdown that
       * nobody can reach anyway, because the field is not writable over the API.
       *
       * ⚠ NOT INDEXED, on purpose. Four distinct values over a few hundred rows
       * is a selectivity no planner will use a btree for. If a library facet ever
       * needs one, the right index is the composite `(organization_id, tema)` —
       * the same shape as `documents_organization_publication_status_idx` — and
       * that is a measured change, not a default.
       */
      name: 'tema',
      type: 'text',
      access: { create: gateWritesOnly, update: gateWritesOnly },
      admin: {
        readOnly: true,
        description:
          'El programa del que forma parte este documento (traducción, dengue, escuela, discapacidad). Lo escribe el seed o el backfill desde el manifiesto del corpus; no se edita aquí.',
      },
    },
    {
      /**
       * 🔴 THE LANGUAGE OF THE PEOPLE THIS DOCUMENT IS ABOUT — NOT THE LANGUAGE
       * IT IS WRITTEN IN. Every document in the seeded corpus is in Spanish.
       *
       * 11 values there (`mixteco`, `náhuatl`, `mazateco`, `tlapaneco (me'phaa)`,
       * `totonaco`, `zapoteco`, `amuzgo`, `mixe`, `hñähñu (otomí)`, `tlahuica`,
       * `tsotsil`), and open in principle — Mexico recognises 68 indigenous
       * languages before variants, so this is `text` for a stronger reason than
       * `tema` is: the set is not closed even in this corpus's own future.
       *
       * 🔴 IT IS NULL FOR ANYTHING THAT IS NOT A `documento`, AND THAT RULE IS
       * ENFORCED TWICE. Read `enforceLenguaDocumentoOnly` for why it is a
       * re-identification key on a `testimonio` and merely a restatement of the
       * document's own text on a `documento`. The write hook nulls it; the
       * `read` access below hides it. Two mechanisms for one rule, both column
       * lookups, both failing closed — ADR §5.3's pattern.
       *
       * ⚠ THE CONSEQUENCE, STATED RATHER THAN DISCOVERED: 59 of the 250 seeded
       * documents are testimonios and will never carry a `lengua`. "Which
       * languages appear in this ecosistema" is therefore answered from the 191
       * `documento` rows only. That is the correct answer, not a gap to close
       * later — and it happens to be unclosable by accident anyway, because
       * `seed/corpus.ts` keeps the manifest join key off a testimonio's title.
       *
       * ⚠ NOT INDEXED — see `tema`.
       */
      name: 'lengua',
      type: 'text',
      access: {
        create: gateWritesOnly,
        update: gateWritesOnly,
        read: lenguaReadable,
      },
      admin: {
        readOnly: true,
        description:
          '⚠ La lengua de las personas de las que habla el documento, no el idioma en que está escrito. Sólo se guarda en un `documento`; en un testimonio es una llave de reidentificación y queda vacía.',
      },
    },
    {
      /**
       * The gate's output, and the ONLY text a `testimonio` is ever embedded
       * from.
       *
       * ⚠ BESIDE the original, never over it. `extractedText` stays as the
       * record of what was actually said, access-controlled in Postgres and
       * never sent to any corpus. Overwriting it would destroy the only copy of
       * what the person gave.
       */
      name: 'redactedText',
      type: 'textarea',
      maxLength: DOCUMENT_TEXT_MAX_LENGTH,
      // 🔴 See `gateWritesOnly`. `admin.readOnly` is a panel hint; this is the rule.
      access: { create: gateWritesOnly, update: gateWritesOnly },
      admin: {
        readOnly: true,
        description:
          'What the anonymisation gate produced. This — not `extractedText` — is what gets embedded for a testimonio or a conversacion.',
      },
    },
    {
      /**
       * 🔴 A TESTIMONIO'S SYSTEM-PROPOSED TITLE (owner ruling 2026-10-24).
       *
       * Generated from the gate's REDACTED output only — `redactedText` once
       * cleared, `heldText` on a hold (`lib/testimonioTitle.ts`). NULL = not generated yet or generation
       * failed; the UI then shows "Testimonio · <tema>". Never `name`: that is
       * the uploader's free-text filename and never went through the gate.
       *
       * ⚠ Read: like `redactedText` once cleared; like `heldText` on a held row
       * (`mayReadTestimonioTitle`). Cleared by the gate's claim, so a re-gated
       * row never shows an old title, and by a rejection.
       */
      name: 'testimonioTitle',
      type: 'text',
      access: { create: gateWritesOnly, update: gateWritesOnly, read: testimonioTitleReadable },
      admin: {
        readOnly: true,
        description:
          'Título propuesto por el sistema a partir del texto anonimizado. Sólo en testimonios.',
      },
    },
    {
      /**
       * 🔴 WHAT A REVIEWER READS. NEVER WHAT A CORPUS READS.
       *
       * The gate's best-effort output at the moment it REFUSED — redacted as far
       * as it got, with (on a verify hold) something still standing in it. A
       * reviewer cannot judge a hold without it: the alternative is handing them
       * `extractedText`, the raw original, which is strictly worse.
       *
       * ⚠ IT IS A SEPARATE COLUMN FROM `redactedText` ON PURPOSE, and that is
       * the whole safety argument. `corpusTextFor` reads `redactedText`; if the
       * held text lived there, a publish would push the text the gate refused
       * straight into the shared corpus, and nothing downstream re-runs the gate
       * to catch it. Nothing reads this column except the review API.
       *
       * ⚠ Cleared when the hold is cleared — see `planIngestRetry`.
       */
      name: 'heldText',
      type: 'textarea',
      maxLength: DOCUMENT_TEXT_MAX_LENGTH,
      // 🔴 Read: uploader / platform admin only on gated content. Reviewers read
      // it through `lib/holdReview.ts` (overrideAccess). See `mayReadGatedOriginal`.
      access: { create: gateWritesOnly, update: gateWritesOnly, read: gatedOriginalReadable },
      admin: {
        readOnly: true,
        description:
          '⚠ El texto que la verificación RECHAZÓ. Sólo para revisión humana; nunca se ingiere.',
      },
    },
    {
      /**
       * Where the verify stage found something still standing, as OFFSETS into
       * `heldText`.
       *
       * 🔴 OFFSETS, NEVER STRINGS — see `SurvivorSpan` in `lib/anonymise/types.ts`
       * for why that is not a loophole in the counts-only rule. Short version: a
       * survivor was not removed, so it is already in `heldText`; pointing at it
       * adds nothing and saves a reviewer from re-reading a whole transcript.
       *
       * ⚠ MEANINGFUL ONLY AGAINST THE `heldText` THEY ARRIVED WITH. The two are
       * written together and cleared together, and nothing may update one alone.
       */
      name: 'anonymisationSurvivors',
      type: 'json',
      access: { create: gateWritesOnly, update: gateWritesOnly, read: gatedOriginalReadable },
      admin: {
        readOnly: true,
        description: 'Posiciones (no texto) de lo que la verificación encontró todavía presente.',
      },
    },
    {
      /**
       * 🔴 `held` IS NOT `failed`, AND THE DIFFERENCE IS THE POINT.
       *
       *   n/a      not gated: an ordinary `documento`
       *   pending  the gate is running
       *   held     🔴 THE GATE REFUSED. Not ingested, and there is no override.
       *   ready    cleared; `redactedText` is populated
       *
       * `failed` deliberately does not appear. A failure invites a retry button;
       * a hold means the gate looked at this and said no, and re-running it on
       * the same bytes will say no again. ai-service has no per-document delete,
       * so "ingest anyway" is not a state this product can offer.
       */
      name: 'anonymisationStatus',
      type: 'select',
      required: true,
      defaultValue: 'n/a',
      index: true,
      options: ANONYMISATION_STATES.map((value) => ({ value, label: ANONYMISATION_LABELS[value] })),
      // 🔴 THE SINGLE MOST IMPORTANT LOCK IN THIS COLLECTION. A client that could
      // write `approved` here would skip the gate outright — see `gateWritesOnly`.
      access: { create: gateWritesOnly, update: gateWritesOnly },
      admin: { position: 'sidebar' },
    },
    {
      name: 'anonymisationError',
      type: 'textarea',
      access: { create: gateWritesOnly, update: gateWritesOnly },
      admin: {
        readOnly: true,
        description:
          'Which stage refused, and why. ⚠ Counts only — it never quotes the text that triggered the hold, because that would be a re-identification map.',
      },
    },
    {
      /**
       * 🔴 COUNTS AND RULE NAMES ONLY. Never a removed string, never a mapping
       * from `[Persona A]` back to anything. A report that carried the matches
       * would be the re-identification map this whole design refuses to keep,
       * filed under a friendlier name. Enforced in `lib/anonymise/gate.ts` and
       * asserted in its tests.
       */
      name: 'anonymisationReport',
      type: 'json',
      access: { create: gateWritesOnly, update: gateWritesOnly },
      admin: {
        readOnly: true,
        description:
          'Per-stage counts of what the gate removed. Rule names and numbers — no removed text.',
      },
    },
    {
      name: 'mode',
      type: 'select',
      required: true,
      defaultValue: 'full-text',
      options: [
        { label: 'Full-text (inline as prompt context)', value: 'full-text' },
        { label: 'RAG retrieve', value: 'rag-retrieve' },
      ],
    },
    {
      name: 'name',
      type: 'text',
      required: true,
      defaultValue: 'Untitled document',
      // 🔴 The uploader's filename. Hidden from colleagues on gated content —
      // see `gatedQueryableReadable` and `constrainGatedQueries`.
      access: { read: gatedQueryableReadable },
    },
    {
      name: 'bodyMarkdown',
      type: 'textarea',
      maxLength: DOCUMENT_TEXT_MAX_LENGTH,
      // 🔴 Raw original text. See `mayReadGatedOriginal`.
      access: { read: gatedOriginalReadable },
      admin: {
        description: 'Markdown source. Used for kind=markdown.',
      },
    },
    {
      name: 'mediaFile',
      type: 'upload',
      relationTo: 'media',
      admin: {
        description:
          'Used for kind=pdf, docx or audio. For audio it is also the PROVENANCE: a member who distrusts a quoted line can play the source recording.',
      },
    },
    { name: 'isPinned', type: 'checkbox', defaultValue: true },
    {
      /**
       * 🔴 THE PIPELINE STATE MACHINE, AND IT MUST STAY HONEST.
       *
       *   n/a          markdown note — no pipeline at all
       *   pending      the row exists; nothing has happened yet
       *   extracting   PDF/DOCX only. Synchronous, seconds.
       *   transcribing AUDIO only. audio-service has the job. ⚠ ROUGHLY REAL
       *                TIME ON CPU: a one-hour recording is a one-hour wait.
       *   transcribed  the transcript is ON THE ROW but not embedded yet. A
       *                real, observable state: if the process dies between
       *                persisting the text and enqueuing the ingest, this is
       *                where the row stops, and it says exactly what is true.
       *   embedding    ai-service is chunking + embedding
       *   ready        retrievable and citable
       *   failed       terminal, with the reason in `ingestError`, and
       *                RETRYABLE via POST /api/documents/:id/retry
       *
       * ⚠ `extracting` is NOT reused for audio. It belongs to the synchronous
       * PDF/DOCX extractor, and borrowing it would tell an audio uploader their
       * one-hour job is a two-second one.
       *
       * ⚠ EVERY NON-TERMINAL STATE HAS SOMETHING THAT WILL MOVE IT. `embedding`
       * is moved by the ai-service callback; `transcribing` by audio-service,
       * including its reconciler, which turns a worker killed mid-job into a
       * real `transcribe.failed` rather than a row that waits forever.
       */
      name: 'ingestStatus',
      type: 'select',
      required: true,
      defaultValue: 'n/a',
      options: [
        { label: 'N/A (markdown)', value: 'n/a' },
        { label: 'Pending (queued)', value: 'pending' },
        { label: 'Extracting text', value: 'extracting' },
        { label: 'Transcribing (audio, ~real time)', value: 'transcribing' },
        { label: 'Transcribed (awaiting ingest)', value: 'transcribed' },
        { label: 'Embedding (awaiting ai-service)', value: 'embedding' },
        { label: 'Ready', value: 'ready' },
        { label: 'Failed', value: 'failed' },
      ],
    },
    {
      /**
       * Why the pipeline stopped, as `code: message`.
       *
       * ⚠ NOT decoration. A `failed` row with no reason is indistinguishable
       * from a bug, and the user cannot tell "wrong file" from "our service is
       * down" — the first they can fix, the second they should just retry. The
       * leading code is stable and is what the frontend maps to Spanish copy.
       */
      name: 'ingestError',
      type: 'textarea',
      admin: {
        readOnly: true,
        description: 'Why the last ingest/transcription attempt failed. `code: message`.',
      },
    },
    {
      name: 'ingestId',
      type: 'text',
      admin: {
        description: 'ai-service ingestId join-back key.',
      },
    },
    {
      /**
       * 🔴 THE CORPUS-GRAPH PIPELINE'S STATE, and it exists for one reason:
       * extraction has NOWHERE DURABLE TO RUN.
       *
       * There is no job queue in `apps/backend` (see `enqueueIngestForDoc`), so
       * extraction is a `setImmediate` and a backend restart mid-run LOSES IT.
       * That is not solved, it is made visible: this column is what turns a lost
       * run into something an operator and the backfill can find, instead of a
       * document that quietly contributes nothing to the graph forever.
       *
       *   n/a         never scheduled — a markdown note, or a row that predates
       *               the graph
       *   pending     scheduled; the deferred run has not started
       *   extracting  windows are being sent to the model
       *   ready       entities, mentions and relations are written
       *   failed      terminal, reason in `graphError`, retryable via
       *               POST /api/documents/:id/graph-retry
       *   skipped     nothing to extract from (no usable text). NOT an error.
       *
       * ⚠ SEPARATE FROM `ingestStatus`, deliberately. They can and do disagree:
       * a document can be `ready` for retrieval and `failed` for the graph. One
       * shared column would force a graph failure to look like a broken upload.
       */
      name: 'graphStatus',
      type: 'select',
      required: true,
      defaultValue: 'n/a',
      index: true,
      options: [
        { label: 'N/A (sin grafo)', value: 'n/a' },
        { label: 'En cola', value: 'pending' },
        { label: 'Extrayendo', value: 'extracting' },
        { label: 'Listo', value: 'ready' },
        { label: 'Falló', value: 'failed' },
        { label: 'Omitido (sin texto)', value: 'skipped' },
      ],
    },
    {
      /**
       * Why extraction stopped, as `code: message` — the same shape as
       * `ingestError`, so the frontend maps the leading code to Spanish copy the
       * same way.
       */
      name: 'graphError',
      type: 'textarea',
      /**
       * 🔴 GATED LIKE THE ORIGINAL. On a schema miss it carries up to 400
       * characters of the model's raw reply (`lib/graph/extract.ts`), which
       * quotes the text it was given. The uploader and a platform admin can
       * read it; a colleague on a published testimonio cannot.
       */
      access: { read: gatedOriginalReadable },
      admin: {
        readOnly: true,
        description: 'Por qué falló la última extracción del grafo. `code: message`.',
      },
    },
    {
      /**
       * 🔴 WHAT MAKES A CORPUS-WIDE RE-RUN POSSIBLE. Stamped with
       * `GRAPH_PROMPT_VERSION` on every run.
       *
       * Changing the extraction prompt invalidates the entities it produced. A
       * corpus with no stamp would be half-extracted by two different contracts
       * with nothing able to tell the halves apart; the backfill selects on
       * exactly this column (`lib/graph/backfill.ts`).
       */
      name: 'graphPromptVersion',
      type: 'text',
      index: true,
      admin: {
        readOnly: true,
        description:
          'Versión del prompt de extracción con la que se construyó el grafo de este documento.',
      },
    },
    {
      name: 'graphExtractedAt',
      type: 'date',
      admin: {
        readOnly: true,
        description: 'Cuándo terminó la última extracción del grafo.',
      },
    },
    {
      /**
       * The audio-service job id — the other join-back key.
       *
       * ⚠ Also the guard against a STALE callback. A retry mints a new job, and
       * a late callback from the old one names the same `externalId`; the
       * receiver only accepts a callback whose `transcribeId` matches this
       * field. Without that check an abandoned attempt could overwrite a good
       * transcript minutes after the fact.
       */
      name: 'transcribeId',
      type: 'text',
      index: true,
      admin: { readOnly: true, description: 'audio-service transcribeId join-back key.' },
    },
    {
      /**
       * How many times transcription has been (re)started for this document.
       *
       * ⚠ It is IN the idempotency key we send audio-service. Retrying with the
       * same key returns the ORIGINAL job — which after a genuine failure means
       * the retry silently does nothing.
       */
      name: 'transcribeAttempt',
      type: 'number',
      defaultValue: 0,
      admin: { readOnly: true, position: 'sidebar' },
    },
    {
      /**
       * Duration, detected language and ASR confidence for an audio document.
       *
       * `durationSeconds` lands at SUBMIT time, so the UI can quote a realistic
       * wait while the job runs. The rest arrives with `transcribe.completed`.
       */
      name: 'audioMeta',
      type: 'json',
      // ⚠ Its detected `language` is the same re-identification key `lengua` is
      // on a testimonio. Uploader / platform admin only on gated content.
      access: { read: gatedOriginalReadable },
      admin: {
        readOnly: true,
        description: 'Recording metadata: duration, language, confidence, model, chunk count.',
      },
    },
    {
      name: 'extractedText',
      type: 'textarea',
      maxLength: DOCUMENT_TEXT_MAX_LENGTH,
      // 🔴 THE UNREDACTED ORIGINAL. On a published testimonio, colleagues read
      // `redactedText`; this stays with the uploader. See `mayReadGatedOriginal`.
      access: { read: gatedOriginalReadable },
      admin: {
        description:
          'The document text: extracted for pdf/docx, TRANSCRIBED for audio. Cached so retries do not redo the work — which for audio is CPU-hours, not milliseconds.',
      },
    },
  ],
  hooks: {
    beforeOperation: [constrainGatedQueries],
    // ⚠ DO NOT FOLD `enforceLenguaDocumentoOnly` INTO `bindDocumentToEcosystem`.
    // Its own doc block says why; the short version is `!req.user`.
    beforeValidate: [bindDocumentToEcosystem, enforceLenguaDocumentoOnly],
    /**
     * ⚠ `invalidateGraphOnContentKindChange` runs on EVERY update, and it is
     * cheap: it returns immediately unless `contentKind` actually changed. It is
     * NOT folded into `extractAndIngestHook` because that hook is guarded by
     * `__skipDocsExtract`, which every internal status write sets — and a
     * privacy invalidation must not be skippable by an internal write path.
     */
    afterChange: [extractAndIngestHook, invalidateGraphOnContentKindChange],
    /**
     * ✅ CORPUS CLEANUP ON DELETE. Deleting a row used to leave its chunks
     * embedded and retrievable — the document vanished from the UI while the
     * ecosistema's assistant kept quoting it, citing something nobody could
     * open.
     *
     * ✅ A REAL DELETE NOW: `admin.deleteDocument` removes the document and its
     * chunks from both the draft and the shared corpus, under the ecosistema's
     * ai-service org. Retiring (closing the validity window) is only the
     * fallback when that call fails. See `retireDeletedDocument`.
     *
     * ⚠ `afterDelete`, not `beforeDelete`, on purpose: a document that could
     * not be retired should still be deletable. The user asked for it gone, and
     * refusing because a downstream service is unreachable would leave them
     * stuck with a row they cannot remove. The failure is logged instead.
     */
    beforeDelete: [scheduleMediaCleanupHook],
    afterDelete: [retireDeletedDocumentHook],
  },
  endpoints: [
    publishEndpoint(),
    unpublishEndpoint(),
    retryIngestEndpoint(),
    retryGraphEndpoint(),
  ],
}

// ---------------------------------------------------------------------------
// POST /api/documents/:id/publish  and  /unpublish
// ---------------------------------------------------------------------------

/**
 * Sharing a draft with the ecosistema, and taking it back.
 *
 * ⚠ THESE ARE NOT PLAIN FIELD WRITES, which is why they are endpoints rather
 * than a PATCH on `publicationStatus`. Publishing RE-EMBEDS the document into a
 * different corpus (isolation is by corpus name — see `lib/corpus.ts`), so it
 * is slow, costs tokens and can fail halfway. A PATCH that flipped a column
 * would claim a document was shared while none of its content was in the shared
 * corpus, and search would simply never find it.
 *
 * `POST` returns as soon as the move is ENQUEUED, not when it is done. The row
 * sits in `publishing` until ai-service calls back; the client should poll
 * `publicationStatus` (and show `publicationError` when it is populated).
 */
function documentActionEndpoint(
  action: 'publish' | 'unpublish',
): Endpoint {
  return {
    path: `/:id/${action}`,
    method: 'post',
    handler: async (req) => {
      const json = (body: unknown, status: number): Response =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        })
      const fail = (status: number, message: string): Response =>
        json({ errors: [{ message }] }, status)

      const user = req.user
      if (!user) return fail(401, 'Authentication required.')

      const id = (req.routeParams as { id?: string } | undefined)?.id
      if (!id) return fail(400, 'Missing document id.')

      // ⚠ Read UNDER ACCESS CONTROL. `uploaderOnly` is what makes "you may only
      // publish your own document" true; using overrideAccess here would let
      // anyone publish anyone's draft into the shared corpus.
      const doc = (await req.payload
        .findByID({ collection: 'documents', id: id as never, depth: 0, overrideAccess: false, user, req })
        .catch(() => null)) as unknown as {
        id: number | string
        publicationStatus?: unknown
        uploadedBy?: unknown
        organization?: unknown
      } | null

      if (!doc) return fail(404, 'No such document.')
      if (String(relationId(doc.uploadedBy) ?? '') !== String(user.id)) {
        return fail(403, 'Only the person who uploaded a document can publish it.')
      }
      const organizationId = relationId(doc.organization)
      if (organizationId == null) {
        // No ecosistema = no shared corpus and no ai-service org to publish into.
        return fail(409, 'This document has no ecosistema, so it cannot be published.')
      }

      const state = doc.publicationStatus
      if (action === 'publish' && state === 'published') {
        return json({ ok: true, publicationStatus: 'published', alreadyDone: true }, 200)
      }
      if (action === 'unpublish' && state === 'draft') {
        return json({ ok: true, publicationStatus: 'draft', alreadyDone: true }, 200)
      }

      // ⚠ THE ADMIN CLIENT, not the app one. Publishing does two things: an
      // ingest (any role) AND a `setDocumentValidity` call to retire the old
      // copy, which is an admin-role route. Using the app key would succeed at
      // the ingest and 403 on the retire — leaving the document in BOTH
      // corpora, published and still in drafts, with no error the user sees.
      const { getAdminAIClient } = await import('@/lib/aiClient')
      const { ingestCallbackUrl } = await import('@/lib/callbackConfig')

      let client
      try {
        client = getAdminAIClient(organizationId)
      } catch {
        // ⚠ Refuse rather than flip the column. Marking a document published
        // when the re-embed could not even be attempted is exactly the lie this
        // endpoint exists to prevent.
        return fail(
          503,
          'The AI service is not configured (AI_SERVICE_ADMIN_API_KEY), so documents cannot be published.',
        )
      }

      const deps = {
        payload: req.payload,
        client: client as never,
        callbackUrl: ingestCallbackUrl() ?? undefined,
      }

      try {
        const result =
          action === 'publish'
            ? await beginPublish(doc as never, deps)
            : await unpublish(doc as never, deps)
        return json(
          {
            ok: true,
            publicationStatus: action === 'publish' ? 'publishing' : 'unpublishing',
            ingestId: result.ingestId,
            corpus: result.corpus,
          },
          202,
        )
      } catch (err) {
        if (err instanceof NotPublishableError) return fail(409, err.message)
        req.payload.logger.error({ err, docId: id, action }, `[documents] ${action} failed`)
        return fail(500, `Could not ${action} this document.`)
      }
    },
  }
}

/**
 * ⚠ FUNCTION DECLARATIONS, NOT `const` ARROWS. They are CALLED in the
 * `endpoints` array of the collection object above, which is evaluated at
 * module load. A `const` arrow is not hoisted, so that call would hit the
 * temporal dead zone and the whole config would throw at import — taking the
 * server down at boot, before any of this ever ran.
 */
// ---------------------------------------------------------------------------
// POST /api/documents/:id/retry — re-run a FAILED ingest
// ---------------------------------------------------------------------------

/** The narrow slice of a row {@link planIngestRetry} reasons about. */
export interface RetryableDocument {
  kind?: string | null
  ingestStatus?: string | null
  extractedText?: string | null
  transcribeAttempt?: number | null
  anonymisationStatus?: string | null
  redactedText?: string | null
}

/**
 * 🔴 WHAT A RETRY ACTUALLY COSTS, decided as a pure function so it can be
 * tested and so the rule is written in one place.
 *
 * ⚠ THE EXPENSIVE MISTAKE THIS AVOIDS: blindly clearing `extractedText` on
 * every retry. If a transcript already exists and only the ai-service ingest
 * failed, clearing it would throw away a finished transcription and re-run the
 * recording through Whisper — CPU-hours, to redo work that succeeded. So:
 *
 *   · text already on the row → re-enqueue the INGEST only.
 *   · no text                → start over, and bump `transcribeAttempt` so the
 *                              idempotency key changes (an unchanged key makes
 *                              audio-service hand back the failed job and the
 *                              retry silently does nothing).
 *
 * Returns null when there is nothing to retry — a `ready` row, or a markdown
 * note that never had a pipeline.
 */
export function planIngestRetry(doc: RetryableDocument): Record<string, unknown> | null {
  if (!INGESTABLE_KINDS.has(String(doc.kind))) return null
  // Only a TERMINAL failure is retryable. Re-running a job that is still going
  // would double-transcribe and leave two callbacks racing for one row.
  if (doc.ingestStatus !== 'failed') return null

  /**
   * 🔴 A HUMAN DECISION IS NOT A TECHNICAL FAILURE, AND RETRY MUST NOT ERASE ONE.
   *
   * A held row is left at `ingestStatus: 'failed'` so the uploader is not
   * watching a spinner forever, which means a `rejected` or `approved` row is
   * also `failed` and would otherwise land in the branch below — where
   * `clearHold` resets the gate state to `n/a`. A reviewer's "no" would be
   * undone by the uploader pressing retry, and their "yes" would be replaced by
   * a fresh, differently-answered gate run.
   *
   * ⚠ THIS IS THE SAME BUG CLASS AS THE RENAME LOOP, one state along. Retry is
   * for "I fixed the source"; a reviewed document has no source problem.
   */
  if (doc.anonymisationStatus === 'rejected') return null

  /**
   * 🔴 AN APPROVED ROW RE-SENDS ITS APPROVED TEXT, AND KEEPS THE APPROVAL.
   *
   * A failure after a release is a TECHNICAL failure (a lost hook run, an
   * ai-service error), and refusing it left the document with no way out at
   * all: `sweepStalledPending` could not stamp it, the uploader could not retry
   * it. So the retry writes exactly what `holdReview.ts` writes on approval, the
   * gate fields untouched: the hook sees `approved` again and ingests
   * `redactedText` without re-running the gate.
   *
   * ⚠ No `redactedText`, no retry. The approval path never ingests
   * `extractedText`, so an approved row without its approved text has nothing
   * it may send.
   */
  if (doc.anonymisationStatus === 'approved') {
    const approved = typeof doc.redactedText === 'string' && doc.redactedText.trim().length > 0
    return approved ? { ingestStatus: 'pending', ingestError: null, ingestId: null } : null
  }

  /**
   * ⚠ CLEARS THE ANONYMISATION HOLD, and this is the ONLY place that does.
   *
   * `runExtractAndIngest` refuses to re-gate a `held` row, so without this a
   * retry would return 202 and then do nothing at all. Clearing it here is what
   * makes "I fixed the source, try again" a deliberate act with a single entry
   * point, instead of something a rename does by accident.
   *
   * 🔴 `redactedText` IS CLEARED TOO, AND THE COMMENT THAT USED TO SIT HERE WAS
   * WRONG. It claimed "either the gate held (so there is none) or it is about to
   * be overwritten by the next run".
   *
   * The first half is false: a row that ran `ready` and then FAILED at
   * ai-service still carries its redaction, and that row is exactly the one this
   * path exists for. The second half only holds if the next run succeeds — if it
   * HOLDS instead, the stale text survives on a row that now reads `held`, and
   * `corpusTextFor` would share it on the next publish. Reachable in five
   * ordinary steps, and permanent once it lands.
   */
  const clearHold = {
    anonymisationStatus: 'n/a',
    anonymisationError: null,
    redactedText: null,
    // ⚠ Cleared with the hold. They describe a refusal that is being re-run, and
    // leaving them would show a reviewer last time's survivors over this time's
    // text — offsets into a string that no longer exists. See `SurvivorSpan`.
    heldText: null,
    anonymisationSurvivors: null,
  }

  const hasText = typeof doc.extractedText === 'string' && doc.extractedText.trim().length > 0
  if (hasText) {
    return { ingestStatus: 'pending', ingestError: null, ingestId: null, ...clearHold }
  }
  return {
    ingestStatus: 'pending',
    ingestError: null,
    ingestId: null,
    transcribeId: null,
    transcribeAttempt: (Number(doc.transcribeAttempt ?? 0) || 0) + 1,
    ...clearHold,
  }
}

/**
 * Re-run the pipeline for a document whose ingest FAILED.
 *
 * ⚠ This is why `failed` is allowed to be a visible, terminal state instead of
 * a silent revert to `pending`. The row keeps its reason (`ingestError`), the
 * user sees it, and this endpoint is the way out. Nothing here retries by
 * itself: the cost of a wrong automatic retry on a three-hour recording is
 * three CPU-hours.
 *
 * The write is a plain `payload.update` with NO `__skipDocsExtract`, so the
 * ordinary `afterChange` hook picks it up — the retry path and the first-upload
 * path are the same code.
 */
function retryIngestEndpoint(): Endpoint {
  return {
    path: '/:id/retry',
    method: 'post',
    handler: async (req) => {
      const json = (body: unknown, status: number): Response =>
        new Response(JSON.stringify(body), {
          status,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          },
        })
      const fail = (status: number, message: string): Response =>
        json({ errors: [{ message }] }, status)

      const user = req.user
      if (!user) return fail(401, 'Authentication required.')

      const id = (req.routeParams as { id?: string } | undefined)?.id
      if (!id) return fail(400, 'Missing document id.')

      // ⚠ Read UNDER ACCESS CONTROL, like publish does. `visibleToCaller` 404s
      // a document the caller may not see, so this cannot be used to probe ids.
      const doc = (await req.payload
        .findByID({
          collection: 'documents',
          id: id as never,
          depth: 0,
          overrideAccess: false,
          user,
          req,
        })
        .catch(() => null)) as unknown as (RetryableDocument & { uploadedBy?: unknown }) | null

      if (!doc) return fail(404, 'No such document.')
      if (String(relationId(doc.uploadedBy) ?? '') !== String(user.id)) {
        return fail(403, 'Only the person who uploaded a document can retry it.')
      }

      const data = planIngestRetry(doc)
      if (!data) {
        return fail(409, 'This document has nothing to retry.')
      }

      await req.payload.update({
        collection: 'documents',
        id: id as never,
        data,
        overrideAccess: true,
      })

      return json({ ok: true, ingestStatus: 'pending' }, 202)
    },
  }
}

// ---------------------------------------------------------------------------
// POST /api/documents/:id/graph-retry — re-run the CORPUS-GRAPH extraction
// ---------------------------------------------------------------------------

/** The narrow slice of a row {@link planGraphRetry} reasons about. */
export interface GraphRetryableDocument {
  extractedText?: string | null
  graphStatus?: string | null
  /** Last write to the row — used to tell a live run from an abandoned one. */
  updatedAt?: string | null
  organization?: unknown
  contentKind?: string | null
  name?: string | null
}

/**
 * 🔴 HOW LONG AN IN-FLIGHT EXTRACTION MAY LOOK ALIVE.
 *
 * ⚠ WITHOUT THIS, THE RETRY ENDPOINT CANNOT FIX THE ONE THING IT EXISTS FOR.
 * The design's headline risk is that a backend restart mid-extraction loses the
 * run (ADR §5.1), and the stated mitigation is "retry re-runs one document".
 * But a lost run leaves the row at `graphStatus: 'extracting'` forever — there
 * is no heartbeat and nothing else moves it — so a retry rule that simply
 * refuses `extracting` refuses precisely the state it was built to rescue.
 *
 * 20 minutes is comfortably past a worst-case real run: `GRAPH_EXTRACT_MAX_WINDOWS`
 * (8) windows, each bounded by `GRAPH_EXTRACT_TIMEOUT_MS` (180 s) ≈ 24 minutes
 * at the absolute ceiling — but that ceiling means every window timed out, which
 * is a failure, not progress. A run doing real work updates the row when it
 * finishes; one that has not touched the row in 20 minutes is not coming back.
 */
export const GRAPH_STALE_RUN_MS = 20 * 60 * 1000

function msSince(timestamp: unknown): number | null {
  if (typeof timestamp !== 'string' || !timestamp) return null
  const t = Date.parse(timestamp)
  return Number.isFinite(t) ? Date.now() - t : null
}

/**
 * May this document's graph be rebuilt right now, and why not?
 *
 * A pure function for the same reason `planIngestRetry` is one: the rule is
 * written in one place and can be tested without an HTTP request.
 *
 * ⚠ THE RULE IS DELIBERATELY WIDER THAN `planIngestRetry`'S. Ingest retry
 * demands a TERMINAL failure, because re-running a live transcription costs
 * CPU-hours and leaves two callbacks racing for one row. Graph extraction has
 * neither problem: a re-run replaces the document's mentions and relations
 * wholesale in one transaction (ADR §5.5), so running it over a `ready` document
 * is how you adopt a new prompt version on one document without a corpus-wide
 * backfill.
 *
 * Two refusals remain, and both are real:
 *   · a run that is IN FLIGHT AND RECENT (`pending` or `extracting`, touched
 *     within {@link GRAPH_STALE_RUN_MS}). A second one would race the first's
 *     wholesale replace and could interleave two documents' worth of writes.
 *     ⚠ `pending` counts: between the status write and the `setImmediate`
 *     firing there is a real window, and a retry landing in it arms two runs.
 *   · no `extractedText` — there is nothing to extract from. The fix is an
 *     ingest retry, not a graph retry, and saying so is more useful than
 *     silently producing an empty graph.
 *
 * 🔴 A STALE in-flight row is ALLOWED THROUGH, and that is the point: a lost
 * run parks at `extracting` with nothing to move it, so refusing that state
 * unconditionally would make this endpoint useless for the exact failure the
 * ADR built it to cover. See {@link GRAPH_STALE_RUN_MS}.
 */
export function planGraphRetry(doc: GraphRetryableDocument): { reason: string } | null {
  const inFlight = doc.graphStatus === 'extracting' || doc.graphStatus === 'pending'
  if (inFlight) {
    const age = msSince(doc.updatedAt)
    // An unreadable/absent timestamp is treated as STALE rather than as live:
    // the alternative is a row that can never be retried, and a duplicate run
    // is recoverable where a permanently stuck document is not.
    if (age !== null && age < GRAPH_STALE_RUN_MS) {
      return { reason: 'Ya se está construyendo el grafo de este documento.' }
    }
  }
  const hasText = typeof doc.extractedText === 'string' && doc.extractedText.trim().length > 0
  if (!hasText) {
    return { reason: 'Este documento todavía no tiene texto del que extraer un grafo.' }
  }
  return null
}

/**
 * Rebuild one document's contribution to the corpus graph.
 *
 * ⚠ THE ORDINARY `afterChange` HOOK CANNOT DO THIS. It drives the ingest
 * pipeline, and for a document that already has text and an `ingestId` it
 * returns early by design. So this endpoint schedules the extraction itself,
 * through the same `scheduleGraphExtractionForDoc` seam the upload path uses.
 *
 * Returns 202 as soon as the run is armed. Poll `graphStatus`.
 */
/** A URL id as a positive safe integer: digits only, else null (the route 400s). */
function digitsId(raw: string | undefined): number | null {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

function retryGraphEndpoint(): Endpoint {
  return {
    path: '/:id/graph-retry',
    method: 'post',
    handler: async (req) => {
      const json = (body: unknown, status: number): Response =>
        new Response(JSON.stringify(body), {
          status,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          },
        })
      const fail = (status: number, message: string): Response =>
        json({ errors: [{ message }] }, status)

      const user = req.user
      if (!user) return fail(401, 'Authentication required.')

      // 🔴 A NUMBER, NOT THE ROUTE-PARAM STRING. `id` flows on into the
      // `graph_*` rows' `document` relationship, and Payload rejects a string
      // there ("The following field is invalid: Document"). Coerce once, here.
      const id = digitsId((req.routeParams as { id?: string } | undefined)?.id)
      if (id == null) return fail(400, 'Missing or invalid document id.')

      // ⚠ Read UNDER ACCESS CONTROL, exactly like publish and retry.
      // `visibleToCaller` 404s a document the caller may not see, so this
      // cannot be used to probe ids.
      const doc = (await req.payload
        .findByID({
          collection: 'documents',
          id: id as never,
          depth: 0,
          overrideAccess: false,
          user,
          req,
        })
        .catch(() => null)) as unknown as (GraphRetryableDocument & { uploadedBy?: unknown }) | null

      if (!doc) return fail(404, 'No such document.')
      if (String(relationId(doc.uploadedBy) ?? '') !== String(user.id)) {
        return fail(403, 'Only the person who uploaded a document can rebuild its graph.')
      }

      const refusal = planGraphRetry(doc)
      if (refusal) return fail(409, refusal.reason)

      const organizationId = relationId(doc.organization)
      if (organizationId == null) {
        // 🔴 No ecosistema means no tenant to scope the graph rows to. Refuse
        // rather than guess: a guessed organization is a cross-tenant write.
        return fail(409, 'This document has no ecosistema, so it has no graph scope.')
      }

      await scheduleGraphExtractionForDoc({
        payload: req.payload,
        docId: id,
        organizationId,
        fresh: { name: doc.name ?? null, contentKind: doc.contentKind ?? null },
      })

      return json({ ok: true, graphStatus: 'pending' }, 202)
    },
  }
}

function publishEndpoint(): Endpoint {
  return documentActionEndpoint('publish')
}

function unpublishEndpoint(): Endpoint {
  return documentActionEndpoint('unpublish')
}
