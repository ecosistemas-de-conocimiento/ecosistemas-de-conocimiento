/**
 * ONE DOCUMENT'S GRAPH, PURGED AND REBUILT (P-02, audit 2026-11-10).
 *
 * 🔴 WHY THIS EXISTS. A switch change (`lib/anonymisationControls.ts`,
 * `lib/regateDocumentsById.ts`) sends a document through the gate again and
 * re-ingests it through `enqueueIngestForDoc`, which never touches the graph.
 * The mentions and relations built from the OLD text (say a cited author the
 * switch kept visible) stayed, with `graphStatus` still `ready` and a current
 * `graphPromptVersion`, so not even the backfill would look at them again.
 *
 * The re-gate therefore calls, in this order:
 *   1. {@link purgeDocumentGraph} next to the corpus erase, before the reset:
 *      the rows and the entities only this document named go, and the row is
 *      stamped so the backfill would rebuild it if nothing else does.
 *   2. {@link rebuildDocumentGraph} after the gate has persisted the new
 *      `redactedText`: the normal live path (`scheduleGraphExtractionForDoc`
 *      → `lib/graph/schedule.ts`). It re-extracts unconditionally; nothing in
 *      that path checks a "done before" stamp. A gate that held the row ends
 *      as `skipped` (`markNotGraphable`) with no rows.
 *
 * ⚠ WHAT A PURGE CANNOT TAKE BACK: a surface form this document appended to
 * the `aliases` of an entity OTHER documents also name. Aliases carry no
 * provenance (`writer.ts` rule 1), so there is nothing to tell which document
 * added which one.
 */
import type { Payload } from 'payload'

import { updateDocumentColumns, type DocumentColumnsPayload } from '@/lib/documentColumns'

import { ORPHAN_GRACE_MS, isEntityReferenced, type GraphBackfillPayload } from './backfill'
import { pruneSeedsIfEnabled, wikiLinkSeedingEnabled } from './schedule'

type Id = number | string

/** The Payload surface a purge needs. Structural, so a unit test needs no instance. */
export type DocumentGraphPayload = GraphBackfillPayload & DocumentColumnsPayload

const relationId = (raw: unknown): Id | null => {
  if (typeof raw === 'string' || typeof raw === 'number') return raw
  if (raw && typeof raw === 'object' && 'id' in raw) return relationId((raw as { id: unknown }).id)
  return null
}

/** Payload's bulk delete reports per-row failures in `errors` instead of throwing. */
function deletedCount(result: unknown, what: string): number {
  const r = (result ?? {}) as { docs?: unknown[]; errors?: unknown[] }
  if (Array.isArray(r.errors) && r.errors.length > 0) {
    throw new Error(`purgeDocumentGraph: ${r.errors.length} ${what} could not be deleted`)
  }
  return Array.isArray(r.docs) ? r.docs.length : 0
}

