/**
 * RAW ERROR TEXT AT REST: rewrite the reason columns (`ingest_error`,
 * `publication_error`, `anonymisation_error`, `graph_error`, `corpus_error`,
 * `gate_reason`, `eval_runs.error`) written before 2026-11-10 that still hold
 * database error text, which can quote the row. Logic, columns and pattern:
 * `src/lib/storedReason.ts`. Reads are already guarded by its `afterRead` hook;
 * this removes the text from the database.
 *
 * 🔴 DRY RUN BY DEFAULT: reads only, prints ids and counts per table and
 * column, never the text. Writes only with `--apply` (or ERRORS_APPLY=1): each
 * matching value becomes its `code:` and `[database error text withheld]`.
 * No Payload hooks, no ai-service or model call. Idempotent.
 *
 *     # dry run
 *     node_modules/.bin/payload run scripts/clean-stored-errors.ts
 *
 *     # apply
 *     ERRORS_APPLY=1 node_modules/.bin/payload run scripts/clean-stored-errors.ts
 *
 * Env, not flags: `payload run` does not reliably forward argv (`--apply` is
 * honoured too when it does).
 *   ERRORS_BATCH=200  rows read per query.
 *   ERRORS_APPLY=1    apply. Anything else is a dry run.
 * plus the backend's usual DATABASE_URI.
 */

import { errSummary } from '../src/lib/errorSummary'
import { cleanStoredReasons } from '../src/lib/storedReason'

const int = (name: string, fallback: number): number => {
  const v = process.env[name]?.trim()
  if (!v) return fallback
  if (!/^\d+$/.test(v)) throw new Error(`${name} must be a number`)
  return Number(v)
}

async function main(): Promise<void> {
  const apply = process.env.ERRORS_APPLY === '1' || process.argv.includes('--apply')

  const { getPayload } = await import('payload')
  const config = (await import('@payload-config')).default
  const payload = await getPayload({ config })
  const db = (payload.db as unknown as { drizzle: Parameters<typeof cleanStoredReasons>[0] }).drizzle

  console.log(`[clean-stored-errors] mode=${apply ? 'APPLY' : 'dry-run'}`)
  const report = await cleanStoredReasons(db, { apply, batchSize: int('ERRORS_BATCH', 200) })
  for (const c of report.columns) {
    console.log(`[clean-stored-errors] ${c.table}.${c.column} ${c.ids.length}${c.ids.length ? ` ${c.ids.join(',')}` : ''}`)
  }
  const total = report.columns.reduce((n, c) => n + c.ids.length, 0)
  console.log(`[clean-stored-errors] ${apply ? 'rewritten' : 'matching'}=${total}`)
  if (!apply) console.log('[clean-stored-errors] dry run — nothing written. Re-run with ERRORS_APPLY=1 (or --apply) to clean them.')
}

// `payload run` awaits only the import; top-level await keeps it alive.
try {
  await main()
  process.exit(process.exitCode ?? 0)
} catch (err) {
  console.error('[clean-stored-errors] failed:', errSummary(err))
  process.exit(1)
}
