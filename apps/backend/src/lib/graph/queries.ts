/**
 * THE READ SIDE OF THE CORPUS GRAPH. `plan/adr-corpus-graph.md` §6, §7, §8.1.
 *
 * Everything a surface of this product is allowed to know about the graph comes
 * out of this file, and every statement in it carries THE SAME THREE GATES:
 *
 *   1. 🔴 `organization_id = $1`, NAMED EXPLICITLY, on every table in the
 *      statement — `graph_entities`, `graph_mentions`, `graph_relations` AND
 *      `documents`. Never inferred from access control: `visibleToCaller`
 *      returns bare `true` for a platform admin
 *      (`collections/Documents.ts:83-107`), and
 *      `apps/web/src/lib/server/admin.ts:10-30` documents that exact trap. The
 *      column is denormalised onto all three graph tables precisely so this
 *      predicate needs no join to be writable (ADR §4.1).
 *
 *   2. 🔴 `documents.publication_status = 'published'`, as a JOIN to
 *      `documents`, never as a denormalised flag on a graph row. A flag goes
 *      stale at exactly the moment publishing happens, which is the moment it
 *      matters. Extraction runs on DRAFTS by design (ADR §5.1), so these tables
 *      are full of rows that must not be counted, ranked, retrieved or shown.
 *
 *   3. 🔴 MINIMUM SUPPORT, `GRAPH_MIN_SUPPORT` (default 3). An entity exists
 *      only if ≥ N DISTINCT PUBLISHED DOCUMENTS mention it; an edge only if
 *      ≥ N distinct published documents evidence it. Applied identically to the
 *      view AND to GraphRAG retrieval — ADR §7.3.3 names retrieval as "the side
 *      door that leaks what the view refuses to show", and an unthresholded
 *      retrieve is that door.
 *
 * ⚠ THE GATES ARE IN SQL, NOT IN JAVASCRIPT. Every threshold below is a
 * `HAVING`, every tenant check a `WHERE`, every published check a `JOIN … AND`.
 * Nothing is filtered after the rows arrive, so there is no path where a caller
 * that forgets to filter gets more than a caller that remembers.
 *
 * ── WHY RAW SQL AND NOT THE LOCAL API ──────────────────────────────────────
 *
 * Payload's local API cannot express `GROUP BY … HAVING`, and every read here is
 * exactly that. ADR §4 states the split deliberately: WRITES go through the
 * collections (`lib/graph/writer.ts`), AGGREGATE READS go through
 * `payload.db.drizzle` here. It is recorded in both places so it is not
 * discovered later as an inconsistency.
 *
 * ── ⚠ TWO POSTGRES TYPES THAT COME BACK AS STRINGS ─────────────────────────
 *
 * `pg` returns `bigint` (`COUNT`) and `numeric` (`graph_mentions.occurrences`,
 * see the comment on that field) as STRINGS, not numbers. The bug that causes is
 * silent and shaped like `"12" >= 3 === false`. Two defences, both used:
 * every count is cast `::int` in SQL, and every count is passed through
 * {@link toCount} on the way out.
 *
 * ── 🔴 TITLES ──────────────────────────────────────────────────────────────
 *
 * Any document title leaving this file goes through `titleFor()` from
 * `lib/contentKind.ts`. `documents.name` is free text that never passed the
 * anonymisation gate; that file records "Testimonio de María López.mp3" as the
 * case that nearly reached a citation card. A raw name on a graph surface is the
 * same leak on a new surface.
 *
 * ── 🔴 SNIPPETS ────────────────────────────────────────────────────────────
 *
 * `graph_mentions.snippet` is returned ONLY for `content_kind = 'documento'`.
 * The writer already stores NULL for everything else (ADR §7.3.4), so the `CASE`
 * in {@link entityDocumentsQuery} plus `snippetAllowed()` on the way out are
 * belt-and-braces over a table that should already be empty there. Both are
 * asserted in `queries.test.ts`, because "should already be" is how the next
 * writer path leaks.
 *
 * ⚠ {@link entityDocumentsQuery} IS THE ONLY STATEMENT HERE THAT SELECTS THE
 * COLUMN, and `queries.test.ts` asserts that of every other one by name. The
 * per-edge evidence list is deliberately outside it — a snippet belongs to a
 * `(document, entity)` pair, not to an edge, so an edge has two candidates and
 * neither is evidence of the edge itself.
 *
 * ── EDGES HAVE THEIR OWN EVIDENCE, AND IT IS NOT AN INTERSECTION ───────────
 *
 * {@link entityEdgeDocumentsQuery} answers *"which published documents evidence
 * THIS connection"* directly out of `graph_relations`, which holds one row per
 * `(document, from, to, type)`. The surface it replaces intersected the two
 * entities' document lists, which is a SUPERSET — a document naming both
 * endpoints without the extraction ever drawing an edge between them was
 * presented as support for a connection nothing had asserted.
 */

import { sql } from '@payloadcms/db-postgres'

import { contentKindOf, titleFor, type ContentKind } from '../contentKind'
import { canonicalKey } from './normalise'
import { snippetAllowed, type GraphEntityType, type GraphRelationType } from './types'

/** A drizzle SQL fragment. `@payloadcms/db-postgres` re-exports `sql` but not its type. */
export type GraphSql = ReturnType<typeof sql>

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** ADR §7.3.3. Chosen by reasoning, not by looking at a real corpus — hence the env var. */
export const GRAPH_MIN_SUPPORT_DEFAULT = 3

/**
 * How many distinct PUBLISHED documents must mention an entity (or evidence an
 * edge) before this product admits it exists.
 *
 * ⚠ JUNK OR A NON-POSITIVE VALUE FALLS BACK TO THE DEFAULT rather than to 0.
 * `GRAPH_MIN_SUPPORT=0` would disable the one measure that answers the brief's
 * re-identification scenario, and a typo must not be able to do that silently.
 * A deployment that genuinely wants a weaker threshold sets `1`, which is
 * accepted — and is a decision somebody made on purpose.
 */
export function graphMinSupport(): number {
  const raw = process.env.GRAPH_MIN_SUPPORT
  const n = raw == null || raw.trim() === '' ? Number.NaN : Number(raw)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : GRAPH_MIN_SUPPORT_DEFAULT
}

