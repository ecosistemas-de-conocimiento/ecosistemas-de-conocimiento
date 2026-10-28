/**
 * THE WRITER — an extraction becomes rows. `plan/adr-corpus-graph.md` §5.5.
 *
 * Three rules, and each one exists because of a specific failure:
 *
 *   1. ENTITIES ARE UPSERTED on `(organization, type, canonicalKey)` and SURVIVE
 *      re-extraction. New surface forms are appended to `aliases`. A re-run
 *      therefore finds the existing row instead of minting a duplicate node.
 *   2. MENTIONS AND RELATIONS ARE REPLACED WHOLESALE per document, in ONE
 *      transaction: delete everything this document said, then write what it
 *      says now. Same idea as ai-service's re-ingest of a stable `external_id`
 *      (`ingest.worker.ts:270`) — same failure mode, no new one to reason about.
 *   3. NOTHING IS KEYED ON `chunkId`. 🔴 `chunks.id` is a fresh uuid on every
 *      re-ingest. The graph's only link to content is `documents.id`, which is
 *      stable for the life of the document.
 *
 * ── 🔴 TENANCY IS NAMED IN EVERY WHERE CLAUSE ──────────────────────────────
 *
 * Every read and every delete below carries `organization: { equals: orgId }`
 * explicitly, and every write sets it. Access control is NOT a tenant filter
 * here: `visibleToCaller` returns bare `true` for a platform admin
 * (`collections/Documents.ts:86`), and these writes run with
 * `overrideAccess: true` anyway. `organization_id` is denormalised onto all
 * three tables for exactly this reason (ADR §4.1) — structural isolation beats
 * a filter predicate, because a predicate fails open the day someone forgets a
 * clause.
 *
 * ── 🔴 SNIPPETS AND TESTIMONIES ────────────────────────────────────────────
 *
 * `snippet` is written ONLY when `contentKind === 'documento'`, and is NULL for
 * everything else (ADR §7.3.4). A verbatim quotation from a testimony is the
 * most direct re-identification surface in the design. The check is here, at the
 * last possible moment, so no path into the table can bypass it.
 */

import type { sql as SqlTag } from '@payloadcms/db-postgres'

import { canonicalKey, mergeAliases } from './normalise'
import {
  SYMMETRIC_RELATION_TYPES,
  publicPersonaKept,
  snippetAllowed,
  type GraphEntityType,
  type GraphExtraction,
  type GraphRelationType,
} from './types'
import { seedKeys, splitStoredSeedEntities, type KnownSeedEntity, type WikiSeeds } from './wikilinks'

// ---------------------------------------------------------------------------
// The Payload surface this module needs
// ---------------------------------------------------------------------------

/**
 * Structural, not `Pick<Payload, …>`, so a unit test can hand in four functions
 * and an object instead of constructing a Payload instance and a postgres pool.
 * The code under test is then the code that runs.
 */
export interface GraphWriterPayload {
  find(args: Record<string, unknown>): Promise<{ docs: unknown[] }>
  create(args: Record<string, unknown>): Promise<unknown>
  update(args: Record<string, unknown>): Promise<unknown>
  delete(args: Record<string, unknown>): Promise<unknown>
  db: {
    beginTransaction?: (...args: unknown[]) => Promise<number | string | null>
    commitTransaction?: (id: number | string) => Promise<void>
    rollbackTransaction?: (id: number | string) => Promise<void>
  }
}

export interface WriteGraphArgs {
  payload: GraphWriterPayload
  docId: string | number
  organizationId: string | number
  /** 🔴 The privacy control, read from the column. Gates `snippet`. */
  contentKind: string | null | undefined
  extraction: GraphExtraction
}

export interface WriteGraphResult {
  entitiesUpserted: number
  mentions: number
  relations: number
  /** Edges whose endpoints did not resolve to a row, and were therefore dropped. */
  relationsDropped: number
}

interface EntityRow {
  id: number | string
  label?: unknown
  aliases?: unknown
  publicFigure?: unknown
}

// ---------------------------------------------------------------------------
// Symmetric-edge normalisation
// ---------------------------------------------------------------------------

