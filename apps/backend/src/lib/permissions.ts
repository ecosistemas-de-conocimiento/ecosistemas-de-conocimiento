/**
 * THE RESOLVER. Rows in, one flat answer out.
 *
 * `/v1/identity/token`, `/v1/identity/me` and `/v1/identity/resolve` all call
 * this file and put the result straight on the wire — so THIS FILE, not any
 * collection, is the shape a consumer actually depends on.
 *
 * ── WHY THE ROLE MODEL IS CODE ───────────────────────────────────────────────
 *
 * An editable RBAC catalogue (`projects`, `permissions`, `roles`, `assignments`
 * collections) answers a question this product does not have. There is ONE
 * product here. Its tenancy axis is the ORGANIZATION, and a person's standing
 * in an organization is one of three things: they own it, they administer it,
 * or they are a member of it. Modelling that as an editable catalogue of
 * permission rows would mean an admin panel where you can define a role that
 * grants `documents:delete` in an app that has exactly one delete button — a
 * configuration surface with nothing real to configure, plus four tables, four
 * sets of access rules and an N+1-shaped resolver to keep correct.
 *
 * So: **the role lives on the membership, and the role→permission map is
 * CODE** (`ROLE_PERMISSIONS` below).
 *
 * ⚠ THE WIRE SHAPE MUST STAY AS IT IS. `@edc/identity-client`
 * consumes `ResolvedPrincipal` with a `projects` map and `ProjectGrant`
 * `{ roles, permissions }`, and its `canInProject(principal, slug, perm)` is
 * the check a consumer writes. In THIS product that map is keyed by
 * ORGANIZATION SLUG. The field is still called `projects` because renaming it
 * is a breaking change to a published client for a cosmetic gain — read it as
 * "the scopes this principal has standing in".
 *
 * ── INVARIANTS THAT ARE LOAD-BEARING, NOT STYLISTIC ──────────────────────────
 *
 * ⚠ Output arrays are DEDUPLICATED AND SORTED. Two calls over the same rows
 * must produce byte-identical JSON, or tokens stop being comparable and every
 * downstream cache key churns for nothing.
 *
 * ⚠ Queries are BATCHED, never per-membership. Three round trips resolve a
 * principal with any number of memberships. A loop with a query inside it would
 * put N+1 on the login path.
 *
 * ⚠ GRANTS ONLY EVER ADD. There is no deny and no precedence order. Removing
 * access means lowering a role or switching something off. Deny rules are where
 * authorization systems become impossible to reason about.
 *
 * ⚠ DEACTIVATION IS THE REVOKE SWITCH, AT THREE LEVELS — `users.isActive`,
 * `memberships.isActive`, `organizations.isActive`. Any one of them false and
 * the grant resolves to nothing.
 */

import type { CollectionSlug, Payload, Where } from 'payload'

// ---------------------------------------------------------------------------
// The role model
// ---------------------------------------------------------------------------

