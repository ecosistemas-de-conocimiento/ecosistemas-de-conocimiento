/**
 * ONE-OFF SEED: the Discapacidad answer style (owner ruling 2026-10-28) on
 * ecosistema 7, for Generales and Resonancias. The text and the rules are in
 * `src/seed/answerStyleDiscapacidad.ts`.
 *
 * 🔴 DRY RUN BY DEFAULT: reads org 7, checks its name is "Discapacidad", and
 * prints what it would do. Writes nothing.
 *
 * 🔴 APPLY writes as the first active platform admin (or SEED_ADMIN_EMAIL),
 * through the collection, so the platform-admin-only hook holds. Refuses when
 * org 7 is not named "Discapacidad" (ids differ between databases).
 *
 *     # dry run
 *     pnpm --filter @edc/backend payload run scripts/seed-answer-style.ts
 *
 *     # apply (either form; `payload run` may not forward argv)
 *     pnpm --filter @edc/backend payload run scripts/seed-answer-style.ts --apply
 *     SEED_APPLY=1 pnpm --filter @edc/backend payload run scripts/seed-answer-style.ts
 *
 * Exit 0 = ran (dry run, written or unchanged). Exit 1 = refused or failed.
 */

import { seedDiscapacidadAnswerStyle } from '../src/seed/answerStyleDiscapacidad'

async function main(): Promise<void> {
  const apply = process.env.SEED_APPLY === '1' || process.argv.includes('--apply')
  const adminEmail = process.env.SEED_ADMIN_EMAIL?.trim() || undefined

  const { getPayload } = await import('payload')
  const config = (await import('@payload-config')).default
  const payload = await getPayload({ config })

  const report = await seedDiscapacidadAnswerStyle(payload, { apply, adminEmail })
  console.log(`[seed-answer-style] ${JSON.stringify(report)}`)
  process.exit(report.outcome === 'refused' ? 1 : 0)
}

// `payload run` awaits only the import, then exits; a bare `main()` dies at its
// first await and writes nothing (measured on dev). Top-level await keeps it alive.
try {
  await main()
} catch (err) {
  console.error('[seed-answer-style] failed:', err)
  process.exit(1)
}
