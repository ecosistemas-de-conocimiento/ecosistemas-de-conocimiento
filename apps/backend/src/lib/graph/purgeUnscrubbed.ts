/**
 * ONE-OFF CLEANUP: delete graph rows on gated documents that have no approved
 * redaction. Entry point: `scripts/purge-unscrubbed-graph-rows.ts`.
 *
 * 🔴 WHY THESE ROWS EXIST. Before the fix in `backfill.ts`, the backfill sent
 * `extractedText` to the extractor for every content kind. For a `testimonio`
 * whose review is held or pending that is the RAW transcript, so its mentions
 * and relations may name the people and places the gate exists to remove.
 *
 * "No approved redaction" is decided by `corpusTextFor`, the same helper the
 * corpus and the live graph path use. Mentions AND relations go: a relation
 * built from the same raw text leaks exactly as much.
 *
 * ⚠ It cannot tell a raw-text row from a clean one, and does not try. A
 * document that fails `corpusTextFor` today must not have a graph either way.
 */
import { corpusTextFor, rowMustPassGate } from '@/lib/anonymiseDocument'

import { deleteOrphanEntities, type GraphBackfillPayload } from './backfill'
import { clearGraphRows } from './schedule'

export type PurgePayload = GraphBackfillPayload & {
  count(args: Record<string, unknown>): Promise<{ totalDocs: number }>
}

export interface PurgeReport {
  apply: boolean
  /** Gated documents with no approved redaction. */
  unscrubbedDocuments: number
  /** Of those, how many carry any graph row. */
  documentsWithRows: number
  mentions: number
  relations: number
  orphansDeleted: number
}

interface Row {
  id: number | string
  organization?: unknown
  contentKind?: unknown
  anonymise?: unknown
  redactedText?: unknown
  anonymisationStatus?: unknown
}

const orgId = (raw: unknown): string | number | null => {
  if (typeof raw === 'string' || typeof raw === 'number') return raw
  if (raw && typeof raw === 'object' && 'id' in raw) return orgId((raw as { id: unknown }).id)
  return null
}

export async function purgeUnscrubbedGraphRows(
  payload: PurgePayload,
  options: { apply?: boolean; log?: (line: string) => void } = {},
): Promise<PurgeReport> {
  const apply = options.apply === true
  const log = options.log ?? ((line: string) => console.log(line))

  const found = await payload.find({
    collection: 'documents',
    limit: 0,
    depth: 0,
    overrideAccess: true,
    sort: 'id',
    select: { organization: true, contentKind: true, anonymise: true, redactedText: true, anonymisationStatus: true },
  })

  const unscrubbed = ((found?.docs ?? []) as Row[]).filter(
    (doc) => rowMustPassGate(doc) && !corpusTextFor(doc).ok,
  )

  const report: PurgeReport = {
    apply,
    unscrubbedDocuments: unscrubbed.length,
    documentsWithRows: 0,
    mentions: 0,
    relations: 0,
    orphansDeleted: 0,
  }
  const touched = new Map<string, string | number>()

  for (const doc of unscrubbed) {
    const organizationId = orgId(doc.organization)
    // 🔴 Every graph query names its tenant. Graph rows always carry one, so a
    // document with none has nothing this script can scope a delete to.
    if (organizationId == null) {
      log(`doc ${doc.id}: sin ecosistema — omitido`)
      continue
    }
    const where = {
      and: [{ organization: { equals: organizationId } }, { document: { equals: doc.id } }],
    }
    const mentions = (await payload.count({ collection: 'graphMentions', where, overrideAccess: true })).totalDocs
    const relations = (await payload.count({ collection: 'graphRelations', where, overrideAccess: true })).totalDocs
    if (mentions + relations === 0) continue

    report.documentsWithRows++
    report.mentions += mentions
    report.relations += relations
    log(
      `doc ${doc.id} (org ${organizationId}, ${String(doc.contentKind)}, ` +
        `${String(doc.anonymisationStatus ?? '—')}): ${mentions} menciones, ${relations} relaciones`,
    )

    if (!apply) continue
    await clearGraphRows(payload, doc.id, organizationId)
    await payload.update({
      collection: 'documents',
      id: doc.id,
      data: { graphStatus: 'skipped', graphError: 'not_graphable: no approved redaction' },
      overrideAccess: true,
      context: { __skipDocsExtract: true },
    })
    touched.set(String(organizationId), organizationId)
  }

  // Entities whose only mentions were the deleted rows still hold a raw name.
  // ⚠ The sweep's 15-minute grace period only spares entities CREATED recently.
  for (const organizationId of touched.values()) {
    report.orphansDeleted += await deleteOrphanEntities(payload, organizationId, log)
  }

  return report
}
