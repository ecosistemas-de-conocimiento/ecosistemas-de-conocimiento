import type { CollectionConfig } from 'payload'

import { withinMyOrganizations, withinMyOrganizationsWithRole } from '../access'
import { relationId } from '../lib/permissions'
import { makeRefuseForeignOrganization } from './Memberships'

/**
 * 🔴 Same hole as teams, one hop out: the access rule pins the project row to
 * my orgs, not the `team` it is created under or moved to. The team's own
 * organization decides, read with `overrideAccess` because this IS the access
 * decision (code audit 2026-10-28, auth MEDIUM).
 */
export const refuseForeignProjectTeam = makeRefuseForeignOrganization(undefined, {
  collection: 'projects',
  field: 'team',
  message: 'You can only put a project under a team of an ecosistema you administer.',
  organizationOf: async (payload, team) => {
    const row = (await payload
      .findByID({ collection: 'teams', id: team as never, depth: 0, overrideAccess: true })
      .catch(() => null)) as { organization?: unknown } | null
    return relationId(row?.organization)
  },
})

/**
 * A project owned by a team. Mentionable (`@proyecto`) and scopable; `summary`
 * and `status` are clean-text fields the chat context renders directly (never
 * `JSON.stringify`'d).
 *
 * ⚠ THIS IS THE DOMAIN `projects`, AND IT IS THE ONLY ONE. The scope a
 * token is minted for is `organizations`, this product's real tenancy axis.
 * See the header of `lib/permissions.ts`. If you are looking for the thing that
 * `aud` names, it is an organization slug, not one of these.
 *
 * Access is tenant-scoped one hop out, through `team.organization`. Payload
 * applies a where-filter on a relationship path, so this is one constraint on
 * the query rather than a post-filter.
 */
export const Projects: CollectionConfig = {
  slug: 'projects',
  admin: {
    useAsTitle: 'name',
    defaultColumns: ['name', 'team', 'status', 'updatedAt'],
    group: 'Domain',
  },
  access: {
    read: withinMyOrganizations('team.organization'),
    create: withinMyOrganizationsWithRole('admin', 'team.organization'),
    update: withinMyOrganizationsWithRole('admin', 'team.organization'),
    delete: withinMyOrganizationsWithRole('admin', 'team.organization'),
  },
  hooks: { beforeValidate: [refuseForeignProjectTeam] },
  fields: [
    { name: 'name', type: 'text', required: true },
    {
      name: 'slug',
      type: 'text',
      required: true,
      index: true,
      admin: { description: 'Stable key within the team (e.g. "acceso-ciudadano").' },
    },
    {
      name: 'team',
      type: 'relationship',
      relationTo: 'teams',
      required: true,
      index: true,
    },
    {
      name: 'status',
      type: 'select',
      defaultValue: 'active',
      options: [
        { label: 'Planeación', value: 'planning' },
        { label: 'Activo', value: 'active' },
        { label: 'En pausa', value: 'paused' },
        { label: 'Concluido', value: 'done' },
      ],
    },
    {
      name: 'summary',
      type: 'textarea',
      admin: {
        description: 'Clean-text project summary injected into the chat context + entity corpus.',
      },
    },
  ],
}