/**
 * Put a symmetric edge's endpoints in a canonical order.
 *
 * ⚠ `relacionado_con` HAS NO DIRECTION, so A→B and B→A are the same fact. Left
 * as two rows they survive the `(document, from, to, type)` UNIQUE index — the
 * tuples genuinely differ — and the edge's support count comes out doubled.
 * That count is what `GRAPH_MIN_SUPPORT` gates on (ADR §7.3.3), so the
 * duplicate does not just inflate a number: it can push a support-1 edge past
 * a threshold designed to hide it.
 *
 * Ordered by id ascending, numerically when both ids are numbers, so the
 * ordering matches the database's own and does not depend on string collation.
 */
export function orderSymmetricEndpoints(
  from: number | string,
  to: number | string,
  type: GraphRelationType,
): { from: number | string; to: number | string } {
  if (!SYMMETRIC_RELATION_TYPES.has(type)) return { from, to }
  const a = typeof from === 'number' ? from : Number(from)
  const b = typeof to === 'number' ? to : Number(to)
  const ordered =
    Number.isFinite(a) && Number.isFinite(b) ? a <= b : String(from) <= String(to)
  return ordered ? { from, to } : { from: to, to: from }
}

// ---------------------------------------------------------------------------
// The write
// ---------------------------------------------------------------------------

/**
 * Replace one document's contribution to the graph.
 *
 * Entities are upserted OUTSIDE the transaction, deliberately: they are shared
 * across documents and are never deleted here, so holding them in the same
 * transaction as a per-document replace would serialise unrelated documents
 * against each other for no benefit. Orphan cleanup is the backfill's job
 * (ADR §5.5) precisely so a mid-flight re-extraction cannot delete an entity
 * another document still uses.
 */
