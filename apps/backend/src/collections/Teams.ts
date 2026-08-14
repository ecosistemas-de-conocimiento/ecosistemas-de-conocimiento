import type { CollectionConfig } from 'payload'

import { withinMyOrganizations, withinMyOrganizationsWithRole } from '../access'

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
