/**
 * ONE ECOSISTEMA'S NUMBERS, AND NOTHING ELSE.
 *
 * ── 🔴 WHY THIS FILE EXISTS AT ALL ───────────────────────────────────────────
 *
 * `Sessions.read` is own-only and `Messages.read` is own-via-session, with no
 * platform-admin bypass — by design, and that design is a product promise, not
 * an implementation detail: a conversation belongs to the person who had it,
 * and nobody else reads it. Not their colleagues, not their organization's
 * admin, not whoever runs the installation.
 *
 * The consequence is that a platform admin asking Payload "how many
 * conversations does this ecosistema have?" through the ordinary REST list does
 * NOT get an error. Payload quietly ANDs the access rule into the query and
 * answers with the admin's OWN conversations in that ecosistema. Measured on a
 * dev database: 61 messages across 12 organizations in the table, 45 returned,
 * all of them the caller's. The tile showed a number, the number was plausible,
 * and it was the wrong number. A wrong-but-plausible metric is worse than a
 * missing one, because nobody goes looking for the bug.
 *
 * ── 🔴 THE FIX IS AGGREGATION, NOT A LOOSER ACCESS RULE ──────────────────────
 *
 * The tempting fix is to add a platform-admin bypass to `Sessions.read`. Do NOT
 * do that. It would make every session row readable by an admin through the
 * generic REST surface, the admin panel, and every future endpoint that forgets
 * to narrow its `select` — and the promise above would be gone, permanently and
 * invisibly.
 *
 * Instead the counting happens HERE, server-side, with an elevated read, and
 * what leaves this file is a struct of INTEGERS. The guarantee is structural
 * rather than disciplinary: a future developer cannot leak a message body from
 * a return type that has no message in it. There is no row to forget to strip.
 *
 * ⚠ THE COROLLARY IS A RULE: never widen `EcosystemMetrics` to carry a row, a
 * sample, an id list, a "most recent conversation", or a rating comment. The
 * elevation below is only safe for as long as the output stays countable. If
 * something needs rows, it needs its own endpoint with its own access rules —
 * not a field on this one.
 *
 * ⚠ RATING COMMENTS SPECIFICALLY. Star counts are tenant-wide and fine to
 * aggregate. Comments are restricted to their author plus Investigador-and-up,
 * and they are free text somebody typed about a conversation. `countStars`
 * below never loads a rating row at all — it asks the database for five
 * integers — so there is no code path here from which a comment could escape
 * even by accident.
 */

import type { Payload, Where } from 'payload'

import { isActiveUser, isPlatformAdminUser } from '../access'
import { organizationIdsForUser } from './permissions'
import { MAX_STARS, MIN_STARS } from '../collections/Ratings'
import { PUBLICATION_STATES, type PublicationState } from './publishDocument'

type Id = number | string

// ---------------------------------------------------------------------------
// The wire shape
// ---------------------------------------------------------------------------

/**
 * ⚠ EVERY LEAF IS A NUMBER (or the ecosistema's own name, which the caller
 * already had in order to ask). See the file header before adding anything.
 */
export interface EcosystemMetrics {
  /**
   * Echoed back so a page that aggregates one tenant can SAY which tenant. A
   * dashboard showing yesterday's ecosistema under today's heading is the same
   * class of bug as the one this file exists to fix.
   */
  ecosystem: { id: string; name: string | null; slug: string | null }
  conversations: {
    /** Chat sessions filed under this ecosistema. */
    sessions: number
    /** Turns across those sessions — user, assistant and system alike. */
    messages: number
  }
  documents: {
    total: number
    /** One count per state in `PUBLICATION_STATES`. Always all four keys. */
    byPublicationStatus: Record<PublicationState, number>
    /** `ingestStatus: 'failed'` — a real backlog item, retryable by its owner. */
    failed: number
    /** Still moving through the pipeline. Nothing for a human to do yet. */
    inProgress: number
  }
  ratings: {
    total: number
    /** Mean stars, unrounded. `null` when there is nothing to average. */
    average: number | null
    /** Index 0 = one star … index 4 = five stars. */
    byStars: number[]
  }
}

