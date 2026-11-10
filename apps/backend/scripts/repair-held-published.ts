/**
 * ONE-OFF REPAIR: gated rows that are published although the anonymisation gate
 * never cleared them (`held` + `published`, 13 on dev 2026-10-21) are retired
 * from the ecosistema's corpus and put back as HELD DRAFTS, where Revisión
 * lists them. Logic and rationale: `src/lib/repairHeldPublished.ts`.
 *
 * 🔴 DRY RUN BY DEFAULT. 🔴 NO WIPE: only the matched rows change. Idempotent.
 *
 *     # dry run (reads only; no ai-service call)
 *     node_modules/.bin/payload run scripts/repair-held-published.ts
 *
 *     # apply
 *     REPAIR_APPLY=1 node_modules/.bin/payload run scripts/repair-held-published.ts
 *
 * Env: REPAIR_APPLY=1, REPAIR_LIMIT=1000, plus the backend's usual DATABASE_URI,
 * AI_SERVICE_URL and AI_SERVICE_ADMIN_API_KEY (retiring is an admin route).
 * Apply makes up to two `setDocumentValidity` calls per row (shared + draft
 * corpus). No model call.
 *
 * ⚠ Run with ingests quiet: rows mid-publish are skipped and listed (`inFlight`).
 * ⚠ Then clean their graph mentions with the existing script (dry run first):
 *     PURGE_APPLY=1 node_modules/.bin/payload run scripts/purge-unscrubbed-graph-rows.ts
 */

import { repairHeldPublished } from '../src/lib/repairHeldPublished'
import { safeErrMessage } from '../src/lib/errorSummary'

async function main(): Promise<void> {
  const apply = process.env.REPAIR_APPLY === '1'
  const limit = Number(process.env.REPAIR_LIMIT) > 0 ? Math.floor(Number(process.env.REPAIR_LIMIT)) : 1000

  const { getPayload } = await import('payload')
  const config = (await import('@payload-config')).default
  const payload = await getPayload({ config })
  const { getAdminAIClient } = await import('../src/lib/aiClient')

  console.log(`[repair-held-published] mode=${apply ? 'APPLY' : 'dry-run'}`)
  const report = await repairHeldPublished(payload, {
    apply,
    limit,
    clientFor: (organizationId) => getAdminAIClient(organizationId) as never,
    log: (line) => console.log(`[repair-held-published] ${line}`),
  })
  console.log(`[repair-held-published] ${JSON.stringify(report)}`)
  if (!apply && report.matched > 0) {
    console.log('[repair-held-published] dry run — re-run with REPAIR_APPLY=1 to write.')
  }
  if (report.failed.length > 0) process.exitCode = 1
}

// `payload run` awaits only the import; top-level await keeps it alive.
try {
  await main()
  process.exit(process.exitCode ?? 0)
} catch (err) {
  console.error('[repair-held-published] failed:', safeErrMessage(err))
  process.exit(1)
}
