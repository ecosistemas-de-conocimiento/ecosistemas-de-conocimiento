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
 *   3. 🔴 MINIMUM SUPPORT. An entity exists only if ≥ `GRAPH_MIN_ENTITY_DOCS`
 *      DISTINCT PUBLISHED DOCUMENTS mention it; a relation edge only if
 *      ≥ `GRAPH_MIN_EDGE_DOCS` distinct published documents evidence it for
 *      that PAIR (any type, either direction); a co-mention edge only if
 *      ≥ `GRAPH_MIN_COMENTION_DOCS` published documents mention both ends.
 *      All default to 1 (owner, 2026-10-21; names are anonymised upstream). Applied identically to the
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
import { GRAPH_NOISE_KEY_PATTERN } from './noise'
import { canonicalKey } from './normalise'
import { snippetAllowed, type GraphEntityType, type GraphRelationType } from './types'

/** A drizzle SQL fragment. `@payloadcms/db-postgres` re-exports `sql` but not its type. */
export type GraphSql = ReturnType<typeof sql>

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * ADR §7.3.3 chose 3 by reasoning. Owner ruling 2026-10-21: the default is 1,
 * because entity names are already anonymised upstream, so the threshold is
 * general privacy, not the security control it was written as. Every other
 * gate stays: published only, gate-cleared text only, no noise labels, no
 * `persona` out of a testimonio.
 */
export const GRAPH_MIN_ENTITY_DOCS_DEFAULT = 1
export const GRAPH_MIN_EDGE_DOCS_DEFAULT = 1
export const GRAPH_MIN_COMENTION_DOCS_DEFAULT = 1
/** Co-mention edges each node keeps, strongest first. See {@link viewEdgesQuery}. */
export const GRAPH_COMENTION_TOP_K_DEFAULT = 8
/** Ceiling on `GRAPH_COMENTION_TOP_K`, so a typo cannot ship a hairball. */
export const MAX_COMENTION_TOP_K = 50

/**
 * A positive integer from the environment, or `fallback`.
 *
 * ⚠ JUNK OR A NON-POSITIVE VALUE FALLS BACK TO THE DEFAULT rather than to 0.
 * A threshold of 0 would count an entity no published document mentions, and a
 * typo must not be able to do that silently.
 */
function positiveIntEnv(name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name]
  const n = raw == null || raw.trim() === '' ? Number.NaN : Number(raw)
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), max) : fallback
}

/** `GRAPH_MIN_ENTITY_DOCS`: distinct PUBLISHED documents that must mention an entity. */
export function graphMinEntityDocs(): number {
  return positiveIntEnv('GRAPH_MIN_ENTITY_DOCS', GRAPH_MIN_ENTITY_DOCS_DEFAULT)
}

/**
 * `GRAPH_MIN_EDGE_DOCS`: distinct published documents that must evidence an
 * extracted relation between one PAIR of entities, any type, either direction.
 */
export function graphMinEdgeDocs(): number {
  return positiveIntEnv('GRAPH_MIN_EDGE_DOCS', GRAPH_MIN_EDGE_DOCS_DEFAULT)
}

/** `GRAPH_MIN_COMENTION_DOCS`: shared published documents for a co-mention edge. */
export function graphMinCoMentionDocs(): number {
  return positiveIntEnv('GRAPH_MIN_COMENTION_DOCS', GRAPH_MIN_COMENTION_DOCS_DEFAULT)
}

/** `GRAPH_COMENTION_TOP_K`: co-mention edges kept per node. Capped at {@link MAX_COMENTION_TOP_K}. */
export function graphCoMentionTopK(): number {
  return positiveIntEnv('GRAPH_COMENTION_TOP_K', GRAPH_COMENTION_TOP_K_DEFAULT, MAX_COMENTION_TOP_K)
}

/**
 * Back-compat name for the ENTITY threshold. Every `minSupport` in this file
 * is the entity threshold; the edge threshold rides as `minEdgeSupport`.
 */
export function graphMinSupport(): number {
  return graphMinEntityDocs()
}

/** Hard ceilings, so no caller can ask for the whole corpus in one page. */
/**
 * Entities in the whole-graph view. Owner 2026-10-21: the overview shows
 * everything, so this is a ceiling against a runaway corpus, not a curation.
 */
export const MAX_VIEW_ENTITIES = 1500
/**
 * Edges in the whole-graph view, relation edges first, then co-mentions by
 * weight. Co-mentions are already capped per node by `GRAPH_COMENTION_TOP_K`,
 * so this only bites on a corpus far past the demo's size.
 */
export const MAX_VIEW_EDGES = 6000
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
  /** The ENTITY threshold in force, so the copy can name it without guessing. */
  minSupport: number
  /** The relation-edge threshold in force (`GRAPH_MIN_EDGE_DOCS`). */
  minEdgeSupport: number
  /**
   * Published documents in this ecosistema, ignoring the graph entirely.
   *
   * ⚠ THIS IS WHAT LETS THE UI TELL TWO EMPTY GRAPHS APART. `entities: []` with
   * `hidden: 0` means either "nothing has been published yet" or "everything
   * published is below the threshold", and those need different Spanish.
   */
  publishedDocuments: number
  /**
   * Every above-threshold edge whose BOTH endpoints are in `entities`. What
   * lets `/grafo` draw the whole graph on load instead of one ego network.
   * Capped at {@link MAX_VIEW_EDGES}, strongest first.
   */
  edges: GraphViewEdge[]
}

