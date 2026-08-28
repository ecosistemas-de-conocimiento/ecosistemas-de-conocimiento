import type {
  CollectionBeforeValidateHook,
  CollectionConfig,
  Endpoint,
  FieldAccess,
  Payload,
} from 'payload'
import { ValidationError } from 'payload'

import { isPlatformAdminUser, withinMyOrganizations } from '../access'
import {
  organizationIdsForUser,
  organizationIdsForUserWithPermission,
  PERMISSIONS,
  relationId,
} from '../lib/permissions'

import { compoundUnique } from './hooks/compoundUnique'

/**
 * A 1-5 star rating of ONE assistant answer, by ONE person.
 *
 * This is the product's only feedback signal, so it has to be trustworthy. Four
 * rules make it so, and each one is enforced server-side rather than trusted
 * from the request body:
 *
 *   1. ONE RATING PER (message, user). Re-rating updates the existing row; it
 *      never appends a second. Otherwise "average stars" is really "average
 *      stars, weighted by how often each person clicked".
 *   2. ONLY ASSISTANT ANSWERS ARE RATEABLE. Rating your own prompt is
 *      meaningless, and letting it through would quietly poison every
 *      aggregate computed over this table.
 *   3. YOU MAY ONLY RATE A MESSAGE IN YOUR OWN SESSION. Sessions are private
 *      (see `collections/Sessions.ts`), so a rating on someone else's message
 *      would also be a probe for whether that message exists.
 *   4. TENANT SCOPING IS DERIVED, NOT DECLARED. `organization` is taken from
 *      the session where possible and always checked against the caller's
 *      memberships. A client cannot file a rating under an organization it does
 *      not belong to, whatever it sends.
 *
 * ── TRANSPORT ────────────────────────────────────────────────────────────────
 * Payload's auto-generated REST at `/api/ratings` is the interface, called with
 * the user's normal session:
 *
 *   GET   /api/ratings?where[message][equals]=<id>   read your rating, if any
 *   POST  /api/ratings                                first rating for a message
 *   PATCH /api/ratings/<id>                           change stars or comment
 *
 * ⚠ `POST` on an already-rated message is REFUSED (409-shaped validation
 * error), not silently duplicated — see rule 1. Because "find, then POST or
 * PATCH" is two round trips and a race, there is also one custom route:
 *
 *   POST /api/ratings/upsert  { message, stars, comment?, organization? }
 *
 * which does the whole thing in one call and is what a rating widget should
 * use. It is defined at the bottom of this file.
 */

// ---------------------------------------------------------------------------
// Shared validation — used by BOTH the collection hook and the upsert endpoint
// ---------------------------------------------------------------------------

export const MIN_STARS = 1
export const MAX_STARS = 5

/**
 * Stars must be a WHOLE number in [1, 5].
 *
 * ⚠ Payload's `min`/`max` on a number field do not reject `4.5`, and a half
 * star that survives into the table makes every downstream aggregate
 * un-reproducible in a way nobody notices until someone asks why the average is
 * 3.47 when only integers were ever clicked. Checked here so both write paths
 * get the same answer.
 */
export function normalizeStars(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isInteger(n)) return null
  if (n < MIN_STARS || n > MAX_STARS) return null
  return n
}

/**
 * WHY a score was given, as a countable value.
 *
 * 🔴 THE POINT IS THAT THESE CAN BE COUNTED. A free-text box tells you why one
 * answer was bad, and only if somebody reads it. A fixed list tells you that
 * 41% of low scores were "it cited something the source does not say" — which
 * is the number that says whether retrieval is getting better or worse.
 *
 * ⚠ TWO LISTS, PICKED BY SCORE, because "what went wrong" and "what worked" are
 * different questions. Offering `invented` under a 5-star rating is noise, and a
 * single neutral list ends up phrased so vaguely that nobody picks anything.
 * The split point is 4: 1-3 asks what went wrong, 4-5 asks what worked.
 *
 * `other` is the escape hatch and the ONLY value that unlocks free text — see
 * `normalizeFeedback`. Everything a preset can express should be a preset;
 * `other` exists so the list can be wrong without blocking the person.
 */
