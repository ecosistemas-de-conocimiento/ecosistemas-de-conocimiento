/**
 * CORPUS-WIDE RE-EXTRACTION, AND ORPHAN CLEANUP.
 * `plan/adr-corpus-graph.md` §5.5, §10.
 *
 *     payload run src/lib/graph/backfill.cli.ts
 *     GRAPH_BACKFILL_LIMIT=20 payload run src/lib/graph/backfill.cli.ts
 *     GRAPH_BACKFILL_DRY_RUN=1 payload run src/lib/graph/backfill.cli.ts
 *
 * ⚠ THE CLI ENTRY IS `backfill.cli.ts`, NOT THIS FILE, and the split is not
 * cosmetic. `payload run` calls `process.exit(0)` as soon as the dynamic
 * `import()` RESOLVES, so a runnable script has to use TOP-LEVEL AWAIT — which
 * means it must be a file nothing else imports. `src/seed/demo.cli.ts` carries
 * the full write-up of both defects that made a self-executing module silently
 * do nothing and still exit 0.
 *
 * ── 🔴 THIS COSTS REAL MONEY ───────────────────────────────────────────────
 *
 * Every document it picks up is `GRAPH_EXTRACT_MAX_WINDOWS` inference calls at
 * the `deep` tier. Re-running a whole corpus is a DELIBERATE OPERATION, not a
 * deploy-time one, and it changes what the graph view shows. `GRAPH_BACKFILL_LIMIT`
 * exists so the first run can be small.
 *
 * ── What it selects ────────────────────────────────────────────────────────
 *
 *   · `graphPromptVersion` ≠ the current {@link GRAPH_PROMPT_VERSION} — the
 *     stamp is what makes stale rows FINDABLE after a prompt change. Includes
 *     rows that were never extracted (the column is NULL).
 *   · `graphStatus = 'failed'` — a lost run or a transient ai-service error.
 *
 * ⚠ `skipped` rows are NOT re-run when their stamp is current: they were skipped
 * because the document has no usable text, and that does not change by itself.
 *
 * ✅ A document extraction was never even SCHEDULED for — the ingest hook threw
 * before reaching the trigger, or the process died between the two — is caught
 * too: its `graphPromptVersion` is NULL, which matches `{ exists: false }`. That
 * is the only recovery path for it, so it is worth knowing that it works.
 *
 * ── Orphan cleanup ─────────────────────────────────────────────────────────
 *
 * Entities with zero mentions are deleted AT THE END, never per document
 * (ADR §5.5). Doing it per document would let a mid-flight re-extraction delete
 * an entity another document still uses, in the window between its mentions
 * being deleted and being written back.
 */

import { runGraphExtraction, type GraphSchedulerPayload } from './schedule'
import { GRAPH_PROMPT_VERSION } from './prompt'

/** The Payload surface the backfill needs, structurally. */
export type GraphBackfillPayload = GraphSchedulerPayload & {
  find(args: Record<string, unknown>): Promise<{ docs: unknown[]; totalDocs?: number }>
  delete(args: Record<string, unknown>): Promise<unknown>
}

export interface BackfillOptions {
  /** Stop after this many documents. `0` / omitted means no limit. */
  limit?: number
  /** Only this ecosistema. Omitted means every ecosistema. */
  organizationId?: string | number
  /** Report what would run, extract nothing, delete nothing. */
  dryRun?: boolean
  /** Skip the orphan sweep (useful when running the backfill in slices). */
  skipOrphanSweep?: boolean
  log?: (message: string) => void
}

export interface BackfillResult {
  candidates: number
  extracted: number
  failed: number
  skipped: number
  orphansDeleted: number
  dryRun: boolean
}

interface DocRow {
  id: number | string
  name?: unknown
  organization?: unknown
  contentKind?: unknown
  extractedText?: unknown
  graphStatus?: unknown
  graphPromptVersion?: unknown
}

const relationId = (raw: unknown): string | number | null => {
  if (typeof raw === 'string' || typeof raw === 'number') return raw
  if (raw && typeof raw === 'object' && 'id' in raw) {
    return relationId((raw as { id: unknown }).id)
  }
  return null
}

/**
 * Documents whose graph is stale or broken.
 *
 * 🔴 `organization` is an explicit predicate when one is asked for, exactly like
 * every other graph query. Access control plays no part: this runs with
 * `overrideAccess: true` and there is no user.
 */
