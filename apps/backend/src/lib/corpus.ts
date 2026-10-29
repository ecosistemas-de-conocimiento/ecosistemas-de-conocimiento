/**
 * ⚠ THE ONLY PLACE A CORPUS NAME IS DERIVED. Everything that talks to
 * ai-service about a corpus goes through here.
 *
 * ── THE MODEL ────────────────────────────────────────────────────────────────
 *
 * An ECOSISTEMA is a group of people who together build a corpus. An
 * `organizations` row IS an ecosistema — one level of tenancy, no second
 * collection. A person only ever sees content in their own ecosistema.
 *
 * A document has a publication state:
 *   · `draft`     — visible ONLY to whoever uploaded it. They can chat against
 *                   it, which is the whole workflow: upload → try it → publish.
 *   · `published` — part of the ecosistema's shared corpus, visible to every
 *                   member.
 *
 * Two corpus kinds, both under this backend's own `(org, project)` at
 * ai-service:
 *
 *   eco-{organizationId}                    the ecosistema's published corpus
 *   eco-{organizationId}-draft-{userId}     one private draft corpus per person
 *
 * ── WHY ISOLATION BY CORPUS NAME AND NOT BY A METADATA FILTER ────────────────
 *
 * 🔴 This is a deliberate choice and it must not be "optimised" into a single
 * corpus with a filter predicate.
 *
 * ai-service resolves a corpus by `{org, project, name}`, and a corpus that
 * does not belong to the caller is INDISTINGUISHABLE from one that does not
 * exist — it 404s by construction. So the isolation is structural: there is no
 * predicate to write, and therefore no predicate to write WRONG. A filter-based
 * scheme fails open the day someone forgets a clause; this scheme fails closed
 * the day someone gets a name wrong, and a wrong name returns nothing.
 *
 * The cost is real and was accepted: publishing means RE-EMBEDDING the
 * document into a different corpus. See `lib/publishDocument.ts`.
 *
 * ── WHY THIS FILE, AND NOT A ONE-LINE HELPER ─────────────────────────────────
 *
 * ai-service CANNOT enforce any of this for us, and that was verified by
 * reading it rather than assumed from its docs:
 *
 *   · It derives `{org, project}` from a BOOT-TIME `API_KEYS` environment map,
 *     never from the request. Every ecosistema here arrives under ONE key and
 *     looks like ONE org to it.
 *   · It will faithfully retrieve from whatever corpus name it is handed.
 *   · ⚠ Budget is keyed on `org` ALONE, so all ecosistemas share one spend cap
 *     and one of them can exhaust it for the rest. That is a limitation of the
 *     deployment, recorded here because someone will eventually ask why one
 *     customer's bulk upload made everybody else's chat fail.
 *
 * ⚠ SO THE AUTHORIZATION BOUNDARY IS THIS BACKEND. "Which corpus may this
 * request touch" is a question only we can answer, and the answer must NEVER
 * come from the request body. A caller that can name its own corpus can read
 * another ecosistema.
 */

import type { Payload } from 'payload'

import { organizationIdsForUser, relationId } from './permissions'

/**
 * ⚠ Ids go into a corpus NAME, which is a path segment on the wire. Anything
 * outside this set would either break the URL or let a crafted id smuggle a
 * separator and address a different corpus — `1-draft-2` reached from an
 * organization literally named `1-draft-2`. Postgres serials and UUIDs both
 * satisfy it; anything that does not is a bug worth throwing over.
 */
const SAFE_ID = /^[A-Za-z0-9_]+$/

function safeSegment(kind: string, id: number | string): string {
  const s = String(id)
  if (!SAFE_ID.test(s)) {
    throw new Error(
      `[corpus] refusing to build a corpus name from an unsafe ${kind} id ${JSON.stringify(s)}. ` +
        'Only letters, digits and underscore are allowed — a separator here would let one ' +
        'tenant address another tenant\'s corpus.',
    )
  }
  return s
}

/** The ecosistema's SHARED corpus. Every published document lands here. */
export function publishedCorpus(organizationId: number | string): string {
  return `eco-${safeSegment('organization', organizationId)}`
}

/**
 * One person's PRIVATE draft corpus inside one ecosistema.
 *
 * ⚠ Keyed by BOTH ids. Same-ecosistema, cross-user leakage is the risk this
 * model introduces that a purely per-tenant scheme did not have: two colleagues
 * in one ecosistema must not see each other's unpublished uploads.
 */
export function draftCorpus(
  organizationId: number | string,
  userId: number | string,
): string {
  return `${publishedCorpus(organizationId)}-draft-${safeSegment('user', userId)}`
}

export class SessionNotOwnedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionNotOwnedError'
  }
}

export class SessionHasNoEcosystemError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionHasNoEcosystemError'
  }
}