export const LOW_SCORE_REASONS = [
  'not-grounded', // cites a source that does not say that
  'invented', // made something up
  'incomplete', // true, but left out what mattered
  'unclear', // right, but hard to understand
  'wrong-language', // answered in the wrong language / register
] as const

export const HIGH_SCORE_REASONS = [
  'accurate', // matched the source
  'well-sourced', // easy to check against the citation
  'clear', // easy to understand
  'complete', // covered what was asked
] as const

export const OTHER_REASON = 'other' as const

export const RATING_REASONS = [
  ...LOW_SCORE_REASONS,
  ...HIGH_SCORE_REASONS,
  OTHER_REASON,
] as const

export type RatingReason = (typeof RATING_REASONS)[number]

/** The reasons offered for a given score. `other` is always last. */
export function reasonsForStars(stars: number): readonly string[] {
  return [...(stars <= 3 ? LOW_SCORE_REASONS : HIGH_SCORE_REASONS), OTHER_REASON]
}

export const REASON_ERROR = 'That reason does not exist for this score.'
export const COMMENT_WITHOUT_OTHER_ERROR =
  'Free text is only stored with the "other" reason. Pick "other", or drop the text.'

export interface NormalizedFeedback {
  reason: RatingReason | null
  comment: string | null
}

/**
 * Validate `reason` + `comment` together, for both write paths.
 *
 * ⚠ THEY CANNOT BE VALIDATED SEPARATELY. The rules are all about the pair:
 *   · a reason must belong to the list for THAT score, or the counts mix
 *     "what worked" into "what went wrong";
 *   · free text is kept only with `other`, so a preset never carries a
 *     contradicting sentence nobody will read;
 *   · `other` with no text is allowed. Someone saying "none of these fit"
 *     without elaborating is still a real signal, and refusing it would just
 *     push them to pick a preset that is wrong.
 *
 * Returns `null` when the pair is invalid, with the reason in `error`.
 */
export function normalizeFeedback(
  stars: number,
  rawReason: unknown,
  rawComment: unknown,
): { ok: true; value: NormalizedFeedback } | { ok: false; error: string } {
  const reason =
    typeof rawReason === 'string' && rawReason.trim() ? (rawReason.trim() as RatingReason) : null
  const commentText =
    typeof rawComment === 'string' && rawComment.trim() ? rawComment.trim() : null

  if (reason !== null && !reasonsForStars(stars).includes(reason)) {
    return { ok: false, error: REASON_ERROR }
  }
  if (commentText !== null && reason !== OTHER_REASON) {
    return { ok: false, error: COMMENT_WITHOUT_OTHER_ERROR }
  }
  return { ok: true, value: { reason, comment: reason === OTHER_REASON ? commentText : null } }
}

export const STARS_ERROR = `Stars must be a whole number between ${MIN_STARS} and ${MAX_STARS}.`

type MessageShape = {
  id: number | string
  role?: unknown
  session?: unknown
}

type SessionShape = {
  id: number | string
  user?: unknown
  organization?: unknown
}

export type RateableTarget = {
  messageId: number | string
  sessionId: number | string
  organizationId: number | string
}

export class NotRateableError extends Error {
  readonly field: string

  constructor(field: string, message: string) {
    super(message)
    this.name = 'NotRateableError'
    this.field = field
  }
}

/**
 * Rules 2, 3 and 4, in one place, for one (message, user) pair.
 *
 * Reads run with `overrideAccess: true` on purpose: this function IS the access
 * decision, and it needs to see the row in order to refuse it. Letting Payload's
 * own access control hide the row instead would turn "you may not rate this"
 * into "no such message", which is the same answer for a message that genuinely
 * does not exist — and then a bug in the rules is indistinguishable from a
 * typo'd id.
 *
 * @param declaredOrganization organization from the request, used only when the
 *   session carries none. Always re-checked against the caller's memberships.
 */
