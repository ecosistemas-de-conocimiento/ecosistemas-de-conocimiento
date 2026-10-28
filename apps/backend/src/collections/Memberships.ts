import type {
  CollectionBeforeDeleteHook,
  CollectionBeforeOperationHook,
  CollectionBeforeValidateHook,
  CollectionConfig,
  FieldAccess,
} from 'payload'
import { sql } from '@payloadcms/db-postgres'
import { APIError, ValidationError } from 'payload'

import { isPlatformAdminUser, withinMyOrganizations, withinMyOrganizationsWithRole } from '../access'
import {
  DEFAULT_ORG_ROLE,
  isOrgRole,
  ORG_ROLES,
  organizationIdsForUserWithMinRole,
  outranks,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  roleInOrganization,
  type OrgRole,
} from '../lib/permissions'

import { transactionHandle } from '../lib/conversationUploads'

import { compoundUnique, toRelationId } from './hooks/compoundUnique'

/**
 * 🔴 NOBODY GIVES THEMSELVES A MEMBERSHIP.
 *
 * The owner's rule, verbatim: *"admin es admin, no necesita ser miembro para
 * ver todo, y no deberá poderse asignar."* A platform admin already reads every
 * tenant — `isPlatformAdminUser` short-circuits `withinMyOrganizations` — so
 * they need no membership to ADMINISTER anything. What a membership adds is
 * PARTICIPATION: uploading into an ecosistema, chatting over its private
 * drafts, publishing as one of its people. Those are different powers, and
 * `create` access on this collection (`withinMyOrganizationsWithRole('admin')`)
 * returns a bare `true` for a platform admin — so without this hook a single
 * `POST /api/memberships` with their own user id turns the oversight role into
 * a master key over every tenant's content.
 *
 * ⚠ IT IS A HOOK, NOT A UI RULE. Hiding the button in the admin panel leaves
 * the REST API wide open, and the REST API is the whole surface. A
 * `beforeValidate` hook runs on every write path Payload has.
 *
 * ⚠ WHAT IS **NOT** BLOCKED, on purpose:
 *  · Assigning OTHER people. That is legitimate administration and the reason
 *    `admin`/`owner` hold `members:manage` at all.
 *  · Editing your own membership's cosmetics — `personName`, `title`, `team`.
 *    Those grant nothing, and a person renaming themselves in an ecosistema
 *    they already belong to is not an escalation.
 *  · Seeding. The bootstrap runs with `overrideAccess: true` and no `req.user`,
 *    so there is nobody to self-assign; the very first owner membership is
 *    created there and only there.
 *
 * What IS blocked is every path by which the requester ends up holding MORE
 * access than they walked in with: creating a membership for themselves,
 * re-pointing someone else's row at themselves, re-activating their own revoked
 * row, and raising their own role.
 */
export const SELF_ASSIGNMENT_MESSAGE =
  'You cannot give yourself a membership. Administering the platform and belonging to an ' +
  'ecosistema are separate powers: a platform admin already reviews every ecosistema without ' +
  'joining one. Ask another administrator to add you if you need to participate.'

const sameId = (a: unknown, b: unknown): boolean =>
  a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b)

const refusal = (req: Parameters<CollectionBeforeValidateHook>[0]['req']) =>
  new ValidationError({
    collection: 'memberships',
    errors: [{ path: 'user', message: SELF_ASSIGNMENT_MESSAGE }],
    req,
  })