export interface SessionCorpora {
  organizationId: number | string
  /** The ecosistema's shared corpus. */
  published: string
  /** This person's private drafts in that ecosistema. */
  draft: string
  /**
   * What a chat turn retrieves from, in one `retrieveMulti` call.
   *
   * ⚠ A MISSING CORPUS CONTRIBUTES ZERO CHUNKS rather than failing the call
   * (`RetrieveMultiResult.corpora[].error === 'not_found'`), so a person who has
   * never uploaded a draft needs no special-casing here — the draft name simply
   * matches nothing.
   */
  all: [string, string]
}

/**
 * ⚠ THE TENANT CHECK. Prove that `sessionId` belongs to `userId`, and return
 * the corpora that session may touch.
 *
 * Reads with `overrideAccess: true` on purpose: this function IS the access
 * decision, and it needs to see the row in order to refuse it. Reading under
 * normal access control would hide someone else's session and report "no such
 * session" — the same answer as a typo — and then a real cross-tenant attempt
 * would be indistinguishable from a fat finger in the logs.
 */
export async function corporaForSession(
  payload: Payload,
  sessionId: number | string,
  userId: number | string,
): Promise<SessionCorpora> {
  const { organizationId } = await assertSessionOwnedBy(payload, sessionId, userId)

  if (organizationId === null) {
    throw new SessionHasNoEcosystemError(
      'This conversation is not attached to an ecosistema, so there is nothing to search.',
    )
  }

  const published = publishedCorpus(organizationId)
  const draft = draftCorpus(organizationId, userId)
  return { organizationId, published, draft, all: [published, draft] }
}

/**
 * Prove a session belongs to a user. Returns the session's ecosistema id.
 *
 * Separate from {@link corporaForSession} because the upload path needs the
 * ownership proof and the tenant id, but not the corpus names.
 */
export async function assertSessionOwnedBy(
  payload: Payload,
  sessionId: number | string,
  userId: number | string,
): Promise<{ organizationId: number | string | null; evalRun: number | null }> {
  const session = (await payload
    .findByID({ collection: 'sessions', id: sessionId as never, depth: 0, overrideAccess: true })
    .catch(() => null)) as unknown as { user?: unknown; organization?: unknown; evalRun?: unknown } | null

  if (!session) {
    throw new SessionNotOwnedError('No such conversation.')
  }

  const owner = relationId(session.user)
  if (owner === null || String(owner) !== String(userId)) {
    // ⚠ Same message for "not yours" and "does not exist" — ON THE WIRE. The
    // distinction is in the server log, not in the response, so this cannot be
    // used to probe which session ids exist. Session ids are sequential.
    throw new SessionNotOwnedError('No such conversation.')
  }

  /**
   * 🔴 OWNERSHIP IS NOT ENOUGH: THE REVOKE SWITCHES COUNT HERE TOO (code audit
   * 2026-10-28, item 4). A conversation outlives the access that opened it. A
   * deactivated account, a removed or switched-off membership, or a
   * switched-off ecosistema must stop searching that ecosistema's corpus and
   * stop writing turns into it, even through a conversation opened before the
   * revoke. `organizationIdsForUser` is the one resolver that applies the
   * membership and ecosistema switches (`lib/permissions.ts`); the account's
   * own switch is read here, because the resolver takes an id, not a row.
   * `isActive: { equals: true }`, never `not_equals: false`: see the note in
   * `lib/permissions.ts` — a NULL flag must fail closed.
   *
   * Same answer as "not yours", for the same reason.
   */
  const active = await payload.find({
    collection: 'users',
    where: { and: [{ id: { equals: userId } }, { isActive: { equals: true } }] },
    depth: 0,
    limit: 1,
    pagination: false,
    overrideAccess: true,
  })
  if (active.docs.length === 0) {
    throw new SessionNotOwnedError('No such conversation.')
  }

  const organizationId = relationId(session.organization)
  const evalRunNum = Number(session.evalRun)
  const evalRun = session.evalRun != null && Number.isSafeInteger(evalRunNum) && evalRunNum > 0 ? evalRunNum : null
  if (evalRun !== null) {
    // 🔴 R77: an eval run's conversation (`/api/evals/session`) belongs to a
    // platform admin, who is never a member. It skips the membership check
    // ONLY while the account is still an active platform admin; `Messages`
    // also refuses its turns unless the run is running.
    const row = active.docs[0] as { isActive?: unknown; isPlatformAdmin?: unknown } | undefined
    if (row?.isPlatformAdmin !== true) throw new SessionNotOwnedError('No such conversation.')
  } else if (organizationId !== null) {
    const mine = await organizationIdsForUser(payload, userId)
    if (!mine.some((id) => String(id) === String(organizationId))) {
      throw new SessionNotOwnedError('No such conversation.')
    }
  }

  return { organizationId, evalRun }
}
