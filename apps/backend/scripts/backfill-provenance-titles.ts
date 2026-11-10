/**
 * STALE TITLES IN SAVED ANSWERS: rewrite the citation title of every gated
 * documento in `messages.provenance` to what every ingest sends today,
 * `documentTitleFor(row)`. Logic, scope and guards: `src/lib/provenanceTitles.ts`.
 *
 * 🔴 DRY RUN BY DEFAULT: reads only, prints message ids and counts. Writes
 * only with `--apply` (or PROVENANCE_APPLY=1). One `jsonb_set` per citation
 * title, one transaction per batch; no Payload hook, no ai-service or model call.
 * 🔴 A message that cites a row held for consent is never touched.
 * Ungated documentos, testimonios and conversation turns are never written:
 * a title that differs from their neutral one is only counted.
 *
 *     # dry run, every ecosistema
 *     node_modules/.bin/payload run scripts/backfill-provenance-titles.ts
 *
 *     # apply, one ecosistema
 *     PROVENANCE_ORG=6 PROVENANCE_APPLY=1 node_modules/.bin/payload run scripts/backfill-provenance-titles.ts
 *
 * Env, not flags: `payload run` does not reliably forward argv (`--apply` is
 * honoured too when it does).
 *   PROVENANCE_ORG        only the messages of this ecosistema's sessions.
 *   PROVENANCE_BATCH=200  messages per batch / transaction (max 1000).
 *   PROVENANCE_APPLY=1    apply. Anything else is a dry run.
 * plus the backend's usual DATABASE_URI.
 */

import { errSummary } from '../src/lib/errorSummary'
import { backfillProvenanceTitles, type ProvenanceDb } from '../src/lib/provenanceTitles'

const int = (name: string, fallback?: number): number | undefined => {
  const v = process.env[name]?.trim()
  if (!v) return fallback
  if (!/^\d+$/.test(v)) throw new Error(`${name} must be a number`)
  return Number(v)
}

async function main(): Promise<void> {
  const apply = process.env.PROVENANCE_APPLY === '1' || process.argv.includes('--apply')
  const organizationId = int('PROVENANCE_ORG')

  const { getPayload } = await import('payload')
  const config = (await import('@payload-config')).default
  const payload = await getPayload({ config })
  const db = (payload.db as unknown as { drizzle: ProvenanceDb }).drizzle

  console.log(`[backfill-provenance-titles] mode=${apply ? 'APPLY' : 'dry-run'} org=${organizationId ?? 'all'}`)
  const report = await backfillProvenanceTitles(db, { apply, organizationId, batchSize: int('PROVENANCE_BATCH', 200) })
  const ids = (label: string, list: number[]) =>
    console.log(`[backfill-provenance-titles] ${label}=${list.length}${list.length > 0 ? ` ids=${list.join(',')}` : ''}`)
  ids('stale', report.stale)
  ids('written', report.written)
  ids('consentHeld', report.consentHeld)
  ids('titleElsewhere', report.titleElsewhere)
  ids('stringProvenance', report.stringProvenance)
  console.log(
    `[backfill-provenance-titles] ${JSON.stringify({
      scanned: report.scanned,
      staleCitations: report.staleCitations,
      openStale: report.openStale,
      missingDocument: report.missingDocument,
    })}`,
  )
  if (!apply) console.log('[backfill-provenance-titles] dry run — nothing written. Re-run with PROVENANCE_APPLY=1 (or --apply).')
}

// `payload run` awaits only the import; top-level await keeps it alive.
try {
  await main()
  process.exit(process.exitCode ?? 0)
} catch (err) {
  console.error('[backfill-provenance-titles] failed:', errSummary(err))
  process.exit(1)
}
