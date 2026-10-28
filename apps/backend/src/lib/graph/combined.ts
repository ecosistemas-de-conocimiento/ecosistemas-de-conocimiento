/**
 * THE COMBINED GRAPH: SEVERAL ECOSISTEMAS ON ONE MAP (owner, 2026-10-21).
 *
 * "Todos mis ecosistemas": offered to anyone in 2+ ecosistemas, over ONLY the
 * ones they belong to (platform admins: all). The set of ecosistemas arrives
 * here as `organizationIds`, and 🔴 it is ALWAYS derived server-side from the
 * caller's memberships (`endpoints/graph.ts` `authoriseCombined`). Nothing in
 * this file accepts a list from a client.
 *
 * ── THE RULE: EVERY GATE PER SOURCE ECOSISTEMA, THEN MERGE ─────────────────
 *
 * Each per-ecosistema row is gated exactly as `queries.ts` gates a single
 * ecosistema, with the tenant predicate written PER ROW:
 *
 *   1. 🔴 `x.organization_id = ANY($ids)` on every graph table AND on
 *      `documents`, plus row-to-row equality (`d.organization_id =
 *      m.organization_id`, `m.organization_id = e.organization_id`), so a row
 *      of one ecosistema can never be joined to a row of another.
 *   2. 🔴 Published only, as a JOIN to `documents`.
 *   3. 🔴 Thresholds PER ECOSISTEMA: an entity enters the merge only from an
 *      ecosistema where it alone has ≥ `GRAPH_MIN_ENTITY_DOCS` documents; a
 *      relation pair only from an ecosistema where it alone has ≥
 *      `GRAPH_MIN_EDGE_DOCS`; a co-mention likewise. Summing first and
 *      thresholding after would let three below-threshold ecosistemas add up
 *      to a visible node, which is exactly what the threshold refuses.
 *   4. 🔴 Noise/placeholder/language labels (`notNoise`), and
 *   5. 🔴 No private `persona` (`publicPersonaOnly`) — per row, as in `queries.ts`:
 *      on every mention read, and on every relation read for either end.
 *   6. 🔴 Full-text search (#31) matches an entity only through its OWN
 *      ecosistema's published, corpus-cleared text (`buildSearchFilter`).
 *
 * ── THE MERGE ──────────────────────────────────────────────────────────────
 *
 * Entities merge by their identity, `(type, canonical_key)` — the same key the
 * writer's unique index uses inside one ecosistema. The merged node's id is the
 * LOWEST per-ecosistema entity id among its visible rows, so the id is stable
 * between the view, the search and the entity panel. Supports, edges and
 * co-mentions are SUMMED across ecosistemas (a document belongs to exactly one
 * ecosistema, so distinct-document counts add up without double counting).
 *
 * ⚠ `combined.pg.test.ts` checks the property that matters: the combined
 * answer equals the merge of the single-ecosistema answers `queries.ts` gives.
 * A gate dropped here shows up there as a difference.
 *
 * ⚠ NO SQL COMMENTS INSIDE THE STATEMENTS, for the same reason as `queries.ts`.
 */

import { sql } from '@payloadcms/db-postgres'

import {
  buildSearchFilter,
  clampLimit,
  flipDirection,
  graphMinEdgeDocs,
  graphMinSupport,
  intArray,
  mapDocumentRow,
  MAX_EDGE_DOCUMENTS,
  MAX_ENTITY_DOCUMENTS,
  MAX_NEIGHBOURS,
  MAX_VIEW_EDGES,
  MAX_VIEW_ENTITIES,
  notNoise,
  publicPersonaOnly,
  relationEndsPublicPersonaOnly,
  rowsOf,
  thresholdsOf,
  toCount,
  toDirection,
  toId,
  toText,
  type GraphDocumentRef,
  type GraphEdgeDirection,
  type GraphQueryPayload,
  type GraphSql,
  type GraphThresholds,
  type GraphViewEdge,
  type GraphViewEdgeKind,
  type GraphViewEntity,
  type Row,
} from './queries'
import { liveEdge, liveMention } from './seedGuard'
import type { GraphEntityType, GraphRelationType } from './types'

/** A merged node: the single-ecosistema shape plus where it comes from. */
export interface CombinedEntity extends GraphViewEntity {
  /** Included ecosistemas it appears in (above threshold there), ascending. */
  ecosystems: number[]
  /** Support per ecosistema, aligned with `ecosystems`. */
  ecosystemSupport: number[]
}

export interface CombinedView {
  entities: CombinedEntity[]
  hidden: number
  /** Merged nodes above the threshold before the cap; see `GraphEntityView.total`. */
  total: number
  minSupport: number
  minEdgeSupport: number
  publishedDocuments: number
  edges: GraphViewEdge[]
  /** The ecosistemas this answer covers, ascending. */
  ecosystems: number[]
}

export interface CombinedNeighbour {
  entity: GraphViewEntity
  relationType: GraphRelationType
  support: number
  pairSupport: number
  direction: GraphEdgeDirection
  documents: GraphDocumentRef[]
}

