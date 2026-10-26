/**
 * ONE-OFF: participants' published documentos that never passed the
 * anonymisation gate are withdrawn from the ecosistema's corpus, filed with
 * `anonymise = true`, and sent through the gate again (2026-10-26 audit).
 * Logic and order: `src/lib/regateMemberDocumentos.ts`.
 *
 * 🔴 DRY RUN BY DEFAULT: reads only, no ai-service call, no model call.
 * 🔴 `--apply` COSTS MODEL CALLS: the gate's detector calls per chunk, ONE
 * DOCUMENT AT A TIME. A cleared row is auto-published by the ai-service
 * callback; a hold waits in Revisión.
 *
 *     # dry run
 *     node_modules/.bin/payload run scripts/regate-member-documentos.ts
 *
 *     # apply
 *     node_modules/.bin/payload run scripts/regate-member-documentos.ts --apply
 *
 * Env: REGATE_LIMIT=1000, plus the backend's usual DATABASE_URI,
 * AI_SERVICE_URL, AI_SERVICE_API_KEY, AI_SERVICE_ADMIN_API_KEY; the detector's
 * ANONYMISE_DETECT_* pacing applies.
 */

import { regateMemberDocumentos } from '../src/lib/regateMemberDocumentos'

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const limit = Number(process.env.REGATE_LIMIT) > 0 ? Math.floor(Number(process.env.REGATE_LIMIT)) : 1000

  const { getPayload } = await import('payload')
  const config = (await import('@payload-config')).default
  const payload = await getPayload({ config })
  const { getAdminAIClient } = await import('../src/lib/aiClient')
  const { isParticipantUpload } = await import('../src/lib/autoPublish')
  const { enqueueIngestForDoc } = await import('../src/collections/Documents')
  const { relationId } = await import('../src/lib/permissions')

  console.log(`[regate-member-documentos] mode=${apply ? 'APPLY' : 'dry-run'}`)
  const report = await regateMemberDocumentos(payload, {
    apply,
    limit,
    isParticipant: (uploaderId, organizationId) => isParticipantUpload(payload, uploaderId, organizationId),
    clientFor: (organizationId) => getAdminAIClient(organizationId) as never,
    gate: async (row) => {
      const organizationId = relationId(row.organization)
      const uploadedById = relationId(row.uploadedBy)
      if (organizationId == null || uploadedById == null) throw new Error('no ecosistema or uploader on the row')
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
    log: (line) => console.log(`[regate-member-documentos] ${line}`),
  })
  console.log(`[regate-member-documentos] ${JSON.stringify(report)}`)
  if (!apply && report.matched > 0) {
    console.log('[regate-member-documentos] dry run — re-run with --apply to withdraw and gate them.')
  }
  if (report.failed.length > 0) process.exitCode = 1
}

// `payload run` awaits only the import; top-level await keeps it alive.
try {
  await main()
  process.exit(process.exitCode ?? 0)
} catch (err) {
  console.error('[regate-member-documentos] failed:', err)
  process.exit(1)
}