export async function writeGraphForDocument(args: WriteGraphArgs): Promise<WriteGraphResult> {
  const { payload, docId, organizationId, contentKind, extraction } = args

  // 🔴 THE PERSON RULE, ONE LAST TIME, AT THE TABLE'S EDGE.
  //
  // ADR §5.3 requires two mechanisms and `extract.ts` implements both. This is a
  // third, and it exists because `snippet` is already gated here (below) and the
  // asymmetry would be invisible: anything that hands a cached or hand-built
  // extraction straight to this function — a replay, a future backfill variant,
  // a test fixture — would bypass the post-filter entirely while still being
  // caught by the snippet rule. Cheap, and it makes "no path into these tables
  // can write a person for a testimony" literally true rather than true of the
  // paths that exist today.
  //
  // 🔴 And since 2026-10-24 (owner: no private individuals in the graph), a
  // persona needs the public-figure mark too, whatever the content kind.
  const entities = extraction.entities.filter(
    (e) => e.type !== 'persona' || publicPersonaKept(contentKind, e.publicFigure),
  )

  // 1. Upsert entities. Not transactional — see the note above.
  //
  // ⚠ TWO MAPS, AND THEY ARE NOT INTERCHANGEABLE. Identity is
  // `(type, canonicalKey)`; a relation endpoint is only a LABEL, so it can be
  // resolved by canonical key alone. Using the canonical-key map for mentions
  // was a real bug: "Oaxaca" as a `lugar` and "Oaxaca" as an `organizacion` are
  // two entity rows, both would resolve to the FIRST one's id, and the second
  // `graphMentions` insert would violate `graph_mentions_document_entity_unq` —
  // rolling back the transaction and losing the whole document's graph.
  const idByTypeAndKey = new Map<string, number | string>()
  const idByCanonical = new Map<string, number | string>()
  let entitiesUpserted = 0

  for (const entity of entities) {
    const key = entity.canonicalKey || canonicalKey(entity.label)
    if (!key) continue
    const id = await upsertEntity({
      payload,
      organizationId,
      type: entity.type,
      canonicalKey: key,
      label: entity.label,
      aliases: entity.aliases,
      publicFigure: entity.type === 'persona' && entity.publicFigure === true,
    })
    if (id == null) continue
    entitiesUpserted++
    idByTypeAndKey.set(`${entity.type}::${key}`, id)
    // First type wins for a key two types share — the same rule `mergeWindows`
    // used to resolve relation endpoints, so the two cannot disagree.
    if (!idByCanonical.has(key)) idByCanonical.set(key, id)
  }

  // 2. Resolve relations against the ids we just have. 🔴 A dangling edge is
  //    worse than a missing one (ADR §5.4).
  const resolved: {
    from: number | string
    to: number | string
    type: GraphRelationType
  }[] = []
  let relationsDropped = 0
  const seenEdges = new Set<string>()

  for (const relation of extraction.relations) {
    const from = idByCanonical.get(relation.fromKey)
    const to = idByCanonical.get(relation.toKey)
    if (from == null || to == null || String(from) === String(to)) {
      relationsDropped++
      continue
    }
    const ends = orderSymmetricEndpoints(from, to, relation.type)
    // Collapses A-B and B-A for a symmetric type into one row, which is the
    // whole point of the ordering above.
    const edgeKey = `${ends.from}|${ends.to}|${relation.type}`
    if (seenEdges.has(edgeKey)) continue
    seenEdges.add(edgeKey)
    resolved.push({ from: ends.from, to: ends.to, type: relation.type })
  }

  // 3. Replace mentions and relations wholesale, in one transaction.
  const transactionID = (await payload.db.beginTransaction?.()) ?? null
  const req = transactionID == null ? undefined : { transactionID }

  try {
    // 🔴 Tenancy named explicitly, in its own predicate, on both deletes.
    const thisDocument = {
      and: [
        { organization: { equals: organizationId } },
        { document: { equals: docId } },
      ],
    }

    await payload.delete({
      collection: 'graphMentions',
      where: thisDocument,
      overrideAccess: true,
      ...(req ? { req } : {}),
    })
    await payload.delete({
      collection: 'graphRelations',
      where: thisDocument,
      overrideAccess: true,
      ...(req ? { req } : {}),
    })

    let mentions = 0
    for (const entity of entities) {
      // ⚠ BY `(type, canonicalKey)`, not by key alone. See the two-map note.
      const entityId = idByTypeAndKey.get(
        `${entity.type}::${entity.canonicalKey || canonicalKey(entity.label)}`,
      )
      if (entityId == null) continue
      await payload.create({
        collection: 'graphMentions',
        data: {
          organization: organizationId,
          document: docId,
          entity: entityId,
          occurrences: Math.max(1, Math.floor(entity.occurrences || 1)),
          // 🔴 THE LAST GATE ON THE SNIPPET. ADR §7.3.4.
          snippet: snippetAllowed(contentKind) ? (entity.snippet ?? null) : null,
          // 🔴 A seed-only mention never counts as "live" for another note's seed.
          seeded: entity.seeded === true,
        },
        overrideAccess: true,
        ...(req ? { req } : {}),
      })
      mentions++
    }

    for (const relation of resolved) {
      await payload.create({
        collection: 'graphRelations',
        data: {
          organization: organizationId,
          document: docId,
          fromEntity: relation.from,
          toEntity: relation.to,
          type: relation.type,
        },
        overrideAccess: true,
        ...(req ? { req } : {}),
      })
    }

    if (transactionID != null) await payload.db.commitTransaction?.(transactionID)

    return {
      entitiesUpserted,
      mentions,
      relations: resolved.length,
      relationsDropped,
    }
  } catch (err) {
    if (transactionID != null) {
      await payload.db.rollbackTransaction?.(transactionID).catch(() => undefined)
    }
    throw err
  }
}

/**
 * Find-or-create one entity on `(organization, type, canonicalKey)`.
 *
 * ⚠ A FIND-THEN-CREATE IS A CHECK, NOT A LOCK. Two concurrent extractions of
 * two documents naming the same entity both read "no row", both create, and one
 * loses to the compound UNIQUE index added by hand in the migration (ADR §4.2).
 * That loss is EXPECTED and is handled here: on a create failure we re-read, and
 * if the row now exists we adopt it. The index is what makes the race safe; this
 * catch is what makes it invisible.
 */