export const refuseSelfAssignment: CollectionBeforeValidateHook = ({
  data,
  operation,
  originalDoc,
  req,
}) => {
  // No authenticated principal ⇒ nobody to self-assign. This is the seed path
  // (`overrideAccess: true`, no `req`), and it must keep working: it is where
  // the first owner of the demo ecosistema comes from.
  const callerId = (req?.user as { id?: unknown } | null | undefined)?.id
  if (callerId === null || callerId === undefined) return data

  const patch = (data ?? {}) as Record<string, unknown>
  const stored = (originalDoc ?? {}) as Record<string, unknown>

  // The row's user AFTER this write. On update Payload sends only what changed,
  // so the stored value stands in for an absent one.
  const nextUser = toRelationId('user' in patch ? patch.user : stored.user)
  if (!sameId(nextUser, callerId)) return data

  // Creating a membership for yourself is the escalation, full stop.
  if (operation !== 'update') throw refusal(req)

  // On update the row may already be the caller's own. Cosmetic edits to it are
  // fine; anything that ADDS access is not.
  const previousUser = toRelationId(stored.user)
  // Re-pointing somebody else's membership at yourself.
  if (!sameId(previousUser, callerId)) throw refusal(req)
  // Un-revoking your own membership.
  if ('isActive' in patch && patch.isActive === true && stored.isActive === false) throw refusal(req)
  // Promoting yourself inside an ecosistema you are already in.
  if ('role' in patch && patch.role !== stored.role) throw refusal(req)

  return data
}

/**
 * 🔴 AN ADMIN OF ONE ECOSISTEMA MUST NOT WRITE MEMBERSHIPS INTO ANOTHER.
 *
 * `create` access is `withinMyOrganizationsWithRole('admin')`, which returns a
 * WHERE constraint (`organization in [my admin orgs]`). Payload uses that
 * constraint to filter reads, updates and deletes of EXISTING rows — but on
 * `create` there is no existing row, and Payload discards the result
 * (`payload/dist/collections/operations/create.js`, measured 2026-10-21: the
 * value of `executeAccess` is ignored). Any truthy answer means "allowed", so an
 * admin of A could `POST /api/memberships { organization: B }` and put an
 * accomplice into B with any role.
 *
 * Update has the twin hole: `update` access scopes WHICH row may be edited
 * (one in A), not what it may be edited INTO — patching `organization` to B
 * moves the row across the boundary.
 *
 * So the target organization is checked here, on every write, against the
 * organizations where the caller holds at least `admin`. Platform admins and
 * the seed path (no `req.user`) are unaffected — the same carve-outs the access
 * rule already makes.
 */
export const FOREIGN_ORGANIZATION_MESSAGE =
  'You can only add people to an ecosistema you administer.'

type AdminOrgResolver = (
  payload: Parameters<typeof organizationIdsForUserWithMinRole>[0],
  userId: number | string,
) => Promise<(number | string)[]>

export const makeRefuseForeignOrganization =
  (
    adminOrgIds: AdminOrgResolver = (payload, userId) =>
      organizationIdsForUserWithMinRole(payload, userId, 'admin'),
  ): CollectionBeforeValidateHook =>
  async ({ data, operation, originalDoc, req }) => {
    const caller = req?.user
    const callerId = (caller as { id?: unknown } | null | undefined)?.id
    if (callerId === null || callerId === undefined) return data
    if (isPlatformAdminUser(caller)) return data

    const patch = (data ?? {}) as Record<string, unknown>
    // On update, only a write that names an organization can move the row; the
    // access rule already pinned the row itself to one of the caller's orgs.
    if (operation === 'update' && !('organization' in patch)) return data

    const stored = (originalDoc ?? {}) as Record<string, unknown>
    const target = toRelationId('organization' in patch ? patch.organization : stored.organization)
    // A missing organization is the `required` validator's job, not ours.
    if (target === null) return data

    const allowed = await adminOrgIds(req.payload, callerId as number | string)
    if (allowed.some((id) => String(id) === String(target))) return data

    throw new ValidationError({
      collection: 'memberships',
      errors: [{ path: 'organization', message: FOREIGN_ORGANIZATION_MESSAGE }],
      req,
    })
  }

export const refuseForeignOrganization = makeRefuseForeignOrganization()

/**
 * 🔴 NOBODY GRANTS, CHANGES OR REMOVES A ROLE ABOVE THEIR OWN.
 *
 * `create`/`update`/`delete` access is `withinMyOrganizationsWithRole('admin')`:
 * it decides WHO may write a membership, never WHAT role it may carry. Without
 * this an `admin` could create an `owner` (an escalation by proxy), promote a
 * colleague to `owner`, or demote and remove the `owner` above them.
 *
 * The rule, per write, against the caller's role in the TARGET ecosistema:
 *  · the role the row ends up with must not outrank the caller's;
 *  · on update and delete, the role the row HAD must not outrank it either.
 *
 * Platform admins and the seed path (no `req.user`) are unaffected, like the
 * hooks above. A caller with no role in the target is refused here too; the
 * foreign-organization hook normally refuses them first.
 */