/** Hard ceilings, so no caller can ask for the whole corpus in one page. */
export const MAX_VIEW_ENTITIES = 200
export const MAX_NEIGHBOURS = 20 // ADR §7.2: the ego-network is ≤ 20 neighbours.
export const MAX_ENTITY_DOCUMENTS = 50
/**
 * How many supporting documents ONE EDGE carries in the entity answer.
 *
 * ⚠ IT MULTIPLIES. The detail response holds up to {@link MAX_NEIGHBOURS}
 * edges, so this cap is paid twenty times over in a single body. Ten is chosen
 * so the worst case is 200 document refs (~16 KB), which is a panel, not a
 * download.
 *
 * ⚠ Truncating the LIST does not truncate the TRUTH: `GraphNeighbour.support`
 * is the real `COUNT(DISTINCT document_id)` for the edge and is unaffected, so
 * the UI can say "14 documentos" above a list of ten.
 */
export const MAX_EDGE_DOCUMENTS = 10
export const MAX_RETRIEVE_SEEDS = 8
export const MAX_RETRIEVE_EDGES = 60
export const MAX_RETRIEVE_DOCUMENTS = 20
export const MAX_RETRIEVE_TERMS = 12
/**
 * ⚠ The whole above-threshold entity list is loaded into this process for
 * `/retrieve`'s deterministic matching (ADR §8.1: "a few hundred rows,
 * indexed"). This cap is what keeps "a few hundred" from becoming "however many
 * there turn out to be" on a corpus nobody predicted.
 */
export const MAX_MATCHABLE_ENTITIES = 2000

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export interface GraphViewEntity {
  id: number
  type: GraphEntityType
  label: string
  /** DISTINCT published documents that mention it. Never a raw occurrence tally. */
  support: number
}

export interface GraphEntityView {
  entities: GraphViewEntity[]
  /**
   * 🔴 HOW MANY ENTITIES THE THRESHOLD REMOVED. Surfaced, not hidden: an
   * invisible threshold looks like an empty database, and the UI has to be able
   * to say *"hay N conexiones que aún no se muestran"* instead of rendering a
   * blank canvas (ADR §7.3.3).
   */
  hidden: number
  /** The threshold in force, so the copy can name it without guessing. */
  minSupport: number
  /**
   * Published documents in this ecosistema, ignoring the graph entirely.
   *
   * ⚠ THIS IS WHAT LETS THE UI TELL TWO EMPTY GRAPHS APART. `entities: []` with
   * `hidden: 0` means either "nothing has been published yet" or "everything
   * published is below the threshold", and those need different Spanish.
   */
  publishedDocuments: number
}

export interface GraphNeighbour {
  entity: GraphViewEntity
  relationType: GraphRelationType
  /** DISTINCT published documents that evidence THIS EDGE. */
  support: number
  /**
   * 🔴 THE PUBLISHED DOCUMENTS THAT ACTUALLY EVIDENCE THIS EDGE — not the ones
   * where both endpoints happen to appear.
   *
   * `graph_relations` holds one row per `(document, from, to, type)`, so this is
   * a direct answer rather than an approximation. The surface it replaces
   * intersected the two entities' document lists client-side, which is a
   * SUPERSET: a document naming both "consulta previa" and "Oaxaca" without the
   * extraction ever drawing an edge between them was counted as support for a
   * connection it never made.
   *
   * ⚠ Capped at {@link MAX_EDGE_DOCUMENTS}; `support` carries the true total.
   * ⚠ NEVER CARRIES A SNIPPET, for any content kind — see the file header.
   */
  documents: GraphDocumentRef[]
}

export interface GraphDocumentRef {
  id: number
  /** 🔴 Always `titleFor(contentKind, name)`. Never `documents.name`. */
  title: string
  contentKind: ContentKind
  /** 🔴 `null` for anything that is not a `documento`. See the file header. */
  snippet?: string | null
}

export interface GraphEntityDetail {
  entity: GraphViewEntity
  neighbours: GraphNeighbour[]
  documents: GraphDocumentRef[]
}

export interface GraphEdge {
  from: GraphViewEntity
  to: GraphViewEntity
  relationType: GraphRelationType
  support: number
}

export interface GraphRetrieval {
  /** The entities the query matched. Seeds, not the whole neighbourhood. */
  entities: GraphViewEntity[]
  /** One hop out of the seeds. Both endpoints are above threshold. */
  edges: GraphEdge[]
  documents: GraphDocumentRef[]
  /** Neighbour labels, for query expansion in the web layer (ADR §8.1). */
  terms: string[]
}

// ---------------------------------------------------------------------------
// The Payload surface these queries need
// ---------------------------------------------------------------------------

/**
 * Structural, not `Pick<Payload, 'db'>`, for the same reason
 * `GraphWriterPayload` is: a unit test hands in one function instead of
 * constructing a Payload instance and a postgres pool, and the code under test
 * is then the code that runs.
 */
export interface GraphQueryPayload {
  db: { drizzle: { execute(query: GraphSql): Promise<unknown> } }
}

type Row = Record<string, unknown>

/**
 * The rows out of a `db.drizzle.execute()`.
 *
 * ⚠ TOLERANT OF BOTH SHAPES ON PURPOSE. drizzle's node-postgres driver returns
 * the `pg` `QueryResult` (`{ rows }`); other drivers and future versions return
 * the array directly. Guessing wrong yields an empty graph with no error, which
 * is the worst failure this file could have — it looks exactly like a young
 * ecosistema.
 */
function rowsOf(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[]
  if (result && typeof result === 'object') {
    const rows = (result as { rows?: unknown }).rows
    if (Array.isArray(rows)) return rows as Row[]
  }
  return []
}

/**
 * A count, as a number, whatever `pg` handed us.
 *
 * 🔴 `COUNT()` is `bigint` and `graph_mentions.occurrences` is `numeric`; `pg`
 * returns BOTH AS STRINGS. Every count is also cast `::int` in SQL, so this is
 * the second of two defences, not the only one.
 */
