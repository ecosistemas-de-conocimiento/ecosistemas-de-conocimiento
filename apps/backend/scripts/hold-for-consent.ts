/**
 * RETENIDO POR CONSENTIMIENTO: set `documents.consent_held = true` on named
 * rows, or on every row of one ecosistema matching a filter (owner decision
 * 2026-11-10). Held rows are never re-ingested, re-embedded, re-gated,
 * graphed or published. Logic and guards: `src/lib/consentHold.ts`.
 *
 * 🔴 DRY RUN BY DEFAULT: reads only, prints the ids and the count. Writes only
 * with `--apply` (or CONSENT_APPLY=1). One `UPDATE`, no Payload hooks, no
 * ai-service or model call.
 * 🔴 REFUSES ids outside CONSENT_ORG, and a filter-less selection (a whole
 * ecosistema is never one typo away).
 * ⚠ It does not unpublish. Rows still shared are listed (`notDraft`):
 * unpublish them after (a held row is only retired, nothing re-embedded).
 *
 *     # the workshop rows (dry run): explicit ids, e.g. from the ingest logs
 *     CONSENT_ORG=8 CONSENT_IDS=1178,1179 \
 *       node_modules/.bin/payload run scripts/hold-for-consent.ts
 *
 *     # or a filter: every draft with a file uploaded by user 1 in ecosistema 8
 *     CONSENT_ORG=8 CONSENT_STATUS=draft CONSENT_UPLOADED_BY=1 CONSENT_HAS_FILE=1 \
 *       node_modules/.bin/payload run scripts/hold-for-consent.ts
 *
 *     # apply: the same, plus
 *     CONSENT_APPLY=1
 *
 * Env, not flags: `payload run` does not reliably forward argv (`--apply` is
 * honoured too when it does).
 *   CONSENT_ORG          required, the ecosistema id.
 *   CONSENT_IDS          csv of document ids. When set, the filters are ignored.
 *   CONSENT_IDS_FILE     a tab-separated ids file (`id<TAB>origin<TAB>note`, `#`
 *                        comments); lines marked EXTRA-NO-TALLER are left out.
 *                        Read in place of CONSENT_IDS, never copied by hand.
 *   CONSENT_STATUS       filter: `publication_status` (draft, published, …).
 *   CONSENT_UPLOADED_BY  filter: uploader's user id.
 *   CONSENT_HAS_FILE=1   filter: only rows with an uploaded file (not in-app notes).
 *   CONSENT_ID_FROM / CONSENT_ID_TO   filter: an inclusive id range.
 *   CONSENT_APPLY=1      apply. Anything else is a dry run.
 * plus the backend's usual DATABASE_URI.
 */

import { readFileSync } from 'node:fs'

import { holdForConsent, parseConsentIdsFile, type ConsentHoldSelection } from '../src/lib/consentHold'
import { errSummary } from '../src/lib/errorSummary'

const env = (name: string): string | undefined => {
  const v = process.env[name]?.trim()
  return v ? v : undefined
}
const int = (name: string): number | undefined => {
  const v = env(name)
  if (v === undefined) return undefined
  if (!/^\d+$/.test(v)) throw new Error(`${name} must be a number`)
  return Number(v)
}

async function main(): Promise<void> {
  const apply = process.env.CONSENT_APPLY === '1' || process.argv.includes('--apply')
  const file = env('CONSENT_IDS_FILE')
  const ids = file
    ? parseConsentIdsFile(readFileSync(file, 'utf8'))
    : (env('CONSENT_IDS') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
  if (file) console.log(`[hold-for-consent] ${ids.length} ids read from ${file}`)
  const selection: ConsentHoldSelection = {
    organizationId: env('CONSENT_ORG') ?? '',
    ...(ids.length > 0
      ? { ids }
      : {
          publicationStatus: env('CONSENT_STATUS'),
          uploadedBy: int('CONSENT_UPLOADED_BY'),
          hasFile: process.env.CONSENT_HAS_FILE === '1' || undefined,
          idFrom: int('CONSENT_ID_FROM'),
          idTo: int('CONSENT_ID_TO'),
        }),
  }

  const { getPayload } = await import('payload')
  const config = (await import('@payload-config')).default
  const payload = await getPayload({ config })
  const db = (payload.db as unknown as { drizzle: Parameters<typeof holdForConsent>[0] }).drizzle

  console.log(`[hold-for-consent] mode=${apply ? 'APPLY' : 'dry-run'} ${JSON.stringify(selection)}`)
  const report = await holdForConsent(db, selection, { apply })
  for (const r of report.rows) {
    console.log(
      `[hold-for-consent] ${r.id} ${r.publicationStatus ?? '-'} ${r.contentKind ?? '-'}${r.alreadyHeld ? ' (already held)' : ''}`,
    )
  }
  console.log(
    `[hold-for-consent] ${JSON.stringify({
      selected: report.rows.length,
      alreadyHeld: report.rows.filter((r) => r.alreadyHeld).length,
      held: report.held,
      refused: report.refused,
      notDraft: report.notDraft,
      revisions: report.revisions,
    })}`,
  )
  if (!apply) console.log('[hold-for-consent] dry run — nothing written. Re-run with CONSENT_APPLY=1 (or --apply) to hold them.')
  if (report.notDraft.length > 0) console.log('[hold-for-consent] ⚠ notDraft rows are still shared: unpublish them.')
  if (report.revisions.length > 0) {
    console.log('[hold-for-consent] revisions are held through their original: not written, nothing to lift on them.')
  }
  if (report.refused.length > 0) process.exitCode = 1
}

// `payload run` awaits only the import; top-level await keeps it alive.
try {
  await main()
  process.exit(process.exitCode ?? 0)
} catch (err) {
  console.error('[hold-for-consent] failed:', errSummary(err))
  process.exit(1)
}
