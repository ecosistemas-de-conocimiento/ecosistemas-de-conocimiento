import type { GlobalConfig } from 'payload'

import { isPlatformAdmin } from '../access'

/**
 * PLATFORM-LEVEL SWITCHES (backlog #39). One row, platform admins only — an
 * ecosistema responsable never reads or writes it.
 *
 * 🔴 NULL MEANS "THE ENV VALUE". Every field is optional and starts empty, so
 * nothing changes on deploy: the process keeps doing what its env says until
 * an admin saves a value here. Read through `lib/platformSettings.ts`, which
 * caches for ≤ 60 s.
 */
export const PlatformSettings: GlobalConfig = {
  slug: 'platform-settings',
  admin: { group: 'Tenancy' },
  access: { read: isPlatformAdmin, update: isPlatformAdmin },
  hooks: {
    afterChange: [
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
