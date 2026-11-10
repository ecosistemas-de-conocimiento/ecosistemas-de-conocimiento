/**
 * STALE TITLES IN AI-SERVICE: rewrite the title of published gated documentos
 * and testimonios in ai-service (document row and every chunk's
 * `metadata.title`) to what every ingest sends today, `documentTitleFor(row)`.
 * Logic, scope and guards: `src/lib/refreshAiTitles.ts`.
 *
 * 🔴 DRY RUN BY DEFAULT: one `dryRun` call per batch, which writes nothing on
 * either side and reports the ids whose ai-service title differs. Writes only
 * with `--apply` (or TITLES_APPLY=1), and then only those ids. No text is sent
 * and nothing is re-embedded; no model call.
 * 🔴 Never selects a row held for consent, or any draft (so no draft of
 * ecosistema 8).
 *
 *     # dry run, every ecosistema
 *     node_modules/.bin/payload run scripts/refresh-ai-titles.ts
 *
 *     # apply, one ecosistema
 *     TITLES_ORG=6 TITLES_APPLY=1 node_modules/.bin/payload run scripts/refresh-ai-titles.ts
 *
 * Env, not flags: `payload run` does not reliably forward argv (`--apply` is
 * honoured too when it does).
 *   TITLES_ORG        only this ecosistema id.
 *   TITLES_BATCH=100  documents per ai-service call (max 200).
 *   TITLES_DELAY_MS=1000  pause after every call (the /v1 cap is 100/min per key).
 *   TITLES_APPLY=1    apply. Anything else is a dry run.
 * plus the backend's usual DATABASE_URI, AI_SERVICE_URL, AI_SERVICE_ADMIN_API_KEY.
 */

import { getAdminAIClient } from '../src/lib/aiClient'
import { errSummary } from '../src/lib/errorSummary'
import { refreshAiTitles } from '../src/lib/refreshAiTitles'

const int = (name: string, fallback?: number): number | undefined => {
  const v = process.env[name]?.trim()
  if (!v) return fallback
  if (!/^\d+$/.test(v)) throw new Error(`${name} must be a number`)
  return Number(v)
}

async function main(): Promise<void> {
  const apply = process.env.TITLES_APPLY === '1' || process.argv.includes('--apply')
  const organizationId = int('TITLES_ORG')

  const { getPayload } = await import('payload')
  const config = (await import('@payload-config')).default
  const payload = await getPayload({ config })
  const db = (payload.db as unknown as { drizzle: Parameters<typeof refreshAiTitles>[0] }).drizzle

  console.log(`[refresh-ai-titles] mode=${apply ? 'APPLY' : 'dry-run'} org=${organizationId ?? 'all'}`)
  const report = await refreshAiTitles(db, {
    apply,
    organizationId,
    batchSize: int('TITLES_BATCH', 100),
    delayMs: int('TITLES_DELAY_MS', 1000),
    clientFor: (org) => getAdminAIClient(org).admin,
  })
  for (const c of report.corpora) {
    console.log(
      `[refresh-ai-titles] eco-${c.organizationId} ${c.copy} ${JSON.stringify({
        sent: c.sent,
        stale: c.changed.length,
        chunksStale: c.chunksChanged,
        notFound: c.notFound,
        missingCorpus: c.missingCorpus,
      })}${c.changed.length > 0 ? ` ids=${c.changed.join(',')}` : ''}`,
    )
  }
  console.log(
    `[refresh-ai-titles] ${JSON.stringify({
      selected: report.selected,
      stale: report.corpora.reduce((n, c) => n + c.changed.length, 0),
      written: report.written.length,
    })}`,
  )
  if (!apply) console.log('[refresh-ai-titles] dry run — nothing written. Re-run with TITLES_APPLY=1 (or --apply).')
}

// `payload run` awaits only the import; top-level await keeps it alive.
try {
  await main()
  process.exit(process.exitCode ?? 0)
} catch (err) {
  console.error('[refresh-ai-titles] failed:', errSummary(err))
  process.exit(1)
}
