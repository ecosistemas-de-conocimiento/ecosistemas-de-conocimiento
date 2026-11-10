/**
 * ONE-OFF: participants' existing drafts onto the auto-publish rule (owner rule,
 * 2026-10-24). Logic: `src/lib/autoPublishBackfill.ts`.
 *
 * 🔴 DRY RUN BY DEFAULT: reads only; no write, no ai-service call, no model call.
 *
 *     # dry run
 *     node_modules/.bin/payload run scripts/auto-publish-participant-drafts.ts
 *
 *     # apply (`AUTO_PUBLISH_APPLY=1` works too, if `payload run` drops the flag)
 *     node_modules/.bin/payload run scripts/auto-publish-participant-drafts.ts --apply
 *
 * Env: AUTO_PUBLISH_LIMIT=1000, plus the backend's usual DATABASE_URI,
 * AI_SERVICE_URL, AI_SERVICE_API_KEY, AI_SERVICE_ADMIN_API_KEY, CALLBACK_*.
 * 🔴 APPLY COSTS: one shared-corpus embed per published draft; for each re-gated
 * audio, the gate's model calls (two detector calls per chunk) plus a draft embed
 * and, once cleared, a shared embed.
 *
 * ⚠ The RUNNING backend must already carry the auto-publish callback: a re-gated
 * audio is published by the server when its draft ingest lands, not by this script.
 * The script waits (up to 10 min) for each re-gated row to leave the gate, so the
 * in-process hook is not killed half way.
 */

import { autoPublishParticipantDrafts } from '../src/lib/autoPublishBackfill'
import { safeErrMessage } from '../src/lib/errorSummary'

const TAG = '[auto-publish-participant-drafts]'
const WAIT_MS = 10 * 60_000

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply') || process.env.AUTO_PUBLISH_APPLY === '1'
  const limit =
    Number(process.env.AUTO_PUBLISH_LIMIT) > 0 ? Math.floor(Number(process.env.AUTO_PUBLISH_LIMIT)) : 1000

  const { getPayload } = await import('payload')
  const config = (await import('@payload-config')).default
  const payload = await getPayload({ config })
  const { getAdminAIClient } = await import('../src/lib/aiClient')
  const { ingestCallbackUrl } = await import('../src/lib/callbackConfig')
  const { autoPublishParticipantDocument, isParticipantUpload } = await import('../src/lib/autoPublish')
  const callbackUrl = ingestCallbackUrl()

  console.log(`${TAG} mode=${apply ? 'APPLY' : 'dry-run'}`)
  const report = await autoPublishParticipantDrafts(payload, {
    apply,
    limit,
    isParticipant: (uploaderId, organizationId) => isParticipantUpload(payload, uploaderId, organizationId),
    publish: (documentId) =>
      autoPublishParticipantDocument({
        payload,
        documentId,
        clientFor: (organizationId) => getAdminAIClient(organizationId) as never,
        ...(callbackUrl ? { callbackUrl } : {}),
      }),
    log: (line) => console.log(`${TAG} ${line}`),
  })
  console.log(`${TAG} ${JSON.stringify(report)}`)

  if (apply && report.regated.length > 0) {
    // The gate runs in this process's `afterChange` hook. Wait for each row to
    // leave it: enqueued (`embedding`), held, or failed.
    const deadline = Date.now() + WAIT_MS
    let waiting = [...report.regated]
    while (waiting.length > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5_000))
      const rows = await payload.find({
        collection: 'documents',
        where: { id: { in: waiting } },
        depth: 0,
        pagination: false,
        overrideAccess: true,
      })
      waiting = (rows.docs as unknown as Array<Record<string, unknown>>)
        .filter((r) => r.ingestStatus === 'pending' || r.ingestStatus === 'extracting' || r.anonymisationStatus === 'pending')
        .map((r) => String(r.id))
    }
    console.log(`${TAG} gate settled; still waiting on: ${JSON.stringify(waiting)}`)
  }
  if (!apply && (report.published.length > 0 || report.regated.length > 0)) {
    console.log(`${TAG} dry run — re-run with --apply to write.`)
  }
  if (report.failed.length > 0) process.exitCode = 1
}

// `payload run` awaits only the import; top-level await keeps it alive.
try {
  await main()
  process.exit(process.exitCode ?? 0)
} catch (err) {
  console.error(`${TAG} failed:`, safeErrMessage(err))
  process.exit(1)
}