export function staleDocumentsWhere(organizationId?: string | number): Record<string, unknown> {
  const stale = {
    or: [
      { graphPromptVersion: { not_equals: GRAPH_PROMPT_VERSION } },
      { graphPromptVersion: { exists: false } },
      { graphStatus: { equals: 'failed' } },
    ],
  }
  // Nothing to extract from an empty row, and asking the model about one costs
  // the same as asking it about a real document.
  const hasText = { extractedText: { exists: true } }

  return organizationId == null
    ? { and: [stale, hasText] }
    : { and: [{ organization: { equals: organizationId } }, stale, hasText] }
}

/**
 * Re-extract every stale document, then sweep orphan entities.
 *
 * ⚠ SEQUENTIAL, ON PURPOSE. Concurrency here would multiply the ai-service spend
 * rate by the fan-out and would make the entity upsert race with itself on every
 * shared node. The UNIQUE index would hold, but the retry traffic would be
 * pointless. Hundreds of documents at a few seconds each is minutes, unattended.
 */
export async function runGraphBackfill(
  payload: GraphBackfillPayload,
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const log = options.log ?? ((m: string) => console.log(m))
  const limit = options.limit && options.limit > 0 ? options.limit : 0
  const dryRun = options.dryRun === true

  const found = await payload.find({
    collection: 'documents',
    where: staleDocumentsWhere(options.organizationId),
    limit: limit || 0,
    depth: 0,
    overrideAccess: true,
    sort: 'id',
  })

  const docs = (found?.docs ?? []) as DocRow[]
  /**
   * Every ecosistema this run touched. The orphan sweep is driven from this set
   * rather than from "all entities", so no query in the backfill is ever
   * unbounded across tenants (ADR §6).
   */
  const touchedOrganizations = new Set<string>()
  const organizationById = new Map<string, string | number>()
  const result: BackfillResult = {
    candidates: docs.length,
    extracted: 0,
    failed: 0,
    skipped: 0,
    orphansDeleted: 0,
    dryRun,
  }

  log(
    `[graph-backfill] ${docs.length} documento(s) por re-extraer ` +
      `(prompt actual: ${GRAPH_PROMPT_VERSION})${dryRun ? ' — SIMULACIÓN' : ''}`,
  )

  for (const doc of docs) {
    const organizationId = relationId(doc.organization)
    if (organizationId == null) {
      // No ecosistema means no tenant to scope the rows to. Refuse rather than
      // guess — a guessed organization is a cross-tenant write.
      log(`[graph-backfill] doc ${doc.id} no tiene ecosistema — omitido`)
      result.skipped++
      continue
    }

    touchedOrganizations.add(String(organizationId))
    organizationById.set(String(organizationId), organizationId)

    if (dryRun) {
      log(
        `[graph-backfill] (simulación) doc ${doc.id} ` +
          `estado=${String(doc.graphStatus ?? 'n/a')} versión=${String(doc.graphPromptVersion ?? '—')}`,
      )
      result.skipped++
      continue
    }

    const status = await runGraphExtraction({
      payload,
      docId: doc.id,
      organizationId,
      // 🔴 The column, verbatim. No default is applied here: `personaAllowed`
      // fails closed on an unexpected value, which is the safe direction.
      contentKind: typeof doc.contentKind === 'string' ? doc.contentKind : null,
      text: typeof doc.extractedText === 'string' ? doc.extractedText : '',
      title: typeof doc.name === 'string' ? doc.name : null,
    })

    if (status === 'ready') result.extracted++
    else if (status === 'failed') result.failed++
    else result.skipped++
  }

  if (!options.skipOrphanSweep && !dryRun) {
    // 🔴 ONE ECOSISTEMA AT A TIME, always. When `--org` was given that is the
    // only one; otherwise it is the set this run actually touched. Either way
    // no query here is unbounded across tenants.
    const sweepTargets =
      options.organizationId != null
        ? [options.organizationId]
        : [...touchedOrganizations].map((k) => organizationById.get(k)!)

    for (const org of sweepTargets) {
      result.orphansDeleted += await deleteOrphanEntities(payload, org, log)
    }
  }

  log(
    `[graph-backfill] listo: ${result.extracted} extraídos, ` +
      `${result.failed} fallidos, ${result.skipped} omitidos, ` +
      `${result.orphansDeleted} nodos huérfanos borrados`,
  )

  return result
}

