/**
 * ONE-OFF: put participants' existing drafts on the auto-publish rule (owner
 * rule, 2026-10-24; `lib/autoPublish.ts`). Script:
 * `scripts/auto-publish-participant-drafts.ts`.
 *
 * Per participant draft (role `member` in its ecosistema):
 *
 *   · cleared (`autoPublishBlocker` is null)   → published, through `beginPublish`
 *   · an AUDIO `documento`                      → re-filed as `testimonio` and sent
 *     back through the gate. The ordinary `afterChange` hook gates and ingests it;
 *     the draft callback then publishes it, or the gate holds it for Revisión.
 *   · `held`                                    → left in Revisión
 *   · an UNGATED `documento` (no `anonymise`)    → skipped `not-gated`, never
 *     published raw (audit 2026-10-28, item 8)
 *   · anything else (in flight, no text, …)     → listed, not touched
 *
 * 🔴 DRY RUN BY DEFAULT: no write, no ai-service call, no model call.
 * ⚠ Idempotent: a published or re-filed row no longer matches.
 */

import type { Payload } from 'payload'

import { autoPublishBlocker, type AutoPublishOutcome } from './autoPublish'
import { relationId } from './permissions'

type Id = number | string
type Row = Record<string, unknown>

export interface AutoPublishBackfillReport {
  apply: boolean
  scanned: number
  /** Published (apply) or would be (dry run). */
  published: string[]
  /** Re-filed as testimonio and sent back through the gate. */
  regated: string[]
  held: string[]
  notParticipant: number
  skipped: Array<{ id: string; reason: string }>
  failed: Array<{ id: string; reason: string }>
}

/** What a gate re-run writes: the retry endpoint's reset (`planIngestRetry`), plus the kind. */
const REGATE_AS_TESTIMONIO = {
  contentKind: 'testimonio',
  ingestStatus: 'pending',
  ingestError: null,
  ingestId: null,
  anonymisationStatus: 'n/a',
  anonymisationError: null,
  redactedText: null,
  heldText: null,
  anonymisationSurvivors: null,
} as const

const hasText = (row: Row): boolean => typeof row.extractedText === 'string' && row.extractedText.trim() !== ''

export async function autoPublishParticipantDrafts(
  payload: Payload,
  deps: {
    apply: boolean
    limit: number
    isParticipant: (uploaderId: Id, organizationId: Id) => Promise<boolean>
    publish: (documentId: Id) => Promise<AutoPublishOutcome>
    log: (line: string) => void
  },
): Promise<AutoPublishBackfillReport> {
  const report: AutoPublishBackfillReport = {
    apply: deps.apply,
    scanned: 0,
    published: [],
    regated: [],
    held: [],
    notParticipant: 0,
    skipped: [],
    failed: [],
  }

  const found = await payload.find({
    collection: 'documents',
    where: {
      and: [
        { publicationStatus: { equals: 'draft' } },
        { contentKind: { in: ['documento', 'testimonio'] } },
      ],
    },
    limit: deps.limit,
    sort: 'id',
    depth: 0,
    overrideAccess: true,
  })

  for (const row of found.docs as unknown as Row[]) {
    report.scanned += 1
    const id = String(row.id)
    const organizationId = relationId(row.organization)
    const uploaderId = relationId(row.uploadedBy)
    if (organizationId === null || uploaderId === null || !(await deps.isParticipant(uploaderId, organizationId))) {
      report.notParticipant += 1
      continue
    }

    if (row.anonymisationStatus === 'held') {
      report.held.push(id)
      continue
    }

    if (row.kind === 'audio' && row.contentKind === 'documento') {
      if (row.anonymisationStatus === 'rejected') {
        report.skipped.push({ id, reason: 'rejected' })
        continue
      }
      if (!hasText(row)) {
        report.skipped.push({ id, reason: 'no-text' })
        continue
      }
      if (row.ingestStatus !== 'ready' && row.ingestStatus !== 'failed') {
        report.skipped.push({ id, reason: 'not-ingested' })
        continue
      }
      if (deps.apply) {
        // ⚠ No `__skipDocsExtract`: the ordinary hook is what runs the gate.
        // Guarded on the state just read, so a row that moved is left alone.
        const res = (await payload.update({
          collection: 'documents',
          where: {
            and: [
              { id: { equals: row.id } },
              { publicationStatus: { equals: 'draft' } },
              { contentKind: { equals: 'documento' } },
            ],
          },
          data: REGATE_AS_TESTIMONIO as never,
          overrideAccess: true,
        })) as { docs?: unknown[] }
        if (!res.docs?.length) {
          report.skipped.push({ id, reason: 'changed' })
          continue
        }
      }
      report.regated.push(id)
      deps.log(`doc ${id}: audio documento → testimonio, sent through the gate`)
      continue
    }

    const blocked = autoPublishBlocker(row)
    if (blocked) {
      report.skipped.push({ id, reason: blocked })
      continue
    }
    if (deps.apply) {
      const out = await deps.publish(row.id as Id)
      if (!out.published) {
        report.failed.push({ id, reason: out.reason })
        continue
      }
    }
    report.published.push(id)
    deps.log(`doc ${id}: ${deps.apply ? 'publishing' : 'would publish'}`)
  }

  return report
}