export interface CombinedEntityDetail {
  entity: CombinedEntity
  neighbours: CombinedNeighbour[]
  documents: GraphDocumentRef[]
}

/** Sanitised, de-duplicated, ascending. An empty list matches nothing. */
export function normaliseOrgIds(ids: readonly unknown[]): number[] {
  const out = new Set<number>()
  for (const raw of ids) {
    const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim())
    if (Number.isSafeInteger(n) && n > 0) out.add(n)
  }
  return [...out].sort((a, b) => a - b)
}

/**
 * 🔴 GATES 1 AND 2 FOR ONE MENTION OR RELATION ROW, PER ROW.
 *
 * `d` is joined to the row's OWN ecosistema, and that ecosistema must be
 * included. The single-ecosistema twin is `joinPublishedDocuments`. Gate 5
 * needs the entity, so callers add it: `publicPersonaOnly` on a mention
 * read, `relationEndsPublicPersonaOnly` on a relation read.
 */
function joinPublishedDocumentsPerRow(alias: 'm' | 'r', ids: GraphSql): GraphSql {
  const table = alias === 'm' ? sql`m` : sql`r`
  return sql`
    JOIN documents d
      ON d.id = ${table}.document_id
     AND d.organization_id = ${table}.organization_id
     AND d.organization_id = ANY(${ids})
     AND d.publication_status = 'published'${alias === 'm' ? liveMention('m', { anyOf: ids }) : liveEdge('r', { anyOf: ids })}`
}

interface MemberOpts {
  minSupport: number
  type?: GraphEntityType | null
  q?: string | null
}

/**
 * Two CTE bodies every combined statement starts from.
 *
 * `ent_all`: per (ecosistema, entity) support over published documents, with
 * gates 1, 2, 4 and 5 — NO threshold, so `hidden` can count what it removes.
 * `member`: the rows of `ent_all` at or above the threshold IN THEIR OWN
 * ecosistema, each carrying `node_id`, the merged node it belongs to.
 *
 * `matched` is the #31 search predicate (TRUE without a query). It is a column,
 * not a filter, so a search never changes which id a merged node gets.
 */
function memberCtes(ids: GraphSql, opts: MemberOpts): GraphSql {
  const typeFilter = opts.type ? sql` AND e.type = ${opts.type}` : sql``
  const search = buildSearchFilter(opts.q, { anyOf: ids })
  // Grouped by `e.id` (the primary key), so `e.*` may be read outside an aggregate.
  const matched = opts.q && opts.q.trim() !== '' ? sql`(TRUE${search})` : sql`TRUE`
  return sql`
    ent_all AS (
      SELECT e.organization_id AS org_id,
             e.id AS entity_id,
             e.type AS type,
             e.label AS label,
             e.canonical_key AS canonical_key,
             COUNT(DISTINCT m.document_id)::int AS support,
             SUM(m.occurrences)::int AS occurrences,
             ${matched} AS matched
      FROM graph_entities e
      JOIN graph_mentions m
        ON m.entity_id = e.id
       AND m.organization_id = e.organization_id
       AND m.organization_id = ANY(${ids})
      ${joinPublishedDocumentsPerRow('m', ids)}
      WHERE e.organization_id = ANY(${ids})${notNoise('e')}${publicPersonaOnly('e')}${typeFilter}
      GROUP BY e.organization_id, e.id, e.type, e.label, e.canonical_key
    ),
    member AS (
      SELECT a.org_id AS org_id,
             a.entity_id AS entity_id,
             a.type AS type,
             a.label AS label,
             a.canonical_key AS canonical_key,
             a.support AS support,
             a.occurrences AS occurrences,
             a.matched AS matched,
             MIN(a.entity_id) OVER (PARTITION BY a.type, a.canonical_key) AS node_id
      FROM ent_all a
      WHERE a.support >= ${opts.minSupport}
    ),
    merged AS (
      SELECT mb.node_id AS node_id,
             mb.type AS type,
             (ARRAY_AGG(mb.label ORDER BY mb.support DESC, mb.entity_id ASC))[1] AS label,
             SUM(mb.support)::int AS support,
             SUM(mb.occurrences)::int AS occurrences,
             ARRAY_AGG(mb.org_id ORDER BY mb.org_id) AS ecosystems,
             ARRAY_AGG(mb.support ORDER BY mb.org_id) AS ecosystem_support,
             BOOL_OR(mb.matched) AS matched
      FROM member mb
      GROUP BY mb.node_id, mb.type
    )`
}

function intList(value: unknown): number[] {
  if (Array.isArray(value)) return value.map(toCount)
  // A driver that does not parse `int[]` hands back `{1,2}`.
  if (typeof value === 'string') {
    return value.replace(/[{}]/g, '').split(',').filter((s) => s.trim() !== '').map(toCount)
  }
  return []
}

