/**
 * ONE-OFF REPAIR: set `ingestStatus: 'ready'` on `published` documents stuck at
 * `pending` — but ONLY where ai-service confirms the document is live in the
 * org's published corpus. Logic and rationale: `src/lib/repairPendingPublished.ts`.
 *
 * 🔴 DRY RUN BY DEFAULT. It reads, asks ai-service, and prints what it would do.
 *
 *     # dry run (writes nothing)
 *     pnpm --filter @edc/backend payload run scripts/repair-pending-published.ts
 *
 *     # apply
 *     REPAIR_APPLY=1 pnpm --filter @edc/backend payload run scripts/repair-pending-published.ts
 *
 * Env:
 *   REPAIR_APPLY=1        write the `ready` status on confirmed-live rows
 *   REPAIR_DELAY_MS=750   pause between ai-service checks (shared 100/min `/v1` limit)
 *   REPAIR_LIMIT=1000     max candidate rows read
 *   plus the backend's usual DATABASE_URI, AI_SERVICE_URL, AI_SERVICE_API_KEY.
 *
 * ⚠ Env vars, not flags: `payload run` does not reliably forward argv to the script.
 *
 * ⚠ Each check is one `/v1/retrieve` call, which embeds a short query string.
 *
 * ⚠ ALTERNATIVE TWO-STEP CHECK, if the API is unavailable: `edc_ai` is a
 * separate database. (1) run this dry run, or query the backend DB, for the
 * candidate ids; (2) on the ai-service DB, confirm each id has a document row
 * in corpus `eco-<orgId>` whose chunks are current (no `valid_to` in the past).
 * Then re-run with REPAIR_APPLY=1 — the script still re-checks via the API.
 *
 * Exit 0 = ran (absent/error rows are reported, not fatal). Exit 1 = could not run.
 */

import { getAppAIClient } from '../src/lib/aiClient'
import { liveCheckViaRetrieve, repairPendingPublished } from '../src/lib/repairPendingPublished'

const positiveInt = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

async function main(): Promise<void> {
  const apply = process.env.REPAIR_APPLY === '1'
  const delayMs = positiveInt(process.env.REPAIR_DELAY_MS, 750)
  const limit = positiveInt(process.env.REPAIR_LIMIT, 1000) || 1000

  const { getPayload } = await import('payload')
  const config = (await import('@payload-config')).default
  const payload = await getPayload({ config })

  console.log(`[repair-pending-published] mode=${apply ? 'APPLY' : 'dry-run'} delayMs=${delayMs}`)

  const report = await repairPendingPublished(payload, liveCheckViaRetrieve((org) => getAppAIClient(org).retrieve), {
    apply,
    delayMs,
    limit,
    log: (line) => console.log(`[repair-pending-published] ${line}`),
  })

  console.log(`[repair-pending-published] ${JSON.stringify(report)}`)
  if (!apply && report.live > 0) {
    console.log('[repair-pending-published] dry run — re-run with REPAIR_APPLY=1 to write.')
  }
}

// `payload run` awaits only the import, then exits; a bare `main()` dies at its
// first await (same defect as src/seed/demo.cli.ts). Top-level await keeps it alive.
try {
  await main()
  process.exit(0)
} catch (err) {
  console.error('[repair-pending-published] failed:', err)
  process.exit(1)
}
