/**
 * CONSISTENCY CHECK: chat turns (`msg-<id>`) in ai-service whose `messages`
 * row is gone, and documents whose chunks disagree with them on validity.
 * Logic and rationale: `src/lib/turnCorpusCheck.ts`.
 *
 * 🔴 READ-ONLY BY DEFAULT. BOTH databases (ai-service's and the backend's) are
 * opened with `default_transaction_read_only=on`, and nothing is erased.
 *
 * 🔴 NO PAYLOAD BOOT. The script reads the backend database directly; it never
 * calls `getPayload`, so no seed, bucket check or janitor runs. `payload run`
 * is only the launcher: it loads `.env` and the TypeScript loader, then imports
 * this file. With APPLY, the only other thing used is the ai-service admin
 * client, for `deleteDocument`.
 *
 *     # report (writes nothing)
 *     AI_DATABASE_URL=postgres://…/edc_ai \
 *       pnpm --filter @edc/backend payload run scripts/check-turn-corpus.ts
 *
 *     # erase the orphans, through ai-service's API (document + chunks together)
 *     TURN_CHECK_APPLY=1 AI_DATABASE_URL=… \
 *       pnpm --filter @edc/backend payload run scripts/check-turn-corpus.ts
 *
 * Env:
 *   AI_DATABASE_URL     the ai-service database (`edc_ai`), REQUIRED
 *   DATABASE_URI        the backend database (`edc_backend`), REQUIRED
 *   TURN_CHECK_APPLY=1  erase `orphan-live` and `orphan-stored` turns; needs
 *                       AI_SERVICE_URL + AI_SERVICE_ADMIN_API_KEY too.
 *
 * ⚠ Env vars, not flags: `payload run` does not reliably forward argv.
 * ⚠ Mismatches are reported only, never repaired.
 *
 * Exit 0 = ran (problems are reported, not fatal). Exit 1 = could not run.
 */

import { drizzle } from '@payloadcms/db-postgres/drizzle/node-postgres'

import { getAdminAIClient } from '../src/lib/aiClient'
import {
  checkTurnCorpus,
  describeError,
  organizationOfTurnCorpus,
  sqlReaders,
  turnCheckEnv,
} from '../src/lib/turnCorpusCheck'

type Closable = { $client?: { end(): Promise<void> } }

async function main(): Promise<void> {
  // First, so a missing or malformed URL fails before anything connects.
  const { apply, aiUrl, backendUrl } = turnCheckEnv(process.env)
  const ai = drizzle(aiUrl)
  const backend = drizzle(backendUrl)

  console.log(`[check-turn-corpus] mode=${apply ? 'APPLY' : 'read-only'}`)
  try {
    const report = await checkTurnCorpus({
      ...sqlReaders(ai, backend),
      erase: async (corpus, externalId) => {
        const organizationId = organizationOfTurnCorpus(corpus)
        if (organizationId == null) throw new Error(`not a shared corpus: ${corpus}`)
        await getAdminAIClient(organizationId).admin.deleteDocument(corpus, externalId)
      },
      log: (line) => console.log(`[check-turn-corpus] ${line}`),
      apply,
    })
    console.log(`[check-turn-corpus] ${JSON.stringify(report)}`)
    if (!apply && report.orphanLive + report.orphanStored > 0) {
      console.log('[check-turn-corpus] read-only — re-run with TURN_CHECK_APPLY=1 to erase the orphans.')
    }
  } finally {
    for (const db of [ai, backend]) await (db as unknown as Closable).$client?.end()
  }
}

// `payload run` awaits only the import; top-level await keeps the script alive
// (same as scripts/repair-pending-published.ts).
try {
  await main()
  process.exit(0)
} catch (err) {
  // 🔴 Never the error object: a malformed AI_DATABASE_URL gives a Node error
  // whose `input` is the whole URL, password included.
  console.error(
    '[check-turn-corpus] failed:',
    describeError(err, [process.env.AI_DATABASE_URL, process.env.DATABASE_URI]),
  )
  process.exit(1)
}
