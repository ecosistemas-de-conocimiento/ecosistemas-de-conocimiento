import type { Access, CollectionConfig } from 'payload'

export const SUGGESTION_KINDS = ['contenido', 'arquitectura', 'interaccion'] as const
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number]

/**
 * "Sugerir" (student view, owner 2026-10-27): a student's suggestion about the
 * ecosistema's content, architecture or interaction. Read by its
 * investigadores and responsables through `endpoints/estudiante.ts`.
 *
 * 🔴 Server-only, like `StudentProfiles`: the endpoint stamps `author` and
 * `organization` from the session, never from the body.
 */
const serverOnly: Access = () => false

export const Suggestions: CollectionConfig = {
  slug: 'suggestions',
  admin: { group: 'Estudiantes', defaultColumns: ['organization', 'kind', 'author', 'createdAt'] },
  access: { read: serverOnly, create: serverOnly, update: serverOnly, delete: serverOnly },
  fields: [
    { name: 'organization', type: 'relationship', relationTo: 'organizations', required: true, index: true },
    { name: 'author', type: 'relationship', relationTo: 'users', required: true, index: true },
    {
      name: 'kind',
      type: 'select',
      required: true,
      options: SUGGESTION_KINDS.map((value) => ({ value, label: value })),
    },
    { name: 'text', type: 'textarea', required: true, maxLength: 2000 },
  ],
}