export async function resolveRateableTarget(args: {
  payload: Payload
  messageId: number | string
  userId: number | string
  declaredOrganization?: unknown
  /** Organization ids the caller is an active member of. */
  memberOrganizationIds: Array<number | string>
}): Promise<RateableTarget> {
  const { payload, messageId, userId, declaredOrganization, memberOrganizationIds } = args

  const message = (await payload
    .findByID({ collection: 'messages', id: messageId, depth: 0, overrideAccess: true })
    .catch(() => null)) as unknown as MessageShape | null

  if (!message) {
    throw new NotRateableError('message', 'No such message.')
  }

  // Rule 2. `system` turns are as unrateable as `user` turns — neither is an
  // answer the assistant produced.
  if (message.role !== 'assistant') {
    throw new NotRateableError(
      'message',
      'Only assistant answers can be rated. This message is not one.',
    )
  }

  const sessionId = relationId(message.session)
  if (sessionId === null) {
    throw new NotRateableError('message', 'This message is not attached to a session.')
  }

  const session = (await payload
    .findByID({ collection: 'sessions', id: sessionId, depth: 0, overrideAccess: true })
    .catch(() => null)) as unknown as SessionShape | null

  if (!session) {
    throw new NotRateableError('session', 'This message is not attached to a session.')
  }

  // Rule 3.
  const owner = relationId(session.user)
  if (owner === null || String(owner) !== String(userId)) {
    throw new NotRateableError('message', 'You can only rate answers in your own conversations.')
  }

  // Rule 4. The session's tenant wins; a client-declared one is only consulted
  // when the session has none (a user who belongs to several organizations and
  // never picked one — see `Sessions.organization`).
  const allowed = new Set(memberOrganizationIds.map(String))
  const fromSession = relationId(session.organization)
  const organizationId = fromSession ?? relationId(declaredOrganization)

  if (organizationId === null) {
    throw new NotRateableError(
      'organization',
      'This conversation has no organization, so the rating needs an explicit `organization`.',
    )
  }
  if (!allowed.has(String(organizationId))) {
    throw new NotRateableError(
      'organization',
      'You are not a member of the organization this rating would belong to.',
    )
  }

  return { messageId: message.id, sessionId: session.id, organizationId }
}

// ---------------------------------------------------------------------------
// The collection hook
// ---------------------------------------------------------------------------

/**
 * Stamp `user`, `session` and `organization` from the server's own knowledge,
 * and refuse anything the four rules forbid.
 *
 * ⚠ Runs BEFORE `compoundUnique` in the hook array, and that order matters:
 * the uniqueness check reads `message` and `user` off the data, and `user` does
 * not exist there until this hook puts it there.
 */
const stampAndValidate: CollectionBeforeValidateHook = async ({
  data,
  operation,
  originalDoc,
  req,
}) => {
  const next = { ...(data ?? {}) } as Record<string, unknown>
  const user = req.user

  // `overrideAccess: true` writes (the seed, an admin script) carry no user.
  // Let them through untouched rather than inventing an author for them.
  if (!user) return next

  const merged = { ...(originalDoc ?? {}), ...next } as Record<string, unknown>

  if (operation === 'create') {
    // ⚠ The author is the SESSION's user, never the body's. A client-supplied
    // `user` would let anyone file ratings in someone else's name.
    next.user = user.id
  } else {
    const original = originalDoc as Record<string, unknown> | undefined
    // Re-pointing an existing rating at a different message or person would
    // slip past the uniqueness check that was run when the row was created.
    if (original) {
      next.user = original.user
      next.message = original.message
    }
  }

  const stars = normalizeStars(merged.stars)
  if (stars === null) {
    throw new ValidationError({
      collection: 'ratings',
      errors: [{ path: 'stars', message: STARS_ERROR }],
      req,
    })
  }
  next.stars = stars

  const messageId = relationId(merged.message)
  if (messageId === null) {
    throw new ValidationError({
      collection: 'ratings',
      errors: [{ path: 'message', message: 'A rating must point at a message.' }],
      req,
    })
  }

  try {
    const target = await resolveRateableTarget({
      payload: req.payload,
      messageId,
      userId: user.id,
      declaredOrganization: merged.organization,
      memberOrganizationIds: await organizationIdsForUser(req.payload, user.id),
    })
    next.message = target.messageId
    next.session = target.sessionId
    next.organization = target.organizationId
  } catch (err) {
    if (err instanceof NotRateableError) {
      throw new ValidationError({
        collection: 'ratings',
        errors: [{ path: err.field, message: err.message }],
        req,
      })
    }
    throw err
  }

  return next
}