/**
 * The five ways to stand in an organization. Ordered least → most privileged;
 * `ROLE_RANK` below depends on that order.
 *
 * ⚠ These strings are on the wire (`roles` in a token, `roles` in a grant, and
 * `memberships[].role` on `/api/users/me`) and in the database
 * (`memberships.role`). Renaming one is a migration AND a client change.
 *
 * ── THE LADDER (owner ruling 2026-10-27) ─────────────────────────────────────
 *
 *   estudiante < member < admin < investigador < owner
 *
 *  · `estudiante` — a participant with a member's grants, plus the student view
 *    where the ecosistema has `studentView` on (`lib/features.ts`). No
 *    Revisión, no rating comments, nobody else's drafts. It ranks BELOW member
 *    so a student can never grant `member`.
 *  · `investigador` — "like admin, but only inside the ecosistemas they're
 *    assigned to": every grant of `admin`. It ranks ABOVE admin and BELOW owner, so the role
 *    ceiling lets an investigador add, re-role and remove everyone except the
 *    responsable. Never the platform: `isPlatformAdmin` is a user flag no
 *    membership sets, and `PATCH /api/plataforma` asks for that flag alone.
 *  · `owner` ("responsable") — investigador's grants plus `organization:manage`
 *    (that ecosistema's /ajustes: saving its switches, the ecosistema
 *    re-anonymisation status and "Reintentar"). The rank above it lets an
 *    owner manage investigadores, and only an owner changes the ecosistema's
 *    slug or switches it off (`collections/Organizations.ts`).
 *
 * 🔴 /ajustes IS THE RESPONSABLE'S (owner decision 2026-11-10, wave 4): an
 * investigador no longer saves Ajustes. From 2026-10-27 to 2026-11-10
 * `organization:manage` came with investigador. Only Ajustes reads that
 * permission (`/api/funciones`, `/api/organizations/:id/anonimizacion`, the
 * web's `canEditFeatures`); /miembros (`members:manage`), Revisión and
 * /admin (`canAdminOrg`, by role) are unchanged.
 *
 * Until 2026-10-27 `investigador` sat between member and admin and managed
 * nobody. The owner widened it: every rank-gated surface
 * (`withinMyOrganizationsWithRole('admin')` on memberships, teams, projects;
 * the usage and metrics reads) now admits it, on purpose.
 *
 * ⚠ THE RANK IS NOT COSMETIC. `organizationIdsForUserWithMinRole` compares by
 * rank, so inserting a role in the wrong slot silently hands it (or denies it)
 * every rank-gated surface at once.
 *
 * ⚠ The Postgres enum's value order is NOT this order (`estudiante` was added
 * by `ALTER TYPE … ADD VALUE`). Nothing sorts by the enum; rank lives here.
 */
export const ORG_ROLES = ['estudiante', 'member', 'admin', 'investigador', 'owner'] as const

export type OrgRole = (typeof ORG_ROLES)[number]

/** Highest wins when someone somehow holds two memberships in one org. */
const ROLE_RANK: Record<OrgRole, number> = {
  estudiante: 0,
  member: 1,
  admin: 2,
  investigador: 3,
  owner: 4,
}

export const DEFAULT_ORG_ROLE: OrgRole = 'member'

export function isOrgRole(value: unknown): value is OrgRole {
  return typeof value === 'string' && (ORG_ROLES as readonly string[]).includes(value)
}

/** `true` when `role` ranks strictly above `than`. The one rank comparison callers outside this file make. */
export function outranks(role: OrgRole, than: OrgRole): boolean {
  return ROLE_RANK[role] > ROLE_RANK[than]
}

/**
 * Every permission this product recognises. The list is SHORT on purpose: each
 * entry has to correspond to something the UI or the API actually gates, or it
 * is decoration that will drift out of sync with the code silently.
 */
