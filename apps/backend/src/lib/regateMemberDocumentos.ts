/**
 * 🔴 ONE-OFF: participants' PUBLISHED documentos that never passed the gate go
 * back through it.
 *
 * Until the 2026-10-26 audit, `enforceVocesUploadRights` set `anonymise` on a
 * participant's documento only when the CLIENT declared `kind: 'pdf' | 'docx'`,
 * and the rule itself is from the same day. Any participant documento published
 * before or around it is shared ungated. Owner recommendation: re-check them
 * (dev data is disposable).
 *
 * Selection, on the stored row: `contentKind = documento`, `anonymise` not
 * `true`, `publicationStatus = published`, and the uploader is a participant
 * (role exactly `member`, not a platform admin) in the row's ecosistema.
 *
 * Apply, ONE ROW AT A TIME, in this order:
 *
 *   1. Retire it from the ecosistema's SHARED corpus (`retireFrom`, the
 *      unpublish rule: sharing stops first). A failure leaves the row as it was.
 *   2. One guarded write: `anonymise = true`, a draft, gate columns reset to the
 *      retryable `n/a`, ingest reset to `extracting` with no `ingestId`.
 *   3. Gate it (`gate`, the script passes `enqueueIngestForDoc`): the gate runs on
 *      `extractedText`, and a cleared row ingests into the draft corpus. The
 *      ai-service callback then auto-publishes it (`lib/autoPublish.ts`); a hold
 *      waits in Revisión. A row with no extracted text (a markdown note) stays a
 *      private gated draft (`withdrawnOnly`).
 *
 * ⚠ IDEMPOTENT: a processed row has `anonymise = true`, so it no longer matches.
 * ⚠ DRY RUN BY DEFAULT; the dry run makes no ai-service call.
 */

import type { Payload } from 'payload'

import { publishedCorpus } from './corpus'
import { relationId } from './permissions'
import { retireFrom, type CorpusMover } from './publishDocument'

type Id = number | string
type Row = Record<string, unknown>

export interface RegateMemberDocumentosReport {
  examined: number
  matched: number
  /** Withdrawn and sent through the gate (apply only). */
  regated: number
  ids: string[]
  /** Withdrawn and filed gated, but there was no text to gate. */
  withdrawnOnly: string[]
  /** Retire or write failed; left as they were. */
  failed: string[]
}

/** The row-only half of the selection. Who uploaded it is asked separately. */
export function needsRegate(row: Row): boolean {
  return row.contentKind === 'documento' && row.anonymise !== true && row.publicationStatus === 'published'
}

export async function regateMemberDocumentos(
  payload: Pick<Payload, 'find' | 'update'>,
  opts: {
    apply: boolean
    /** Is this uploader a participant in that ecosistema? `isParticipantUpload`. */
    isParticipant: (uploaderId: Id, organizationId: Id) => Promise<boolean>
    /** Admin client for one ecosistema: retiring is an admin route. */
    clientFor: (organizationId: Id) => CorpusMover
    /** Gate and ingest one reset row. */
    gate: (row: Row) => Promise<unknown>
    limit?: number
    now?: Date
    log?: (line: string) => void
  },
): Promise<RegateMemberDocumentosReport> {
  const log = opts.log ?? (() => undefined)
  const found = (await payload.find({
    collection: 'documents',
    where: {
      and: [
        { contentKind: { equals: 'documento' } },
        { publicationStatus: { equals: 'published' } },
        { or: [{ anonymise: { equals: false } }, { anonymise: { exists: false } }] },
      ],
    },
    limit: opts.limit ?? 1000,
    depth: 0,
    overrideAccess: true,
  })) as unknown as { docs?: Row[] }
  const rows = found.docs ?? []
  const report: RegateMemberDocumentosReport = {
    examined: rows.length,
    matched: 0,
    regated: 0,
    ids: [],
    withdrawnOnly: [],
    failed: [],
  }

  for (const row of rows) {
    if (row.id == null || !needsRegate(row)) continue
    const id = String(row.id)
    const organizationId = relationId(row.organization)
    const uploader = relationId(row.uploadedBy)
    if (organizationId == null || uploader == null) continue
    if (!(await opts.isParticipant(uploader, organizationId))) continue
    report.matched += 1
    report.ids.push(id)
    log(`doc ${id}: participant documento published ungated in eco-${String(organizationId)}`)
    if (!opts.apply) continue

    try {
      // 1. Out of the shared corpus FIRST.
      await retireFrom(opts.clientFor(organizationId), publishedCorpus(organizationId), row.id as Id, opts.now ?? new Date())

      // 2. Filed gated, as a draft — guarded, so a row that changed meanwhile is left alone.
      const res = (await payload.update({
        collection: 'documents',
        where: {
          and: [
            { id: { equals: row.id } },
            { publicationStatus: { equals: 'published' } },
            { or: [{ anonymise: { equals: false } }, { anonymise: { exists: false } }] },
          ],
        },
        data: {
          anonymise: true,
          publicationStatus: 'draft',
          publicationError: null,
          publishIngestId: null,
          anonymisationStatus: 'n/a',
          anonymisationError: null,
          redactedText: null,
          heldText: null,
          anonymisationSurvivors: null,
          testimonioTitle: null,
          ingestId: null,
          ingestStatus: 'extracting',
          ingestError: null,
        },
        depth: 0,
        overrideAccess: true,
        context: { __skipDocsExtract: true },
      } as never)) as unknown as { docs?: Row[] }
      const updated = res?.docs?.[0]
      if (!updated) {
        log(`doc ${id}: changed since it was read — left alone`)
        continue
      }

      // 3. Through the gate.
      const text = updated.extractedText
      if (typeof text !== 'string' || text.trim() === '') {
        report.withdrawnOnly.push(id)
        log(`doc ${id}: no extracted text — withdrawn, left a private gated draft`)
        continue
      }
      await opts.gate(updated)
      report.regated += 1
      log(`doc ${id}: withdrawn and sent through the gate`)
    } catch (err) {
      report.failed.push(id)
      log(`doc ${id}: NOT processed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return report
}