// ---------------------------------------------------------------------------
// Who may READ the free text
// ---------------------------------------------------------------------------

/**
 * 🔴 THE COMMENT IS THE ONLY PART OF A RATING THAT CONTAINS SOMEBODY'S WORDS.
 *
 * `read` on this collection is TENANT-WIDE — an admin looking at answer quality
 * needs their ecosistema's ratings. That is right for `stars` and `reason`,
 * which are counts and name nobody. It was wrong for `comment`: it meant every
 * member of an ecosistema could read every colleague's written complaint. The
 * product does warn people this field is not private, which is honest, and
 * "not private" was quietly being implemented as "published to your coworkers".
 *
 * So the field is narrowed to whoever holds `ratings:read-comments` IN THE
 * ECOSISTEMA THE RATING BELONGS TO — Investigador and up — plus the person who
 * wrote it.
 *
 * ⚠ FIELD access, not collection access, deliberately. Hiding the whole row
 * would take the star counts with it and break the quality view for admins. A
 * field gate lets Payload strip exactly one key from the response.
 *
 * ⚠ FAILS CLOSED. If the row's ecosistema cannot be determined from what Payload
 * hands this callback, the answer is `false`. An undeterminable tenant is the
 * one case where guessing is a disclosure.
 *
 * ⚠ `read` ONLY. Writing a comment is unchanged — the rater is authenticated and
 * `normalizeFeedback` already decides whether the text is kept at all. Gating
 * `create`/`update` here would stop people leaving the feedback in the first
 * place, which is the opposite of the intent.
 */
export const canReadRatingComment: FieldAccess = async ({ req, doc, data, siblingData }) => {
  const user = req.user
  if (!user) return false
  if (isPlatformAdminUser(user)) return true

  const row = (doc ?? data ?? siblingData ?? {}) as Record<string, unknown>

  // Your own note is always yours to read back. Without this a member who just
  // wrote a comment would watch it vanish from the response on the next GET,
  // which reads as data loss rather than as a privacy rule.
  const author = relationId(row.user)
  if (author !== null && String(author) === String(user.id)) return true

  const organizationId = relationId(row.organization)
  if (organizationId === null) return false

  /**
   * ⚠ MEMOIZED ON `req`, because field access runs ONCE PER DOCUMENT. A 100-row
   * ratings page called this 100 times, and each call ran
   * `organizationIdsForUserWithPermission` — two uncached queries — so listing
   * ratings cost 200 extra round trips to answer one question whose answer
   * cannot change within a request.
   *
   * The cache key includes the user id: `req` is per request, but a server-side
   * caller can pass an explicit `user`, and answering for the wrong person is
   * the one mistake this must not make.
   */
  // ⚠ `?? {}` because `req.context` is only guaranteed on a real Payload
  // request. A caller without one simply gets no memoization, never a crash —
  // an access check must not depend on a performance optimisation being present.
  const cache = (req.context ?? {}) as { __ratingCommentOrgs?: Record<string, string[]> }
  const cacheKey = String(user.id)
  if (!cache.__ratingCommentOrgs) cache.__ratingCommentOrgs = {}
  let allowed = cache.__ratingCommentOrgs[cacheKey]
  if (!allowed) {
    allowed = (
      await organizationIdsForUserWithPermission(
        req.payload,
        user.id,
        PERMISSIONS.ratingsReadComments,
      )
    ).map(String)
    cache.__ratingCommentOrgs[cacheKey] = allowed
  }
  return allowed.includes(String(organizationId))
}

// ---------------------------------------------------------------------------
// The collection
// ---------------------------------------------------------------------------