export function toCount(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : 0
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') {
    const n = Number(value.trim())
    return Number.isFinite(n) ? Math.trunc(n) : 0
  }
  return 0
}

function toId(value: unknown): number {
  return toCount(value)
}

function toText(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

// ---------------------------------------------------------------------------
// The gates, as reusable SQL
// ---------------------------------------------------------------------------

/**
 * 🔴 GATES 1 AND 2 IN ONE FRAGMENT: join a graph table to `documents`, scoped
 * to this ecosistema, published only.
 *
 * Written once and used by every statement below so the two gates cannot drift
 * apart between queries. The alias is passed in as raw SQL rather than
 * interpolated as a value because it is an identifier, and every call site
 * passes a literal from this file.
 */
function joinPublishedDocuments(alias: 'm' | 'r', organizationId: number): GraphSql {
  const table = alias === 'm' ? sql`m` : sql`r`
  return sql`
    JOIN documents d
      ON d.id = ${table}.document_id
     AND d.organization_id = ${organizationId}
     AND d.publication_status = 'published'`
}

/**
 * Entity support, gated, as a CTE body.
 *
 * `COUNT(DISTINCT m.document_id)` — DISTINCT DOCUMENTS, never occurrences. ADR
 * §7.3.3's whole basis: a single repetitive testimony must not be able to look
 * like three independent sources.
 */
function entitySupportCte(organizationId: number, minSupport: number): GraphSql {
  return sql`
    SELECT m.entity_id AS entity_id,
           COUNT(DISTINCT m.document_id)::int AS support
    FROM graph_mentions m
    ${joinPublishedDocuments('m', organizationId)}
    WHERE m.organization_id = ${organizationId}
    GROUP BY m.entity_id
    HAVING COUNT(DISTINCT m.document_id) >= ${minSupport}`
}

// ---------------------------------------------------------------------------
// 1. The view — GET /api/graph/view
// ---------------------------------------------------------------------------

export interface EntityViewArgs {
  organizationId: number
  /** One of the five node types, or null for all of them. */
  type?: GraphEntityType | null
  /** Free text. Canonicalised with the SAME helper the writer uses. */
  q?: string | null
  limit?: number
  minSupport?: number
}

/**
 * Ranked entities for one ecosistema, plus how many the threshold removed.
 *
 * ⚠ ONE STATEMENT, TWO ANSWERS, ONE SET OF GATES. `visible` and `hidden` are
 * both selected from the SAME `supported` CTE. Two separate queries would be the
 * obvious shape and would be a standing invitation for someone to fix a gate in
 * one of them; here there is only one place a gate can be written.
 *
 * ⚠ THE THRESHOLD IS A SQL PREDICATE ON BOTH BRANCHES (`>= $min` / `< $min`),
 * not a partition done in JavaScript after the rows arrive.
 *
 * ⚠ IT IS THE ONE STATEMENT HERE THAT DOES NOT USE `HAVING`, and that is forced,
 * not sloppy. `hidden` is a count of the groups the threshold REMOVES, so the
 * `supported` CTE has to keep them — a `HAVING` inside it would delete the very
 * rows the second branch exists to count. The predicate therefore moves one
 * level out, onto the aggregate column, and applies to both branches from one
 * place. `queries.test.ts` audits for either form.
 *
 * The `LEFT JOIN … ON TRUE` against a single-row `hidden` is what makes the
 * statement return one row carrying `hidden` even when nothing is visible —
 * otherwise an empty graph would carry no count and the UI could not explain
 * itself.
 */
export function entityViewQuery(args: EntityViewArgs): GraphSql {
  const { organizationId } = args
  const minSupport = args.minSupport ?? graphMinSupport()
  const limit = clampLimit(args.limit, MAX_VIEW_ENTITIES, MAX_VIEW_ENTITIES)

  const typeFilter = args.type ? sql` AND e.type = ${args.type}` : sql``
  const searchFilter = buildSearchFilter(args.q)

  return sql`
    WITH supported AS (
      SELECT e.id AS id,
             e.type AS type,
             e.label AS label,
             COUNT(DISTINCT m.document_id)::int AS support,
             SUM(m.occurrences)::int AS occurrences
      FROM graph_entities e
      JOIN graph_mentions m
        ON m.entity_id = e.id
       AND m.organization_id = ${organizationId}
      ${joinPublishedDocuments('m', organizationId)}
      WHERE e.organization_id = ${organizationId}${typeFilter}${searchFilter}
      GROUP BY e.id, e.type, e.label
    ),
    visible AS (
      SELECT * FROM supported
      WHERE support >= ${minSupport}
      ORDER BY support DESC, occurrences DESC, label ASC
      LIMIT ${limit}
    ),
    hidden AS (
      SELECT COUNT(*)::int AS n FROM supported WHERE support < ${minSupport}
    )
    SELECT v.id AS id, v.type AS type, v.label AS label, v.support AS support, h.n AS hidden
    FROM hidden h
    LEFT JOIN visible v ON TRUE
    ORDER BY v.support DESC NULLS LAST, v.label ASC`
}

/**
 * How many documents this ecosistema has PUBLISHED, graph or no graph.
 *
 * ⚠ Not a graph query, and deliberately kept next to them. Without it the view
 * cannot tell "nobody has published anything yet" from "everything published is
 * below the threshold", and those are different sentences in Spanish.
 */
export function publishedDocumentCountQuery(organizationId: number): GraphSql {
  return sql`
    SELECT COUNT(*)::int AS n
    FROM documents d
    WHERE d.organization_id = ${organizationId}
      AND d.publication_status = 'published'`
}

export async function readEntityView(
  payload: GraphQueryPayload,
  args: EntityViewArgs,
): Promise<GraphEntityView> {
  const minSupport = args.minSupport ?? graphMinSupport()
  const [viewResult, countResult] = await Promise.all([
    payload.db.drizzle.execute(entityViewQuery({ ...args, minSupport })),
    payload.db.drizzle.execute(publishedDocumentCountQuery(args.organizationId)),
  ])

  const rows = rowsOf(viewResult)
  const entities: GraphViewEntity[] = []
  let hidden = 0

  for (const row of rows) {
    hidden = toCount(row.hidden)
    // `id` is NULL on the single row a graph with nothing visible returns.
    if (row.id == null) continue
    entities.push({
      id: toId(row.id),
      type: toText(row.type) as GraphEntityType,
      label: toText(row.label),
      support: toCount(row.support),
    })
  }

  return {
    entities,
    hidden,
    minSupport,
    publishedDocuments: toCount(rowsOf(countResult)[0]?.n),
  }
}

// ---------------------------------------------------------------------------
// 2. One entity, one hop — GET /api/graph/entity/:id
// ---------------------------------------------------------------------------

export interface EntityDetailArgs {
  organizationId: number
  entityId: number
  neighbourLimit?: number
  documentLimit?: number
  /** Supporting documents per EDGE. Capped at {@link MAX_EDGE_DOCUMENTS}. */
  edgeDocumentLimit?: number
  minSupport?: number
}

/**
 * The focal entity — and 🔴 ONLY IF IT IS ITSELF ABOVE THE THRESHOLD.
 *
 * Without the `HAVING`, `/entity/:id` becomes the side door: a caller who knows
 * (or guesses) an id reads a node the view refuses to list. Ids are sequential
 * integers, so guessing is trivial.
 */
export function entityDetailQuery(args: EntityDetailArgs): GraphSql {
  const { organizationId, entityId } = args
  const minSupport = args.minSupport ?? graphMinSupport()
  return sql`
    SELECT e.id AS id,
           e.type AS type,
           e.label AS label,
           COUNT(DISTINCT m.document_id)::int AS support
    FROM graph_entities e
    JOIN graph_mentions m
      ON m.entity_id = e.id
     AND m.organization_id = ${organizationId}
    ${joinPublishedDocuments('m', organizationId)}
    WHERE e.organization_id = ${organizationId}
      AND e.id = ${entityId}
    GROUP BY e.id, e.type, e.label
    HAVING COUNT(DISTINCT m.document_id) >= ${minSupport}`
}

/**
 * One hop out of an entity.
 *
 * ⚠ TWO THRESHOLDS, NOT ONE. The EDGE needs `>= min` distinct published
 * documents evidencing it, and the NEIGHBOUR needs `>= min` distinct published
 * documents mentioning it (the `ent_support` join). In practice the writer
 * always creates a mention alongside a relation endpoint, so the second is
 * usually implied — "usually" is not a privacy guarantee, and a neighbour is a
 * node the caller can see.
 */
export function entityNeighboursQuery(args: EntityDetailArgs): GraphSql {
  const { organizationId, entityId } = args
  const minSupport = args.minSupport ?? graphMinSupport()
  const limit = clampLimit(args.neighbourLimit, MAX_NEIGHBOURS, MAX_NEIGHBOURS)

  return sql`
    WITH ent_support AS (${entitySupportCte(organizationId, minSupport)}),
    edges AS (
      SELECT CASE WHEN r.from_entity_id = ${entityId} THEN r.to_entity_id
                  ELSE r.from_entity_id END AS neighbour_id,
             r.type AS relation_type,
             COUNT(DISTINCT r.document_id)::int AS support
      FROM graph_relations r
      ${joinPublishedDocuments('r', organizationId)}
      WHERE r.organization_id = ${organizationId}
        AND (r.from_entity_id = ${entityId} OR r.to_entity_id = ${entityId})
      GROUP BY 1, 2
      HAVING COUNT(DISTINCT r.document_id) >= ${minSupport}
    )
    SELECT e.id AS id,
           e.type AS type,
           e.label AS label,
           s.support AS support,
           edges.relation_type AS relation_type,
           edges.support AS edge_support
    FROM edges
    JOIN graph_entities e
      ON e.id = edges.neighbour_id
     AND e.organization_id = ${organizationId}
    JOIN ent_support s ON s.entity_id = e.id
    WHERE e.id <> ${entityId}
    ORDER BY edges.support DESC, s.support DESC, e.label ASC
    LIMIT ${limit}`
}

/**
 * 🔴 THE PUBLISHED DOCUMENTS THAT EVIDENCE EACH EDGE OF THE EGO-NETWORK.
 *
 * ── WHY THIS QUERY EXISTS AT ALL ───────────────────────────────────────────
 *
 * ADR §7.2 asks for *"the supporting documents for any edge"*. Until this
 * statement there was no per-edge query, so the surface APPROXIMATED it by
 * INTERSECTING the two entities' document lists — and the UI had to say so, in
 * Spanish, because the intersection is a SUPERSET of the truth: a document that
 * names both endpoints without the extraction ever drawing an edge between them
 * landed in the list as evidence for a connection it never made.
 *
 * `graph_relations` already holds one row per `(document, from, to, type)`
 * (ADR §4.1), so the honest answer was always one join away. This is it.
 *
 * ── ONE STATEMENT FOR THE WHOLE EGO-NETWORK, NOT ONE PER EDGE ──────────────
 *
 * ⚠ The panel shows ONE edge at a time, but fetching one edge at a time would
 * be up to {@link MAX_NEIGHBOURS} round-trips through authorisation and two rate
 * limiters to fill a panel the caller already paid one request for. `edges` and
 * {@link entityNeighboursQuery}'s CTE of the same name are the SAME aggregation
 * over the same rows, so the two answers cannot disagree about which edges exist
 * — which is the property that would break first if this were a separate route
 * with its own copy of the thresholds.
 *
 * ⚠ `ROW_NUMBER() … PARTITION BY` IS THE PER-EDGE CAP, IN SQL. A plain `LIMIT`
 * would spend the whole budget on the first edge and return nothing for the
 * rest. The `ORDER BY … document_id DESC` inside the partition matches
 * {@link entityDocumentsQuery}'s tiebreak, so "the ten shown" means the same
 * thing on both lists.
 *
 * ⚠ `evidence` GROUPS BY `(neighbour, type, document)` RATHER THAN SELECTING
 * DISTINCT BY ACCIDENT. An asymmetric relation type can legitimately hold both
 * A→B and B→A for the SAME document; from this entity's point of view those are
 * one edge, and the `edges` CTE already counts them as one because its tally is
 * over distinct `document_id`. Without the grouping the list would show that
 * document twice while `support` said one — the list and its own count
 * disagreeing, which is the bug a reader has no way to diagnose.
 *
 * ⚠ NO SQL COMMENT SURVIVES IN THIS STATEMENT, deliberately. `queries.test.ts`
 * greps the rendered text for the gates, so a comment mentioning a gate clause
 * would let a statement PASS the audit on prose alone. Explanations live here.
 *
 * ── THE THREE GATES, AND A FOURTH THING WORTH SAYING ───────────────────────
 *
 * Gates 1 and 2 ride on {@link joinPublishedDocuments}. Gate 3 is applied
 * TWICE, exactly as in {@link entityNeighboursQuery}: the EDGE needs `>= min`
 * distinct published documents evidencing it (the `HAVING`), and the NEIGHBOUR
 * needs `>= min` distinct published documents mentioning it (`ent_support`).
 *
 * 🔴 That first threshold is also what makes this list safe to be PRECISE about.
 * A per-edge list is narrower than the intersection it replaces, and narrower
 * means more identifying — but an edge below `GRAPH_MIN_SUPPORT` does not exist
 * as far as this file is concerned, so the shortest list this can ever return is
 * `GRAPH_MIN_SUPPORT` documents long. It can never point at one testimony, which
 * is the scenario ADR §7.3 is written against.
 *
 * ⚠ NO SNIPPET, DELIBERATELY, AND NOT ONLY BECAUSE THE TEST FORBIDS IT.
 * `graph_mentions.snippet` is per `(document, entity)`, so an EDGE has two
 * candidate quotations and neither of them is evidence OF THE EDGE — it is
 * evidence of one endpoint. Returning one would put a verbatim quotation on a
 * surface whose own semantics do not justify it. `entityDocumentsQuery` remains
 * the only statement in this file that selects the column.
 */
export function entityEdgeDocumentsQuery(args: EntityDetailArgs): GraphSql {
  const { organizationId, entityId } = args
  const minSupport = args.minSupport ?? graphMinSupport()
  const neighbourLimit = clampLimit(args.neighbourLimit, MAX_NEIGHBOURS, MAX_NEIGHBOURS)
  const perEdge = clampLimit(args.edgeDocumentLimit, MAX_EDGE_DOCUMENTS, MAX_EDGE_DOCUMENTS)

  // ⚠ The overall ceiling is derived, not guessed: no more rows than the answer
  // can hold, whatever the two caps are set to.
  const total = neighbourLimit * perEdge

  return sql`
    WITH ent_support AS (${entitySupportCte(organizationId, minSupport)}),
    edges AS (
      SELECT CASE WHEN r.from_entity_id = ${entityId} THEN r.to_entity_id
                  ELSE r.from_entity_id END AS neighbour_id,
             r.type AS relation_type,
             COUNT(DISTINCT r.document_id)::int AS support
      FROM graph_relations r
      ${joinPublishedDocuments('r', organizationId)}
      WHERE r.organization_id = ${organizationId}
        AND (r.from_entity_id = ${entityId} OR r.to_entity_id = ${entityId})
      GROUP BY 1, 2
      HAVING COUNT(DISTINCT r.document_id) >= ${minSupport}
    ),
    evidence AS (
      SELECT CASE WHEN r.from_entity_id = ${entityId} THEN r.to_entity_id
                  ELSE r.from_entity_id END AS neighbour_id,
             r.type AS relation_type,
             d.id AS document_id,
             d.name AS name,
             d.content_kind AS content_kind
      FROM graph_relations r
      ${joinPublishedDocuments('r', organizationId)}
      WHERE r.organization_id = ${organizationId}
        AND (r.from_entity_id = ${entityId} OR r.to_entity_id = ${entityId})
      GROUP BY 1, 2, d.id, d.name, d.content_kind
    ),
    ranked AS (
      SELECT ev.neighbour_id AS neighbour_id,
             ev.relation_type AS relation_type,
             ev.document_id AS document_id,
             ev.name AS name,
             ev.content_kind AS content_kind,
             ROW_NUMBER() OVER (
               PARTITION BY ev.neighbour_id, ev.relation_type
               ORDER BY ev.document_id DESC
             ) AS rn
      FROM evidence ev
      JOIN edges
        ON edges.neighbour_id = ev.neighbour_id
       AND edges.relation_type = ev.relation_type
      JOIN ent_support s ON s.entity_id = ev.neighbour_id
      WHERE ev.neighbour_id <> ${entityId}
    )
    SELECT ranked.neighbour_id AS neighbour_id,
           ranked.relation_type AS relation_type,
           ranked.document_id AS id,
           ranked.name AS name,
           ranked.content_kind AS content_kind
    FROM ranked
    WHERE ranked.rn <= ${perEdge}
    ORDER BY ranked.neighbour_id ASC, ranked.relation_type ASC, ranked.document_id DESC
    LIMIT ${total}`
}

/**
 * The published documents behind an entity.
 *
 * 🔴 THE SNIPPET GATE IS THE `CASE`. `graph_mentions.snippet` is returned only
 * where `documents.content_kind = 'documento'`. The writer already stores NULL
 * for a testimonio or a conversacion (ADR §7.3.4), so this is the second of two
 * mechanisms — and the one that still holds if a future write path forgets.
 *
 * ⚠ THE `ent_support` JOIN IS NOT REDUNDANT, even though every caller has
 * already checked the entity with {@link entityDetailQuery}. This statement is
 * exported, so "the caller checked first" is a convention, and a convention is
 * not a gate. With the join, a below-threshold entity's documents cannot be
 * listed by ANY caller — which is the property ADR §7.3.3 actually asks for.
 *
 * ⚠ `d.name` IS SELECTED BUT NEVER RETURNED RAW. {@link mapDocumentRow} runs it
 * through `titleFor()`; see the file header.
 */
export function entityDocumentsQuery(args: EntityDetailArgs): GraphSql {
  const { organizationId, entityId } = args
  const minSupport = args.minSupport ?? graphMinSupport()
  const limit = clampLimit(args.documentLimit, MAX_ENTITY_DOCUMENTS, MAX_ENTITY_DOCUMENTS)
  return sql`
    WITH ent_support AS (${entitySupportCte(organizationId, minSupport)})
    SELECT d.id AS id,
           d.name AS name,
           d.content_kind AS content_kind,
           CASE WHEN d.content_kind = 'documento' THEN m.snippet ELSE NULL END AS snippet
    FROM graph_mentions m
    ${joinPublishedDocuments('m', organizationId)}
    JOIN ent_support s ON s.entity_id = m.entity_id
    WHERE m.organization_id = ${organizationId}
      AND m.entity_id = ${entityId}
    ORDER BY m.occurrences DESC, d.id DESC
    LIMIT ${limit}`
}

/**
 * 🔴 THE TITLE AND SNIPPET GATE, IN JAVASCRIPT, OVER THE SQL ONE.
 *
 * `titleFor` replaces a testimonio's or conversacion's free-text `name` with a
 * neutral label; `snippetAllowed` drops a snippet that reached us anyway. Both
 * duplicate a rule already enforced upstream, and both are here because this is
 * the last point before the bytes leave the process.
 */
function mapDocumentRow(row: Row, withSnippet: boolean): GraphDocumentRef {
  const contentKind = contentKindOf({ contentKind: row.content_kind })
  const ref: GraphDocumentRef = {
    id: toId(row.id),
    title: titleFor(contentKind, typeof row.name === 'string' ? row.name : null),
    contentKind,
  }
  if (withSnippet) {
    const raw = typeof row.snippet === 'string' ? row.snippet.trim() : ''
    ref.snippet = snippetAllowed(contentKind) && raw !== '' ? raw : null
  }
  return ref
}

/**
 * One entity, its one-hop neighbourhood and its supporting documents.
 *
 * Returns `null` when the entity does not exist in this ecosistema, is not
 * mentioned by any published document, or is below the threshold. 🔴 All three
 * are the SAME answer on the wire — telling them apart would let a caller
 * enumerate what the threshold is hiding.
 */
export async function readEntityDetail(
  payload: GraphQueryPayload,
  args: EntityDetailArgs,
): Promise<GraphEntityDetail | null> {
  const minSupport = args.minSupport ?? graphMinSupport()
  const scoped = { ...args, minSupport }

  const entityRow = rowsOf(await payload.db.drizzle.execute(entityDetailQuery(scoped)))[0]
  if (!entityRow) return null

  const entity: GraphViewEntity = {
    id: toId(entityRow.id),
    type: toText(entityRow.type) as GraphEntityType,
    label: toText(entityRow.label),
    support: toCount(entityRow.support),
  }

  const [neighbourResult, documentResult, edgeDocumentResult] = await Promise.all([
    payload.db.drizzle.execute(entityNeighboursQuery(scoped)),
    payload.db.drizzle.execute(entityDocumentsQuery(scoped)),
    payload.db.drizzle.execute(entityEdgeDocumentsQuery(scoped)),
  ])

  // ⚠ KEYED ON `(neighbour, relationType)`, NOT ON THE NEIGHBOUR ALONE. Two
  // entities can be joined by more than one predicate — "sequía de 2023"
  // `ocurre_en` AND `afecta_a` "Juxtlahuaca" is an ordinary pair — and those are
  // two rows in `neighbours`, each with its own support. Keying on the
  // neighbour would give both edges the union of their evidence and overstate
  // the weaker one.
  const edgeDocuments = new Map<string, GraphDocumentRef[]>()
  for (const row of rowsOf(edgeDocumentResult)) {
    const key = `${toId(row.neighbour_id)}|${toText(row.relation_type)}`
    const list = edgeDocuments.get(key)
    // 🔴 `withSnippet: false`. These rows carry no quotation; see the query.
    const ref = mapDocumentRow(row, false)
    if (list) list.push(ref)
    else edgeDocuments.set(key, [ref])
  }

  const neighbours: GraphNeighbour[] = rowsOf(neighbourResult).map((row) => {
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
      documents: edgeDocuments.get(`${id}|${relationType}`) ?? [],
    }
  })

  const documents = rowsOf(documentResult).map((row) => mapDocumentRow(row, true))

  return { entity, neighbours, documents }
}