/**
 * ⚠ ONE ERROR FOR "NO SUCH ECOSISTEMA" AND "NOT YOURS", ON PURPOSE.
 *
 * This repo answers 404 rather than 403 for a refused read (see
 * `Sessions`' `/corpora` endpoint). A 403 confirms the row exists, which turns
 * any id-taking endpoint into an oracle for which ecosistemas are on the
 * installation and how many members they have. The caller cannot tell the two
 * apart, and that is the point — so the route must not log or return a
 * `reason` that gives it away either.
 */
export class EcosystemNotVisibleError extends Error {
  constructor(message = 'No such ecosistema.') {
    super(message)
    this.name = 'EcosystemNotVisibleError'
  }
}

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

/**
 * 🔴 THE ELEVATION SITE. Every count below runs with `overrideAccess: true`.
 *
 * That is not a shortcut — it is the entire reason this file exists. The
 * caller's own access rules are exactly what produces the wrong answer (see
 * the file header), so asking the database as the caller would defeat the
 * purpose. What makes the elevation safe is the RETURN TYPE: `count` hands back
 * `{ totalDocs }` and nothing else, so no row is ever materialized, let alone
 * serialized. Keep it that way — a `find` here, however narrow its `select`,
 * would be an elevated read of private conversations.
 */
const countWith = async (
  payload: Payload,
  collection: 'sessions' | 'messages' | 'documents' | 'ratings',
  where: Where,
): Promise<number> => {
  const { totalDocs } = await payload.count({ collection, where, overrideAccess: true })
  return totalDocs
}

const scoped = (organizationId: Id, extra?: Where): Where =>
  extra
    ? { and: [{ organization: { equals: organizationId } }, extra] }
    : { organization: { equals: organizationId } }

/**
 * ⚠ MESSAGES CARRY NO `organization` COLUMN. They are scoped only through their
 * session, so the filter walks the relationship — the same path
 * `Messages.read` uses for `session.user`. Counting messages any other way
 * means either an unfiltered read (every tenant's turns) or a two-step
 * "collect session ids, then filter by them", which silently under-counts the
 * moment the id list is longer than one page. That truncation is what the web
 * BFF hit, and why its tile could only ever show `null` for busy ecosistemas.
 */
const messagesWhere = (organizationId: Id): Where => ({
  'session.organization': { equals: organizationId },
})

/**
 * Stars as five integers, never as rows.
 *
 * 🔴 THIS IS DELIBERATELY NOT `find(...).then(rows => average(rows))`. Loading
 * rating rows to average them would pull `comment` — restricted free text — into
 * this process, one careless `...rating` away from the response body. Five
 * counts cost five cheap indexed queries (`ratings.stars` is indexed) and make
 * the leak unrepresentable.
 */
async function countStars(payload: Payload, organizationId: Id): Promise<number[]> {
  const stars = Array.from({ length: MAX_STARS - MIN_STARS + 1 }, (_, i) => MIN_STARS + i)
  return Promise.all(
    stars.map((value) => countWith(payload, 'ratings', scoped(organizationId, { stars: { equals: value } }))),
  )
}

/**
 * `inProgress` is defined by EXCLUSION — anything that is neither finished
 * (`ready`), inapplicable (`n/a`) nor broken (`failed`). Listing the in-flight
 * states positively would go stale the next time the pipeline grows one, and it
 * would go stale silently: the tile would just quietly stop counting them.
 */
const SETTLED_INGEST_STATES = ['ready', 'n/a', 'failed'] as const

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

type OrganizationRow = { id: Id; name?: unknown; slug?: unknown; isActive?: unknown }

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null

/**
 * Metrics for ONE ecosistema, for ONE caller.
 *
 * Throws `EcosystemNotVisibleError` for every refusal — unknown ecosistema,
 * deactivated ecosistema, deactivated account, and "you are not a member" all
 * produce the identical error. See that class for why.
 *
 * ⚠ THE MEMBERSHIP CHECK IS NOT OPTIONAL AND CANNOT BE MOVED TO THE ROUTE.
 * Everything after it runs elevated. A caller who reaches the counting section
 * without passing this gate reads any tenant's numbers, and the numbers are
 * exactly what the tenancy model is protecting here.
 */
