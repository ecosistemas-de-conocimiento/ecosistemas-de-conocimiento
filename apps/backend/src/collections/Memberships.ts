import type { CollectionBeforeDeleteHook, CollectionBeforeValidateHook, CollectionConfig } from 'payload'
import { APIError, ValidationError } from 'payload'

import { isPlatformAdminUser, withinMyOrganizations, withinMyOrganizationsWithRole } from '../access'
import {
  DEFAULT_ORG_ROLE,
  isOrgRole,
  ORG_ROLES,
  organizationIdsForUserWithMinRole,
  outranks,
  roleInOrganization,
  type OrgRole,
} from '../lib/permissions'

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
    create: withinMyOrganizationsWithRole('admin'),
    update: withinMyOrganizationsWithRole('admin'),
    delete: withinMyOrganizationsWithRole('admin'),
  },
  hooks: {
    beforeValidate: [
      // 🔴 First, because a refusal must not depend on whether a twin row
      // happens to exist. See `refuseSelfAssignment` above.
      refuseSelfAssignment,
      // 🔴 Then the tenant boundary on the TARGET row — see the hook's header.
      refuseForeignOrganization,
      // 🔴 And the role ceiling — see `refuseRoleAboveOwn`.
      refuseRoleAboveOwn,
      compoundUnique({
        collection: 'memberships',
        fields: ['user', 'organization'],
        errorPath: 'user',
        message: 'This person already has a membership in this organization.',
      }),
    ],
    beforeDelete: [refuseDeleteAboveOwn],
  },
  fields: [
    {
      name: 'user',
      type: 'relationship',
      relationTo: 'users',
      required: true,
      index: true,
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