// ---------------------------------------------------------------------------
// 3. GraphRAG retrieval — POST /api/graph/retrieve
// ---------------------------------------------------------------------------

/**
 * Every above-threshold entity in the ecosistema, with its canonical key.
 *
 * ⚠ THIS IS THE WHOLE MATCHING INPUT, AND IT IS DELIBERATELY NOT A SEARCH.
 * ADR §8.1: matching is deterministic string work over a few hundred indexed
 * rows — NO LLM CALL, NO COST. The trade-off is stated in ADR §11: it will miss
 * paraphrases.
 *
 * 🔴 The threshold is applied HERE, before matching, so retrieval can never
 * reach an entity the view refuses to list.
 */
export function matchableEntitiesQuery(organizationId: number, minSupport: number): GraphSql {
  return sql`
    SELECT e.id AS id,
           e.type AS type,
           e.label AS label,
           e.canonical_key AS canonical_key,
           COUNT(DISTINCT m.document_id)::int AS support
    FROM graph_entities e
    JOIN graph_mentions m
      ON m.entity_id = e.id
     AND m.organization_id = ${organizationId}
    ${joinPublishedDocuments('m', organizationId)}
    WHERE e.organization_id = ${organizationId}
    GROUP BY e.id, e.type, e.label, e.canonical_key
    HAVING COUNT(DISTINCT m.document_id) >= ${minSupport}
    ORDER BY support DESC, e.label ASC
    LIMIT ${MAX_MATCHABLE_ENTITIES}`
}