async function upsertEntity(args: {
  payload: GraphWriterPayload
  organizationId: string | number
  type: GraphEntityType
  canonicalKey: string
  label: string
  aliases: string[]
  /**
   * Only ever true here for a persona: a non-public one never reaches the
   * writer. An existing row is raised to true, never lowered — the mark means
   * "some documento named her as a public figure".
   */
  publicFigure: boolean
}): Promise<number | string | null> {
  const { payload, organizationId, type, canonicalKey: key, label, aliases, publicFigure } = args

  const where = {
    // 🔴 Tenancy first, always, in its own predicate.
    and: [
      { organization: { equals: organizationId } },
      { type: { equals: type } },
      { canonicalKey: { equals: key } },
    ],
  }

  const found = (await payload.find({
    collection: 'graphEntities',
    where,
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })) as { docs: EntityRow[] }

  const existing = found?.docs?.[0]
  if (existing) {
    const currentLabel = typeof existing.label === 'string' ? existing.label : label
    const currentAliases = Array.isArray(existing.aliases)
      ? (existing.aliases as unknown[]).filter((a): a is string => typeof a === 'string')
      : []
    // The surface form this document used joins the alias list unless it is
    // already the display label. The stored label is NOT overwritten: whichever
    // document named the entity first keeps naming it, so the graph view does
    // not rename nodes as unrelated documents are re-extracted.
    const nextAliases = mergeAliases(currentAliases, currentLabel, [...aliases, label])
    // ⚠ COMPARE CONTENTS, NOT LENGTH. A length check stops updating for good
    // once the list reaches `MAX_ALIASES`, and it also misses a same-length
    // list whose members changed.
    const aliasesChanged = nextAliases.join(' ') !== currentAliases.join(' ')
    const raisePublic = publicFigure && existing.publicFigure !== true
    if (aliasesChanged || raisePublic) {
      await payload.update({
        collection: 'graphEntities',
        id: existing.id,
        data: {
          ...(aliasesChanged ? { aliases: nextAliases } : {}),
          ...(raisePublic ? { publicFigure: true } : {}),
        },
        overrideAccess: true,
      })
    }
    return existing.id
  }

  try {
    const created = (await payload.create({
      collection: 'graphEntities',
      data: {
        organization: organizationId,
        type,
        label,
        canonicalKey: key,
        aliases: mergeAliases([], label, aliases),
        publicFigure,
      },
      overrideAccess: true,
    })) as { id?: number | string } | null
    return created?.id ?? null
  } catch (err) {
    // Lost the race against the UNIQUE index. Adopt the winner's row.
    const retry = (await payload.find({
      collection: 'graphEntities',
      where,
      limit: 1,
      depth: 0,
      overrideAccess: true,
    })) as { docs: EntityRow[] }
    const winner = retry?.docs?.[0]
    if (!winner) throw err
    // ⚠ Merge OUR surface forms into the winner's row too. Adopting the id and
    // walking away would silently drop this document's label — the one thing
    // the alias list exists to preserve.
    const winnerLabel = typeof winner.label === 'string' ? winner.label : label
    const winnerAliases = Array.isArray(winner.aliases)
      ? (winner.aliases as unknown[]).filter((a): a is string => typeof a === 'string')
      : []
    const merged = mergeAliases(winnerAliases, winnerLabel, [...aliases, label])
    const mergedChanged = merged.join(' ') !== winnerAliases.join(' ')
    const raiseWinner = publicFigure && winner.publicFigure !== true
    if (mergedChanged || raiseWinner) {
      await payload
        .update({
          collection: 'graphEntities',
          id: winner.id,
          data: {
            ...(mergedChanged ? { aliases: merged } : {}),
            ...(raiseWinner ? { publicFigure: true } : {}),
          },
          overrideAccess: true,
        })
        .catch(() => undefined)
    }
    return winner.id
  }
}

// ---------------------------------------------------------------------------
// Wikilink seeds: which stored nodes a seed may attach to
// ---------------------------------------------------------------------------

/** A drizzle SQL fragment. `@payloadcms/db-postgres` re-exports `sql` but not its type. */
type Sql = ReturnType<typeof SqlTag>

/** Structural: `payload.db.drizzle`, or a bare drizzle in a test. */
export interface SeedExecutor {
  execute(query: Sql): Promise<unknown>
}

const rowsOf = (result: unknown): Record<string, unknown>[] =>
  Array.isArray(result) ? result : ((result as { rows?: Record<string, unknown>[] })?.rows ?? [])

/**
 * 🔴 THE INGEST RUN'S LOOKUP — the one copy of the rule. Every stored node in
 * this ecosistema for the seed keys, with `mentionedElsewhere` = a MODEL-WRITTEN
 * mention (`seeded = false`) in ANOTHER document exists now, then split by
 * {@link splitStoredSeedEntities}.
 *
 *   · `document_id <> docId`: this note's own old mentions are not evidence.
 *     The lookup runs before the replace-all, so they are still there.
 *   · `seeded = false`: another note's SEED is not evidence either — two notes
 *     must not keep a once-mislabelled name alive for each other (AUDIT-C).
 *   · Entities are never deleted, so an orphan `tema` has no such mention.
 *
 * Tenancy in every WHERE.
 */
