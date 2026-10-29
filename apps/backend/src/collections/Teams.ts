import type { CollectionConfig } from 'payload'

import { withinMyOrganizations, withinMyOrganizationsWithRole } from '../access'
import { makeRefuseForeignOrganization } from './Memberships'

/**
 * 🔴 The `admin`-in-my-orgs access rule scopes WHICH team is written, never
 * WHERE it is written to: Payload ignores a WHERE on create, and an update can
 * patch `organization`. See `makeRefuseForeignOrganization` (code audit
 * 2026-10-28, auth MEDIUM).
 */
export const refuseForeignTeamOrganization = makeRefuseForeignOrganization(undefined, {
  collection: 'teams',
  field: 'organization',
  message: 'You can only put a team in an ecosistema you administer.',
})

/**
 * A team inside an organization. Teams own projects and gather memberships.
 *
 * This is domain structure, not authorization: a team grants nothing. It exists
 * so the knowledgebase has something to talk ABOUT — teams are mentionable
 * (`@equipo`) and scopable in a chat session's context header, and their
 * `mission` text is injected into the deterministic context summary.
 *
 * Access is tenant-scoped through `organization`. Writes need `admin` in that
 * organization, because reshaping the org chart changes what every answer in
 * the tenant is grounded in.
 */
export const Teams: CollectionConfig = {
  slug: 'teams',
  admin: {
    useAsTitle: 'name',
    defaultColumns: ['name', 'organization', 'slug', 'updatedAt'],
    group: 'Domain',
  },
  access: {
    read: withinMyOrganizations(),
    create: withinMyOrganizationsWithRole('admin'),
    update: withinMyOrganizationsWithRole('admin'),
    delete: withinMyOrganizationsWithRole('admin'),
  },
  hooks: { beforeValidate: [refuseForeignTeamOrganization] },
  fields: [
    { name: 'name', type: 'text', required: true },
    {
      name: 'slug',
      type: 'text',
      required: true,
      index: true,
      admin: { description: 'Stable key within the organization (e.g. "plataforma").' },
    },
    {
      name: 'organization',
      type: 'relationship',
      relationTo: 'organizations',
      required: true,
      index: true,
    },
    {
      name: 'mission',
      type: 'textarea',
      admin: { description: 'Clean-text mission/charter injected into the chat context.' },
    },
  ],
}
