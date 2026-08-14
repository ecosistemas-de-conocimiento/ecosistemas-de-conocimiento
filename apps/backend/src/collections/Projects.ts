import type { CollectionConfig } from 'payload'

import { withinMyOrganizations, withinMyOrganizationsWithRole } from '../access'

/**
 * A project owned by a team. Mentionable (`@proyecto`) and scopable; `summary`
 * and `status` are clean-text fields the chat context renders directly (never
 * `JSON.stringify`'d).
 *
 * ⚠ THIS IS THE DOMAIN `projects`, AND IT IS THE ONLY ONE. The standalone
 * identity provider that was merged into this backend also had a `projects`
 * collection, meaning something completely different: the catalogue of PRODUCTS
 * in a fleet, whose slug was a token audience. Both cannot live here under one
 * name, and only one of them describes something this product has.
 *
 * The IdP's version was deleted. Its job — being the scope a token is minted
 * for — moved to `organizations`, which is this product's real tenancy axis.
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