export interface MatchableEntity extends GraphViewEntity {
  canonicalKey: string
}

/**
 * Shortest entity key worth matching, in characters.
 *
 * ⚠ Below this, matching is noise: a two-letter key ("ap") appears inside
 * ordinary Spanish words and would seed the expansion from nothing.
 */
const MIN_MATCH_CHARS = 3

/**
 * Reduce a canonical key to space-separated tokens.
 *
 * ⚠ PUNCTUATION IS WHY THIS EXISTS. `canonicalKey` folds accents and case but
 * keeps punctuation, so a query canonicalises to `¿que pasa en oaxaca?` and a
 * naive `includes(' oaxaca ')` misses because of the question mark. Replacing
 * every non letter/digit with a space, on BOTH sides, makes the comparison a
 * token-boundary one.
 *
 * ⚠ `\p{L}` keeps `ñ` and every accented letter that survived canonicalisation.
 */
function tokenSpaced(key: string): string {
  const cleaned = key
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned === '' ? '' : ` ${cleaned} `
}

/**
 * Which of this ecosistema's entities does the query name?
 *
 * Pure, synchronous, no I/O, no model call — the whole point (ADR §8.1). The
 * query is canonicalised with THE SAME `canonicalKey` the writer used to store
 * the keys, so "Mexico" finds "México" for free.
 *
 * ⚠ A MATCH SUBSUMED BY A LONGER ONE IS DROPPED. "la consulta previa" matches
 * both `consulta previa` and `consulta`, and seeding from both is worse than
 * seeding from the specific one alone: the broader node drags in a neighbourhood
 * the question did not ask about, and it does so while spending one of the few
 * seed slots. Only whole-token containment counts, so "Consulta" is dropped
 * against "Consulta previa" but "Agua" is not dropped against "Aguascalientes".
 *
 * Ranked by support, because an entity the corpus leans on is the better seed;
 * key length breaks ties toward the more specific of two equals.
 */