/**
 * 🔴 HOW YOUNG AN ENTITY IS PROTECTED FROM THE SWEEP.
 *
 * `writeGraphForDocument` upserts entities OUTSIDE its transaction and inserts
 * mentions INSIDE it (`writer.ts`, deliberately — entities are shared across
 * documents). Between those two moments a freshly created entity is committed,
 * visible, and has zero mentions. It looks exactly like an orphan.
 *
 * ADR §5.5 argues that sweeping at the END of a backfill makes that window
 * harmless. It does not, quite: the window belongs to the WRITER, so a
 * concurrent upload can be sitting in it while the sweep runs. Deleting then
 * makes the other document's mention insert fail on the foreign key and marks
 * that document `failed`.
 *
 * A 15-minute grace period closes it without a lock. It is generously longer
 * than any single write can take, and the cost of being wrong is only that a
 * genuine orphan survives until the next sweep — which is nothing.
 */
export const ORPHAN_GRACE_MS = 15 * 60 * 1000

/**
 * Delete entities nothing references any more, within ONE ecosistema.
 *
 * ⚠ RUN AT THE END OF A BACKFILL, NEVER PER DOCUMENT. Between a document's
 * mentions being deleted and its new ones being written, an entity can
 * momentarily have zero mentions while the same document is about to reference
 * it again. Sweeping at the end is what keeps that window harmless (ADR §5.5),
 * and {@link ORPHAN_GRACE_MS} covers the one the ADR missed.
 *
 * 🔴 `organizationId` IS REQUIRED. It used to be optional, and omitting it made
 * this read and DELETE across every ecosistema — an unbounded `organization_id`
 * query, which ADR §6 says does not exist anywhere in this design, including
 * the internal paths. `runGraphBackfill` now sweeps one ecosistema at a time.
 *
 * ⚠ An entity is an orphan only if NEITHER a mention NOR a relation names it.
 * Checking mentions alone would delete a node an edge still points at, and the
 * foreign key would then take the edge with it (ON DELETE cascade).
 */
export async function deleteOrphanEntities(
  payload: GraphBackfillPayload,
  organizationId: string | number,
  log: (message: string) => void = () => undefined,
): Promise<number> {
  const entities = (await payload.find({
    collection: 'graphEntities',
    // 🔴 Tenancy named explicitly, and mandatory.
    where: { organization: { equals: organizationId } },
    limit: 0,
    depth: 0,
    overrideAccess: true,
  })) as { docs: { id: number | string; createdAt?: unknown }[] }

  const cutoff = Date.now() - ORPHAN_GRACE_MS
  let deleted = 0

  for (const entity of entities?.docs ?? []) {
    // Skip anything a concurrent write may still be finishing. See the grace
    // period's note above.
    const createdAt =
      typeof entity.createdAt === 'string' ? Date.parse(entity.createdAt) : Number.NaN
    if (Number.isFinite(createdAt) && createdAt > cutoff) continue

    const referenced = await isReferenced(payload, organizationId, entity.id)
    if (referenced) continue

    try {
      await payload.delete({
        collection: 'graphEntities',
        id: entity.id,
        overrideAccess: true,
      })
      deleted++
    } catch (err) {
      // ⚠ One failed delete must not abort the sweep. A row that lost a race
      // and gained a mention a millisecond ago is exactly the case, and it is
      // the right outcome: keep the node, keep going.
      log(`[graph-backfill] no se pudo borrar el nodo ${entity.id}: ${String(err)}`)
    }
  }

  if (deleted > 0) log(`[graph-backfill] ${deleted} nodo(s) huérfano(s) borrados`)
  return deleted
}

/** Does any mention or any relation in this ecosistema name this entity? */
async function isReferenced(
  payload: GraphBackfillPayload,
  organizationId: string | number,
  entityId: number | string,
): Promise<boolean> {
  const org = { organization: { equals: organizationId } }

  const mentions = (await payload.find({
    collection: 'graphMentions',
    // 🔴 Tenancy named explicitly even though `entity` alone would find the
    // rows. Every graph query carries its own organization predicate.
    where: { and: [org, { entity: { equals: entityId } }] },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })) as { docs: unknown[] }
  if ((mentions?.docs ?? []).length > 0) return true

  const relations = (await payload.find({
    collection: 'graphRelations',
    where: {
      and: [
        org,
        { or: [{ fromEntity: { equals: entityId } }, { toEntity: { equals: entityId } }] },
      ],
    },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })) as { docs: unknown[] }
  return (relations?.docs ?? []).length > 0
}