export async function findSeedEntities(
  db: SeedExecutor,
  organizationId: string | number,
  docId: string | number,
  seeds: WikiSeeds | null | undefined,
): Promise<{ personaKeys: string[]; known: KnownSeedEntity[] }> {
  const keys = seedKeys(seeds)
  const org = Number(organizationId)
  const doc = Number(docId)
  if (keys.length === 0 || !Number.isFinite(org) || !Number.isFinite(doc)) return { personaKeys: [], known: [] }
  // ⚠ LAZY: the postgres adapter is a heavy module, and most importers of
  // this file never seed.
  const { sql } = await import('@payloadcms/db-postgres')
  const keyList = sql.join(keys.map((k) => sql`${k}`), sql`, `)
  const rows = rowsOf(
    await db.execute(sql`
      SELECT e.type, e.label, e.canonical_key AS "canonicalKey",
             EXISTS (SELECT 1 FROM graph_mentions o
                      WHERE o.organization_id = ${org} AND o.entity_id = e.id
                        AND o.document_id <> ${doc} AND o.seeded = false) AS "mentionedElsewhere"
        FROM graph_entities e
       WHERE e.organization_id = ${org} AND e.canonical_key IN (${keyList})
       ORDER BY (e.type = 'tema') DESC, e.id`),
  ) as { type: unknown; label: unknown; canonicalKey: unknown; mentionedElsewhere: unknown }[]
  // 🔴 EVERY stored persona of the ecosistema, with its aliases — not only
  // the seed keys — so a surname or alias form blocks too ("Chomsky" against
  // a stored "Noam Chomsky"). Personas are public figures only, so this set
  // stays small.
  const personas = rowsOf(
    await db.execute(sql`
      SELECT e.canonical_key AS key, e.aliases FROM graph_entities e
       WHERE e.organization_id = ${org} AND e.type = 'persona'`),
  )
  const personaNames: string[] = []
  for (const p of personas) {
    if (typeof p.key === 'string') personaNames.push(p.key)
    if (Array.isArray(p.aliases)) for (const a of p.aliases) if (typeof a === 'string') personaNames.push(a)
  }
  const { personaKeys, known } = splitStoredSeedEntities(rows, personaNames)
  return { personaKeys, known: known.map(({ type, label, canonicalKey: key }) => ({ type, label, canonicalKey: key })) }
}

/**
 * 🔴 PRUNE SEEDS NOTHING MODEL-WRITTEN KEEPS ALIVE (audit 2026-10-28, item 1).
 *
 * Note A's model stops calling a name a `tema`; notes B and C hold SEEDED
 * mentions of that node and are not re-run. Without this they would keep it
 * on the graph forever. So after every graph write or clear in a seeding
 * ecosistema: delete each `seeded = true` mention whose node has no
 * `seeded = false` mention left, and the edges that touch that node in the
 * same document (a seed edge is title → link, so it dies with its seed).
 *
 * ONE statement (a data-modifying CTE), so it is atomic on its own. It runs
 * after the document's own transaction commits: Payload's transaction handle
 * is not reachable from raw SQL here. The read path's `seedGuard.ts` covers
 * the window. Tenancy in every WHERE. Returns the mentions deleted.
 */
export async function pruneDeadSeeds(db: SeedExecutor, organizationId: string | number): Promise<number> {
  const org = Number(organizationId)
  if (!Number.isFinite(org)) return 0
  const { sql } = await import('@payloadcms/db-postgres')
  const rows = rowsOf(
    await db.execute(sql`
      WITH dead AS (
        DELETE FROM graph_mentions m
         WHERE m.organization_id = ${org} AND m.seeded = true
           AND NOT EXISTS (SELECT 1 FROM graph_mentions o
                            WHERE o.organization_id = ${org} AND o.entity_id = m.entity_id AND o.seeded = false)
        RETURNING m.document_id, m.entity_id
      ), edges AS (
        DELETE FROM graph_relations r
         USING dead d
         WHERE r.organization_id = ${org} AND r.document_id = d.document_id
           AND (r.from_entity_id = d.entity_id OR r.to_entity_id = d.entity_id)
        RETURNING r.id
      )
      SELECT (SELECT count(*)::int FROM dead) AS mentions, (SELECT count(*)::int FROM edges) AS edges`),
  )
  return Number(rows[0]?.mentions ?? 0)
}
