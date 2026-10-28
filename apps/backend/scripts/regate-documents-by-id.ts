/**
 * ONE-OFF, BY ID: withdraw named documents from the ecosistema's corpora
 * (shared and the uploader's draft), reset their gate columns, and send them
 * back through the anonymisation gate and into ingest. For rows gated before a
 * prompt change (owner's ruling Q24 = A, 2026-10-28: public names are not
 * personal data). Logic and order: `src/lib/regateDocumentsById.ts`.
 *
 * 🔴 DRY RUN BY DEFAULT: reads only, no ai-service call, no model call. It
 * prints, per id, the current status and the placeholder counts.
 * 🔴 APPLY COSTS DETECTOR CALLS (stage 3 + verify per chunk), ONE DOCUMENT AT
 * A TIME. A row that was published ends a draft: a participant's upload is
 * auto-published by the ai-service callback, anyone else's is republished by
 * hand. A hold waits in Revisión.
 * 🔴 REFUSES ids outside REGATE_ORG, never-gated rows, rows mid-transition,
 * and testimonios unless REGATE_ALLOW_TESTIMONIO=1.
 *
 *     # dry run
 *     REGATE_ORG=7 REGATE_IDS=354,351 \
 *       node_modules/.bin/payload run scripts/regate-documents-by-id.ts
 *
 *     # apply
 *     REGATE_ORG=7 REGATE_IDS=354,351 REGATE_APPLY=1 \
 *       node_modules/.bin/payload run scripts/regate-documents-by-id.ts
 *
 * Env, not flags: `payload run` does not reliably forward argv (`--apply` and
 * `--allow-testimonio` are honoured too when it does).
 *   REGATE_ORG               required, the ecosistema id.
 *   REGATE_IDS               required, csv of document ids.
 *   REGATE_APPLY=1           apply. Anything else is a dry run.
 *   REGATE_ALLOW_TESTIMONIO=1  allow testimonios.
 * plus the backend's usual DATABASE_URI, AI_SERVICE_URL, AI_SERVICE_API_KEY,
 * AI_SERVICE_ADMIN_API_KEY; the detector's ANONYMISE_DETECT_* settings apply.
 */

import { regateDocumentsById } from '../src/lib/regateDocumentsById'

async function main(): Promise<void> {
  const apply = process.env.REGATE_APPLY === '1' || process.argv.includes('--apply')
  const allowTestimonio = process.env.REGATE_ALLOW_TESTIMONIO === '1' || process.argv.includes('--allow-testimonio')
  const organizationId = (process.env.REGATE_ORG ?? '').trim()
  const ids = (process.env.REGATE_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!/^\d+$/.test(organizationId)) throw new Error('REGATE_ORG must be an ecosistema id')
  if (ids.length === 0 || ids.some((id) => !/^\d+$/.test(id))) throw new Error('REGATE_IDS must be a csv of document ids')

  const { getPayload } = await import('payload')
  const config = (await import('@payload-config')).default
  const payload = await getPayload({ config })
  const { getAdminAIClient } = await import('../src/lib/aiClient')
  const { enqueueIngestForDoc } = await import('../src/collections/Documents')
  const { relationId } = await import('../src/lib/permissions')

  console.log(
    `[regate-documents-by-id] mode=${apply ? 'APPLY' : 'dry-run'} eco-${organizationId} ids=${ids.join(',')}` +
      (allowTestimonio ? ' (testimonios allowed)' : ''),
  )
  const report = await regateDocumentsById(payload, {
    ids,
    organizationId,
    apply,
    allowTestimonio,
    client: getAdminAIClient(organizationId) as never,
    gate: async (row) => {
      const uploadedById = relationId(row.uploadedBy)
      if (uploadedById == null) throw new Error('no uploader on the row')
      await enqueueIngestForDoc({
        payload,
        docId: row.id as number,
        organizationId,
        uploadedById,
        fresh: {
          ...(row as Record<string, never>),
          anonymise: row.anonymise ?? null,
          anonymisationStatus: (row.anonymisationStatus as string | null | undefined) ?? null,
          redactedText: (row.redactedText as string | null | undefined) ?? null,
        },
        extractedText: String(row.extractedText),
      })
    },
    log: (line) => console.log(`[regate-documents-by-id] ${line}`),
  })
  console.log(
    `[regate-documents-by-id] ${JSON.stringify({ regated: report.regated, refused: report.refused, failed: report.failed })}`,
  )
  if (!apply) console.log('[regate-documents-by-id] dry run — re-run with REGATE_APPLY=1 to withdraw and gate them.')
  if (report.failed.length > 0 || report.refused.length > 0) process.exitCode = 1
}

// `payload run` awaits only the import; top-level await keeps it alive.
try {
  await main()
  process.exit(process.exitCode ?? 0)
} catch (err) {
  console.error('[regate-documents-by-id] failed:', err)
  process.exit(1)
}