function combinedEntityOf(row: Row): CombinedEntity {
  return {
    id: toId(row.id),
    type: toText(row.type) as GraphEntityType,
    label: toText(row.label),
    support: toCount(row.support),
    ecosystems: intList(row.ecosystems),
    ecosystemSupport: intList(row.ecosystem_support),
  }
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export interface CombinedViewArgs {
  organizationIds: readonly number[]
  type?: GraphEntityType | null
  q?: string | null
  limit?: number
  minSupport?: number
  minEdgeSupport?: number
}

export function combinedEntityViewQuery(args: CombinedViewArgs): GraphSql {
  const ids = intArray(normaliseOrgIds(args.organizationIds))
  const minSupport = args.minSupport ?? graphMinSupport()
  const limit = clampLimit(args.limit, MAX_VIEW_ENTITIES, MAX_VIEW_ENTITIES)
  const searching = Boolean(args.q && args.q.trim() !== '')
  const visibleFilter = searching ? sql`WHERE mg.matched` : sql``
  const hiddenFilter = searching ? sql` AND BOOL_OR(a.matched)` : sql``
  return sql`
    WITH ${memberCtes(ids, { minSupport, type: args.type, q: args.q })},
    visible AS (
      SELECT mg.node_id AS id, mg.type AS type, mg.label AS label, mg.support AS support,
             mg.occurrences AS occurrences, mg.ecosystems AS ecosystems,
             mg.ecosystem_support AS ecosystem_support
      FROM merged mg
      ${visibleFilter}
      ORDER BY mg.support DESC, mg.occurrences DESC, mg.label ASC
      LIMIT ${limit}
    ),
    hidden AS (
      SELECT COUNT(*)::int AS n FROM (
        SELECT a.type, a.canonical_key
        FROM ent_all a
        GROUP BY a.type, a.canonical_key
        HAVING MAX(a.support) < ${minSupport}${hiddenFilter}
      ) below
    ),
    total AS (
      SELECT COUNT(*)::int AS n FROM merged mg ${visibleFilter}
    )
    SELECT v.id AS id, v.type AS type, v.label AS label, v.support AS support,
           v.ecosystems AS ecosystems, v.ecosystem_support AS ecosystem_support, h.n AS hidden,
           t.n AS total
    FROM hidden h
    CROSS JOIN total t
    LEFT JOIN visible v ON TRUE
    ORDER BY v.support DESC NULLS LAST, v.label ASC`
}

export function combinedPublishedCountQuery(organizationIds: readonly number[]): GraphSql {
  return sql`
    SELECT COUNT(*)::int AS n
    FROM documents d
    WHERE d.organization_id = ANY(${intArray(normaliseOrgIds(organizationIds))})
      AND d.publication_status = 'published'`
}

/**
 * Edges between merged nodes. Same shape and the same rules as
 * `viewEdgesQuery`, with each threshold applied inside one ecosistema before
 * the per-ecosistema counts are summed.
 */
export function combinedViewEdgesQuery(
  organizationIds: readonly number[],
  nodeIds: readonly number[],
  thresholds: number | GraphThresholds,
  limit = MAX_VIEW_EDGES,
): GraphSql {
  const t = thresholdsOf(thresholds)
  const ids = intArray(normaliseOrgIds(organizationIds))
  const nodes = intArray(nodeIds.map((id) => Math.trunc(Number(id))).filter((id) => Number.isFinite(id)))
  // ⚠ SHAPED FOR THE PLANNER, measured. Aggregated CTEs are estimated at 1–3
  // rows, so any JOIN between two of them becomes a nested loop: the first
  // version took 23 s on the local 4-ecosistema copy. Here every gated base
  // read is its own MATERIALIZED CTE joined only to `listed` by hash, distinct
  // counts per ecosistema come from window functions (no join back), and
  // relation and co-mention pairs are folded by UNION ALL + GROUP BY, not JOIN.
  return sql`
    WITH ${memberCtes(ids, { minSupport: t.entity })},
    listed AS MATERIALIZED (
      SELECT mb.org_id AS org_id, mb.entity_id AS entity_id, mb.node_id AS node_id
      FROM member mb
      WHERE mb.node_id = ANY(${nodes})
    ),
    rel_raw AS MATERIALIZED (
      SELECT r.organization_id AS org_id, r.from_entity_id AS from_entity, r.to_entity_id AS to_entity,
             r.type AS relation_type, r.document_id AS document_id
      FROM graph_relations r
      ${joinPublishedDocumentsPerRow('r', ids)}
      ${relationEndsPublicPersonaOnly()}
      WHERE r.organization_id = ANY(${ids})
    ),
    rel AS MATERIALIZED (
      SELECT rr.org_id AS org_id,
             LEAST(lf.node_id, lt.node_id) AS a,
             GREATEST(lf.node_id, lt.node_id) AS b,
             lf.node_id AS from_id,
             lt.org_id AS to_org,
             lf.org_id AS from_org,
             rr.relation_type AS relation_type,
             rr.document_id AS document_id
      FROM rel_raw rr
      JOIN listed lf ON lf.entity_id = rr.from_entity
      JOIN listed lt ON lt.entity_id = rr.to_entity
      WHERE lf.node_id <> lt.node_id
    ),
    rel_ranked AS (
      SELECT rel.*,
             DENSE_RANK() OVER (PARTITION BY rel.org_id, rel.a, rel.b ORDER BY rel.document_id) AS doc_rank
      FROM rel
      WHERE rel.from_org = rel.org_id AND rel.to_org = rel.org_id
    ),
    rel_counted AS (
      SELECT rr.*, MAX(rr.doc_rank) OVER (PARTITION BY rr.org_id, rr.a, rr.b) AS org_pair_docs
      FROM rel_ranked rr
    ),
    rel_kept AS MATERIALIZED (
      SELECT rc.a AS a, rc.b AS b, rc.from_id AS from_id, rc.relation_type AS relation_type,
             rc.document_id AS document_id
      FROM rel_counted rc
      WHERE rc.org_pair_docs >= ${t.edge}
    ),
    rel_types AS (
      SELECT rk.a AS a,
             rk.b AS b,
             rk.relation_type AS relation_type,
             COUNT(DISTINCT rk.document_id) AS n,
             CASE WHEN BOOL_AND(rk.from_id = rk.a) THEN 'out'
                  WHEN BOOL_AND(rk.from_id = rk.b) THEN 'in'
                  ELSE 'both' END AS direction
      FROM rel_kept rk
      GROUP BY rk.a, rk.b, rk.relation_type
    ),
    rel_pairs AS (
      SELECT rk.a AS a, rk.b AS b, COUNT(DISTINCT rk.document_id)::int AS support
      FROM rel_kept rk
      GROUP BY rk.a, rk.b
    ),
    rel_top AS (
      SELECT rt.a AS a, rt.b AS b,
             (ARRAY_AGG(rt.relation_type ORDER BY rt.n DESC, rt.relation_type ASC))[1] AS relation_type,
             (ARRAY_AGG(rt.direction ORDER BY rt.n DESC, rt.relation_type ASC))[1] AS direction
      FROM rel_types rt
      GROUP BY rt.a, rt.b
    ),
    ment_raw AS MATERIALIZED (
      SELECT DISTINCT m.organization_id AS org_id, m.document_id AS document_id, m.entity_id AS entity_id
      FROM graph_mentions m
      ${joinPublishedDocumentsPerRow('m', ids)}
      JOIN graph_entities ce
        ON ce.id = m.entity_id
       AND ce.organization_id = m.organization_id
      WHERE m.organization_id = ANY(${ids})${publicPersonaOnly('ce')}
    ),
    doc_nodes AS MATERIALIZED (
      SELECT mr.org_id AS org_id, mr.document_id AS document_id,
             ARRAY_AGG(DISTINCT l.node_id ORDER BY l.node_id) AS nodes
      FROM ment_raw mr
      JOIN listed l ON l.entity_id = mr.entity_id AND l.org_id = mr.org_id
      GROUP BY mr.org_id, mr.document_id
    ),
    co_org AS (
      SELECT dn.org_id AS org_id, x.node AS a, y.node AS b, COUNT(*)::int AS weight
      FROM doc_nodes dn
      CROSS JOIN LATERAL UNNEST(dn.nodes) WITH ORDINALITY AS x(node, i)
      CROSS JOIN LATERAL UNNEST(dn.nodes) WITH ORDINALITY AS y(node, j)
      WHERE y.j > x.i
      GROUP BY dn.org_id, x.node, y.node
    ),
    pairs AS (
      SELECT u.a AS a, u.b AS b,
             SUM(u.rel_support)::int AS rel_support,
             SUM(u.co_weight)::int AS co_weight,
             SUM(u.co_kept)::int AS co_kept,
             MAX(u.relation_type) AS relation_type,
             MAX(u.direction) AS direction
      FROM (
        SELECT rp.a AS a, rp.b AS b, rp.support AS rel_support, 0 AS co_weight, 0 AS co_kept,
               NULL::text AS relation_type, NULL::text AS direction
        FROM rel_pairs rp
        UNION ALL
        SELECT rt.a, rt.b, 0, 0, 0, rt.relation_type::text, rt.direction
        FROM rel_top rt
        UNION ALL
        SELECT co.a, co.b, 0, co.weight,
               CASE WHEN co.weight >= ${t.coMention} THEN co.weight ELSE 0 END, NULL, NULL
        FROM co_org co
      ) u
      GROUP BY u.a, u.b
    ),
    co_only AS (
      SELECT p.a AS a, p.b AS b, p.co_kept AS weight
      FROM pairs p
      WHERE p.rel_support = 0 AND p.co_kept > 0
    ),
    co_ends AS (
      SELECT co_only.a AS node, co_only.b AS other, co_only.a AS a, co_only.b AS b,
             co_only.weight AS weight
      FROM co_only
      UNION ALL
      SELECT co_only.b, co_only.a, co_only.a, co_only.b, co_only.weight
      FROM co_only
    ),
    co_ranked AS (
      SELECT co_ends.a AS a, co_ends.b AS b, co_ends.weight AS weight,
             ROW_NUMBER() OVER (
               PARTITION BY co_ends.node
               ORDER BY co_ends.weight DESC, co_ends.other ASC
             ) AS rn
      FROM co_ends
    ),
    co_kept AS (
      SELECT co_ranked.a AS a, co_ranked.b AS b, MAX(co_ranked.weight)::int AS weight
      FROM co_ranked
      WHERE co_ranked.rn <= ${t.topK}
      GROUP BY co_ranked.a, co_ranked.b
    ),
    out_edges AS (
      SELECT p.a AS from_id, p.b AS to_id, 'relation' AS kind, 0 AS kind_rank,
             p.rel_support AS support, p.co_weight AS co_mentions,
             p.relation_type AS relation_type, p.direction AS direction
      FROM pairs p
      WHERE p.rel_support > 0
      UNION ALL
      SELECT k.a, k.b, 'co-mention', 1, k.weight, k.weight, NULL, NULL
      FROM co_kept k
    )
    SELECT e.from_id AS from_id, e.to_id AS to_id, e.kind AS kind, e.support AS support,
           e.co_mentions AS co_mentions, e.relation_type AS relation_type,
           e.direction AS direction
    FROM out_edges e
    ORDER BY e.kind_rank ASC, e.support DESC, e.from_id ASC, e.to_id ASC
    LIMIT ${clampLimit(limit, MAX_VIEW_EDGES, MAX_VIEW_EDGES)}`
}

function edgesFromRows(rows: readonly Row[]): GraphViewEdge[] {
  const edges: GraphViewEdge[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const a = toId(row.from_id)
    const b = toId(row.to_id)
    if (!a || !b || a === b) continue
    const from = Math.min(a, b)
    const to = Math.max(a, b)
    const key = `${from}|${to}`
    if (seen.has(key)) continue
    seen.add(key)
    const kind: GraphViewEdgeKind = row.kind === 'relation' ? 'relation' : 'co-mention'
    const edge: GraphViewEdge = {
      from,
      to,
      kind,
      support: toCount(row.support),
      coMentions: toCount(row.co_mentions),
    }
    if (kind === 'relation') {
      edge.relationType = toText(row.relation_type) as GraphRelationType
      const direction = toDirection(row.direction)
      edge.direction = a === from ? direction : flipDirection(direction)
    }
    edges.push(edge)
  }
  return edges
}

export async function readCombinedView(
  payload: GraphQueryPayload,
  args: CombinedViewArgs,
): Promise<CombinedView> {
  const organizationIds = normaliseOrgIds(args.organizationIds)
  const minSupport = args.minSupport ?? graphMinSupport()
  const minEdgeSupport = args.minEdgeSupport ?? graphMinEdgeDocs()
  const [viewResult, countResult] = await Promise.all([
    payload.db.drizzle.execute(combinedEntityViewQuery({ ...args, organizationIds, minSupport })),
    payload.db.drizzle.execute(combinedPublishedCountQuery(organizationIds)),
  ])

  const entities: CombinedEntity[] = []
  let hidden = 0
  let total = 0
  for (const row of rowsOf(viewResult)) {
    hidden = toCount(row.hidden)
    total = toCount(row.total)
    if (row.id == null) continue
    entities.push(combinedEntityOf(row))
  }

  let edges: GraphViewEdge[] = []
  // A search answers ids only (`/grafo/buscar`); it needs no edges.
  const searching = Boolean(args.q && args.q.trim() !== '')
  if (entities.length > 0 && !searching) {
    edges = edgesFromRows(
      rowsOf(
        await payload.db.drizzle.execute(
          combinedViewEdgesQuery(
            organizationIds,
            entities.map((e) => e.id),
            { entity: minSupport, edge: minEdgeSupport },
          ),
        ),
      ),
    )
  }

  return {
    entities,
    hidden,
    total,
    minSupport,
    minEdgeSupport,
    publishedDocuments: toCount(rowsOf(countResult)[0]?.n),
    edges,
    ecosystems: organizationIds,
  }
}

// ---------------------------------------------------------------------------
// One merged node, one hop
// ---------------------------------------------------------------------------

export interface CombinedDetailArgs {
  organizationIds: readonly number[]
  /** Any visible per-ecosistema id of the node; the answer uses the node id. */
  entityId: number
  minSupport?: number
  minEdgeSupport?: number
  neighbourLimit?: number
  documentLimit?: number
  edgeDocumentLimit?: number
}

/**
 * The focal node's rows in every included ecosistema. The node is resolved
 * ONLY from a row that is itself visible (`member`), so an id below the
 * threshold, outside the included set, or noise finds nothing — one answer,
 * the same as `entityDetailQuery`.
 *
 * `member.node_id` already names the merged node (the lowest id in its
 * `(type, canonical_key)` partition), so the focal entity's own row carries the
 * node, and the node's rows are the `member` rows with that `node_id`.
 */
function focalNode(entityId: number): GraphSql {
  return sql`(SELECT fm.node_id FROM member fm WHERE fm.entity_id = ${entityId})`
}

/**
 * ⚠ SHAPED FOR THE PLANNER, measured (2026-10-28, local postgres:16, the audit's
 * org-6-sized fixture). Aggregated CTEs are estimated at ~1 row, so a JOIN
 * between two of them is planned as a nested loop over both. The old `focus` /
 * `focal` pair was a self-join of `member`, and the detail statement's
 * `merged … IN (SELECT … FROM focal)` re-ran it once per merged node: 4.6 s
 * for one hub entity on 482 nodes. Here the node is one scalar subquery
 * (planned once), `focal` is MATERIALIZED (it holds one row per ecosistema),
 * and the neighbour statements below read `node_attr` instead of re-joining
 * `merged`. `combined.test.ts` pins the shape; `combinedDetail.pg.test.ts`
 * times it.
 */
function focalCtes(ids: GraphSql, entityId: number, minSupport: number): GraphSql {
  return sql`${memberCtes(ids, { minSupport })},
    focal AS MATERIALIZED (
      SELECT mb.org_id AS org_id, mb.entity_id AS entity_id, mb.node_id AS node_id
      FROM member mb
      WHERE mb.node_id = ${focalNode(entityId)}
    )`
}

export function combinedEntityDetailQuery(args: CombinedDetailArgs): GraphSql {
  const ids = intArray(normaliseOrgIds(args.organizationIds))
  const minSupport = args.minSupport ?? graphMinSupport()
  return sql`
    WITH ${memberCtes(ids, { minSupport })}
    SELECT mg.node_id AS id, mg.type AS type, mg.label AS label, mg.support AS support,
           mg.ecosystems AS ecosystems, mg.ecosystem_support AS ecosystem_support
    FROM merged mg
    WHERE mg.node_id = ${focalNode(args.entityId)}`
}

/**
 * The relation rows touching the focal node, per ecosistema, kept only where
 * the PAIR passes the edge threshold in that ecosistema (`org_pair_docs`).
 * Shared by the neighbour list and the per-edge evidence, so the two agree.
 *
 * Each row carries its neighbour's MERGED label, support and type from
 * `node_attr` — the same values `merged` computes (`label` of the
 * best-supported row, lowest id on a tie; `support` summed), by window over
 * `member` instead of a GROUP BY that would have to be joined back.
 *
 * ⚠ NO JOIN BETWEEN DERIVED SETS except to `focal` (one row per ecosistema,
 * which is the right driver: an index probe of `graph_relations` per row).
 * The neighbour gate — the other end must be a visible `member` row of the
 * relation's own ecosistema — is a FOLD, not a JOIN: relation rows and
 * `node_attr` rows are stacked by UNION ALL and the node's columns spread over
 * `(org_id, entity_id)` by window; a relation row without a node row is
 * dropped. Measured: joining `node_attr` instead let the planner put
 * `focal × node_attr` (estimated 1 × 67, actually 899 rows) on the outside
 * and probe `graph_relations` 899 times, 2.0 s for a hub. Distinct document
 * counts are DENSE_RANK + MAX windows, as in `combinedViewEdgesQuery`.
 */
function focalRelationCtes(ids: GraphSql, minEdge: number): GraphSql {
  return sql`
    node_attr AS MATERIALIZED (
      SELECT mb.org_id AS org_id,
             mb.entity_id AS entity_id,
             mb.node_id AS node_id,
             mb.type AS node_type,
             FIRST_VALUE(mb.label) OVER (
               PARTITION BY mb.node_id ORDER BY mb.support DESC, mb.entity_id ASC
             ) AS node_label,
             (SUM(mb.support) OVER (PARTITION BY mb.node_id))::int AS node_support
      FROM member mb
    ),
    rel_raw AS MATERIALIZED (
      SELECT r.organization_id AS org_id,
             CASE WHEN r.from_entity_id = f.entity_id THEN r.to_entity_id
                  ELSE r.from_entity_id END AS other_id,
             f.node_id AS focal_node,
             r.type AS relation_type,
             r.document_id AS document_id,
             d.name AS name,
             d.content_kind AS content_kind,
             (r.from_entity_id = f.entity_id) AS is_out
      FROM graph_relations r
      ${joinPublishedDocumentsPerRow('r', ids)}
      ${relationEndsPublicPersonaOnly()}
      JOIN focal f
        ON f.org_id = r.organization_id
       AND (r.from_entity_id = f.entity_id OR r.to_entity_id = f.entity_id)
      WHERE r.organization_id = ANY(${ids})
    ),
    rel_folded AS (
      SELECT u.*,
             MAX(u.n_node_id) OVER (PARTITION BY u.org_id, u.entity_id) AS neighbour_id,
             MAX(u.n_type) OVER (PARTITION BY u.org_id, u.entity_id) AS node_type,
             MAX(u.n_label) OVER (PARTITION BY u.org_id, u.entity_id) AS node_label,
             MAX(u.n_support) OVER (PARTITION BY u.org_id, u.entity_id) AS node_support
      FROM (
        SELECT rr.org_id AS org_id, rr.other_id AS entity_id, TRUE AS is_rel,
               rr.focal_node AS focal_node, rr.relation_type AS relation_type,
               rr.document_id AS document_id, rr.name AS name, rr.content_kind AS content_kind,
               rr.is_out AS is_out,
               NULL::int AS n_node_id, NULL AS n_type, NULL::text AS n_label, NULL::int AS n_support
        FROM rel_raw rr
        UNION ALL
        SELECT na.org_id, na.entity_id, FALSE, NULL, NULL, NULL, NULL, NULL, NULL,
               na.node_id, na.node_type, na.node_label, na.node_support
        FROM node_attr na
      ) u
    ),
    rel AS MATERIALIZED (
      SELECT rf.org_id AS org_id, rf.neighbour_id AS neighbour_id, rf.node_type AS node_type,
             rf.node_label AS node_label, rf.node_support AS node_support,
             rf.relation_type AS relation_type, rf.document_id AS document_id,
             rf.name AS name, rf.content_kind AS content_kind, rf.is_out AS is_out
      FROM rel_folded rf
      WHERE rf.is_rel
        AND rf.neighbour_id IS NOT NULL
        AND rf.neighbour_id <> rf.focal_node
    ),
    rel_org_ranked AS (
      SELECT rel.*,
             DENSE_RANK() OVER (PARTITION BY rel.org_id, rel.neighbour_id ORDER BY rel.document_id) AS org_doc_rank
      FROM rel
    ),
    rel_org_counted AS (
      SELECT ror.*,
             MAX(ror.org_doc_rank) OVER (PARTITION BY ror.org_id, ror.neighbour_id) AS org_pair_docs
      FROM rel_org_ranked ror
    ),
    rel_kept AS MATERIALIZED (
      SELECT roc.org_id AS org_id, roc.neighbour_id AS neighbour_id, roc.node_type AS node_type,
             roc.node_label AS node_label, roc.node_support AS node_support,
             roc.relation_type AS relation_type, roc.document_id AS document_id,
             roc.name AS name, roc.content_kind AS content_kind, roc.is_out AS is_out
      FROM rel_org_counted roc
      WHERE roc.org_pair_docs >= ${minEdge}
    )`
}

/**
 * ⚠ `neighbour_id` closes the sort, so two neighbours with the same label and
 * the same counts always come out in the same order, and the LIMIT always cuts
 * at the same row.
 */
export function combinedNeighboursQuery(args: CombinedDetailArgs): GraphSql {
  const ids = intArray(normaliseOrgIds(args.organizationIds))
  const minSupport = args.minSupport ?? graphMinSupport()
  const minEdge = args.minEdgeSupport ?? graphMinEdgeDocs()
  const limit = clampLimit(args.neighbourLimit, MAX_NEIGHBOURS, MAX_NEIGHBOURS)
  return sql`
    WITH ${focalCtes(ids, args.entityId, minSupport)},
    ${focalRelationCtes(ids, minEdge)},
    pair_ranked AS (
      SELECT rk.*,
             DENSE_RANK() OVER (PARTITION BY rk.neighbour_id ORDER BY rk.document_id) AS pair_doc_rank
      FROM rel_kept rk
    ),
    pair_counted AS (
      SELECT pr.*,
             MAX(pr.pair_doc_rank) OVER (PARTITION BY pr.neighbour_id) AS pair_support
      FROM pair_ranked pr
    ),
    edges AS (
      SELECT pc.neighbour_id AS neighbour_id,
             pc.node_type AS node_type,
             pc.node_label AS node_label,
             pc.node_support AS node_support,
             pc.relation_type AS relation_type,
             COUNT(DISTINCT pc.document_id)::int AS support,
             MAX(pc.pair_support)::int AS pair_support,
             CASE WHEN BOOL_AND(pc.is_out) THEN 'out'
                  WHEN BOOL_AND(NOT pc.is_out) THEN 'in'
                  ELSE 'both' END AS direction
      FROM pair_counted pc
      GROUP BY pc.neighbour_id, pc.node_type, pc.node_label, pc.node_support, pc.relation_type
    )
    SELECT edges.neighbour_id AS id,
           edges.node_type AS type,
           edges.node_label AS label,
           edges.node_support AS support,
           edges.relation_type AS relation_type,
           edges.support AS edge_support,
           edges.pair_support AS pair_support,
           edges.direction AS direction
    FROM edges
    ORDER BY edges.pair_support DESC, edges.support DESC, edges.node_support DESC, edges.node_label ASC,
             edges.relation_type ASC, edges.neighbour_id ASC
    LIMIT ${limit}`
}

export function combinedEdgeDocumentsQuery(args: CombinedDetailArgs): GraphSql {
  const ids = intArray(normaliseOrgIds(args.organizationIds))
  const minSupport = args.minSupport ?? graphMinSupport()
  const minEdge = args.minEdgeSupport ?? graphMinEdgeDocs()
  const neighbourLimit = clampLimit(args.neighbourLimit, MAX_NEIGHBOURS, MAX_NEIGHBOURS)
  const perEdge = clampLimit(args.edgeDocumentLimit, MAX_EDGE_DOCUMENTS, MAX_EDGE_DOCUMENTS)
  return sql`
    WITH ${focalCtes(ids, args.entityId, minSupport)},
    ${focalRelationCtes(ids, minEdge)},
    evidence AS (
      SELECT rk.neighbour_id AS neighbour_id,
             rk.relation_type AS relation_type,
             rk.document_id AS document_id,
             rk.name AS name,
             rk.content_kind AS content_kind
      FROM rel_kept rk
      GROUP BY rk.neighbour_id, rk.relation_type, rk.document_id, rk.name, rk.content_kind
    ),
    ranked AS (
      SELECT ev.*,
             ROW_NUMBER() OVER (
               PARTITION BY ev.neighbour_id, ev.relation_type
               ORDER BY ev.document_id DESC
             ) AS rn
      FROM evidence ev
    )
    SELECT ranked.neighbour_id AS neighbour_id,
           ranked.relation_type AS relation_type,
           ranked.document_id AS id,
           ranked.name AS name,
           ranked.content_kind AS content_kind
    FROM ranked
    WHERE ranked.rn <= ${perEdge}
    ORDER BY ranked.neighbour_id ASC, ranked.relation_type ASC, ranked.document_id DESC
    LIMIT ${neighbourLimit * perEdge}`
}

/**
 * The focal node's published documents, from included ecosistemas only.
 * 🔴 The snippet `CASE` and the persona gate on the list are the same as
 * `entityDocumentsQuery`'s.
 */
export function combinedEntityDocumentsQuery(args: CombinedDetailArgs): GraphSql {
  const ids = intArray(normaliseOrgIds(args.organizationIds))
  const minSupport = args.minSupport ?? graphMinSupport()
  const limit = clampLimit(args.documentLimit, MAX_ENTITY_DOCUMENTS, MAX_ENTITY_DOCUMENTS)
  return sql`
    WITH ${focalCtes(ids, args.entityId, minSupport)}
    SELECT d.id AS id,
           d.name AS name,
           d.content_kind AS content_kind,
           CASE WHEN d.content_kind = 'documento' THEN m.snippet ELSE NULL END AS snippet
    FROM graph_mentions m
    ${joinPublishedDocumentsPerRow('m', ids)}
    JOIN focal f ON f.entity_id = m.entity_id AND f.org_id = m.organization_id
    JOIN graph_entities ce ON ce.id = m.entity_id AND ce.organization_id = m.organization_id
    WHERE m.organization_id = ANY(${ids})${publicPersonaOnly('ce')}
    ORDER BY m.occurrences DESC, d.id DESC
    LIMIT ${limit}`
}

export async function readCombinedEntityDetail(
  payload: GraphQueryPayload,
  args: CombinedDetailArgs,
): Promise<CombinedEntityDetail | null> {
  const scoped: CombinedDetailArgs = {
    ...args,
    organizationIds: normaliseOrgIds(args.organizationIds),
    minSupport: args.minSupport ?? graphMinSupport(),
    minEdgeSupport: args.minEdgeSupport ?? graphMinEdgeDocs(),
  }
  const entityRow = rowsOf(await payload.db.drizzle.execute(combinedEntityDetailQuery(scoped)))[0]
  if (!entityRow) return null
  const entity = combinedEntityOf(entityRow)

  const [neighbourResult, documentResult, edgeDocumentResult] = await Promise.all([
    payload.db.drizzle.execute(combinedNeighboursQuery(scoped)),
    payload.db.drizzle.execute(combinedEntityDocumentsQuery(scoped)),
    payload.db.drizzle.execute(combinedEdgeDocumentsQuery(scoped)),
  ])

  const edgeDocuments = new Map<string, GraphDocumentRef[]>()
  for (const row of rowsOf(edgeDocumentResult)) {
    const key = `${toId(row.neighbour_id)}|${toText(row.relation_type)}`
    const ref = mapDocumentRow(row, false)
    const list = edgeDocuments.get(key)
    if (list) list.push(ref)
    else edgeDocuments.set(key, [ref])
  }

  const neighbours: CombinedNeighbour[] = rowsOf(neighbourResult).map((row) => {
    const id = toId(row.id)
    const relationType = toText(row.relation_type) as GraphRelationType
    return {
      entity: {
        id,
        type: toText(row.type) as GraphEntityType,
        label: toText(row.label),
        support: toCount(row.support),
      },
      relationType,
      support: toCount(row.edge_support),
      pairSupport: toCount(row.pair_support ?? row.edge_support),
      direction: toDirection(row.direction),
      documents: edgeDocuments.get(`${id}|${relationType}`) ?? [],
    }
  })

  return {
    entity,
    neighbours,
    documents: rowsOf(documentResult).map((row) => mapDocumentRow(row, true)),
  }
}