export async function ecosystemMetrics(args: {
  payload: Payload
  /** The ecosistema being asked about, as sent by the caller. Never trusted. */
  organizationId: Id
  /** The authenticated `users` row, or null/undefined when nobody is signed in. */
  user: unknown
}): Promise<EcosystemMetrics> {
  const { payload, organizationId, user } = args

  // Deactivation is the revoke switch (see `lib/permissions.ts`), so a switched
  // off account is refused before any read happens, elevated or not.
  if (!isActiveUser(user)) throw new EcosystemNotVisibleError()

  // ⚠ `.catch(() => null)` is about MALFORMED IDS, not about swallowing outages.
  // `organizationId` is caller-supplied text; Postgres raises a cast error on
  // `id = 'abc'` rather than returning zero rows. Letting that become a 500
  // while a valid-but-unknown id 404s would make the two distinguishable, and
  // the counting reads below are left un-caught so a genuine database failure
  // still surfaces as a 500.
  const found = await payload
    .find({
      collection: 'organizations',
      where: { and: [{ id: { equals: organizationId } }, { isActive: { equals: true } }] },
      limit: 1,
      depth: 0,
      // Reading the ecosistema row is elevated for the same reason as everything
      // below: a platform admin is allowed to ask about an ecosistema they are
      // not a member of, and their membership list is empty by design.
      overrideAccess: true,
    })
    .catch(() => null)
  const organization = (found?.docs[0] ?? null) as OrganizationRow | null
  if (!organization) throw new EcosystemNotVisibleError()

  // 🔴 THE GATE. A platform admin may ask about any ecosistema; everybody else
  // may ask only about ones they hold an ACTIVE membership in, at any role —
  // this endpoint returns nothing a member is not already entitled to know
  // about their own ecosistema, so gating it at `admin` would only push admins
  // back onto the broken client-side count.
  if (!isPlatformAdminUser(user)) {
    const principalId = (user as { id?: Id } | null)?.id
    if (principalId === undefined || principalId === null) throw new EcosystemNotVisibleError()

    const mine = await organizationIdsForUser(payload, principalId)
    // ⚠ Compared as strings: Postgres hands ids back as `7` or `'7'` depending
    // on the path, and `7 !== '7'` would refuse a legitimate member.
    if (!new Set(mine.map(String)).has(String(organization.id))) {
      throw new EcosystemNotVisibleError()
    }
  }

  const orgId = organization.id

  const [sessions, messages, documentsTotal, byPublicationStatus, failed, settled, byStars] =
    await Promise.all([
      countWith(payload, 'sessions', scoped(orgId)),
      countWith(payload, 'messages', messagesWhere(orgId)),
      countWith(payload, 'documents', scoped(orgId)),
      Promise.all(
        PUBLICATION_STATES.map((state) =>
          countWith(payload, 'documents', scoped(orgId, { publicationStatus: { equals: state } })),
        ),
      ),
      countWith(payload, 'documents', scoped(orgId, { ingestStatus: { equals: 'failed' } })),
      countWith(payload, 'documents', scoped(orgId, { ingestStatus: { in: [...SETTLED_INGEST_STATES] } })),
      countStars(payload, orgId),
    ])

  const ratingsTotal = byStars.reduce((sum, n) => sum + n, 0)
  const starSum = byStars.reduce((sum, n, i) => sum + n * (MIN_STARS + i), 0)

  return {
    ecosystem: {
      id: String(organization.id),
      name: text(organization.name),
      slug: text(organization.slug),
    },
    conversations: { sessions, messages },
    documents: {
      total: documentsTotal,
      byPublicationStatus: Object.fromEntries(
        PUBLICATION_STATES.map((state, i) => [state, byPublicationStatus[i] ?? 0]),
      ) as Record<PublicationState, number>,
      failed,
      // Never negative even if a row carries an ingestStatus this build does not
      // know about — a nonsense tile is worse than a slightly low one.
      inProgress: Math.max(0, documentsTotal - settled),
    },
    ratings: {
      total: ratingsTotal,
      average: ratingsTotal === 0 ? null : starSum / ratingsTotal,
      byStars,
    },
  }
}