export const PERMISSIONS = {
  /** See the organization's documents and their extracted text. */
  documentsRead: 'documents:read',
  /** Upload a document and enqueue it for ingestion. */
  documentsWrite: 'documents:write',
  /** Remove a document, and with it the answers grounded in it. */
  documentsDelete: 'documents:delete',
  /** Open a chat session and ask questions over the knowledgebase. */
  chatUse: 'chat:use',
  /** Star an assistant answer 1-5. */
  ratingsWrite: 'ratings:write',
  /** Add, remove and re-role people in the organization. */
  membersManage: 'members:manage',
  /** Rename the organization, deactivate it, change its settings. */
  organizationManage: 'organization:manage',
  /**
   * 🔴 UPLOAD SOMEBODY ELSE'S WORDS. What separates an Investigador from a
   * participant on the upload surface.
   *
   * `documents:write` means "file MY material". This means "file material that
   * came from someone who is not on this platform" — a Voz (`contentKind:
   * 'testimonio'`), or a document collected in the field. `uploadedBy` stays the
   * Investigador, because it records WHO PERFORMED THE UPLOAD; the words are
   * somebody else's and the system deliberately never learns whose.
   *
   * ⚠ It is a separate permission and not a free consequence of `documents:write`
   * because every testimony goes through the anonymisation gate and lands in the
   * shared corpus as an anonymous voice. That is a different act from uploading
   * a PDF you own, and a participant should not perform it by accident.
   */
  vocesUpload: 'voces:upload',
  /**
   * Read `ratings.comment` — the free text behind the `other` reason.
   *
   * ⚠ THIS USED TO BE IMPLICIT AND WIDE. `ratings` read access is tenant-wide,
   * so until this permission existed every member of an ecosistema could read
   * every colleague's written complaint about an answer. The UI warns people the
   * field is not private, which is honest, but "not private" was being read as
   * "published to everyone you work with". Narrowing it to Investigador and up
   * is the point of the permission; the star counts stay tenant-wide, because
   * those are what an admin needs and they name nobody.
   */
  ratingsReadComments: 'ratings:read-comments',
  /**
   * 🔴 REVIEW A DOCUMENT THE ANONYMISATION GATE REFUSED, and release it or
   * reject it.
   *
   * ── WHY THIS IS A REAL PRIVILEGE AND NOT A CHORE ────────────────────────────
   *
   * A hold means the gate is not sure the text is safe. Reviewing one therefore
   * means reading material that HAS NOT PASSED ANONYMISATION — the gate's
   * best-effort output with, quite possibly, somebody's name still in it. And an
   * approval writes that text into a shared corpus that has no per-document
   * delete, so it is irreversible in practice.
   *
   * ── WHY INVESTIGADOR AND NOT ADMIN ──────────────────────────────────────────
   *
   * 🔴 The bar had to land somewhere between "the uploader" and "whoever runs
   * the installation", and the argument that decided it is CONTEXT:
   *
   *   · The person who can tell "the gate over-redacted this into nonsense" from
   *     "a neighbour's name is still in paragraph four" is the person who
   *     collected the material. That is the Investigador — the same role that
   *     holds `voces:upload`, which is what put the Voz here in the first place.
   *   · Gating it at `admin` would hand the judgement to the person with the
   *     LEAST context, and the predictable outcome is holds sitting unreviewed
   *     until somebody clicks approve without reading. An unread approval is
   *     worse than no review, because it launders the decision.
   *   · Admin and owner hold it too. Since 2026-10-27 admin ranks below
   *     investigador and holds it directly; estudiante and member never do.
   *
   * ⚠ IT IS A SEPARATE PERMISSION, NOT A FREE CONSEQUENCE OF `voces:upload`, for
   * exactly the reason `voces:upload` is separate from `documents:write`:
   * overriding a fail-closed safety gate is a different act from filing
   * material, and the day the two need to be held by different people, the
   * split already exists.
   *
   * ⚠ AND IT IS SCOPED, like every permission here. Holding it grants review of
   * holds in the ecosistemas you are an active member of, and nowhere else.
   */
  holdsReview: 'holds:review',
} as const

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS]

const MEMBER_PERMISSIONS: readonly Permission[] = [
  PERMISSIONS.documentsRead,
  PERMISSIONS.documentsWrite,
  PERMISSIONS.chatUse,
  PERMISSIONS.ratingsWrite,
]

/**
 * ⚠ EXACTLY A MEMBER'S GRANTS. What a student adds is a VIEW, switched per
 * ecosistema by `studentView`, not a permission: the token carries nothing
 * extra, and the role itself (`roles: ['estudiante']`) is what the view reads.
 */
const ESTUDIANTE_PERMISSIONS: readonly Permission[] = [...MEMBER_PERMISSIONS]

/**
 * ⚠ Built by SPREAD up the ladder: a rank that does not come with the lower
 * role's grants is a lie that shows up as someone refused what a colleague one
 * rank below them can do.
 */
const ADMIN_PERMISSIONS: readonly Permission[] = [
  ...MEMBER_PERMISSIONS,
  PERMISSIONS.vocesUpload,
  PERMISSIONS.ratingsReadComments,
  PERMISSIONS.holdsReview,
  PERMISSIONS.documentsDelete,
  PERMISSIONS.membersManage,
]

/**
 * Admin's grants, scoped like every membership to the ecosistemas the person
 * is assigned to; the rank above admin is the difference. See the ladder in
 * the `ORG_ROLES` header.
 */
const INVESTIGADOR_PERMISSIONS: readonly Permission[] = [...ADMIN_PERMISSIONS]

/** Investigador plus `organization:manage` — the ecosistema's /ajustes (owner decision 2026-11-10). */
const OWNER_PERMISSIONS: readonly Permission[] = [...INVESTIGADOR_PERMISSIONS, PERMISSIONS.organizationManage]

