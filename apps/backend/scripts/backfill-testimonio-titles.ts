/**
 * ONE-OFF BACKFILL: a system-proposed title for every testimonio the gate has
 * produced redacted output for (owner ruling 2026-10-24). Logic and rules:
 * `src/lib/backfillTestimonioTitles.ts` and `src/lib/testimonioTitle.ts`.
 *
 * 🔴 DRY RUN BY DEFAULT: reads the backend, prints how many rows and how many
 * redacted characters would be sent, calls NO model.
 *
 * 🔴 APPLY makes 1–2 `generate.sync` calls per row through the gate detector's
 * backend (ANONYMISE_DETECT_URL first; hosted only per ANONYMISE_DETECT_FALLBACK,
 * never for a held row). A hosted call is paid and booked to each
 * row's ecosistema (`X-AI-Org: eco-<id>`), paced by
 * `ANONYMISE_DETECT_MIN_GAP_MS` (set it, e.g. 2700, to stay under the 30/min
 * generate cap) plus BACKFILL_DELAY_MS between rows.
 *
 *     # dry run
 *     pnpm --filter @edc/backend payload run scripts/backfill-testimonio-titles.ts
 *
 *     # apply (either form)
 *     pnpm --filter @edc/backend payload run scripts/backfill-testimonio-titles.ts --apply
 *     BACKFILL_APPLY=1 pnpm --filter @edc/backend payload run scripts/backfill-testimonio-titles.ts
 *
 * Env:
 *   BACKFILL_APPLY=1         same as --apply (`payload run` may not forward argv)
 *   BACKFILL_FORCE=1         re-title rows that already have a title (or --force)
 *   BACKFILL_ORG=<id>        only this ecosistema
 *   BACKFILL_AFTER_ID=<id>   resume after this document id (the report prints `lastId`)
 *   BACKFILL_DELAY_MS=500    pause between rows
 *   BACKFILL_LIMIT=1000      max rows read
 *   plus the backend's usual DATABASE_URI, AI_SERVICE_URL, AI_SERVICE_API_KEY,
 *   and ANONYMISE_DETECT_URL / _MODEL / _FALLBACK as the gate reads them.
 *
 * 🔴 Skips rows whose ecosistema switched `testimonioTitles` off (and all rows
 * under TESTIMONIO_TITLES=off). The hosted fallback follows the STORED switch
 * (Plataforma → detectorFallback) first, then ANONYMISE_DETECT_FALLBACK; a
 * failed read is `none`.
 *
 * Exit 0 = ran (per-row failures are counted, not fatal). Exit 1 = could not run.
 */

import { backfillTestimonioTitles } from '../src/lib/backfillTestimonioTitles'
import { detectorFallbackMode } from '../src/lib/platformSettings'
import { titleClientFromEnv } from '../src/lib/testimonioTitle'

const nonNegativeInt = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw)
  return raw !== undefined && raw !== '' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

async function main(): Promise<void> {
  const apply = process.env.BACKFILL_APPLY === '1' || process.argv.includes('--apply')
  const force = process.env.BACKFILL_FORCE === '1' || process.argv.includes('--force')
  const delayMs = nonNegativeInt(process.env.BACKFILL_DELAY_MS, 500)
  const limit = nonNegativeInt(process.env.BACKFILL_LIMIT, 1000) || 1000
  const org = process.env.BACKFILL_ORG?.trim() || undefined
  const afterRaw = process.env.BACKFILL_AFTER_ID?.trim()
  const afterId = afterRaw ? nonNegativeInt(afterRaw, 0) : undefined

  const { getPayload } = await import('payload')
  const config = (await import('@payload-config')).default
  const payload = await getPayload({ config })

  const tag = '[backfill-testimonio-titles]'
  console.log(
    `${tag} mode=${apply ? 'APPLY' : 'dry-run'}${force ? ' force' : ''} delayMs=${delayMs} limit=${limit}` +
      `${org ? ` org=${org}` : ''}${afterId != null ? ` afterId=${afterId}` : ''}`,
  )

  const report = await backfillTestimonioTitles(
    payload,
    async (o, source) => {
      let fallbackMode: 'hosted' | 'none'
      try {
        fallbackMode = await detectorFallbackMode()
      } catch {
        fallbackMode = 'none'
      }
      return titleClientFromEnv({ organizationId: o, source, fallbackMode })
    },
    {
      apply,
      force,
      delayMs,
      limit,
      ...(org ? { organizationId: /^\d+$/.test(org) ? Number(org) : org } : {}),
      ...(afterId != null ? { afterId } : {}),
      log: (line) => console.log(`${tag} ${line}`),
    },
  )

  console.log(`${tag} ${JSON.stringify(report)}`)
  if (!apply && report.candidates > 0) {
    console.log(
      `${tag} dry run — ${report.candidates} testimonio(s) (${report.held} held), ` +
        `${report.disabled} skipped (titles off), ${report.inputChars} redacted characters would be sent (1–2 calls each). ` +
        'Re-run with --apply or BACKFILL_APPLY=1.',
    )
  }
}

try {
  await main()
  process.exit(0)
} catch (err) {
  console.error('[backfill-testimonio-titles] failed:', err)
  process.exit(1)
}
