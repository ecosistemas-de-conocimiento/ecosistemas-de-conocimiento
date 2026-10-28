/**
 * Queue a model re-extraction of a seeding ecosistema's `[[wikilink]]` notes,
 * so old notes get their seeds judged by a model run. Logic, and why the
 * prompt version is not bumped: `src/lib/graph/reextractWikilinkNotes.ts`.
 *
 * 🔴 DRY RUN BY DEFAULT: prints the ids and an estimated cost; writes nothing.
 *
 *     # dry run
 *     REEXTRACT_ORG=8 pnpm --filter @edc/backend payload run scripts/reextract-wikilink-notes.ts
 *     # only some notes
 *     REEXTRACT_ORG=8 REEXTRACT_IDS=101,102 pnpm --filter @edc/backend payload run scripts/reextract-wikilink-notes.ts
 *     # apply: clear their graphPromptVersion, then run the model backfill
 *     REEXTRACT_ORG=8 REEXTRACT_APPLY=1 pnpm --filter @edc/backend payload run scripts/reextract-wikilink-notes.ts
 *     GRAPH_BACKFILL_ORG=8 pnpm --filter @edc/backend payload run src/lib/graph/backfill.cli.ts
 *
 * ⚠ Env vars, not flags: `payload run` does not reliably forward argv.
 * ⚠ No AI call here; the backfill that follows is the paid step.
 * Exit 0 = ran. Exit 1 = could not run.
 */

import { parseReextractIds, planWikilinkReextraction } from '../src/lib/graph/reextractWikilinkNotes'

async function main(): Promise<void> {
  const organizationId = Number(process.env.REEXTRACT_ORG ?? '')
  if (!Number.isInteger(organizationId) || organizationId <= 0) throw new Error('REEXTRACT_ORG=<id> is required')
  // 🔴 Strict: set-but-empty, `1e2`, `0x10` all refuse (see `parseReextractIds`).
  const ids = parseReextractIds(process.env.REEXTRACT_IDS)
  const apply = process.env.REEXTRACT_APPLY === '1'
  const usd = Number(process.env.REEXTRACT_USD_PER_WINDOW ?? '')

  const { getPayload } = await import('payload')
  const config = (await import('@payload-config')).default
  const payload = await getPayload({ config })
  const db = (payload.db as unknown as { drizzle: Parameters<typeof planWikilinkReextraction>[0] }).drizzle

  const plan = await planWikilinkReextraction(db, {
    organizationId,
    ...(ids ? { ids } : {}),
    apply,
    ...(Number.isFinite(usd) && usd > 0 ? { usdPerWindow: usd } : {}),
  })
  console.log(`[reextract-wikilinks] org=${organizationId} mode=${apply ? 'APPLY' : 'dry-run'}`)
  console.log(`[reextract-wikilinks] notes=${plan.ids.length} ids=${plan.ids.join(',')}`)
  const price = `$${plan.usdPerWindow}/window (quoted from ADR §5.2 — an estimate, not measured)`
  console.log(`[reextract-wikilinks] these notes: ${plan.windows} windows ≈ $${plan.estimatedUsd} at ${price}`)
  console.log(
    `[reextract-wikilinks] already stale in org ${organizationId} (the backfill runs them too): ` +
      `${plan.alreadyStale.ids.length} docs, ${plan.alreadyStale.windows} windows ≈ $${plan.alreadyStale.estimatedUsd}` +
      (plan.alreadyStale.ids.length ? ` ids=${plan.alreadyStale.ids.join(',')}` : ''),
  )
  console.log(
    `[reextract-wikilinks] backfill run total: ${plan.backfillTotal.documents} docs, ${plan.backfillTotal.windows} windows ` +
      `≈ $${plan.backfillTotal.estimatedUsd} (inferred, before retries)`,
  )
  if (apply) {
    console.log(`[reextract-wikilinks] queued=${plan.queued}. Now run: GRAPH_BACKFILL_ORG=${organizationId} payload run src/lib/graph/backfill.cli.ts`)
  } else {
    console.log('[reextract-wikilinks] dry run — set REEXTRACT_APPLY=1 to queue.')
  }
}

// `payload run` awaits only the import; top-level await keeps it alive.
try {
  await main()
  process.exit(0)
} catch (err) {
  console.error('[reextract-wikilinks] failed:', err instanceof Error ? err.message : err)
  process.exit(1)
}
