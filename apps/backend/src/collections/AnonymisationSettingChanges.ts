/**
 * 🔴 THE AUDIT TRAIL OF EVERY ANONYMISATION SWITCH CHANGE (audit 2026-11-07,
 * item B): `keepDocumentAuthor` and `keepCitedAuthors`, per document
 * (`lib/anonymisationControls.ts`) and per ecosistema (the `Organizations`
 * afterChange hook, so `/api/funciones` and any other write path are covered).
 *
 * One row per key that changed: who, when (`createdAt`), which ecosistema,
 * which document (absent for an ecosistema change), the key, the value before
 * and after. `null` is "the ecosistema's" for a document and "never set" (the
 * default, off) for an ecosistema.
 *
 * 🔴 NEVER ANY TEXT: no name, no redaction, no note. A switch decides which
 * names reach the corpus; this row only says who flipped it.
 *
 * Append-only, like `anonymisation-reviews`: created server-side only
 * (`overrideAccess`), never updated or deleted through the API.
 */

import type { CollectionConfig } from 'payload'

import { isActiveUser, isPlatformAdminUser } from '../access'
import { organizationIdsForUserWithPermission, PERMISSIONS } from '../lib/permissions'
import { ANONYMISE_SWITCHES } from '../lib/publicFigures'

export const AnonymisationSettingChanges: CollectionConfig = {
  slug: 'anonymisation-setting-changes',
  admin: {
    useAsTitle: 'key',
    defaultColumns: ['key', 'scope', 'before', 'after', 'organization', 'document', 'actor', 'createdAt'],
    group: 'Feedback',
    description: 'Cada cambio de las opciones de anonimización, por documento o por ecosistema. Solo se agregan filas.',
  },
  access: {
    // Same readers as the review log: `holds:review` in that ecosistema, or a platform admin.
    read: async ({ req }) => {
      const user = req.user
      if (!user || !isActiveUser(user)) return false
      if (isPlatformAdminUser(user)) return true
      const ids = await organizationIdsForUserWithPermission(req.payload, user.id, PERMISSIONS.holdsReview)
      if (ids.length === 0) return false
      return { organization: { in: ids } }
    },
    create: () => false,
    update: () => false,
    delete: () => false,
  },
  fields: [
    { name: 'organization', type: 'relationship', relationTo: 'organizations', required: true, index: true },
    /** Absent for an ecosistema-wide change. */
    { name: 'document', type: 'relationship', relationTo: 'documents', index: true },
    /** Who changed it. Absent only for a write with no user (a script). */
    { name: 'actor', type: 'relationship', relationTo: 'users', index: true },
    {
      name: 'scope',
      type: 'select',
      required: true,
      options: [
        { label: 'Documento', value: 'documento' },
        { label: 'Ecosistema', value: 'ecosistema' },
      ],
    },
    {
      name: 'key',
      type: 'select',
      required: true,
      options: ANONYMISE_SWITCHES.map((value) => ({ label: value, value })),
    },
    /** Null: "the ecosistema's" (document) or never set (ecosistema). */
    { name: 'before', type: 'checkbox' },
    { name: 'after', type: 'checkbox' },
  ],
  timestamps: true,
}

type Id = number | string

export interface SettingChange {
  organization: Id
  document?: Id | null
  actor?: Id | null
  scope: 'documento' | 'ecosistema'
  key: (typeof ANONYMISE_SWITCHES)[number]
  before: boolean | null
  after: boolean | null
}

/**
 * Write one audit row per change. 🔴 THROWS on a failed write, so the caller
 * does not make a change it could not record (the review log's rule: the
 * audit row first). Pass `req` to write inside the caller's transaction.
 */
export async function recordSettingChanges(
  payload: { create: (args: never) => Promise<unknown> },
  changes: readonly SettingChange[],
  req?: unknown,
): Promise<void> {
  for (const c of changes) {
    await payload.create({
      collection: 'anonymisation-setting-changes',
      data: {
        organization: c.organization,
        document: c.document ?? null,
        actor: c.actor ?? null,
        scope: c.scope,
        key: c.key,
        before: c.before,
        after: c.after,
      },
      overrideAccess: true,
      ...(req ? { req } : {}),
    } as never)
  }
}
