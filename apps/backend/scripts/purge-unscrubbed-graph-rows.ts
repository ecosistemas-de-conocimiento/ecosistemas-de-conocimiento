/**
 * ONE-OFF CLEANUP: delete graph mentions and relations on gated documents
 * (testimonio, conversacion, unknown kind) that have no approved redaction.
 * Logic and rationale: `src/lib/graph/purgeUnscrubbed.ts`.
 *
 * 🔴 DRY RUN BY DEFAULT. It reads and prints counts; it writes nothing.
 *
 *     # dry run (writes nothing)
 *     pnpm --filter @edc/backend payload run scripts/purge-unscrubbed-graph-rows.ts
 *
 *     # apply: delete the rows, mark the documents `skipped`, sweep orphan entities
 *     PURGE_APPLY=1 pnpm --filter @edc/backend payload run scripts/purge-unscrubbed-graph-rows.ts
 *
 * ⚠ Env vars, not flags: `payload run` does not reliably forward argv to the script.
 * ⚠ No AI calls. Database only (DATABASE_URI).
 *
 * Exit 0 = ran. Exit 1 = could not run.
 */

import { purgeUnscrubbedGraphRows, type PurgePayload } from '../src/lib/graph/purgeUnscrubbed'

async function main(): Promise<void> {
  const apply = process.env.PURGE_APPLY === '1'

  const { getPayload } = await import('payload')
  const config = (await import('@payload-config')).default
  const payload = await getPayload({ config })

  console.log(`[purge-unscrubbed-graph] mode=${apply ? 'APPLY' : 'dry-run'}`)
  const report = await purgeUnscrubbedGraphRows(payload as unknown as PurgePayload, {
    apply,
    log: (line) => console.log(`[purge-unscrubbed-graph] ${line}`),
  })
  console.log(`[purge-unscrubbed-graph] ${JSON.stringify(report)}`)
  if (!apply && report.documentsWithRows > 0) {
    console.log('[purge-unscrubbed-graph] dry run — re-run with PURGE_APPLY=1 to delete.')
  }
}

// `payload run` awaits only the import, then exits; a bare `main()` dies at its
// first await (same defect as src/seed/demo.cli.ts). Top-level await keeps it alive.
try {
  await main()
  process.exit(0)
} catch (err) {
  console.error('[purge-unscrubbed-graph] failed:', err)
  process.exit(1)
}