export function matchEntitiesToQuery(
  entities: readonly MatchableEntity[],
  query: string,
  limit = MAX_RETRIEVE_SEEDS,
): MatchableEntity[] {
  const haystack = tokenSpaced(canonicalKey(query))
  if (haystack === '') return []

  const matched: { entity: MatchableEntity; needle: string }[] = []
  for (const entity of entities) {
    const key = entity.canonicalKey || canonicalKey(entity.label)
    if (key.length < MIN_MATCH_CHARS) continue
    const needle = tokenSpaced(key)
    // `needle` carries a leading and a trailing space; strip them for the length
    // check so a padded two-letter key cannot sneak past MIN_MATCH_CHARS.
    if (needle === '' || needle.length - 2 < MIN_MATCH_CHARS) continue
    if (haystack.includes(needle)) matched.push({ entity, needle })
  }

  const kept = matched.filter(
    (candidate) =>
      !matched.some(
        (other) => other !== candidate && other.needle.includes(candidate.needle),
      ),
  )

  kept.sort((a, b) => {
    const bySupport = b.entity.support - a.entity.support
    if (bySupport !== 0) return bySupport
    const byLength = b.entity.canonicalKey.length - a.entity.canonicalKey.length
    if (byLength !== 0) return byLength
    return a.entity.label.localeCompare(b.entity.label, 'es')
  })

  return kept.slice(0, Math.max(0, limit)).map((candidate) => candidate.entity)
}

