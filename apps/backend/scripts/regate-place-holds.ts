/**
 * ONE-OFF: re-run the anonymisation gate on holds whose verify findings were
 * places only (31 of 38 on dev, 2026-10-21), now that a town no longer holds.
 * Logic and selection: `src/lib/regatePlaceHolds.ts`. NO WIPE.
 *
 * 🔴 DRY RUN BY DEFAULT, and the dry run makes no model call: it applies the
 * current town rule to each row's STORED findings and lists which rows would be
 * re-run and which stay held.
 * 🔴 APPLY COSTS MODEL CALLS: two detector calls per chunk per re-run document
 * (stage 3 + verify), ONE DOCUMENT AT A TIME through the seed's targeted path;
 * a cleared seeded genre is then published, a hold stays in Revisión.
 *
 *     # dry run (writes nothing, no model call)
 *     node_modules/.bin/payload run scripts/regate-place-holds.ts
 *
 *     # apply
 *     REGATE_APPLY=1 node_modules/.bin/payload run scripts/regate-place-holds.ts
 *
 * Env: REGATE_APPLY=1, REGATE_LIMIT=1000, plus the backend's usual
 * DATABASE_URI, AI_SERVICE_URL, AI_SERVICE_API_KEY, AI_SERVICE_ADMIN_API_KEY;
 * the detector's ANONYMISE_DETECT_* pacing applies.
 */

import { regatePlaceOnlyHolds } from '../src/lib/regatePlaceHolds'

async function main(): Promise<void> {
  const apply = process.env.REGATE_APPLY === '1'
  const limit = Number(process.env.REGATE_LIMIT) > 0 ? Math.floor(Number(process.env.REGATE_LIMIT)) : 1000

  const { getPayload } = await import('payload')
  const config = (await import('@payload-config')).default
  const payload = await getPayload({ config })
  const { ingestSeededDocuments } = await import('../src/seed/corpus')

  console.log(`[regate-place-holds] mode=${apply ? 'APPLY' : 'dry-run'}`)
  const report = await regatePlaceOnlyHolds(payload as never, {
    apply,
    limit,
    gate: (organizationId, documentId) =>
      ingestSeededDocuments(payload, organizationId, { awaitDrafts: true, onlyIds: new Set([documentId]) }),
    log: (line) => console.log(`[regate-place-holds] ${line}`),
  })
  console.log(`[regate-place-holds] ${JSON.stringify(report)}`)
  if (!apply && report.matched > 0) {
    console.log('[regate-place-holds] dry run — re-run with REGATE_APPLY=1 to gate them again.')
  }
}

// `payload run` awaits only the import; top-level await keeps it alive.
try {
  await main()
  process.exit(0)
} catch (err) {
  console.error('[regate-place-holds] failed:', err)
  process.exit(1)
}