export const ROLE_CEILING_MESSAGE = 'No puedes dar, cambiar ni quitar un rol superior al tuyo.'

type RoleResolver = (
  payload: Parameters<typeof roleInOrganization>[0],
  userId: number | string,
  organizationId: number | string,
) => Promise<OrgRole | null>

const roleOrDefault = (value: unknown): OrgRole => (isOrgRole(value) ? value : DEFAULT_ORG_ROLE)

export const makeRefuseRoleAboveOwn =
  (roleIn: RoleResolver = roleInOrganization): CollectionBeforeValidateHook =>
  async ({ data, operation, originalDoc, req }) => {
    const caller = req?.user
    const callerId = (caller as { id?: unknown } | null | undefined)?.id
    if (callerId === null || callerId === undefined) return data
    if (isPlatformAdminUser(caller)) return data

    const patch = (data ?? {}) as Record<string, unknown>
    const stored = (originalDoc ?? {}) as Record<string, unknown>
    const target = toRelationId('organization' in patch ? patch.organization : stored.organization)
    if (target === null) return data

    const refuse = () =>
      new ValidationError({
        collection: 'memberships',
        errors: [{ path: 'role', message: ROLE_CEILING_MESSAGE }],
        req,
      })

    const mine = await roleIn(req.payload, callerId as number | string, target as number | string)
    if (mine === null) throw refuse()

    const isUpdate = operation === 'update'
    const next = roleOrDefault('role' in patch ? patch.role : isUpdate ? stored.role : undefined)
    if (outranks(next, mine)) throw refuse()
    if (isUpdate && outranks(roleOrDefault(stored.role), mine)) throw refuse()

    // A move takes the row OUT of its source ecosistema: the caller's role
    // there must also reach the role the row had (audit 2026-10-28).
    const source = isUpdate ? toRelationId(stored.organization) : null
    if (source !== null && String(source) !== String(target)) {
      const mineAtSource = await roleIn(req.payload, callerId as number | string, source as number | string)
      if (mineAtSource === null || outranks(roleOrDefault(stored.role), mineAtSource)) throw refuse()
    }
    return data
  }

export const refuseRoleAboveOwn = makeRefuseRoleAboveOwn()

export const makeRefuseDeleteAboveOwn =
  (roleIn: RoleResolver = roleInOrganization): CollectionBeforeDeleteHook =>
  async ({ id, req }) => {
    const caller = req?.user
    const callerId = (caller as { id?: unknown } | null | undefined)?.id
    if (callerId === null || callerId === undefined) return
    if (isPlatformAdminUser(caller)) return

    const row = (await req.payload
      .findByID({ collection: 'memberships', id, depth: 0, overrideAccess: true, req })
      .catch(() => null)) as Record<string, unknown> | null
    // No such row: Payload answers 404 itself. A row outside the caller's
    // ecosistemas: delete access refuses it. Neither is this hook's call.
    if (!row) return
    const organization = toRelationId(row.organization)
    if (organization === null) return
    const mine = await roleIn(req.payload, callerId as number | string, organization as number | string)
    if (mine === null) return
    if (outranks(roleOrDefault(row.role), mine)) throw new APIError(ROLE_CEILING_MESSAGE, 403, undefined, true)
  }

export const refuseDeleteAboveOwn = makeRefuseDeleteAboveOwn()