export interface GraphNeighbour {
  entity: GraphViewEntity
  relationType: GraphRelationType
  /** DISTINCT published documents that evidence THIS EDGE. */
  support: number
  /**
   * DISTINCT published documents evidencing ANY relation between the focal
   * entity and this neighbour — the pair's weight, the same number the
   * overview edge carries. One row per type shares it.
   */
  pairSupport: number
  /**
   * 🔴 WHICH WAY THE EDGE POINTS, SEEN FROM THE FOCAL ENTITY.
   *
   * `out` ⇒ focal → neighbour ("Xoxocotla ubicado_en Morelos", seen from
   * Xoxocotla). `in` ⇒ neighbour → focal (the same row, seen from Morelos).
   * `both` ⇒ rows exist in both directions, or the type is symmetric.
   *
   * ⚠ WITHOUT IT THE PANEL READ EVERY INCOMING EDGE BACKWARDS: Morelos was
   * listed as "está en Xoxocotla" (backlog #16). The stored direction was right;
   * the `CASE WHEN … THEN to ELSE from` that finds the neighbour dropped it.
   */
  direction: GraphEdgeDirection
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

export type GraphEdgeDirection = 'out' | 'in' | 'both'

function toDirection(value: unknown): GraphEdgeDirection {
  return value === 'out' || value === 'in' ? value : 'both'
}

/** What drew an overview edge. */
export type GraphViewEdgeKind = 'relation' | 'co-mention'

/**
 * One edge of the WHOLE-GRAPH view (`/grafo` on load, backlog #3), between two
 * entities the same answer lists. ONE PER UNORDERED PAIR (owner, 2026-10-21):
 * every relation type and both directions fold into it.
 *
 * `relation` ⇒ the extraction drew at least one relation between the pair.
 * `co-mention` ⇒ none did, but published documents mention both.
 */
export interface GraphViewEdge {
  /** The lower of the two entity ids. */
  from: number
  /** The higher of the two entity ids. */
  to: number
  kind: GraphViewEdgeKind
  /**
   * DISTINCT published documents behind the edge: for `relation`, documents
   * evidencing ANY relation of the pair; for `co-mention`, documents
   * mentioning both.
   */
  support: number
  /** Published documents mentioning both ends. Carried on relation edges too. */
  coMentions: number
  /**
   * `relation` only: the type with the most documents (ties: alphabetical),
   * and which way it points from `from` (`out` ⇒ from → to).
   */
  relationType?: GraphRelationType
  direction?: GraphEdgeDirection
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
 * 🔴 GATE 4 — NO LANGUAGE AND NO REDACTION PLACEHOLDER (owner, 2026-10-21).
 *
 * `noise.ts` holds the pattern and the reasoning; the extractor already drops
 * these labels, and THIS hides the rows written before it did. Matched on
 * `canonical_key` — the writer's own accent/case fold — with the pattern bound
 * as a parameter, so JavaScript and Postgres run the same regex text.
 *
 * Every statement gets it either directly on `graph_entities` or through
 * {@link entitySupportCte}, which every edge/neighbour/document statement joins.
 */
function notNoise(alias: 'e' | 'ne'): GraphSql {
  const col = alias === 'e' ? sql`e.canonical_key` : sql`ne.canonical_key`
  return sql` AND NOT (${col} ~ ${GRAPH_NOISE_KEY_PATTERN})`
}

/**
 * 🔴 GATE 5 — A `persona` IS COUNTED ONLY FROM A `documento` (ADR §7.3.4).
 *
 * The extractor already drops every `persona` out of a testimonio or a
 * conversacion (`extract.ts` `dropForbiddenPersonas`, and the response schema
 * has no `persona` for them). This is the read-side belt over it: with the
 * support threshold at 1 (owner, 2026-10-21) a stray row is no longer hidden by
 * needing several documents, so the rule has to hold in SQL as well.
 *
 * Needs `d` (the published-documents join) in scope.
 */
function personaFromDocumentoOnly(alias: 'e' | 'ne' | 'ce'): GraphSql {
  const col = alias === 'e' ? sql`e.type` : alias === 'ne' ? sql`ne.type` : sql`ce.type`
  return sql` AND (${col} <> 'persona' OR d.content_kind = 'documento')`
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
    JOIN graph_entities ne
      ON ne.id = m.entity_id
     AND ne.organization_id = ${organizationId}${notNoise('ne')}${personaFromDocumentoOnly('ne')}
    WHERE m.organization_id = ${organizationId}
    GROUP BY m.entity_id
    HAVING COUNT(DISTINCT m.document_id) >= ${minSupport}`
}

/**
 * 🔴 THE EGO-NETWORK'S EDGE GATE, OVER THE PAIR (owner, 2026-10-21).
 *
 * One row per neighbour of `entityId` whose relations — ANY type, EITHER
 * direction — are evidenced by `>= minEdge` distinct published documents. The
 * same rule as the overview's `rel_pairs` in {@link viewEdgesQuery}, so a pair
 * the map draws is a pair the panel lists, and the other way round.
 */
function neighbourPairsCte(organizationId: number, entityId: number, minEdge: number): GraphSql {
  return sql`
    SELECT CASE WHEN r.from_entity_id = ${entityId} THEN r.to_entity_id
                ELSE r.from_entity_id END AS neighbour_id,
           COUNT(DISTINCT r.document_id)::int AS pair_support
    FROM graph_relations r
    ${joinPublishedDocuments('r', organizationId)}
    WHERE r.organization_id = ${organizationId}
      AND (r.from_entity_id = ${entityId} OR r.to_entity_id = ${entityId})
    GROUP BY 1
    HAVING COUNT(DISTINCT r.document_id) >= ${minEdge}`
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
  /** Relation-edge threshold. Defaults to `GRAPH_MIN_EDGE_DOCS`. */
  minEdgeSupport?: number
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
  const searchFilter = buildSearchFilter(args.q, organizationId)

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
      WHERE e.organization_id = ${organizationId}${notNoise('e')}${personaFromDocumentoOnly('e')}${typeFilter}${searchFilter}
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
  const minEdgeSupport = args.minEdgeSupport ?? graphMinEdgeDocs()
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

  // Only when something is visible: an empty view needs no third round trip.
  const edges: GraphViewEdge[] = []
  if (entities.length > 0) {
    const edgeRows = rowsOf(
      await payload.db.drizzle.execute(
        viewEdgesQuery(
          args.organizationId,
          entities.map((e) => e.id),
          { entity: minSupport, edge: minEdgeSupport },
        ),
      ),
    )
    const seen = new Set<string>()
    for (const row of edgeRows) {
      const a = toId(row.from_id)
      const b = toId(row.to_id)
      if (!a || !b || a === b) continue
      const from = Math.min(a, b)
      const to = Math.max(a, b)
      // One per pair. The statement already guarantees it; this keeps a later
      // edit from shipping a duplicate key to a keyed list.
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
        // The direction is from the row's `from_id`; flip it if the row came
        // back with its ends swapped.
        const direction = toDirection(row.direction)
        edge.direction = a === from ? direction : flipDirection(direction)
      }
      edges.push(edge)
    }
  }

  return {
    entities,
    hidden,
    minSupport,
    minEdgeSupport,
    publishedDocuments: toCount(rowsOf(countResult)[0]?.n),
    edges,
  }
}

function flipDirection(direction: GraphEdgeDirection): GraphEdgeDirection {
  return direction === 'out' ? 'in' : direction === 'in' ? 'out' : 'both'
}

/** The thresholds one statement applies. A bare number sets entity AND edge. */
export interface GraphThresholds {
  entity: number
  edge: number
  /** Co-mention edges only. Default `GRAPH_MIN_COMENTION_DOCS`. */
  coMention?: number
  /** Co-mention edges kept per node. Default `GRAPH_COMENTION_TOP_K`. */
  topK?: number
}

function thresholdsOf(value: number | GraphThresholds): Required<GraphThresholds> {
  const t = typeof value === 'number' ? { entity: value, edge: value } : value
  const topK = Math.floor(Number(t.topK ?? graphCoMentionTopK()))
  return {
    entity: t.entity,
    edge: t.edge,
    coMention: t.coMention ?? graphMinCoMentionDocs(),
    topK: Number.isFinite(topK) ? Math.min(Math.max(1, topK), MAX_COMENTION_TOP_K) : GRAPH_COMENTION_TOP_K_DEFAULT,
  }
}

/**
 * 🔴 THE EDGES OF THE WHOLE-GRAPH VIEW: RELATIONS, THEN CO-MENTIONS, SAME GATES.
 *
 * ── RELATION EDGES, ONE PER PAIR (owner, 2026-10-21) ───────────────────────
 *
 * Every `graph_relations` row between two listed entities is folded onto the
 * unordered pair `(LEAST, GREATEST)` FIRST, and the edge threshold is applied to
 * the pair's distinct published documents (`rel_pairs`). The label is the type
 * with the most documents, ties alphabetical (`rel_types.rn = 1`), with its
 * direction seen from the lower id. The ego-network panel applies the SAME pair
 * threshold ({@link entityNeighboursQuery}), so the map and the panel agree
 * about which pairs are connected.
 *
 * ── CO-MENTION EDGES, AT QUERY TIME ────────────────────────────────────────
 *
 * Two entities mentioned in the same published document are linked
 * (`co_all`), weighted by the published documents they share. Computed here
 * from `graph_mentions` rather than cached: a materialised view would need a
 * refresh on every publish and every extraction, and would hold draft rows the
 * published-only gate must filter anyway. The self-join is per document, so it
 * costs Σ (entities per document)² — measured in the lane report on the local
 * corpus (`EXPLAIN ANALYZE`).
 *
 * 🔴 THE CO-MENTION SIDE CARRIES EVERY GATE THE RELATION SIDE DOES: tenant and
 * published on the join to `documents`; noise labels and the entity threshold
 * through `listed` (which is `ent_support`); and — belt over the extractor's
 * `dropForbiddenPersonas` — no `persona` mention counted from anything but a
 * `documento`.
 *
 * ⚠ TOP-K PER NODE (`GRAPH_COMENTION_TOP_K`). Each node nominates its K
 * strongest co-mention partners (ties: the lower id); a pair is kept when
 * EITHER end nominates it. A k-nearest-neighbour graph, chosen (review): no
 * entity loses all its co-mentions to a hub, at the cost that a hub can exceed
 * K. A pair that already has a relation edge is drawn as that edge, carries the
 * co-mention weight in `co_mentions`, and takes no top-K slot.
 *
 * ⚠ NO SQL COMMENT IN THE STATEMENT: `queries.test.ts` greps the text for the
 * gates, and a comment could pass the audit on prose alone.
 */
export function viewEdgesQuery(
  organizationId: number,
  entityIds: readonly number[],
  thresholds: number | GraphThresholds,
  limit = MAX_VIEW_EDGES,
): GraphSql {
  const t = thresholdsOf(thresholds)
  const ids = entityIds.map((id) => Math.trunc(Number(id))).filter((id) => Number.isFinite(id))
  return sql`
    WITH ent_support AS (${entitySupportCte(organizationId, t.entity)}),
    listed AS (
      SELECT s.entity_id AS entity_id
      FROM ent_support s
      WHERE s.entity_id = ANY(${intArray(ids)})
    ),
    rel AS (
      SELECT LEAST(r.from_entity_id, r.to_entity_id) AS a,
             GREATEST(r.from_entity_id, r.to_entity_id) AS b,
             r.from_entity_id AS from_id,
             r.type AS relation_type,
             r.document_id AS document_id
      FROM graph_relations r
      ${joinPublishedDocuments('r', organizationId)}
      JOIN listed lf ON lf.entity_id = r.from_entity_id
      JOIN listed lt ON lt.entity_id = r.to_entity_id
      WHERE r.organization_id = ${organizationId}
        AND r.from_entity_id <> r.to_entity_id
    ),
    rel_pairs AS (
      SELECT rel.a AS a, rel.b AS b, COUNT(DISTINCT rel.document_id)::int AS support
      FROM rel
      GROUP BY rel.a, rel.b
      HAVING COUNT(DISTINCT rel.document_id) >= ${t.edge}
    ),
    rel_types AS (
      SELECT rel.a AS a,
             rel.b AS b,
             rel.relation_type AS relation_type,
             CASE WHEN BOOL_AND(rel.from_id = rel.a) THEN 'out'
                  WHEN BOOL_AND(rel.from_id = rel.b) THEN 'in'
                  ELSE 'both' END AS direction,
             ROW_NUMBER() OVER (
               PARTITION BY rel.a, rel.b
               ORDER BY COUNT(DISTINCT rel.document_id) DESC, rel.relation_type ASC
             ) AS rn
      FROM rel
      GROUP BY rel.a, rel.b, rel.relation_type
    ),
    ment AS (
      SELECT DISTINCT m.document_id AS document_id, m.entity_id AS entity_id
      FROM graph_mentions m
      ${joinPublishedDocuments('m', organizationId)}
      JOIN listed l ON l.entity_id = m.entity_id
      JOIN graph_entities ce
        ON ce.id = m.entity_id
       AND ce.organization_id = ${organizationId}
      WHERE m.organization_id = ${organizationId}${personaFromDocumentoOnly('ce')}
    ),
    co_all AS (
      SELECT x.entity_id AS a, y.entity_id AS b, COUNT(DISTINCT x.document_id)::int AS weight
      FROM ment x
      JOIN ment y ON y.document_id = x.document_id AND y.entity_id > x.entity_id
      GROUP BY x.entity_id, y.entity_id
    ),
    co_only AS (
      SELECT c.a AS a, c.b AS b, c.weight AS weight
      FROM co_all c
      LEFT JOIN rel_pairs rp ON rp.a = c.a AND rp.b = c.b
      WHERE rp.a IS NULL AND c.weight >= ${t.coMention}
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
      SELECT rp.a AS from_id, rp.b AS to_id, 'relation' AS kind, 0 AS kind_rank,
             rp.support AS support, COALESCE(c.weight, 0)::int AS co_mentions,
             rt.relation_type AS relation_type, rt.direction AS direction
      FROM rel_pairs rp
      JOIN rel_types rt ON rt.a = rp.a AND rt.b = rp.b AND rt.rn = 1
      LEFT JOIN co_all c ON c.a = rp.a AND c.b = rp.b
      UNION ALL
      SELECT k.a, k.b, 'co-mention', 1, k.weight, k.weight, NULL, NULL
      FROM co_kept k
    )
    SELECT e.from_id AS from_id, e.to_id AS to_id, e.kind AS kind, e.support AS support,
           e.co_mentions AS co_mentions, e.relation_type AS relation_type,
           e.direction AS direction
    FROM out_edges e
    JOIN ent_support fs ON fs.entity_id = e.from_id
    JOIN ent_support ts ON ts.entity_id = e.to_id
    ORDER BY e.kind_rank ASC, e.support DESC, e.from_id ASC, e.to_id ASC
    LIMIT ${clampLimit(limit, MAX_VIEW_EDGES, MAX_VIEW_EDGES)}`
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
  /** Relation-edge threshold, over the PAIR. Defaults to `GRAPH_MIN_EDGE_DOCS`. */
  minEdgeSupport?: number
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
    WHERE e.organization_id = ${organizationId}${notNoise('e')}${personaFromDocumentoOnly('e')}
      AND e.id = ${entityId}
    GROUP BY e.id, e.type, e.label
    HAVING COUNT(DISTINCT m.document_id) >= ${minSupport}`
}

/**
 * One hop out of an entity.
 *
 * ⚠ TWO THRESHOLDS, NOT ONE. The PAIR needs `>= GRAPH_MIN_EDGE_DOCS` distinct
 * published documents evidencing any relation between the two (`pairs` — one
 * rule with the overview, see {@link neighbourPairsCte}), and the NEIGHBOUR needs
 * `>= GRAPH_MIN_ENTITY_DOCS` published documents mentioning it (`ent_support`).
 * Each per-type row then carries both its own `edge_support` and the pair's. In practice the writer
 * always creates a mention alongside a relation endpoint, so the second is
 * usually implied — "usually" is not a privacy guarantee, and a neighbour is a
 * node the caller can see.
 */
export function entityNeighboursQuery(args: EntityDetailArgs): GraphSql {
  const { organizationId, entityId } = args
  const minSupport = args.minSupport ?? graphMinSupport()
  const minEdge = args.minEdgeSupport ?? graphMinEdgeDocs()
  const limit = clampLimit(args.neighbourLimit, MAX_NEIGHBOURS, MAX_NEIGHBOURS)

  return sql`
    WITH ent_support AS (${entitySupportCte(organizationId, minSupport)}),
    pairs AS (${neighbourPairsCte(organizationId, entityId, minEdge)}),
    edges AS (
      SELECT CASE WHEN r.from_entity_id = ${entityId} THEN r.to_entity_id
                  ELSE r.from_entity_id END AS neighbour_id,
             r.type AS relation_type,
             COUNT(DISTINCT r.document_id)::int AS support,
             CASE WHEN BOOL_AND(r.from_entity_id = ${entityId}) THEN 'out'
                  WHEN BOOL_AND(r.to_entity_id = ${entityId}) THEN 'in'
                  ELSE 'both' END AS direction
      FROM graph_relations r
      ${joinPublishedDocuments('r', organizationId)}
      WHERE r.organization_id = ${organizationId}
        AND (r.from_entity_id = ${entityId} OR r.to_entity_id = ${entityId})
      GROUP BY 1, 2
    )
    SELECT e.id AS id,
           e.type AS type,
           e.label AS label,
           s.support AS support,
           edges.relation_type AS relation_type,
           edges.support AS edge_support,
           pairs.pair_support AS pair_support,
           edges.direction AS direction
    FROM edges
    JOIN pairs ON pairs.neighbour_id = edges.neighbour_id
    JOIN graph_entities e
      ON e.id = edges.neighbour_id
     AND e.organization_id = ${organizationId}
    JOIN ent_support s ON s.entity_id = e.id
    WHERE e.id <> ${entityId}
    ORDER BY pairs.pair_support DESC, edges.support DESC, s.support DESC, e.label ASC,
             edges.relation_type ASC
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
 * TWICE, exactly as in {@link entityNeighboursQuery}: the PAIR needs
 * `>= GRAPH_MIN_EDGE_DOCS` distinct published documents evidencing any relation
 * between the two (`pairs`, {@link neighbourPairsCte}), and the NEIGHBOUR needs
 * `>= GRAPH_MIN_ENTITY_DOCS` published documents mentioning it (`ent_support`).
 *
 * ⚠ At the default of 1 (owner, 2026-10-21) a list CAN point at one document.
 * The owner accepted that because entity names are anonymised upstream; the
 * snippet and title gates below still hold.
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
  const minEdge = args.minEdgeSupport ?? graphMinEdgeDocs()
  const neighbourLimit = clampLimit(args.neighbourLimit, MAX_NEIGHBOURS, MAX_NEIGHBOURS)
  const perEdge = clampLimit(args.edgeDocumentLimit, MAX_EDGE_DOCUMENTS, MAX_EDGE_DOCUMENTS)

  // ⚠ The overall ceiling is derived, not guessed: no more rows than the answer
  // can hold, whatever the two caps are set to.
  const total = neighbourLimit * perEdge

  return sql`
    WITH ent_support AS (${entitySupportCte(organizationId, minSupport)}),
    pairs AS (${neighbourPairsCte(organizationId, entityId, minEdge)}),
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
      JOIN pairs ON pairs.neighbour_id = ev.neighbour_id
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
      pairSupport: toCount(row.pair_support ?? row.edge_support),
      direction: toDirection(row.direction),
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
    WHERE e.organization_id = ${organizationId}${notNoise('e')}${personaFromDocumentoOnly('e')}
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

// ---------------------------------------------------------------------------
// Seeding a CATEGORY question (ADR §19 — the measured defect)
// ---------------------------------------------------------------------------

/**
 * 🔴 WHY THIS EXISTS, AND WHAT WAS MEASURED BEFORE IT DID.
 *
 * `matchEntitiesToQuery` above tests ONE direction of containment: the entity's
 * key must appear inside the question. That is exactly right for a **local**
 * question, which names its subject — *"¿qué lengua habla Efrén Peralta
 * Guzmán…"*. It cannot fire on a **global** question, which names a CATEGORY —
 * *"¿qué centros de salud aparecen en varios documentos?"* — because
 * `Centro de Salud de Tlayacapan` is not a substring of that sentence.
 *
 * The evaluation of 2026-09-05 (ADR §19, `src/eval/RESULTS.md`) measured the
 * cost of that: 6 of 10 global questions matched zero entities, the matcher
 * never reached 2 seeds out of a budget of {@link MAX_RETRIEVE_SEEDS} = 8, and
 * **0 of the 55 expected global facts were ever reached as a seed** — while 52
 * of those 55 sat in the graph above the support threshold. The graph was being
 * asked what recurs across documents by a matcher that required the asker to
 * already name the thing that recurs.
 *
 * ── THREE TIERS, ALL PURE ──────────────────────────────────────────────────
 *
 * ⚠ ADR §8.1 chose a pure, synchronous matcher — no I/O, no model call — so the
 * graph leg can run concurrently with the vector retrieve. **That property is
 * kept.** Everything below is string work over the candidate rows
 * {@link matchableEntitiesQuery} already returned. No new statement, no new
 * round trip, and therefore nothing new to register in the gate test.
 *
 *  1. **Literal.** {@link matchEntitiesToQuery}, unchanged and still first.
 *  2. **Category containment.** The same literal test run the OTHER way: a
 *     contiguous n-gram of the question's content words, singularised, appearing
 *     inside an entity's key. This is what turns *"centros de salud"* into the
 *     three hospital entities.
 *  3. **Type anchor.** When the question's interrogative phrase is HEADED by a
 *     plural noun naming an entity type — *"¿Qué **personas** concretas…"* — the
 *     remaining seed slots are filled with that type's highest-support entities.
 *
 * ── WHAT WAS REJECTED, WITH THE MEASUREMENT THAT REJECTED IT ───────────────
 *
 * · **An embedding lookup over entity labels** (`/v1/embed`, `bge-m3`). Built
 *   and measured on the same 10 global questions: it reached **5 of 55** facts,
 *   worse than either tier here, and it never surfaced a single one of the
 *   eleven languages for *"lenguas indígenas"*. Bare entity labels are one to
 *   four words with no context; cosine over them is close to noise (every score
 *   in 0.40–0.57). It would also have cost a round trip per turn and a stored
 *   vector per entity. Not worth it, and that is a measurement, not a guess.
 * · **Seeding from the entities of the documents plain retrieval returned.**
 *   Measured at topK 5 and 12: **9 and 11 of 55**. It also serialises the graph
 *   leg behind the vector retrieve, which is the one thing §8.1's concurrency
 *   was for. Rejected on both counts.
 *
 * ⚠ **WHAT THIS STILL CANNOT DO, STATED PLAINLY.** A category with no lexical
 * bridge to its members stays unreachable. *"¿Qué lenguas indígenas hablan…"*
 * still seeds none of `náhuatl`, `mixteco`, `mazateco`: no label contains
 * "lengua", no relation types them as languages, and their support puts them in
 * the middle of the `tema` distribution. That question is answered by the
 * `lengua` column (ADR §18.5), not by the graph, and no seeding rule changes it.
 */

/** How many tokens a query n-gram may span. Beyond four it matches nothing. */
const MAX_QUERY_GRAM_TOKENS = 4

/** Shortest query n-gram worth matching, in characters. Same reason as {@link MIN_MATCH_CHARS}. */
const MIN_GRAM_CHARS = 4

/**
 * Spanish function words plus the boilerplate of an instruction.
 *
 * ⚠ This is a STOP LIST, not a stemmer. Its only job is to stop tier 2 from
 * building n-grams out of "que", "en", "los" — grams that would match half the
 * corpus. A word wrongly present here costs one missed n-gram; a word wrongly
 * absent costs a noisy seed. Both are recoverable, which is why a crude list is
 * the right size of tool.
 */
const QUERY_STOPWORDS: ReadonlySet<string> = new Set(
  (
    'a al ante aparece aparecen aqui asi aun aunque cada como con contra cual cuales ' +
    'cuando cuanta cuantas cuanto cuantos de del desde donde dos e el ella ellas ello ' +
    'ellos en entre era eran es esa esas ese eso esos esta estan estas este esto estos ' +
    'fue fueron ha hace hacen hacia han hasta hay la las le les lo los mas me mi ' +
    'mientras mucho muchos muy nada ni no nos o os otra otras otro otros para pero poco ' +
    'por porque que quien quienes se segun ser si sin sobre solo son su sus tambien tan ' +
    'tanto te tiene tienen toda todas todo todos tras un una unas uno unos varias varios ' +
    'y ya documento documentos publicado publicados enumera enumeralos enumeralas nombra ' +
    'nombralos nombralas menciona mencionan mencionado mencionados mencionada mencionadas ' +
    'distinto distintos distinta distintas concreto concreta concretos concretas repite ' +
    'repiten repitan comparten cuentan vienen viene hablan habla dice dicen'
  ).split(' '),
)

/**
 * The nouns a person uses to name an entity TYPE rather than an entity.
 *
 * ⚠ Deliberately a closed list per type, not a rule. The five types are a closed
 * set (`GraphEntityType`), and a rule that guessed hypernyms would eventually
 * decide "centro" means `lugar` and seed every place name in the corpus.
 */
const TYPE_NOUNS: ReadonlyArray<readonly [GraphEntityType, readonly string[]]> = [
  ['persona', ['persona', 'gente', 'vecino', 'habitante', 'nombre']],
  [
    'lugar',
    ['lugar', 'comunidad', 'pueblo', 'municipio', 'localidad', 'colonia', 'barrio', 'region', 'sitio', 'zona'],
  ],
  ['evento', ['evento', 'jornada', 'actividad', 'feria', 'taller', 'suceso', 'encuentro']],
  [
    'organizacion',
    ['organizacion', 'institucion', 'centro', 'hospital', 'escuela', 'clinica', 'sede', 'dependencia', 'programa', 'colectivo', 'asociacion'],
  ],
  ['tema', ['tema', 'preocupacion', 'asunto', 'problema', 'practica', 'herramienta', 'concepto', 'idea']],
]

/**
 * The types tier 3 may fill seed slots with.
 *
 * 🔴 `tema` AND `lugar` ARE DELIBERATELY ABSENT, and this was measured, not
 * assumed. Tier 3 ranks by support, and for these two types the highest-support
 * members are the corpus's ambient hubs — `Morelos` (81 documents), `Cuernavaca`
 * (56), `español` (38) — not answers. On the 10 global questions, allowing them
 * bought **one** extra fact and spent **22** seed slots on hubs. For `persona`,
 * `organizacion` and `evento` the top of the distribution IS the set of
 * recurring named things a global question asks for: it bought **7** facts.
 */
const TYPE_ANCHORABLE: ReadonlyArray<GraphEntityType> = ['persona', 'organizacion', 'evento']

/** Question words after which the head noun says what kind of thing is wanted. */
const INTERROGATIVES: ReadonlySet<string> = new Set(['que', 'cual', 'cuales', 'quien', 'quienes'])

/** How far past the question word to look for that head noun. */
const TYPE_HEAD_WINDOW = 3

/** Canonicalise, then split on anything that is not a letter or digit. */
function queryTokens(text: string): string[] {
  return canonicalKey(text)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) => token !== '')
}

/**
 * A crude Spanish singulariser: `centros` → `centro`, `hospitales` → `hospital`.
 *
 * ⚠ Applied to BOTH sides, so it never has to be right in an absolute sense —
 * only consistent. `lunes` → `lun` on both sides still compares equal. What it
 * must not do is collapse a short word, hence the length guards.
 */
function singularise(token: string): string {
  if (token.length > 4 && token.endsWith('es')) return token.slice(0, -2)
  if (token.length > 3 && token.endsWith('s')) return token.slice(0, -1)
  return token
}

/** Is this token a plural? The signal that the asker wants a SET, not one thing. */
function isPlural(token: string): boolean {
  return singularise(token) !== token
}

/**
 * Every contiguous n-gram of the query's content words, singularised, longest
 * first. `¿Qué centros de salud…` yields `centro de salud`, `centro de`,
 * `de salud`, `centro`, `salud`.
 */
function queryGrams(query: string): string[] {
  const tokens = queryTokens(query)
    .filter((token) => token.length >= MIN_MATCH_CHARS && !QUERY_STOPWORDS.has(token))
    .map(singularise)
  const grams: string[] = []
  for (let n = Math.min(MAX_QUERY_GRAM_TOKENS, tokens.length); n >= 1; n -= 1) {
    for (let i = 0; i + n <= tokens.length; i += 1) {
      const gram = tokens.slice(i, i + n).join(' ')
      if (gram.length >= MIN_GRAM_CHARS) grams.push(gram)
    }
  }
  return grams
}

/** An entity key as singularised, space-delimited tokens, padded for boundary tests. */
function singularisedKey(entity: MatchableEntity): string {
  const spaced = tokenSpaced(entity.canonicalKey || canonicalKey(entity.label))
  if (spaced === '') return ''
  return ` ${spaced.trim().split(' ').map(singularise).join(' ')} `
}

/**
 * TIER 2 — the entities whose LABEL contains a phrase from the question.
 *
 * The mirror image of {@link matchEntitiesToQuery}. Ranked by how many tokens
 * of the question the label absorbed (a three-token hit is a far better seed
 * than a one-token one), then by support.
 *
 * When the question also names a type, the pool is narrowed to it — otherwise
 * *"¿qué personas…"* seeds the `tema` node `personas sordas` instead of a person.
 */
export function categoryMatchEntities(
  entities: readonly MatchableEntity[],
  query: string,
  types: readonly GraphEntityType[] = [],
): MatchableEntity[] {
  const grams = queryGrams(query)
  if (grams.length === 0) return []
  const pool = types.length > 0 ? entities.filter((e) => types.includes(e.type)) : entities

  const hits: { entity: MatchableEntity; tokens: number }[] = []
  for (const entity of pool) {
    const key = singularisedKey(entity)
    if (key === '') continue
    let widest = 0
    for (const gram of grams) {
      if (key.includes(` ${gram} `)) widest = Math.max(widest, gram.split(' ').length)
    }
    if (widest > 0) hits.push({ entity, tokens: widest })
  }

  hits.sort(
    (a, b) =>
      b.tokens - a.tokens ||
      b.entity.support - a.entity.support ||
      a.entity.label.localeCompare(b.entity.label, 'es'),
  )
  return hits.map((hit) => hit.entity)
}

/**
 * The entity types this question asks for, if any.
 *
 * `strict` demands the type noun be PLURAL and HEAD an interrogative phrase —
 * *"¿Qué **personas** concretas…"*. That is the shape of a question asking for a
 * set, and it is what separates a global question from a local one: *"¿qué
 * lengua habla X, de qué comunidad viene y en qué lugar colabora?"* names three
 * type nouns and every one of them is singular, so nothing fires.
 *
 * ⚠ Without `strict` the noun may sit anywhere, which is right for narrowing
 * tier 2's pool and WRONG for tier 3 — in *"¿Qué lenguas indígenas hablan las
 * personas…"* the word `personas` is the subject of the sentence, not the thing
 * being asked for, and filling eight slots with people is the noise this rule
 * exists to prevent.
 */
export function queryEntityTypes(query: string, strict: boolean): GraphEntityType[] {
  const tokens = queryTokens(query)
  const wanted = new Set<string>()

  if (strict) {
    tokens.forEach((token, index) => {
      if (!INTERROGATIVES.has(token)) return
      for (const head of tokens.slice(index + 1, index + 1 + TYPE_HEAD_WINDOW)) {
        if (QUERY_STOPWORDS.has(head) || !isPlural(head)) continue
        wanted.add(singularise(head))
      }
    })
  } else {
    for (const token of tokens) wanted.add(singularise(token))
  }
  if (wanted.size === 0) return []

  return TYPE_NOUNS.filter(
    ([type, nouns]) =>
      (!strict || TYPE_ANCHORABLE.includes(type)) && nouns.some((noun) => wanted.has(noun)),
  ).map(([type]) => type)
}

/**
 * The seed set for one turn: literal first, then category, then type anchor.
 *
 * This is what {@link readGraphRetrieval} calls. {@link matchEntitiesToQuery}
 * stays exactly as it was and stays the first tier — a question that names its
 * subject still seeds from that subject, and the later tiers only ever fill
 * slots the literal tier left empty.
 *
 * Pure and synchronous, like the tier it wraps. Measured at ~0.65 ms per call
 * over 221 candidates against ~0.17 ms for the literal tier alone — half a
 * millisecond on a graph leg whose median is 78 ms.
 */
export function seedEntitiesForQuery(
  entities: readonly MatchableEntity[],
  query: string,
  limit = MAX_RETRIEVE_SEEDS,
): MatchableEntity[] {
  const cap = Math.max(0, limit)
  const seeds = matchEntitiesToQuery(entities, query, cap)
  if (seeds.length >= cap) return seeds

  const chosen = new Set(seeds.map((entity) => entity.id))
  const add = (entity: MatchableEntity): void => {
    if (seeds.length >= cap || chosen.has(entity.id)) return
    chosen.add(entity.id)
    seeds.push(entity)
  }

  for (const entity of categoryMatchEntities(entities, query, queryEntityTypes(query, false))) {
    add(entity)
  }

  const anchored = queryEntityTypes(query, true)
  if (anchored.length > 0) {
    const ranked = entities
      .filter((entity) => anchored.includes(entity.type))
      .sort((a, b) => b.support - a.support || a.label.localeCompare(b.label, 'es'))
    for (const entity of ranked) add(entity)
  }

  return seeds
}

/**
 * A list of integer ids as a Postgres `int[]` expression: `ARRAY[$6, $7]::int[]`.
 *
 * 🔴 WHY NOT `${ids}::int[]`. Drizzle's `sql` tag does not bind a JS array as
 * ONE parameter — it expands it into `($6, $7, …)`. One id then fails with
 * `malformed array literal`, two or more with `cannot cast type record to
 * integer[]`. That shipped, and `POST /api/graph/retrieve` answered HTTP 500 for
 * every query that matched an entity (measured 2026-10-17). `queries.pg.test.ts`
 * runs these statements through the real driver to keep it fixed.
 *
 * Each id is its own scalar parameter, so nothing is inlined. An empty list
 * renders `ARRAY[]::int[]`, which Postgres accepts and `ANY` treats as no match.
 */
function intArray(ids: readonly number[]): GraphSql {
  return sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::int[]`
}

/**
 * One hop out of a set of seed entities, both endpoints above threshold.
 *
 * ⚠ `= ANY(${intArray(ids)})` rather than a built-up `IN (…)` list. The ids
 * come from our own previous query, so either would be safe — but a hand-built
 * `IN` list is the shape somebody later copies for a value that did NOT come
 * from us. 🔴 Never interpolate the JS array itself: see {@link intArray}.
 */
export function retrieveEdgesQuery(
  organizationId: number,
  seedIds: readonly number[],
  thresholds: number | GraphThresholds,
  limit = MAX_RETRIEVE_EDGES,
): GraphSql {
  const t = thresholdsOf(thresholds)
  const ids = seedIds.map((id) => Math.trunc(Number(id))).filter((id) => Number.isFinite(id))
  return sql`
    WITH ent_support AS (${entitySupportCte(organizationId, t.entity)}),
    edges AS (
      SELECT r.from_entity_id AS from_id,
             r.to_entity_id AS to_id,
             r.type AS relation_type,
             COUNT(DISTINCT r.document_id)::int AS support
      FROM graph_relations r
      ${joinPublishedDocuments('r', organizationId)}
      WHERE r.organization_id = ${organizationId}
        AND (r.from_entity_id = ANY(${intArray(ids)}) OR r.to_entity_id = ANY(${intArray(ids)}))
      GROUP BY 1, 2, 3
      HAVING COUNT(DISTINCT r.document_id) >= ${t.edge}
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
      AND m.entity_id = ANY(${intArray(ids)})
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
  /** Per-relation-type threshold for the one-hop expansion. Default `GRAPH_MIN_EDGE_DOCS`. */
  minEdgeSupport?: number
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
  const minEdge = args.minEdgeSupport ?? graphMinEdgeDocs()
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

  const seeds = seedEntitiesForQuery(candidates, args.query, seedLimit)
  if (seeds.length === 0) return empty

  const seedIds = seeds.map((entity) => entity.id)
  const [edgeResult, documentResult] = await Promise.all([
    payload.db.drizzle.execute(
      retrieveEdgesQuery(args.organizationId, seedIds, { entity: minSupport, edge: minEdge }),
    ),
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

/** Longest `q` worth searching; the web caps its box at 120. */
export const MAX_SEARCH_CHARS = 200

/**
 * Accented letters folded for the accent-blind half of the full-text match.
 * `Ñ` → `ñ` because `to_tsvector` lowercases with the database's ctype, which
 * may be `C` (ASCII only).
 */
const ACCENTED = 'áéíóúüÁÉÍÓÚÜÑ'
const UNACCENTED = 'aeiouuAEIOUUñ'

/**
 * 🔴 THE TEXT A DOCUMENT CONTRIBUTES TO SEARCH = THE TEXT IT CONTRIBUTES TO THE
 * CORPUS. The SQL mirror of `corpusTextFor` (`lib/anonymiseDocument.ts`): a
 * `documento` searches its `extracted_text`; anything else searches its
 * `redacted_text`, and only once the gate (or a human) has cleared it.
 *
 * ⚠ NEVER `extracted_text` FOR GATED CONTENT. The raw transcript of a
 * testimonio still holds the names the gate removed; matching against it would
 * turn the search box into an oracle ("does any Voz mention Juana Pérez?").
 */
const SEARCHABLE_TEXT = sql`coalesce(CASE
      WHEN sd.content_kind = 'documento' THEN sd.extracted_text
      WHEN sd.anonymisation_status IN ('ready', 'approved') THEN sd.redacted_text
    END, '')`

/**
 * The `q=` filter: an entity matches if its NAME contains the text, or if it
 * is mentioned by a published document of this ecosistema whose TEXT matches
 * (backlog #31, `/grafo` search).
 *
 * ── Text ──
 * Postgres full-text search with the `spanish` config ("migraciones" stems to
 * "migr"); `websearch_to_tsquery`, so quotes and `-palabra` work and stray
 * punctuation cannot raise a syntax error. Two vectors, OR-ed: as written (the
 * stemmer's suffixes are accented, so "migración" finds "migraciones") and
 * accent-folded on both sides (so "migracion" finds "migración").
 *
 * 🔴 SAME GATES AS EVERY OTHER STATEMENT. The documents are this ecosistema's
 * and published, and their text is {@link SEARCHABLE_TEXT}. The entity still
 * goes through the outer statement's support threshold and noise/persona
 * gates, so search can only narrow the visible graph, never widen it.
 *
 * ⚠ No index: the vectors are built per query. Fine at today's corpus size
 * (see the commit that added this); a stored `tsvector` column is the next step.
 *
 * ── Name ──
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
function buildSearchFilter(q: string | null | undefined, organizationId: number): GraphSql {
  const raw = typeof q === 'string' ? q.trim().slice(0, MAX_SEARCH_CHARS) : ''
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
    OR e.id IN (
      SELECT sm.entity_id
      FROM graph_mentions sm
      JOIN documents sd
        ON sd.id = sm.document_id
       AND sd.organization_id = ${organizationId}
       AND sd.publication_status = 'published'
      WHERE sm.organization_id = ${organizationId}
        AND (
          to_tsvector('spanish', ${SEARCHABLE_TEXT}) @@ websearch_to_tsquery('spanish', ${raw})
          OR to_tsvector('spanish', translate(${SEARCHABLE_TEXT}, ${ACCENTED}, ${UNACCENTED}))
             @@ websearch_to_tsquery('spanish', translate(${raw}, ${ACCENTED}, ${UNACCENTED}))
        )
    )
  )`
}
