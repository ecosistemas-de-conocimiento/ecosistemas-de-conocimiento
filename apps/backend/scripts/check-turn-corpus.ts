/**
 * CONSISTENCY CHECK: chat turns (`msg-<id>`) in ai-service whose `messages`
 * row is gone, and documents whose chunks disagree with them on validity.
 * Logic and rationale: `src/lib/turnCorpusCheck.ts`.
 *
 * 🔴 READ-ONLY BY DEFAULT. The ai-service database is opened with
 * `default_transaction_read_only=on`, and nothing is erased.
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
 *   TURN_CHECK_APPLY=1  erase `orphan-live` and `orphan-stored` turns
 *   plus the backend's usual DATABASE_URI, and AI_SERVICE_URL +
 *   AI_SERVICE_ADMIN_API_KEY for the erase.
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
  readOnlyUrl,
  sqlReaders,
} from '../src/lib/turnCorpusCheck'

async function main(): Promise<void> {
  const apply = process.env.TURN_CHECK_APPLY === '1'
  const aiUrl = process.env.AI_DATABASE_URL
  if (!aiUrl) throw new Error('AI_DATABASE_URL is not set (the ai-service database, edc_ai).')

  // First, so a malformed URL fails before anything connects.
  const aiReadOnlyUrl = readOnlyUrl(aiUrl)

  const { getPayload } = await import('payload')
  const config = (await import('@payload-config')).default
  const payload = await getPayload({ config })
  const backend = (payload.db as unknown as { drizzle: { execute(q: unknown): Promise<unknown> } }).drizzle
  const ai = drizzle(aiReadOnlyUrl)

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
    await (ai as unknown as { $client?: { end(): Promise<void> } }).$client?.end()
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