/** Borra todas las filas del grafo (menciones/aristas/lo que sea por documento) de este documento. Idempotente. Lanza si falla. */
export async function purgeDocumentGraph(payload: Payload, documentId: number | string): Promise<{ removed: number }> {
  const p = payload as unknown as DocumentGraphPayload
  const found = await p.find({
    collection: 'documents',
    where: { id: { equals: documentId } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  const row = found?.docs?.[0] as { organization?: unknown } | undefined
  // No row: its graph rows went with it (ON DELETE cascade). The orphaned
  // entities are the janitor's (`orphanJanitor.ts`).
  if (!row) return { removed: 0 }
  const organizationId = relationId(row.organization)
  // Graph rows always carry their document's ecosistema; none, none to scope to.
  if (organizationId == null) return { removed: 0 }

  // 🔴 Tenancy named explicitly, as in every other graph query.
  const org = { organization: { equals: organizationId } }
  const where = { and: [org, { document: { equals: documentId } }] }

  // The entities this document names, read BEFORE its rows go: afterwards
  // nothing says which entities were its own.
  const named = new Map<string, Id>()
  const mentions = (await p.find({ collection: 'graphMentions', where, limit: 0, depth: 0, overrideAccess: true }))
    ?.docs as { entity?: unknown }[] | undefined
  for (const m of mentions ?? []) {
    const id = relationId(m.entity)
    if (id != null) named.set(String(id), id)
  }
  const relations = (await p.find({ collection: 'graphRelations', where, limit: 0, depth: 0, overrideAccess: true }))
    ?.docs as { fromEntity?: unknown; toEntity?: unknown }[] | undefined
  for (const r of relations ?? []) {
    for (const end of [r.fromEntity, r.toEntity]) {
      const id = relationId(end)
      if (id != null) named.set(String(id), id)
    }
  }

  let removed = 0
  removed += deletedCount(await p.delete({ collection: 'graphMentions', where, overrideAccess: true }), 'mentions')
  removed += deletedCount(await p.delete({ collection: 'graphRelations', where, overrideAccess: true }), 'relations')
  // This document's mentions may have been the last ones keeping another
  // note's wikilink seeds alive. Never throws.
  await pruneSeedsIfEnabled(p, organizationId)

  // The entities only this document named: label and aliases are the very
  // names the re-gate removes. ⚠ The orphan sweep's grace period applies
  // here too: an entity written in the last minutes may be another document's
  // in-flight reuse, and deleting it would cascade that document's new
  // mention. One spared now is the daily janitor's.
  const cutoff = Date.now() - ORPHAN_GRACE_MS
  for (const entityId of named.values()) {
    if (await isEntityReferenced(p, organizationId, entityId)) continue
    const entity = (
      await p.find({
        collection: 'graphEntities',
        where: { and: [org, { id: { equals: entityId } }] },
        limit: 1,
        depth: 0,
        overrideAccess: true,
      })
    )?.docs?.[0] as { createdAt?: unknown; updatedAt?: unknown } | undefined
    if (!entity) continue
    const recent = [entity.createdAt, entity.updatedAt].some((at) => {
      const t = typeof at === 'string' ? Date.parse(at) : Number.NaN
      return Number.isFinite(t) && t > cutoff
    })
    if (recent) continue
    removed += deletedCount(
      await p.delete({ collection: 'graphEntities', where: { and: [org, { id: { equals: entityId } }] }, overrideAccess: true }),
      'entities',
    )
  }

  // 🔴 NOT `ready` ANY MORE, and findable. A NULL `graphPromptVersion` is the
  // backfill's "never extracted" clause, so a rebuild that never comes (the
  // re-gate's reset lost a race, the process died) is still recoverable.
  await updateDocumentColumns(p, {
    id: documentId,
    data: {
      graphStatus: 'pending',
      graphError: null,
      graphPromptVersion: null,
      graphExtractedAt: null,
      ...(wikiLinkSeedingEnabled(organizationId) ? { wikiLinks: null } : {}),
    },
  })

  return { removed }
}

/**
 * Re-extract one document's graph through the normal live path, after the
 * gate has run. Fire-and-forget like every graph run: it never throws, and a
 * row the gate did not clear ends `skipped` with no rows.
 */
export async function rebuildDocumentGraph(payload: Payload, documentId: number | string): Promise<void> {
  try {
    const found = await payload.find({
      collection: 'documents',
      where: { id: { equals: documentId } },
      limit: 1,
      depth: 0,
      overrideAccess: true,
    })
    const row = found?.docs?.[0] as { organization?: unknown; name?: unknown; contentKind?: unknown } | undefined
    const organizationId = relationId(row?.organization)
    if (!row || organizationId == null) return
    const { scheduleGraphExtractionForDoc } = await import('@/collections/Documents')
    await scheduleGraphExtractionForDoc({
      payload,
      docId: documentId,
      organizationId,
      fresh: {
        name: typeof row.name === 'string' ? row.name : '',
        contentKind: (typeof row.contentKind === 'string' ? row.contentKind : null) as never,
      },
    })
  } catch (err) {
    const { errSummary } = await import('@/lib/errorSummary')
    console.error('[graph] could not schedule the rebuild of doc', documentId, errSummary(err))
  }
}
