/**
 * 🔴 THE AUDIT TRAIL OF EVERY ANONYMISATION SWITCH CHANGE (audit 2026-11-07,
 * item B): every `ANONYMISE_SWITCHES` key (`keepDocumentAuthor`,
 * `keepCitedAuthors`, and since 2026-11-10 `keepPublicFigures`, audit P-04),
 * per document (`lib/anonymisationControls.ts`) and per ecosistema (the
 * `Organizations` afterChange hook, so `/api/funciones` and any other write
 * path are covered); and the platform's `detectorFallback`
 * (`globals/PlatformSettings.ts`, scope `plataforma`, no ecosistema), which
 * decides whether raw text may reach the hosted detector.
 *
 * One row per key that changed: who, when (`createdAt`), which ecosistema
 * (absent for a platform change), which document (absent for an ecosistema or
 * platform change), the key, the value before and after. `null` is "the
 * ecosistema's" for a document, "never set" (the default, off) for an
 * ecosistema, and "the env value" for `detectorFallback`, where `true` is
 * `hosted` and `false` is `none` ({@link fallbackAsBoolean}).
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

/** Every audited key: the document/ecosistema switches, then the platform's. */
export const SETTING_KEYS = [...ANONYMISE_SWITCHES, 'detectorFallback'] as const
export type SettingKey = (typeof SETTING_KEYS)[number]

/** `detectorFallback` as the log stores it: `hosted` → true, `none` → false, unset (the env) → null. */
export function fallbackAsBoolean(v: unknown): boolean | null {
  return v === 'hosted' ? true : v === 'none' ? false : null
}

export const AnonymisationSettingChanges: CollectionConfig = {
  slug: 'anonymisation-setting-changes',
  admin: {
    useAsTitle: 'key',
    defaultColumns: ['key', 'scope', 'before', 'after', 'organization', 'document', 'actor', 'createdAt'],
    group: 'Feedback',
    description: 'Cada cambio de las opciones de anonimización, por documento o por ecosistema. Solo se agregan filas.',
  },
  /**
   * 🔴 `where[document.name]` / `sort=document.name` (and `uploadedBy`,
   * `session`) reach the gated `documents` columns through the relationship,
   * where the narrowing on `documents` never runs: a reviewer who did not
   * upload a gated documento could confirm its file name row by row (audit
   * 2026-11-10). Same rule as `anonymisation-reviews`, at this path.
   * `relationFilterHook` (`access/relationFilters.ts`, on every collection)
   * runs `constrainGatedQueriesAt('document.')` here through this prefix.
   */
  custom: { gatedQueryPrefix: 'document.' },
  access: {
    // Same readers as the review log: `holds:review` in that ecosistema, or a platform admin.
    read: async ({ req }) => {
      const user = req.user
      if (!user || !isActiveUser(user)) return false
      if (isPlatformAdminUser(user)) return true
      const ids = await organizationIdsForUserWithPermission(req.payload, user.id, PERMISSIONS.holdsReview, req)
      if (ids.length === 0) return false
      return { organization: { in: ids } }
    },
    create: () => false,
    update: () => false,
    delete: () => false,
  },
  fields: [
    /** Required except for a platform change (`scope: 'plataforma'`). */
    {
      name: 'organization',
      type: 'relationship',
      relationTo: 'organizations',
      index: true,
      validate: (value: unknown, { siblingData }: { siblingData?: { scope?: unknown } }) =>
        value != null || siblingData?.scope === 'plataforma' ? true : 'Falta el ecosistema.',
    },
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
        { label: 'Plataforma', value: 'plataforma' },
      ],
    },
    {
      name: 'key',
      type: 'select',
      required: true,
      options: SETTING_KEYS.map((value) => ({ label: value, value })),
    },
    /** Null: "the ecosistema's" (document) or never set (ecosistema). */
    { name: 'before', type: 'checkbox' },
    { name: 'after', type: 'checkbox' },
  ],
  timestamps: true,
}

type Id = number | string

export interface SettingChange {
  /** Null only for `scope: 'plataforma'`. */
  organization: Id | null
  document?: Id | null
  actor?: Id | null
  scope: 'documento' | 'ecosistema' | 'plataforma'
  key: SettingKey
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
