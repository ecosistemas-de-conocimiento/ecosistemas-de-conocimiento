/**
 * ONE-OFF REPAIR: rows HELD only because the anonymisation detector never
 * answered (429, 5xx, 402, timeout — "no pudo terminar (transporte)") go back
 * to the retryable state. Logic and rationale: `src/lib/anonymise/resetInfraHolds.ts`.
 *
 * 🔴 CONTENT HOLDS ARE NEVER TOUCHED. 🔴 DRY RUN BY DEFAULT.
 *
 *     # dry run (writes nothing)
 *     pnpm --filter @edc/backend payload run scripts/reset-infra-holds.ts
 *
 *     # apply
 *     RESET_APPLY=1 pnpm --filter @edc/backend payload run scripts/reset-infra-holds.ts
 *
 * Then re-gate: re-run the seed ingest (`SEED_CORPUS_INGEST=1 pnpm seed:demo`)
 * for seeded rows; draft-path rows are re-driven by the ingest-recovery sweep
 * (`INGEST_RECOVERY_GATE_RETRY_MIN`, default 15 min).
 *
 * Env: RESET_APPLY=1, RESET_LIMIT=1000, plus the backend's usual DATABASE_URI.
 * No ai-service call is made.
 */

import { resetInfraHolds } from '../src/lib/anonymise/resetInfraHolds'

async function main(): Promise<void> {
  const apply = process.env.RESET_APPLY === '1'
  const limit = Number(process.env.RESET_LIMIT) > 0 ? Math.floor(Number(process.env.RESET_LIMIT)) : 1000

  const { getPayload } = await import('payload')
  const config = (await import('@payload-config')).default
  const payload = await getPayload({ config })

  console.log(`[reset-infra-holds] mode=${apply ? 'APPLY' : 'dry-run'}`)
  const report = await resetInfraHolds(payload as never, {
    apply,
    limit,
    log: (line) => console.log(`[reset-infra-holds] ${line}`),
  })
  console.log(`[reset-infra-holds] ${JSON.stringify({ ...report, ids: report.ids.length })}`)
  if (!apply && report.matched > 0) {
    console.log('[reset-infra-holds] dry run — re-run with RESET_APPLY=1 to write.')
  }
}

// `payload run` awaits only the import; top-level await keeps it alive.
try {
  await main()
  process.exit(0)
} catch (err) {
  console.error('[reset-infra-holds] failed:', err)
  process.exit(1)
}
