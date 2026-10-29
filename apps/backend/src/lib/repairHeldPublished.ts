/**
 * 🔴 ONE-OFF REPAIR: gated rows that are SHARED although the gate never cleared
 * them go back to held drafts, out of the ecosistema's corpus.
 *
 * Measured on dev, 2026-10-21 (runbook `infra/fleet/edc-1.md` §4p): 13
 * testimonios at `anonymisation_status = held` + `publication_status =
 * published`, indexed in the shared corpus (ids 28, 29, 41, 134, 163, 188, 191,
 * 208, 222, 223, 227, 238, 246). Cause: two seed ingests in one process gated
 * the same rows twice; see `GATE_CLAIM_GUARD` in `lib/anonymiseDocument.ts`.
 * The code paths are fixed; this cleans up the rows they left.
 *
 * What it selects: a gated row (`mustPassAnonymisationGate`) that
 * `corpusTextFor` refuses and whose `publicationStatus` is `published`,
 * `publishing` or `unpublishing`. Nothing else is read or touched.
 *
 * What `apply` does, per row, in this order:
 *
 *   1. Retire it from the ecosistema's SHARED corpus (`retireFrom`, the same
 *      primitive the unpublish move uses; a 404 counts as already retired), and
 *      from the uploader's draft corpus in case an earlier run put it there.
 *      🔴 The retire comes first: if it throws, the row is left as it was and
 *      the run says so, rather than reading `draft` while still searchable.
 *   2. One guarded write: `publicationStatus: 'draft'`, `ingestStatus:
 *      'failed'` with an `anonymisation_held` reason (what an ordinary held
 *      draft carries), publish fields cleared. The gate's columns are not
 *      touched, so the row stays `held` with its `heldText`.
 *   3. Once that write landed, ERASE both copies (`eraseWithdrawnCopies`,
 *      audit 2026-10-28): a retired copy is hidden, not gone. An approval
 *      re-enqueues the redacted text, so nothing needs the old copy.
 *
 * ── 🔴 THE REVISIÓN ROW ──────────────────────────────────────────────────────
 *
 * Revisión's queue IS `documents.anonymisation_status = 'held'`
 * (`listHeldDocuments` in `lib/holdReview.ts`, no publication filter). The
 * `anonymisation_reviews` table holds DECISIONS and gets a row only when a
 * reviewer approves or rejects — no undecided hold has one, by design, so there
 * is nothing to "create" there. What a hold needs to be reviewable is
 * `heldText`; the report lists any row without it (`unreviewable`) so a person
 * can reset it for a new gate run instead.
 *
 * ⚠ RUN IT WITH INGESTS QUIET. A `publishing`/`unpublishing` row with a
 * `publishIngestId` is mid-move and is skipped (`inFlight`), never retired
 * under a live ingest.
 *
 * ⚠ GRAPH MENTIONS are not touched here. The existing cleanup removes them:
 * `scripts/purge-unscrubbed-graph-rows.ts` deletes mentions and relations on
 * every gated row `corpusTextFor` refuses — a held row is one — and marks it
 * `graphStatus: skipped`. Run it after this script (dry run, then
 * `PURGE_APPLY=1`).
 *
 * ⚠ IDEMPOTENT: a repaired row is a draft, so it no longer matches. A second
 * run reports 0. ⚠ DRY RUN BY DEFAULT.
 */

import type { Payload } from 'payload'

import { corpusTextFor, rowMustPassGate } from './anonymiseDocument'
import { draftCorpus, publishedCorpus } from './corpus'
import { relationId } from './permissions'
import { eraseWithdrawnCopies, retireFrom, type CorpusDeleter } from './publishDocument'

const SHARED_STATES = ['published', 'publishing', 'unpublishing'] as const

interface Row {
  id?: number | string
  organization?: unknown
  uploadedBy?: unknown
  contentKind?: unknown
  anonymise?: unknown
  publicationStatus?: unknown
  anonymisationStatus?: unknown
  anonymisationError?: unknown
  redactedText?: unknown
  heldText?: unknown
  publishIngestId?: unknown
}

export interface RepairHeldPublishedReport {
  examined: number
  /** Gated, shared, and not cleared. */
  matched: number
  repaired: number
  ids: Array<number | string>
  /** Matched rows with no `heldText`: a reviewer would see nothing. */
  unreviewable: Array<number | string>
  /** Rows whose retire or write failed; left as they were. */
  failed: Array<number | string>
  /** Repaired rows whose erase failed in some corpus: retired, chunks still stored. */
  notErased: Array<number | string>
  /**
   * 🔴 Rows mid-move (`publishing`/`unpublishing` with a `publishIngestId`):
   * skipped. Retiring now and letting the ingest land afterwards would leave
   * live chunks in the shared corpus under a row that reads `draft`. The
   * callback (`confirmPublish`) now withdraws an uncleared row itself; run this
   * again once ingests are quiet if any stay listed.
   */
  inFlight: Array<number | string>
}

