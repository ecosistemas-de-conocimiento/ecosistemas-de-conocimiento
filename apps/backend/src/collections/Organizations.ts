import type { CollectionConfig } from 'payload'

import { isPlatformAdmin, withinMyOrganizations, withinMyOrganizationsWithRole } from '../access'

import { normalizedSlug } from './hooks/compoundUnique'

/**
 * ⚠ THE TENANT. Everything in this product hangs off an organization: its
 * people (`memberships`), its structure (`teams` → `projects`), and — through
 * the session that produced them — its documents, messages and ratings.
 *
 * THE SLUG IS THE CONTRACT. It is what a client sends as the `audience` of a
 * token request, what keys the `projects` map in a resolved principal, and what
 * `aud` carries on every issued token. Renaming an organization is free;
 * changing its slug invalidates every token already in flight and every stored
 * reference to it. Treat it as permanent once anyone has logged in.
 *
 * ⚠ THE TOKEN AUDIENCE IS THE TENANT. There is one product and many tenants,
 * so the audience is the tenant, not a `project`. See the
 * header of `lib/permissions.ts` for the full reasoning.
 */
export const Organizations: CollectionConfig = {
  slug: 'organizations',
  admin: {
    useAsTitle: 'name',
    defaultColumns: ['name', 'slug', 'isActive', 'updatedAt'],
    group: 'Tenancy',
  },
  access: {
    // You see the organizations you belong to, and no others. A boolean here
    // would make the whole customer list browsable by any account.
    read: withinMyOrganizations('id'),
    // Creating a tenant is an installation-level act, not a self-service one.
    create: isPlatformAdmin,
    // An owner may rename/reconfigure their own organization; nobody else can.
    update: withinMyOrganizationsWithRole('owner', 'id'),
    // Deleting a tenant takes its people, documents and history with it.
    delete: isPlatformAdmin,
  },
  hooks: {
    beforeValidate: [
      ({ data }) => {
        const next = { ...(data ?? {}) } as Record<string, unknown>
        const slug = normalizedSlug(next.slug)
        if (slug) next.slug = slug
        return next
      },
    ],
    afterChange: [
      // Each ecosistema is its own ai-service org; give it a budget on create
      // (`lib/provisionEcosystem.ts`). Not awaited: the create already
      // succeeded, and a slow ai-service must not hold the admin request.
      ({ doc, operation, req }) => {
        if (operation !== 'create') return doc
        const id = (doc as { id?: number | string }).id
        if (id == null) return doc
        void import('@/lib/provisionEcosystem').then(({ provisionEcosystemOrg }) =>
          provisionEcosystemOrg(id, { logger: req.payload.logger }),
        )
        return doc
      },
    ],
  },
  fields: [
    { name: 'name', type: 'text', required: true },
    {
      name: 'slug',
      type: 'text',
      required: true,
      unique: true,
      index: true,
      admin: {
        description:
          'Stable URL-safe key, lowercased. Used as the token audience — changing it breaks every issued token.',
      },
    },
    {
      name: 'description',
      type: 'textarea',
      admin: { description: 'Clean-text summary injected into the chat context.' },
    },
    {
      // An inactive organization grants nothing: the resolver skips it
      // entirely, so switching this off revokes access for every one of its
      // members at once without touching a single membership row.
      name: 'isActive',
      type: 'checkbox',
      defaultValue: true,
      index: true,
      label: 'Organization active',
      admin: { position: 'sidebar' },
    },
  ],
}
