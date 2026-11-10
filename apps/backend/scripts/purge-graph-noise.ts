/**
 * ONE-OFF CLEANUP: delete graph entities that are a LANGUAGE or a redaction
 * PLACEHOLDER, or whose label CONTAINS one (`mercado de Domicilio C`), with
 * their mentions and relations.
 * Logic and rationale: `src/lib/graph/purgeNoise.ts` and `src/lib/graph/noise.ts`.
 *
 * 🔴 DRY RUN BY DEFAULT. It reads and prints counts; it writes nothing.
 *
 *     # dry run, every ecosistema (writes nothing)
 *     pnpm --filter @edc/backend payload run scripts/purge-graph-noise.ts
 *
 *     # apply, one ecosistema
 *     PURGE_NOISE_APPLY=1 PURGE_NOISE_ORG=1 pnpm --filter @edc/backend payload run scripts/purge-graph-noise.ts
 *
 *     # in the deployed backend container, from /repo/apps/backend (never pnpm there)
 *     env -u SEED_CORPUS_INGEST node_modules/.bin/payload run scripts/purge-graph-noise.ts
 *     env -u SEED_CORPUS_INGEST PURGE_NOISE_APPLY=1 node_modules/.bin/payload run scripts/purge-graph-noise.ts
 *
 * Env:
 *   PURGE_NOISE_APPLY=1     delete (one transaction); otherwise a dry run
 *   PURGE_NOISE_ORG=<id>    only this ecosistema; omit for all
 *
 * ⚠ Env vars, not flags: `payload run` does not reliably forward argv to the script.
 * ⚠ No AI calls. Database only (DATABASE_URI). Idempotent.
 *
 * Exit 0 = ran. Exit 1 = could not run.
 */

import type { GraphQueryPayload } from '../src/lib/graph/queries'
import { purgeGraphNoise } from '../src/lib/graph/purgeNoise'
import { safeErrMessage } from '../src/lib/errorSummary'

async function main(): Promise<void> {
  const apply = process.env.PURGE_NOISE_APPLY === '1'
  const rawOrg = process.env.PURGE_NOISE_ORG?.trim()
  const organizationId = rawOrg ? Number(rawOrg) : null
  if (rawOrg && !Number.isInteger(organizationId)) {
    throw new Error(`PURGE_NOISE_ORG must be an integer id, got "${rawOrg}"`)
  }

  const { getPayload } = await import('payload')
  const config = (await import('@payload-config')).default
  const payload = await getPayload({ config })

  const tag = '[purge-graph-noise]'
  console.log(`${tag} mode=${apply ? 'APPLY' : 'dry-run'} org=${organizationId ?? 'all'}`)
  const report = await purgeGraphNoise(payload as unknown as GraphQueryPayload, {
    apply,
    organizationId,
  })
  for (const line of report.sample) console.log(`${tag} ${line}`)
  console.log(
    `${tag} entities=${report.entities} mentions=${report.mentions} relations=${report.relations}` +
      (apply ? ' (deleted)' : ''),
  )
  if (!apply && report.entities > 0) {
    console.log(`${tag} dry run — re-run with PURGE_NOISE_APPLY=1 to delete.`)
  }
}

// `payload run` awaits only the import, then exits; a bare `main()` dies at its
// first await (same defect as src/seed/demo.cli.ts). Top-level await keeps it alive.
try {
  await main()
  process.exit(0)
} catch (err) {
  console.error('[purge-graph-noise] failed:', safeErrMessage(err))
  process.exit(1)
}