/**
 * 🔴 NOBODY LEAVES AN ECOSISTEMA WITHOUT A RESPONSABLE.
 *
 * The role ceiling above means only an `owner` (or a platform admin) can make
 * another `owner`. So if the last active owner removes, deactivates or demotes
 * their own row, nobody inside the ecosistema can ever restore one. The same
 * holds one step down for an ecosistema that has no owner: the last person
 * holding `members:manage` would lock everyone out of /miembros.
 *
 * The rule, on delete and on any update that takes a row's grant away
 * (`isActive: false`, or a role change): if the row is an active owner, another
 * active owner must remain; if it is an active manager, another active manager
 * must remain. Ordinary self-leave (an admin under an owner, an owner with a
 * co-owner) is untouched.
 *
 * Moving a row to another ecosistema (`organization` changes) counts as
 * removing it from the source.
 *
 * ⚠ CONCURRENCY. Two owners leaving at once would each count the other and
 * both pass. So the count runs after `pg_advisory_xact_lock` on the
 * ecosistema, in the write's own transaction: the second waits for the first
 * to commit, then counts again. No transaction to lock in → refused (fail
 * closed). Bulk writes run their per-row hooks concurrently in ONE
 * transaction, where the lock is re-entrant and does not help, so
 * `refuseBulkResponsableWrite` refuses any bulk delete or grant-changing bulk
 * update that touches an active manager row.
 *
 * Platform admins and the seed path (no `req.user`) are unaffected, like the
 * hooks above: they clean up and rebuild tenants, and they can always re-add
 * an owner.
 */
export const LAST_RESPONSABLE_MESSAGE = 'El ecosistema se quedaría sin responsable.'

const MANAGER_ROLES = ORG_ROLES.filter((r) => ROLE_PERMISSIONS[r].includes(PERMISSIONS.membersManage))

type Req = Parameters<CollectionBeforeValidateHook>[0]['req']

