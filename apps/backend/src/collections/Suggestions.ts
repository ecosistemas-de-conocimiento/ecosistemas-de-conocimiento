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
    /**
     * ⚠ NOT `required`, on purpose: deleting the author keeps the suggestion,
     * anonymous (`author_id` → NULL, `20261027_061014_student_view_fk_cascade`).
     * The endpoint still always stamps it from the session.
     */
    { name: 'author', type: 'relationship', relationTo: 'users', index: true },
    {
      name: 'kind',
      type: 'select',
      required: true,
      options: SUGGESTION_KINDS.map((value) => ({ value, label: value })),
    },
    { name: 'text', type: 'textarea', required: true, maxLength: 2000 },
  ],
}
