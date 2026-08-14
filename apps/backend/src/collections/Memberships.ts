import type { CollectionConfig } from 'payload'

import { withinMyOrganizations, withinMyOrganizationsWithRole } from '../access'
import { DEFAULT_ORG_ROLE, ORG_ROLES, type OrgRole } from '../lib/permissions'

import { compoundUnique } from './hooks/compoundUnique'

/** Admin-panel labels. Exhaustive by type, so adding a role forces a label. */
const ROLE_LABELS: Record<OrgRole, string> = {
  member: 'Member — read, upload, chat, rate answers',
  admin: 'Admin — the above, plus manage people and delete documents',
  owner: 'Owner — the above, plus manage the organization itself',
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
      compoundUnique({
        collection: 'memberships',
        fields: ['user', 'organization'],
        errorPath: 'user',
        message: 'This person already has a membership in this organization.',
      }),
    ],
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
