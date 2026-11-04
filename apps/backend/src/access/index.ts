/**
 * WHO IS ALLOWED TO DO WHAT, AT THE DOCUMENT LEVEL.
 *
 * Two different questions live in two different files, and confusing them is
 * how a tenant leak gets written:
 *
 *   · THIS FILE answers "may this request touch this row?" — Payload access
 *     control, enforced by the database query Payload builds.
 *   · `lib/permissions.ts` answers "what does this person hold, and where?" —
 *     the resolver whose output goes on the wire in a token.
 *
 * There are exactly two kinds of account:
 *
 *   · platform admin — `isPlatformAdmin: true`. Runs the installation. Reads
 *                      and writes everything.
 *   · everybody else — reads and edits THEIR OWN user row, plus whatever their
 *                      organization memberships grant.
 *
 * ⚠ Every check also requires the account to be ACTIVE. Deactivating a person
 * has to actually take their access away, and Payload's own auth knows nothing
 * about `isActive` — so the flag is enforced here, on every surface.
 *
 * ⚠ TENANT-SCOPED HELPERS ARE ASYNC AND HIT THE DATABASE. `withinMyOrganizations`
 * has to ask which organizations the caller belongs to before it can build a
 * constraint. That is one extra query per access check, and it is the price of
 * not storing a denormalized org list on the user row that could go stale. If
 * it ever shows up in a profile, cache it on `req` — do NOT replace it with a
 * cheaper boolean.
 */

import type { Access, FieldAccess, PayloadRequest, Where } from 'payload'

import {
  organizationIdsForUser,
  organizationIdsForUserWithMinRole,
  type OrgRole,
} from '../lib/permissions'

/** The bits of a `users` row an access check reads. */
type PrincipalLike = {
  id?: number | string
  isActive?: unknown
  isPlatformAdmin?: unknown
}

const asPrincipal = (user: unknown): PrincipalLike | null =>
  user && typeof user === 'object' ? (user as PrincipalLike) : null

/**
 * Active unless explicitly switched off. A row whose column is null (or a
 * request carrying a user shape from before the field existed) stays usable;
 * only a deliberate `false` locks the account out.
 */
export function isActiveUser(user: unknown): boolean {
  const principal = asPrincipal(user)
  return principal !== null && principal.isActive !== false
}

/** True only for an ACTIVE account carrying the platform-admin flag. */
export function isPlatformAdminUser(user: unknown): boolean {
  const principal = asPrincipal(user)
  return principal !== null && principal.isActive !== false && principal.isPlatformAdmin === true
}

/** The id of whoever is making this request, or `null` when nobody is. */
export function principalId(req: PayloadRequest): number | string | null {
  const principal = asPrincipal(req.user)
  return principal?.id ?? null
}

/** Platform admins only. The gate on every catalog collection's writes. */
export const isPlatformAdmin: Access = ({ req }) => isPlatformAdminUser(req.user)

/** Any active account. Consumers of the catalog need to read it to make sense. */
export const isAuthenticated: Access = ({ req }) => isActiveUser(req.user)

/**
 * Own `users` row only.
 *
 * Returns a WHERE CONSTRAINT rather than a boolean so the constraint reaches
 * the query: a team member's Users list contains exactly one row (their own)
 * and asking for somebody else's id 404s instead of 403-ing. A boolean here
 * would let anyone browse the team roster.
 */
export const isSelf: Access = ({ req }) => {
  const id = principalId(req)
  if (id === null || !isActiveUser(req.user)) return false
  return { id: { equals: id } } satisfies Where
}

/** Self-scoped for a team member, unrestricted for a platform admin. */
export const isSelfOrPlatformAdmin: Access = (args) =>
  isPlatformAdminUser(args.req.user) ? true : isSelf(args)

/**
 * Same idea for a collection that POINTS AT a user instead of being one:
 * a platform admin sees everything, everybody else sees only the rows whose
 * `field` is them.
 */
export const isPlatformAdminOrOwnedBy =
  (field: string): Access =>
  ({ req }) => {
    if (isPlatformAdminUser(req.user)) return true
    const id = principalId(req)
    if (id === null || !isActiveUser(req.user)) return false
    return { [field]: { equals: id } } satisfies Where
  }

/**
 * ⚠ THE TENANT BOUNDARY. Rows whose `field` names an organization the caller is
 * an active member of.
 *
 * Returns a WHERE CONSTRAINT, never a boolean, so the constraint reaches the
 * query: a list request comes back containing only the caller's organizations'
 * rows, and asking for someone else's row by id 404s instead of 403-ing. A
 * boolean here would be a full cross-tenant read.
 *
 * ⚠ NO MEMBERSHIPS ⇒ `false`, NOT an empty constraint. `{ organization: { in: [] } }`
 * is the kind of thing an ORM can optimise into "no constraint", and the
 * failure mode is total: every tenant's rows returned to a user who belongs to
 * none. Refuse outright instead.
 *
 * Platform admins bypass this — see `isPlatformAdminUser`.
 */
export const withinMyOrganizations =
  (field = 'organization'): Access =>
  async ({ req }) => {
    if (isPlatformAdminUser(req.user)) return true
    const id = principalId(req)
    if (id === null || !isActiveUser(req.user)) return false

    const organizationIds = await organizationIdsForUser(req.payload, id)
    if (organizationIds.length === 0) return false

    return { [field]: { in: organizationIds } } satisfies Where
  }

/**
 * Same constraint, narrowed to organizations where the caller holds at least
 * `minRole`. This is what makes the role model enforceable at the document
 * level instead of only on the wire: `admin` gates member management, `owner`
 * gates the organization row itself.
 *
 * Same empty-list rule as above — no qualifying organizations means `false`.
 */
export const withinMyOrganizationsWithRole =
  (minRole: OrgRole, field = 'organization'): Access =>
  async ({ req }) => {
    if (isPlatformAdminUser(req.user)) return true
    const id = principalId(req)
    if (id === null || !isActiveUser(req.user)) return false

    const organizationIds = await organizationIdsForUserWithMinRole(req.payload, id, minRole)
    if (organizationIds.length === 0) return false

    return { [field]: { in: organizationIds } } satisfies Where
  }

/**
 * ⚠ THE SELF-ESCALATION GATE. The single most important rule in this app.
 *
 * A team member may update their own `users` row — that is how they change
 * their name, avatar and locale. Without a FIELD-level gate that same update
 * could carry `isPlatformAdmin: true`, and anyone with an account would own the
 * entire installation.
 *
 * Applied to `create` and `update` (Payload strips the field from incoming data
 * when this returns false, so an attempt is ignored rather than rejected) and to
 * `read`, so who holds the keys is not browsable by the people who do not.
 *
 * Seeding the first admin runs with `overrideAccess: true`, which bypasses this
 * by design — that path is the bootstrap, and it is the only one.
 */
export const platformAdminFieldAccess: FieldAccess = ({ req }) => isPlatformAdminUser(req.user)

/**
 * Who may open /admin. Any ACTIVE account, because the admin panel is where a
 * team member edits their own profile — the Users list is self-scoped by
 * `isSelf`, so "can log in" is not "can see the team".
 */
export const canAccessAdminPanel = ({ req }: { req: PayloadRequest }): boolean =>
  isActiveUser(req.user)