export const Ratings: CollectionConfig = {
  slug: 'ratings',
  admin: {
    useAsTitle: 'stars',
    defaultColumns: ['stars', 'message', 'user', 'organization', 'createdAt'],
    group: 'Feedback',
    description: 'User ratings of assistant answers. One per person per answer.',
  },
  access: {
    // Read is TENANT-wide, not per user: an admin looking at answer quality
    // needs to see their organization's ratings, and a rating carries no
    // conversation content of its own — only a star count and an optional note.
    read: withinMyOrganizations(),
    // Anyone signed in may attempt a write; `stampAndValidate` is what decides
    // whether the specific message is rateable by this specific person. A
    // where-constraint here cannot express "and the message is an assistant
    // turn in your own session", so the rules live in the hook.
    create: ({ req: { user } }) => Boolean(user),
    // You edit your own rating and nobody else's.
    update: ({ req: { user } }) => (user ? { user: { equals: user.id } } : false),
    delete: ({ req: { user } }) => (user ? { user: { equals: user.id } } : false),
  },
  hooks: {
    // ⚠ ORDER IS LOAD-BEARING — see `stampAndValidate`.
    beforeValidate: [
      stampAndValidate,
      compoundUnique({
        collection: 'ratings',
        fields: ['message', 'user'],
        errorPath: 'message',
        message:
          'You have already rated this answer. Update that rating instead of creating a second one (PATCH /api/ratings/<id>, or POST /api/ratings/upsert).',
      }),
    ],
  },
  fields: [
    {
      name: 'message',
      type: 'relationship',
      relationTo: 'messages',
      required: true,
      index: true,
      admin: { description: 'The assistant answer being rated. Immutable after creation.' },
    },
    {
      // Denormalized from `message.session` for query convenience — "how did
      // this conversation score?" should not need a join through messages.
      // ⚠ Always written by the hook, never trusted from the request.
      name: 'session',
      type: 'relationship',
      relationTo: 'sessions',
      required: true,
      index: true,
      admin: { readOnly: true, description: 'Derived from the message. Do not set by hand.' },
    },
    {
      // ⚠ THE TENANT SCOPE. Every read of this collection is filtered on it.
      name: 'organization',
      type: 'relationship',
      relationTo: 'organizations',
      required: true,
      index: true,
      admin: {
        readOnly: true,
        description: 'Derived from the session and checked against your memberships.',
      },
    },
    {
      name: 'user',
      type: 'relationship',
      relationTo: 'users',
      required: true,
      index: true,
      admin: { readOnly: true, description: 'Taken from the session. Do not set by hand.' },
    },
    {
      name: 'stars',
      type: 'number',
      required: true,
      index: true,
      min: MIN_STARS,
      max: MAX_STARS,
      admin: {
        step: 1,
        description: `${MIN_STARS}-${MAX_STARS}. Whole numbers only — enforced in the hook, because min/max alone would accept 4.5.`,
      },
    },
    {
      /**
       * WHY, as a countable value. See `RATING_REASONS`.
       *
       * ⚠ Not `required`. A score with no reason is still a score, and forcing
       * a reason would make people pick the first option to get past it — which
       * poisons exactly the counts this field exists to produce.
       */
      name: 'reason',
      type: 'select',
      options: [...RATING_REASONS],
      admin: {
        description:
          'Which preset reason the person chose. Valid values depend on the score: 1-3 offers the "what went wrong" list, 4-5 the "what worked" list. `other` is the only one that allows free text.',
      },
    },
    {
      /**
       * ⚠ ONLY STORED WITH `reason: 'other'` — enforced in `normalizeFeedback`,
       * which both write paths call. A preset that also carries a sentence is a
       * contradiction nobody will read, and it would quietly turn the counts
       * back into free text.
       */
      name: 'comment',
      type: 'textarea',
      // 🔴 The one part of a rating that is somebody's words. See
      // `canReadRatingComment` for why this is a FIELD gate and not a row gate.
      access: { read: canReadRatingComment },
      admin: {
        description:
          'Free text, kept ONLY when `reason` is `other`. Optional even then — "none of these fit" is a real signal on its own. Readable by its author and by Investigador-and-up in the same ecosistema.',
      },
    },
  ],
  endpoints: [ratingUpsertEndpoint()],
}

