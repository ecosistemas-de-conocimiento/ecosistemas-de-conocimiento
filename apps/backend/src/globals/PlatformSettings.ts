import type { GlobalAfterChangeHook, GlobalConfig } from 'payload'

import { isPlatformAdmin } from '../access'

/**
 * 🔴 A `detectorFallback` CHANGE IS AUDITED (audit 2026-11-10, P-04): it
 * decides whether raw text may reach the hosted detector, so it gets an
 * `anonymisation-setting-changes` row (scope `plataforma`, no ecosistema), in
 * the update's transaction (`req`): a failed audit write fails the update.
 */
export const auditDetectorFallback: GlobalAfterChangeHook = async ({ doc, previousDoc, req }) => {
  const { fallbackAsBoolean, recordSettingChanges } = await import('../collections/AnonymisationSettingChanges')
  const before = fallbackAsBoolean((previousDoc as { detectorFallback?: unknown } | undefined)?.detectorFallback)
  const after = fallbackAsBoolean((doc as { detectorFallback?: unknown } | undefined)?.detectorFallback)
  if (before === after) return doc
  await recordSettingChanges(
    req.payload as never,
    [
      {
        organization: null,
        actor: (req.user as { id?: number | string } | null | undefined)?.id ?? null,
        scope: 'plataforma',
        key: 'detectorFallback',
        before,
        after,
      },
    ],
    req,
  )
  return doc
}

/**
 * PLATFORM-LEVEL SWITCHES (backlog #39). One row, platform admins only — an
 * ecosistema responsable never reads or writes it.
 *
 * 🔴 NULL MEANS "THE ENV VALUE". Every field is optional and starts empty, so
 * nothing changes on deploy: the process keeps doing what its env says until
 * an admin saves a value here. Read through `lib/platformSettings.ts`, which
 * caches for ≤ 60 s. Every `detectorFallback` change is audited
 * ({@link auditDetectorFallback}).
 */
export const PlatformSettings: GlobalConfig = {
  slug: 'platform-settings',
  admin: { group: 'Tenancy' },
  access: { read: isPlatformAdmin, update: isPlatformAdmin },
  hooks: {
    afterChange: [
      auditDetectorFallback,
      async () => {
        const { invalidatePlatformSettings } = await import('../lib/platformSettings')
        invalidatePlatformSettings()
      },
    ],
  },
  fields: [
    {
      // `ANONYMISE_DETECT_FALLBACK` at runtime: may a call the Spark cannot
      // answer go to the hosted model? See `lib/anonymise/fallbackGenerator.ts`.
      name: 'detectorFallback',
      type: 'select',
      options: [
        { label: 'hosted', value: 'hosted' },
        { label: 'none', value: 'none' },
      ],
    },
  ],
}