/**
 * One hop out of a set of seed entities, both endpoints above threshold.
 *
 * ⚠ `= ANY(${ids}::int[])` rather than a built-up `IN (…)` list. The ids come
 * from our own previous query, so either would be safe — but a hand-built `IN`
 * list is the shape somebody later copies for a value that did NOT come from us.
 */
export function retrieveEdgesQuery(
  organizationId: number,
  seedIds: readonly number[],
  minSupport: number,
  limit = MAX_RETRIEVE_EDGES,
): GraphSql {
  const ids = seedIds.map((id) => Math.trunc(Number(id))).filter((id) => Number.isFinite(id))
  return sql`
    WITH ent_support AS (${entitySupportCte(organizationId, minSupport)}),
    edges AS (
      SELECT r.from_entity_id AS from_id,
             r.to_entity_id AS to_id,
             r.type AS relation_type,
             COUNT(DISTINCT r.document_id)::int AS support
      FROM graph_relations r
      ${joinPublishedDocuments('r', organizationId)}
      WHERE r.organization_id = ${organizationId}
        AND (r.from_entity_id = ANY(${ids}::int[]) OR r.to_entity_id = ANY(${ids}::int[]))
      GROUP BY 1, 2, 3
      HAVING COUNT(DISTINCT r.document_id) >= ${minSupport}
    )
    SELECT edges.relation_type AS relation_type,
           edges.support AS support,
           f.id AS from_id, f.type AS from_type, f.label AS from_label, fs.support AS from_support,
           t.id AS to_id, t.type AS to_type, t.label AS to_label, ts.support AS to_support
    FROM edges
    JOIN graph_entities f ON f.id = edges.from_id AND f.organization_id = ${organizationId}
    JOIN graph_entities t ON t.id = edges.to_id AND t.organization_id = ${organizationId}
    JOIN ent_support fs ON fs.entity_id = f.id
    JOIN ent_support ts ON ts.entity_id = t.id
    ORDER BY edges.support DESC, f.label ASC, t.label ASC
    LIMIT ${clampLimit(limit, MAX_RETRIEVE_EDGES, MAX_RETRIEVE_EDGES)}`
}

/**
 * The published documents that mention the seed entities, most relevant first.
 *
 * "Most relevant" is how many DISTINCT seed entities a document mentions, then
 * how often. ⚠ `SUM(m.occurrences)` is over a `numeric` column and comes back
 * from `pg` as a STRING — hence the `::int`, and {@link toCount} on the way out.
 *
 * ⚠ NO SNIPPET HERE, for any content kind. These rows feed a chat prompt, and a
 * verbatim quotation is the surface ADR §7.3.4 exists to remove. The citation
 * carries the document id; the text comes from ordinary retrieval.
 *
 * ⚠ The `ent_support` join is here for the same reason as in
 * {@link entityDocumentsQuery}: the statement is exported, so it has to hold the
 * threshold on its own rather than trust the id list it was handed.
 */