/** The selection rule, exported for the test. */
export function isSharedButNotCleared(row: Row): boolean {
  return (
    rowMustPassGate(row) &&
    (SHARED_STATES as readonly unknown[]).includes(row.publicationStatus) &&
    !corpusTextFor(row).ok
  )
}

export async function repairHeldPublished(
  payload: Pick<Payload, 'find' | 'update'>,
  opts: {
    apply: boolean
    /** Admin client for one ecosistema: retiring and erasing are admin routes. */
    clientFor: (organizationId: number | string) => CorpusDeleter
    limit?: number
    now?: Date
    log?: (line: string) => void
  },
): Promise<RepairHeldPublishedReport> {
  const log = opts.log ?? (() => undefined)
  const found = (await payload.find({
    collection: 'documents',
    where: { publicationStatus: { in: [...SHARED_STATES] } },
    limit: opts.limit ?? 1000,
    depth: 0,
    overrideAccess: true,
  })) as unknown as { docs?: Row[] }
  const rows = found.docs ?? []

  const report: RepairHeldPublishedReport = {
    examined: rows.length,
    matched: 0,
    repaired: 0,
    ids: [],
    unreviewable: [],
    failed: [],
    notErased: [],
    inFlight: [],
  }

  for (const row of rows) {
    if (row.id == null || !isSharedButNotCleared(row)) continue
    if (row.publicationStatus !== 'published' && typeof row.publishIngestId === 'string' && row.publishIngestId !== '') {
      report.inFlight.push(row.id)
      log(`doc ${row.id}: ${String(row.publicationStatus)} with an ingest in flight — skipped; run again when quiet`)
      continue
    }
    report.matched += 1
    report.ids.push(row.id)
    const reviewable = typeof row.heldText === 'string' && row.heldText.trim() !== ''
    if (!reviewable) report.unreviewable.push(row.id)
    const organizationId = relationId(row.organization)
    log(
      `doc ${row.id}: ${String(row.publicationStatus)} + ${String(row.anonymisationStatus)}` +
        ` in eco-${String(organizationId)}${reviewable ? '' : ' (no heldText: not reviewable)'}`,
    )
    if (!opts.apply) continue

    try {
      if (organizationId == null) throw new Error('no ecosistema on the row')
      const client = opts.clientFor(organizationId)
      const now = opts.now ?? new Date()
      // 1. Out of the shared corpus FIRST.
      await retireFrom(client, publishedCorpus(organizationId), row.id, now)
      const uploader = relationId(row.uploadedBy)
      if (uploader != null) await retireFrom(client, draftCorpus(organizationId, uploader), row.id, now)

      // 2. Back to a held draft — guarded, so a row that changed meanwhile is left alone.
      const reason = typeof row.anonymisationError === 'string' ? row.anonymisationError : 'held'
      const res = (await payload.update({
        collection: 'documents',
        where: {
          and: [
            { id: { equals: row.id } },
            { publicationStatus: { equals: row.publicationStatus as string } },
            { anonymisationStatus: { equals: row.anonymisationStatus as string } },
            // 🔴 And no move started since it was read.
            {
              publishIngestId:
                typeof row.publishIngestId === 'string' && row.publishIngestId !== ''
                  ? { equals: row.publishIngestId }
                  : { exists: false },
            },
          ],
        },
        data: {
          publicationStatus: 'draft',
          publicationError: null,
          publishIngestId: null,
          ingestStatus: 'failed',
          ingestError: `anonymisation_held: ${reason}`.slice(0, 500),
        },
        overrideAccess: true,
        context: { __skipDocsExtract: true },
      } as never)) as unknown as { docs?: unknown[] }
      if ((res?.docs?.length ?? 0) > 0) {
        report.repaired += 1
        // 3. 🔴 Erase both copies: the held text was never cleared (audit 2026-10-28).
        const { failed } = await eraseWithdrawnCopies(
          client,
          [publishedCorpus(organizationId), ...(uploader != null ? [draftCorpus(organizationId, uploader)] : [])],
          row.id,
        )
        if (failed.length > 0) {
          report.notErased.push(row.id)
          log(`doc ${row.id}: retired but NOT erased from ${failed.join(', ')}`)
        }
      } else log(`doc ${row.id}: changed since it was read — left alone`)
    } catch (err) {
      report.failed.push(row.id)
      log(`doc ${row.id}: NOT repaired: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return report
}
