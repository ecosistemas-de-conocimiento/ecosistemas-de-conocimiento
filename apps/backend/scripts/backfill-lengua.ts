/**
 * ONE-OFF BACKFILL: re-stamp `metadata.lengua` on published documento chunks
 * (audit C-3). Logic and rationale: `src/lib/backfillLengua.ts`.
 *
 * 🔴 DRY RUN BY DEFAULT. It reads the backend, prints what it would re-ingest
 * and how many characters that is, and calls ai-service NOT AT ALL.
 *
 * 🔴 APPLY RE-EMBEDS every listed document (paid embedding calls). Running it
 * with BACKFILL_APPLY=1 is Rodrigo's decision.
 *
 *     # dry run (writes nothing, calls nothing paid)
 *     pnpm --filter @edc/backend payload run scripts/backfill-lengua.ts
 *
 *     # apply, one ecosistema, paced
 *     BACKFILL_APPLY=1 BACKFILL_ORG=1 pnpm --filter @edc/backend payload run scripts/backfill-lengua.ts
 *
 * Env:
 *   BACKFILL_APPLY=1         enqueue the re-ingests
 *   BACKFILL_ORG=<id>        only this ecosistema
 *   BACKFILL_AFTER_ID=<id>   resume after this document id (the report prints `lastId`)
 *   BACKFILL_DELAY_MS=1000   pause between enqueues (shared 100/min `/v1` limit)
 *   BACKFILL_LIMIT=1000      max candidate rows read
 *   plus the backend's usual DATABASE_URI, AI_SERVICE_URL, AI_SERVICE_API_KEY.
 *
 * ⚠ Env vars, not flags: `payload run` does not reliably forward argv to the script.
 *
 * ⚠ The ingest is asynchronous. A finished run means "enqueued", not "embedded";
 * check the chunks afterwards (e.g. count `metadata ? 'lengua'` on `edc_ai`).
 *
 * Exit 0 = ran (per-row errors are reported, not fatal). Exit 1 = could not run.
 */

import { getAppAIClient } from '../src/lib/aiClient'
import { backfillLengua } from '../src/lib/backfillLengua'
import { safeErrMessage } from '../src/lib/errorSummary'

const nonNegativeInt = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw)
  return raw !== undefined && raw !== '' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

async function main(): Promise<void> {
  const apply = process.env.BACKFILL_APPLY === '1'
  const delayMs = nonNegativeInt(process.env.BACKFILL_DELAY_MS, 1000)
  const limit = nonNegativeInt(process.env.BACKFILL_LIMIT, 1000) || 1000
  const org = process.env.BACKFILL_ORG?.trim() || undefined
  const afterRaw = process.env.BACKFILL_AFTER_ID?.trim()
  const afterId = afterRaw ? nonNegativeInt(afterRaw, 0) : undefined

  const { getPayload } = await import('payload')
  const config = (await import('@payload-config')).default
  const payload = await getPayload({ config })

  const tag = '[backfill-lengua]'
  console.log(
    `${tag} mode=${apply ? 'APPLY' : 'dry-run'} delayMs=${delayMs} limit=${limit}` +
      `${org ? ` org=${org}` : ''}${afterId != null ? ` afterId=${afterId}` : ''}`,
  )

  const report = await backfillLengua(payload, (o) => getAppAIClient(o), {
    apply,
    delayMs,
    limit,
    ...(org ? { organizationId: /^\d+$/.test(org) ? Number(org) : org } : {}),
    ...(afterId != null ? { afterId } : {}),
    log: (line) => console.log(`${tag} ${line}`),
  })

  console.log(`${tag} ${JSON.stringify(report)}`)
  if (!apply && report.planned > 0) {
    console.log(
      `${tag} dry run — ${report.planned} document(s), ${report.chars} characters would be ` +
        're-embedded. Re-run with BACKFILL_APPLY=1 to enqueue.',
    )
  }
}

// `payload run` awaits only the import, then exits; top-level await keeps it alive
// (same as scripts/repair-pending-published.ts).
try {
  await main()
  process.exit(0)
} catch (err) {
  console.error('[backfill-lengua] failed:', safeErrMessage(err))
  process.exit(1)
}