// ---------------------------------------------------------------------------
// POST /api/ratings/upsert
// ---------------------------------------------------------------------------

/**
 * One call that creates a rating or updates the caller's existing one.
 *
 * ⚠ WHY THIS EXISTS ALONGSIDE THE AUTO REST. "One rating per (message, user),
 * and re-rating updates it" cannot be expressed as a plain `POST`: Payload's
 * create path has no way to become an update, and the uniqueness hook can only
 * refuse. Without this route every client has to do GET-then-POST-or-PATCH,
 * which is two round trips and a race — two fast clicks on the star widget
 * produce two creates, one of which fails with a validation error the user
 * never asked to see.
 *
 * ⚠ IT IS NOT A BYPASS. The write goes through `payload.create` / `payload.update`
 * with `overrideAccess: false` and the caller's own user, so every access rule
 * and every hook above runs exactly as it would on the REST route. The only
 * thing this adds is the find-first step.
 *
 * ⚠ The find-then-write is still not atomic. Two truly simultaneous requests
 * can both see "no existing rating" and both create; the uniqueness hook then
 * fails the loser, which is the right outcome and the same one the plain REST
 * path gives. A database-level unique index closes the window properly — see
 * `src/migrations/README.md`.
 */
function ratingUpsertEndpoint(): Endpoint {
  return {
    path: '/upsert',
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

      let body: Record<string, unknown> = {}
      try {
        const parsed: unknown = typeof req.json === 'function' ? await req.json() : null
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          body = parsed as Record<string, unknown>
        }
      } catch {
        return fail(400, 'Body must be JSON.')
      }

      const messageId = relationId(body.message)
      if (messageId === null) return fail(400, '`message` is required.')

      const stars = normalizeStars(body.stars)
      if (stars === null) return fail(400, STARS_ERROR)

      // `reason` and `comment` are validated as a PAIR — see normalizeFeedback.
      const feedback = normalizeFeedback(stars, body.reason, body.comment)
      if (!feedback.ok) return fail(400, feedback.error)
      const { reason, comment } = feedback.value

      // Validate BEFORE writing so the caller gets one clear reason rather than
      // a Payload validation envelope assembled out of hook errors.
      try {
        await resolveRateableTarget({
          payload: req.payload,
          messageId,
          userId: user.id,
          declaredOrganization: body.organization,
          memberOrganizationIds: await organizationIdsForUser(req.payload, user.id),
        })
      } catch (err) {
        if (err instanceof NotRateableError) return fail(403, err.message)
        throw err
      }

      // `overrideAccess: true` on the LOOKUP only: we are searching by the
      // caller's own id, and the tenant filter would cost a second membership
      // query to find a row we already know belongs to them.
      const existing = await req.payload.find({
        collection: 'ratings',
        where: { and: [{ message: { equals: messageId } }, { user: { equals: user.id } }] },
        limit: 1,
        depth: 0,
        overrideAccess: true,
        req,
      })

      const found = existing.docs[0] as { id: number | string } | undefined

      // The WRITE runs under normal access control and normal hooks. Whatever
      // this route does, it is not allowed to be a way around them.
      const doc = found
        ? await req.payload.update({
            collection: 'ratings',
            id: found.id as never,
            // ⚠ Written unconditionally, nulls included. A re-rate that moves
            // 2 -> 5 must CLEAR the old "what went wrong" reason; spreading
            // conditionally would leave `invented` sitting on a 5-star row.
            // `as never` for the same reason the create below uses it:
            // `src/payload-types.ts` is generated and does not yet carry
            // `reason`. Regenerate it (`pnpm generate:types`) after the next
            // image build and both casts can go.
            data: { stars, reason, comment } as never,
            overrideAccess: false,
            user,
            req,
          })
        : await req.payload.create({
            collection: 'ratings',
            data: {
              message: messageId,
              stars,
              reason,
              comment,
              ...(body.organization === undefined ? {} : { organization: body.organization }),
            } as never,
            overrideAccess: false,
            user,
            req,
          })

      return json({ doc, created: !found }, found ? 200 : 201)
    },
  }
}