/**
 * Role → effective permissions. THE map; nothing else expands a role.
 *
 * ⚠ Consumers receive a FLAT permission list and check membership in it. They
 * never expand a role themselves. The moment two places expand roles
 * independently they drift, and the drift is silent.
 */
export const ROLE_PERMISSIONS: Record<OrgRole, readonly Permission[]> = {
  estudiante: ESTUDIANTE_PERMISSIONS,
  member: MEMBER_PERMISSIONS,
  investigador: INVESTIGADOR_PERMISSIONS,
  admin: ADMIN_PERMISSIONS,
  owner: OWNER_PERMISSIONS,
}

/**
 * What a PLATFORM ADMIN holds in every active organization.
 *
 * They run the installation, so the token says so explicitly rather than making
 * each caller remember to special-case a flag it might forget to check.
 */
const PLATFORM_ADMIN_ROLE: OrgRole = 'owner'

// ---------------------------------------------------------------------------
// Wire types — mirror `@edc/identity-client`
// ---------------------------------------------------------------------------

export type ProjectGrant = { roles: string[]; permissions: string[] }

export type ResolvedPrincipal = {
  email: string
  name: string | null
  isPlatformAdmin: boolean
  /**
   * Keyed by ORGANIZATION SLUG. Named `projects` for wire compatibility with
   * `@edc/identity-client` — see the file header.
   *
   * An organization the person has no active membership in is simply ABSENT;
   * there are no empty placeholders to filter out downstream.
   */
  projects: Record<string, ProjectGrant>
}

// ---------------------------------------------------------------------------
// Row shapes + small helpers
// ---------------------------------------------------------------------------

type Id = number | string

type UserRow = {
  id: Id
  email: string
  displayName?: string | null
  isPlatformAdmin?: boolean | null
  isActive?: boolean | null
}

type OrganizationRow = { id: Id; slug: string; isActive?: boolean | null }

type MembershipRow = {
  id: Id
  user?: unknown
  organization?: unknown
  role?: unknown
  isActive?: boolean | null
}

/** Map keys have to be stable whether Postgres hands back 7 or '7'. */
const keyOf = (id: Id): string => String(id)

/** A relationship is an id at depth 0 and a document deeper in. Take the id. */
export function relationId(value: unknown): Id | null {
  if (typeof value === 'number') return value
  if (typeof value === 'string') return value === '' ? null : value
  if (value && typeof value === 'object') {
    const id = (value as { id?: unknown }).id
    if (typeof id === 'number' || typeof id === 'string') return id
  }
  return null
}

const uniqueIds = (ids: Id[]): Id[] => {
  const seen = new Map<string, Id>()
  for (const id of ids) if (!seen.has(keyOf(id))) seen.set(keyOf(id), id)
  return [...seen.values()]
}

/**
 * Every read here runs with `overrideAccess: true`. Two reasons, both
 * load-bearing: `isPlatformAdmin` is field-gated to admins (see `access/`) and
 * would come back stripped, and the resolver answers for OTHER people — a
 * service asking "what may ana do in acme" is not ana.
 */
/**
 * ⚠ WHY `isActive: { equals: true }` AND NOT `{ not_equals: false }`.
 *
 * They are NOT the same filter. Payload's drizzle adapter (3.88,
 * `dist/queries/parseParams.js`) compiles
 * `not_equals: false` to `IS NULL OR <> false`, so a row whose column is NULL
 * PASSES it — the looser predicate grants access on a missing flag. Every
 * filter below asks for `= true` instead: an authorization gate should fail
 * CLOSED and should read as if it does. Every
 * `isActive` field carries `defaultValue: true`, so a row without it is an
 * anomaly, and an anomaly resolving to "no access" is the outcome we want.
 */
async function findAll<T>(payload: Payload, collection: CollectionSlug, where: Where): Promise<T[]> {
  const result = await payload.find({
    collection,
    where,
    depth: 0,
    pagination: false,
    overrideAccess: true,
  })
  return result.docs as unknown as T[]
}

/** The user row, or null when there is no such person or they are switched off. */
async function loadActiveUser(payload: Payload, email: string): Promise<UserRow | null> {
  const normalized = email.trim().toLowerCase()
  if (!normalized) return null

  const rows = await findAll<UserRow>(payload, 'users', { email: { equals: normalized } })
  const user = rows[0]
  // `= true`, like every filter here: a NULL flag is no access.
  if (!user || user.isActive !== true) return null
  return user
}