export function retrieveDocumentsQuery(
  organizationId: number,
  seedIds: readonly number[],
  minSupport: number,
  limit = MAX_RETRIEVE_DOCUMENTS,
): GraphSql {
  const ids = seedIds.map((id) => Math.trunc(Number(id))).filter((id) => Number.isFinite(id))
  return sql`
    WITH ent_support AS (${entitySupportCte(organizationId, minSupport)})
    SELECT d.id AS id,
           d.name AS name,
           d.content_kind AS content_kind,
           COUNT(DISTINCT m.entity_id)::int AS matched_entities,
           SUM(m.occurrences)::int AS occurrences
    FROM graph_mentions m
    ${joinPublishedDocuments('m', organizationId)}
    JOIN ent_support s ON s.entity_id = m.entity_id
    WHERE m.organization_id = ${organizationId}
      AND m.entity_id = ANY(${ids}::int[])
    GROUP BY d.id, d.name, d.content_kind
    ORDER BY matched_entities DESC, occurrences DESC, d.id DESC
    LIMIT ${clampLimit(limit, MAX_RETRIEVE_DOCUMENTS, MAX_RETRIEVE_DOCUMENTS)}`
}

export interface RetrieveArgs {
  organizationId: number
  query: string
  /** How many seed entities to expand from. Capped at {@link MAX_RETRIEVE_SEEDS}. */
  limit?: number
  minSupport?: number
}

/**
 * The GraphRAG contribution for one turn (ADR §8.1, G1).
 *
 * Three statements, all gated: load the matchable entities, match in JS, expand
 * one hop, list the supporting documents. An empty match short-circuits — with
 * no seeds there is nothing to expand and no reason to pay for two more queries.
 *
 * ⚠ SILENT FALLBACK IS THE CALLER'S JOB, not this function's. `prepareTurn`
 * wraps every provider in a `.catch(() => [])` (ADR §8.2); throwing here so the
 * caller can decide is the honest split.
 */
export async function readGraphRetrieval(
  payload: GraphQueryPayload,
  args: RetrieveArgs,
): Promise<GraphRetrieval> {
  const minSupport = args.minSupport ?? graphMinSupport()
  const seedLimit = clampLimit(args.limit, MAX_RETRIEVE_SEEDS, MAX_RETRIEVE_SEEDS)
  const empty: GraphRetrieval = { entities: [], edges: [], documents: [], terms: [] }

  const candidates = rowsOf(
    await payload.db.drizzle.execute(matchableEntitiesQuery(args.organizationId, minSupport)),
  ).map<MatchableEntity>((row) => ({
    id: toId(row.id),
    type: toText(row.type) as GraphEntityType,
    label: toText(row.label),
    support: toCount(row.support),
    canonicalKey: toText(row.canonical_key),
  }))

  const seeds = matchEntitiesToQuery(candidates, args.query, seedLimit)
  if (seeds.length === 0) return empty

  const seedIds = seeds.map((entity) => entity.id)
  const [edgeResult, documentResult] = await Promise.all([
    payload.db.drizzle.execute(retrieveEdgesQuery(args.organizationId, seedIds, minSupport)),
    payload.db.drizzle.execute(
      retrieveDocumentsQuery(args.organizationId, seedIds, minSupport),
    ),
  ])

  const edges: GraphEdge[] = rowsOf(edgeResult).map((row) => ({
    from: {
      id: toId(row.from_id),
      type: toText(row.from_type) as GraphEntityType,
      label: toText(row.from_label),
      support: toCount(row.from_support),
    },
    to: {
      id: toId(row.to_id),
      type: toText(row.to_type) as GraphEntityType,
      label: toText(row.to_label),
      support: toCount(row.to_support),
    },
    relationType: toText(row.relation_type) as GraphRelationType,
    support: toCount(row.support),
  }))

  return {
    entities: seeds.map(({ id, type, label, support }) => ({ id, type, label, support })),
    edges,
    documents: rowsOf(documentResult).map((row) => mapDocumentRow(row, false)),
    terms: expansionTerms(seeds, edges),
  }
}

/**
 * The neighbour labels the web layer uses as query expansion (ADR §8.1).
 *
 * ⚠ SEEDS ARE EXCLUDED. The query already contains them by definition, so
 * re-adding them expands nothing and costs prompt tokens. De-duplicated by
 * canonical key so "México" and "Mexico" are one term.
 */
export function expansionTerms(
  seeds: readonly GraphViewEntity[],
  edges: readonly GraphEdge[],
  limit = MAX_RETRIEVE_TERMS,
): string[] {
  const seedIds = new Set(seeds.map((entity) => entity.id))
  const seen = new Set(seeds.map((entity) => canonicalKey(entity.label)))
  const out: string[] = []

  for (const edge of edges) {
    for (const endpoint of [edge.from, edge.to]) {
      if (seedIds.has(endpoint.id)) continue
      const key = canonicalKey(endpoint.label)
      if (key === '' || seen.has(key)) continue
      seen.add(key)
      out.push(endpoint.label)
      if (out.length >= limit) return out
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function clampLimit(requested: unknown, fallback: number, max: number): number {
  const n = typeof requested === 'number' ? requested : Number(requested)
  if (!Number.isFinite(n) || n < 1) return Math.min(fallback, max)
  return Math.min(Math.floor(n), max)
}

/**
 * The `q=` filter.
 *
 * ⚠ `strpos`, NOT `LIKE`. A `LIKE '%' || $1 || '%'` would treat `%` and `_`
 * inside the user's text as wildcards, so a search for "50%" would match
 * everything. `strpos` is a literal substring search with nothing to escape.
 *
 * The query is canonicalised with the SAME `canonicalKey` the writer used to
 * build `canonical_key`, so the search is accent- and case-insensitive without
 * needing the `unaccent` extension installed.
 *
 * ⚠ ALIASES ARE MATCHED ACCENT-SENSITIVELY, and that is a known limitation.
 * `aliases` stores SURFACE forms, not canonical keys (see `normalise.ts`), so
 * the only fold available in SQL is `lower()`. Aliases exist so "el CIDE" finds
 * "CIDE"; that works. "el CIDÉ" would not.
 */
function buildSearchFilter(q: string | null | undefined): GraphSql {
  const raw = typeof q === 'string' ? q.trim() : ''
  if (raw === '') return sql``
  const key = canonicalKey(raw)
  if (key === '') return sql``
  const lowered = raw.toLowerCase()
  return sql` AND (
    strpos(e.canonical_key, ${key}) > 0
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(e.aliases) = 'array' THEN e.aliases ELSE '[]'::jsonb END
      ) AS alias
      WHERE strpos(lower(alias), ${lowered}) > 0
    )
  )`
}