/** True when taking `row`'s grant away leaves its ecosistema with nobody to run it. */
async function wouldLeaveNoResponsable(req: Req, row: Record<string, unknown>): Promise<boolean> {
  if (row.isActive !== true) return false
  const role = roleOrDefault(row.role)
  if (!MANAGER_ROLES.includes(role)) return false
  const organization = toRelationId(row.organization)
  if (organization === null) return false
  const tx = await transactionHandle(req)
  if (!tx) return true
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('edc.memberships.responsable'), ${Number(organization)})`)
  const others = async (roles: readonly OrgRole[]) =>
    (
      await req.payload.count({
        collection: 'memberships',
        where: {
          and: [
            { organization: { equals: organization } },
            { isActive: { equals: true } },
            { role: { in: roles } },
            { id: { not_equals: row.id } },
          ],
        },
        overrideAccess: true,
        req,
      })
    ).totalDocs
  return (await others(role === 'owner' ? ['owner'] : MANAGER_ROLES)) === 0
}

const exemptCaller = (req: Req): boolean => {
  const callerId = (req?.user as { id?: unknown } | null | undefined)?.id
  return callerId === null || callerId === undefined || isPlatformAdminUser(req.user)
}

const lastResponsable = () => new APIError(LAST_RESPONSABLE_MESSAGE, 409, undefined, true)

export const refuseLeavingWithoutResponsable: CollectionBeforeValidateHook = async ({
  data,
  operation,
  originalDoc,
  req,
}) => {
  if (operation !== 'update' || exemptCaller(req)) return data
  const patch = (data ?? {}) as Record<string, unknown>
  const stored = (originalDoc ?? {}) as Record<string, unknown>
  const deactivates = 'isActive' in patch && patch.isActive !== true && stored.isActive === true
  const changesRole = 'role' in patch && patch.role !== stored.role
  const moves =
    'organization' in patch && String(toRelationId(patch.organization)) !== String(toRelationId(stored.organization))
  if (moves) {
    if (await wouldLeaveNoResponsable(req, stored)) throw lastResponsable()
    return data
  }
  if (!deactivates && !changesRole) return data
  // A role change that keeps the row's rank in the rule (owner → owner, or
  // manager → another manager below owner) takes nothing away.
  const next = roleOrDefault(patch.role)
  const keepsGrant =
    !deactivates && MANAGER_ROLES.includes(next) && (stored.role !== 'owner' || next === 'owner')
  if (keepsGrant) return data
  if (await wouldLeaveNoResponsable(req, stored)) throw lastResponsable()
  return data
}

const GRANT_FIELDS = ['isActive', 'role', 'organization'] as const

/** Who may write memberships: `members:manage`. Shared by the access rule and the bulk guard. */
const manageAccess = withinMyOrganizationsWithRole('admin')

export const refuseBulkResponsableWrite: CollectionBeforeOperationHook = async ({ args, operation, req }) => {
  if (operation !== 'delete' && operation !== 'update') return args
  const a = args as { id?: unknown; where?: unknown; data?: Record<string, unknown>; overrideAccess?: boolean }
  // By-id operations have `id`; only bulk ones arrive with a bare `where`.
  if (a.id !== undefined || !a.where || exemptCaller(req)) return args
  if (operation === 'update' && !GRANT_FIELDS.some((f) => f in (a.data ?? {}))) return args
  // 🔴 beforeOperation runs BEFORE Payload's access check (re-audit
  // 2026-10-28). Counting over every row would answer 409 vs 403 by whether a
  // hidden row matched — an oracle on who manages what. So count only rows the
  // caller could write anyway; with no access at all, let Payload refuse.
  const access = a.overrideAccess === true ? true : await manageAccess({ req } as never)
  if (access === false) return args
  const hit = await req.payload.count({
    collection: 'memberships',
    where: {
      and: [
        a.where as never,
        { isActive: { equals: true } },
        { role: { in: MANAGER_ROLES } },
        ...(access === true ? [] : [access as never]),
      ],
    },
    overrideAccess: true,
    req,
  })
  if (hit.totalDocs > 0) throw lastResponsable()
  return args
}

export const refuseDeleteLastResponsable: CollectionBeforeDeleteHook = async ({ id, req }) => {
  if (exemptCaller(req)) return
  const row = (await req.payload
    .findByID({ collection: 'memberships', id, depth: 0, overrideAccess: true, req })
    .catch(() => null)) as Record<string, unknown> | null
  if (row && (await wouldLeaveNoResponsable(req, row))) throw lastResponsable()
}

const USER_QUERY_MESSAGE = 'Consulta no permitida.'

/** `user`, `user.email`, `USER`, `User.id` … — every letter case, since the check must not be narrower than the database. */
const isUserPath = (path: string): boolean => {
  const p = path.trim().toLowerCase()
  return p === 'user' || p.startsWith('user.')
}

/**
 * True when `where` filters on `user` (or `user.*`) by anything but
 * `user equals <me>`. ⚠ Payload lowercases `and`/`or` before it builds SQL
 * (`validateQueryPaths.js:17`, drizzle `parseParams`), so `AND`, `Or`, `aNd`
 * must be walked too (third audit 2026-10-28: `where[AND][0][user]` recovered a
 * hidden id in 10 requests). Their value is walked whether it is an array or a
 * keyed object.
 */
function queriesOthersByUser(where: unknown, callerId: unknown): boolean {
  if (!where || typeof where !== 'object') return false
  for (const [key, value] of Object.entries(where as Record<string, unknown>)) {
    const lower = key.trim().toLowerCase()
    if (lower === 'and' || lower === 'or') {
      const items = value && typeof value === 'object' ? Object.values(value as Record<string, unknown>) : []
      if (items.some((w) => queriesOthersByUser(w, callerId))) return true
      continue
    }
    if (!isUserPath(key)) continue
    const ops = value && typeof value === 'object' ? Object.entries(value as Record<string, unknown>) : []
    const [op, operand] = ops[0] ?? []
    const ownOnly =
      key === 'user' &&
      ops.length === 1 &&
      op === 'equals' &&
      (typeof operand === 'string' || typeof operand === 'number') &&
      String(operand) === String(callerId)
    if (!ownOnly) return true
  }
  return false
}

const sortsByUser = (sort: unknown): boolean =>
  (Array.isArray(sort) ? sort : typeof sort === 'string' ? sort.split(',') : []).some((s) =>
    isUserPath(String(s).trim().replace(/^-/, '')),
  )

/**
 * 🔴 THE HIDDEN ACCOUNT ID CANNOT BE SEARCHED FOR EITHER.
 *
 * `readMembershipUser` hides the value, but a where-query still could find it:
 * `where[user][greater_than]` binary-searched a hidden id in 10 requests, and
 * `sort=user` leaked order (re-audit 2026-10-28). So, for a caller who is not
 * a platform admin and goes through access, any filter or sort on `user`
 * other than `user equals <me>`:
 *  · is refused (400) when the caller manages no ecosistema;
 *  · is narrowed to the ecosistemas they manage otherwise — where they can
 *    already read every `user` value.
 * Trusted local calls (`overrideAccess: true`) are untouched.
 */
export const limitQueriesOnUser: CollectionBeforeOperationHook = async ({ args, req }) => {
  const a = args as { where?: unknown; sort?: unknown; overrideAccess?: boolean }
  if (a.overrideAccess === true) return args
  const callerId = (req?.user as { id?: unknown } | null | undefined)?.id
  if (callerId === null || callerId === undefined || isPlatformAdminUser(req.user)) return args
  if (!queriesOthersByUser(a.where, callerId) && !sortsByUser(a.sort)) return args
  const managed = await organizationIdsForUserWithMinRole(req.payload, callerId as number | string, 'admin')
  if (managed.length === 0) throw new APIError(USER_QUERY_MESSAGE, 400, undefined, true)
  const scope = { organization: { in: managed } }
  return { ...args, where: a.where ? { and: [a.where, scope] } : scope } as typeof args
}

/**
 * 🔴 WHO SEES THE ACCOUNT ID ON A MEMBERSHIP.
 *
 * User ids are a sequence, so a fresh id on a new row tells every member that
 * a brand-new account was just made (an account-existence oracle, audit
 * 2026-10-28). The id is shown to a platform admin, to the row's own person,
 * and to whoever holds `members:manage` in the row's ecosistema. Without a doc
 * (Payload asking whether the field may be QUERIED) it answers yes, so
 * `where[user][equals]=<me>` keeps working for everyone; `limitQueriesOnUser`
 * decides which other queries on it are allowed.
 */
export const readMembershipUser: FieldAccess = async ({ req, doc }) => {
  const callerId = (req?.user as { id?: unknown } | null | undefined)?.id
  if (callerId === null || callerId === undefined) return false
  if (isPlatformAdminUser(req.user)) return true
  if (!doc) return true
  const row = doc as Record<string, unknown>
  if (String(toRelationId(row.user)) === String(callerId)) return true
  const organization = toRelationId(row.organization)
  if (organization === null) return false
  const cache = ((req.context as Record<string, unknown>).membershipUserRead ??= new Map()) as Map<
    string,
    Promise<OrgRole | null>
  >
  const key = String(organization)
  if (!cache.has(key)) cache.set(key, roleInOrganization(req.payload, callerId as number | string, organization as number | string))
  const role = await cache.get(key)!
  return role !== null && ROLE_PERMISSIONS[role].includes(PERMISSIONS.membersManage)
}

/** Admin-panel labels. Exhaustive by type, so adding a role forces a label. */
const ROLE_LABELS: Record<OrgRole, string> = {
  estudiante: 'Estudiante — a member, plus the student view where it is switched on',
  member: 'Member — read, upload, chat, rate answers',
  admin:
    'Admin — the above, plus Voces on behalf of others, rating comments, Revisión, manage people, delete documents',
  investigador:
    'Investigador — the above, plus this ecosistema’s settings (/ajustes); manages everyone but the owner',
  owner: 'Owner — the above, plus the ecosistema’s slug and on/off switch',
}

/**
 * ⚠ THE AUTHORIZATION ROW. One person, in one organization, with one role.
 *
 * This is where the whole role model lives. There is no `roles` collection, no
 * `permissions` collection and no `assignments` collection. This product has
 * one permission vocabulary, so the
 * role is a `select` here and the role→permission expansion is code
 * (`ROLE_PERMISSIONS` in `lib/permissions.ts`). That header explains the choice
 * in full.
 *
 * ── WHAT THIS COLLECTION USED TO BE ──────────────────────────────────────────
 * In the product backend this was a directory entry: a denormalized
 * `personName`/`personEmail` pair hanging off a team, deliberately NOT requiring
 * a real account, so a PoC could seed colleagues who had never logged in. It
 * now carries access, so `user` and `organization` are REQUIRED — a row that
 * grants nothing to nobody is not a membership. `personName` survives as an
 * optional display override for the `@`-mention surface, which resolves
 * memberships as domain entities (see `lib/contextRefs.ts`).
 *
 * ── UNIQUENESS ───────────────────────────────────────────────────────────────
 * ⚠ (user, organization) is enforced by a HOOK, not a database constraint —
 * Payload has no compound unique index. Two simultaneous creates can therefore
 * both pass it. The resolver is written to survive that: it takes the HIGHEST
 * role when it finds duplicates rather than picking one arbitrarily, so a race
 * produces the grant an admin intended rather than a coin flip. The real fix is
 * a partial unique index in the first baseline migration — see
 * `src/migrations/README.md`.
 */
export const Memberships: CollectionConfig = {
  slug: 'memberships',
  admin: {
    useAsTitle: 'personName',
    defaultColumns: ['user', 'organization', 'role', 'isActive', 'updatedAt'],
    group: 'Tenancy',
  },
  access: {
    // Everyone in an organization can see who else is in it — that is what
    // makes `@`-mentions and a member list work. Scoped to YOUR organizations.
    read: withinMyOrganizations(),
    // Adding, re-roling and removing people is the `members:manage` permission,
    // which `admin` and `owner` hold.
    create: manageAccess,
    update: manageAccess,
    delete: manageAccess,
  },
  hooks: {
    // 🔴 Bulk writes cannot take out a responsable — see `refuseLeavingWithoutResponsable`.
    beforeOperation: [limitQueriesOnUser, refuseBulkResponsableWrite],
    beforeValidate: [
      // 🔴 First, because a refusal must not depend on whether a twin row
      // happens to exist. See `refuseSelfAssignment` above.
      refuseSelfAssignment,
      // 🔴 Then the tenant boundary on the TARGET row — see the hook's header.
      refuseForeignOrganization,
      // 🔴 And the role ceiling — see `refuseRoleAboveOwn`.
      refuseRoleAboveOwn,
      // 🔴 And no ecosistema left without a responsable — see its header.
      refuseLeavingWithoutResponsable,
      compoundUnique({
        collection: 'memberships',
        fields: ['user', 'organization'],
        errorPath: 'user',
        message: 'This person already has a membership in this organization.',
      }),
    ],
    beforeDelete: [refuseDeleteAboveOwn, refuseDeleteLastResponsable],
  },
  fields: [
    {
      name: 'user',
      type: 'relationship',
      relationTo: 'users',
      required: true,
      index: true,
      access: { read: readMembershipUser },
      admin: { description: 'The account this membership grants access to.' },
    },
    {
      name: 'organization',
      type: 'relationship',
      relationTo: 'organizations',
      required: true,
      index: true,
      admin: { description: 'The tenant. Required — this is what the membership scopes.' },
    },
    {
      // ⚠ THE GRANT. `lib/permissions.ts` expands this into the flat permission
      // list that goes on the wire. Do not add a role here without adding it to
      // `ORG_ROLES` and `ROLE_PERMISSIONS` in the same change — an unknown
      // value falls back to `member` in the resolver, which under-grants
      // SILENTLY. The `options` list below is derived from `ORG_ROLES` so the
      // two cannot fall out of step; the labels are the only hand-written part.
      name: 'role',
      type: 'select',
      required: true,
      defaultValue: DEFAULT_ORG_ROLE,
      index: true,
      options: ORG_ROLES.map((role) => ({ value: role, label: ROLE_LABELS[role] })),
    },
    {
      // Revoke without losing the audit trail. The resolver checks this, so
      // switching it off takes access away on the next request.
      name: 'isActive',
      type: 'checkbox',
      defaultValue: true,
      index: true,
      label: 'Membership active',
      admin: { position: 'sidebar' },
    },
    {
      name: 'team',
      type: 'relationship',
      relationTo: 'teams',
      index: true,
      admin: {
        description:
          'Optional. Which team inside the organization this person sits on — display and chat context only, it grants nothing.',
      },
    },
    {
      name: 'personName',
      type: 'text',
      admin: {
        description:
          'Optional display override for chat context and `@`-mentions. Falls back to the user account when empty.',
      },
    },
    {
      name: 'title',
      type: 'text',
      admin: { description: 'Human-readable job title, e.g. "Coordinadora". Display only.' },
    },
  ],
}