function displayNameOf(user: UserRow): string | null {
  const name = typeof user.displayName === 'string' ? user.displayName.trim() : ''
  return name === '' ? null : name
}

/** Dedupe + sort, so two calls over the same rows are byte-identical. */
const sortedGrant = (roles: string[], permissions: string[]): ProjectGrant => ({
  roles: [...new Set(roles)].sort(),
  permissions: [...new Set(permissions)].sort(),
})

/** The grant one role produces. The single expansion point. */
export function grantForRole(role: OrgRole): ProjectGrant {
  return sortedGrant([role], [...ROLE_PERMISSIONS[role]])
}

/** The role on a membership row, defaulting rather than throwing on junk. */
function roleOf(membership: MembershipRow): OrgRole {
  return isOrgRole(membership.role) ? membership.role : DEFAULT_ORG_ROLE
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * The ACTIVE organizations this user is an ACTIVE member of, with their role.
 *
 * Two queries, never one per membership. Exported because access control needs
 * exactly this answer (see `access/index.ts` and `collections/Ratings.ts`) and
 * a second, subtly different implementation of "which orgs may this person
 * touch" is how a tenant leak gets written.
 */
export async function membershipsForUser(
  payload: Payload,
  userId: Id,
): Promise<Array<{ organization: OrganizationRow; role: OrgRole }>> {
  const memberships = await findAll<MembershipRow>(payload, 'memberships', {
    and: [{ user: { equals: userId } }, { isActive: { equals: true } }],
  })
  if (memberships.length === 0) return []

  const orgIds = uniqueIds(
    memberships
      .map((membership) => relationId(membership.organization))
      .filter((id): id is Id => id !== null),
  )
  if (orgIds.length === 0) return []

  const organizations = await findAll<OrganizationRow>(payload, 'organizations', {
    and: [{ id: { in: orgIds } }, { isActive: { equals: true } }],
  })
  const byId = new Map(organizations.map((org) => [keyOf(org.id), org]))

  // Highest role wins if two membership rows somehow point at the same org.
  // (Uniqueness on (user, organization) is a hook, not a database constraint,
  // so a raced double-insert is possible — see collections/hooks/compoundUnique.)
  const best = new Map<string, { organization: OrganizationRow; role: OrgRole }>()
  for (const membership of memberships) {
    const orgId = relationId(membership.organization)
    // Missing from the map = unknown org, or a deactivated one. Skip either.
    const organization = orgId === null ? undefined : byId.get(keyOf(orgId))
    if (!organization) continue

    const role = roleOf(membership)
    const existing = best.get(keyOf(organization.id))
    if (!existing || ROLE_RANK[role] > ROLE_RANK[existing.role]) {
      best.set(keyOf(organization.id), { organization, role })
    }
  }

  return [...best.values()]
}

/**
 * The ids of every organization a user may touch. The one query access control
 * asks. Returns `[]` for a user with no active memberships — which callers must
 * treat as "sees nothing", never as "sees everything".
 */
export async function organizationIdsForUser(payload: Payload, userId: Id): Promise<Id[]> {
  const rows = await membershipsForUser(payload, userId)
  return rows.map((row) => row.organization.id)
}

/**
 * The same list, narrowed to organizations where the user holds AT LEAST
 * `minRole`. This is what lets "admins manage members" and "owners rename the
 * organization" be real rules rather than comments.
 *
 * ⚠ Comparison is by `ROLE_RANK`, not by string equality: asking for `admin`
 * must include owners, or every owner-only account would silently lose the
 * admin surface.
 */
export async function organizationIdsForUserWithMinRole(
  payload: Payload,
  userId: Id,
  minRole: OrgRole,
): Promise<Id[]> {
  const rows = await membershipsForUser(payload, userId)
  return rows
    .filter((row) => ROLE_RANK[row.role] >= ROLE_RANK[minRole])
    .map((row) => row.organization.id)
}

/**
 * The role this user holds in ONE organization, or `null` when they hold none
 * there (no active membership, or the organization is switched off). Same two
 * queries as `membershipsForUser`; the highest role wins on a raced duplicate.
 */
export async function roleInOrganization(
  payload: Payload,
  userId: Id,
  organizationId: Id,
): Promise<OrgRole | null> {
  const rows = await membershipsForUser(payload, userId)
  return rows.find((row) => keyOf(row.organization.id) === keyOf(organizationId))?.role ?? null
}

/**
 * The organizations where this user holds `permission`.
 *
 * ⚠ ASK BY PERMISSION, NOT BY RANK, for anything that is not a strict ladder.
 * `organizationIdsForUserWithMinRole` is the right question for "who manages
 * members" — that genuinely is a ladder. It is the WRONG question for "who may
 * file a Voz", because the answer is a property of the role, and encoding it as
 * `minRole: 'investigador'` bakes the current rank order into the call site. The
 * day a role is inserted or reordered, a rank-phrased check silently changes
 * meaning while a permission-phrased one does not.
 *
 * Same two queries as every other resolver here; no per-membership round trip.
 */
export async function organizationIdsForUserWithPermission(
  payload: Payload,
  userId: Id,
  permission: Permission,
): Promise<Id[]> {
  const rows = await membershipsForUser(payload, userId)
  return rows
    .filter((row) => ROLE_PERMISSIONS[row.role].includes(permission))
    .map((row) => row.organization.id)
}

/**
 * Everything one person may do, everywhere. `null` when the email belongs to
 * nobody or to a deactivated account — callers should treat that as "no such
 * principal", NOT as "a principal with no permissions". The two are different:
 * the first is a 404/403, the second is a valid user who simply has not been
 * added to an organization yet.
 */
export async function resolvePrincipal(
  payload: Payload,
  email: string,
): Promise<ResolvedPrincipal | null> {
  const user = await loadActiveUser(payload, email)
  if (!user) return null

  const isPlatformAdmin = user.isPlatformAdmin === true
  const projects: Record<string, ProjectGrant> = {}

  if (isPlatformAdmin) {
    // Expanded across every ACTIVE organization, with no membership row needed.
    const organizations = await findAll<OrganizationRow>(payload, 'organizations', {
      isActive: { equals: true },
    })
    const grant = grantForRole(PLATFORM_ADMIN_ROLE)
    for (const organization of organizations) {
      projects[organization.slug] = { roles: [...grant.roles], permissions: [...grant.permissions] }
    }
    return {
      email: user.email,
      name: displayNameOf(user),
      isPlatformAdmin: true,
      projects,
    }
  }

  for (const { organization, role } of await membershipsForUser(payload, user.id)) {
    projects[organization.slug] = grantForRole(role)
  }

  return {
    email: user.email,
    name: displayNameOf(user),
    isPlatformAdmin: false,
    projects,
  }
}

/**
 * The same answer, narrowed to one organization — what a token request needs.
 *
 * `null` means NO ACCESS, and covers all four ways of having none: unknown or
 * deactivated user, unknown or deactivated organization, and no active
 * membership.
 */
export async function resolveForOrganization(
  payload: Payload,
  email: string,
  organizationSlug: string,
): Promise<ProjectGrant | null> {
  const user = await loadActiveUser(payload, email)
  if (!user) return null

  const slug = organizationSlug.trim().toLowerCase()
  if (!slug) return null

  const organizations = await findAll<OrganizationRow>(payload, 'organizations', {
    and: [{ slug: { equals: slug } }, { isActive: { equals: true } }],
  })
  const organization = organizations[0]
  if (!organization) return null

  if (user.isPlatformAdmin === true) return grantForRole(PLATFORM_ADMIN_ROLE)

  const memberships = await findAll<MembershipRow>(payload, 'memberships', {
    and: [
      { user: { equals: user.id } },
      { organization: { equals: organization.id } },
      { isActive: { equals: true } },
    ],
  })
  if (memberships.length === 0) return null

  // Highest role wins — same rule as `membershipsForUser`, for the same reason.
  let best: OrgRole = DEFAULT_ORG_ROLE
  let found = false
  for (const membership of memberships) {
    const role = roleOf(membership)
    if (!found || ROLE_RANK[role] > ROLE_RANK[best]) {
      best = role
      found = true
    }
  }

  return grantForRole(best)
}
