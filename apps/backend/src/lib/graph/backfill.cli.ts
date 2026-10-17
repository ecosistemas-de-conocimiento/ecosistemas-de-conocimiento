/**
 * Runnable entry point for the corpus-graph backfill.
 *
 *     payload run src/lib/graph/backfill.cli.ts
 *
 * Environment:
 *     GRAPH_BACKFILL_LIMIT=20     stop after N documents (default: all)
 *     GRAPH_BACKFILL_ORG=3        only this ecosistema (default: all)
 *     GRAPH_BACKFILL_DRY_RUN=1    list candidates, extract nothing
 *     GRAPH_BACKFILL_NO_SWEEP=1   skip the orphan-entity sweep
 *     GRAPH_BACKFILL_STALE_EXTRACTING_MIN=30
 *                                 retry rows stuck at `extracting` for longer
 *                                 than this many minutes (default 30)
 *
 * ── 🔴 WHY THIS IS A SEPARATE FILE FROM `backfill.ts` ──────────────────────
 *
 * Exactly the reasoning in `src/seed/demo.cli.ts`, and it was learned the
 * expensive way there. Two defects in `payload run` (measured against
 * `payload@3.84.1`) make a self-executing module silently do nothing:
 *
 *   1. `payload run <script>` REWRITES `process.argv` before importing, so the
 *      usual `import.meta.url === pathToFileURL(process.argv[1])` self-execution
 *      test is ALWAYS false under the very command the docs recommend.
 *   2. `payload run` calls `process.exit(0)` as soon as the dynamic `import()`
 *      RESOLVES. A `void main()` at module scope is not awaited, so the process
 *      dies at the first `await`.
 *
 * Both are fixed by the two properties of this file: nothing imports it, so it
 * is free to have side effects at module scope, and it uses TOP-LEVEL AWAIT, so
 * `payload run` waits for the work before exiting.
 *
 * ⚠ `backfill.ts` therefore stays import-safe and unit-testable. Do not move
 * this `await` into it.
 */
import { getPayload } from 'payload'
import config from '@payload-config'

import { runGraphBackfill, type GraphBackfillPayload } from './backfill'

const intFromEnv = (name: string): number | undefined => {
  const raw = process.env[name]
  if (!raw || !raw.trim()) return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined
}

const payload = await getPayload({ config })

const result = await runGraphBackfill(payload as unknown as GraphBackfillPayload, {
  limit: intFromEnv('GRAPH_BACKFILL_LIMIT'),
  organizationId: process.env.GRAPH_BACKFILL_ORG?.trim() || undefined,
  dryRun: process.env.GRAPH_BACKFILL_DRY_RUN === '1',
  skipOrphanSweep: process.env.GRAPH_BACKFILL_NO_SWEEP === '1',
  staleExtractingMs: (() => {
    const minutes = intFromEnv('GRAPH_BACKFILL_STALE_EXTRACTING_MIN')
    return minutes ? minutes * 60 * 1000 : undefined
  })(),
})

// A non-zero exit when something failed, so a wrapper script cannot report
// success from a run that half-worked.
if (result.failed > 0) {
  console.error(`[graph-backfill] ${result.failed} documento(s) fallaron`)
  process.exit(1)
}
