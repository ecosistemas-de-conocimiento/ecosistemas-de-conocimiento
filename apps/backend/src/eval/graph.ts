/**
 * The GraphRAG leg, as the ADR designs it — reproduced so it can be measured.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴 THE SHIPPED PATH DOES NOT WORK, AND THAT IS WHY THIS FILE EXISTS
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `POST /api/graph/retrieve` returns **HTTP 500 for every query that matches at
 * least one entity**. Measured against the running `edc-backend-1` on
 * 2026-09-04; see `RESULTS.md` §1 for the two Postgres errors and the reproduction.
 *
 * The cause is in `retrieveEdgesQuery` / `retrieveDocumentsQuery`
 * (`lib/graph/queries.ts`): they bind a JS array into `= ANY(${ids}::int[])`,
 * and drizzle's `sql` tag does not bind an array as ONE array parameter — it
 * expands it into a parenthesised list of scalar placeholders. One seed renders
 * `ANY(($6)::int[])` with `$6 = 160` → `malformed array literal: "160"`; two or
 * more render `ANY(($6, $7)::int[])` → `cannot cast type record to integer[]`.
 * The SQL TEXT is correct; only the parameter binding is wrong.
 *
 * The web provider treats a non-2xx as "the graph had nothing", deliberately
 * without even a log line (`apps/web/src/lib/server/graph.ts:fetchGraphRetrieval`),
 * and `prepareTurn` wraps the provider in `.catch(() => null)`. So today the
 * graph contributes exactly nothing, silently, on every turn.
 *
 * ⚠ CONSEQUENCE FOR THE MEASUREMENT, STATED ONCE AND REPEATED IN THE REPORT:
 * the "with graph" arm here measures **GraphRAG as designed**, not GraphRAG as
 * currently shipped. As shipped, the two arms are byte-identical by
 * construction — no chunks, no block, `fuseMatches(vector, [])` is the plain
 * score sort, and `buildChatTurn` is called without `graphContext`.
 *
 * ── WHAT IS PRODUCTION CODE HERE AND WHAT IS A COPY ─────────────────────────
 *
 * Production, imported and unmodified:
 *   · `matchableEntitiesQuery`, `retrieveEdgesQuery`, `retrieveDocumentsQuery`
 *     — the SQL itself, including all three gates (org, published, min support)
 *   · `seedEntitiesForQuery`  — the whole seed-matching algorithm (all three tiers)
 *   · `expansionTerms`        — the neighbour labels used to widen the query
 *   · `graphMinSupport`, `toCount`, `contentKindOf`, `titleFor`
 *
 * Copied, because `apps/backend` cannot import `apps/web`'s `$lib`:
 *   · `foldText`, `expandGraphQuery`, `graphContextParagraph` and the three
 *     copy helpers it uses. `graph.copy.test.ts` pins them against the cases
 *     `apps/web/src/lib/graph.test.ts` asserts.
 *
 * Changed, and ONLY this:
 *   · the array parameter is inlined as `ARRAY[…]` (`db.ts:inlineParams`)
 *     instead of being bound. That is the defect above, routed around.
 */

import {
  MAX_RETRIEVE_SEEDS,
  expansionTerms,
  graphMinSupport,
  seedEntitiesForQuery,
  matchableEntitiesQuery,
  retrieveDocumentsQuery,
  retrieveEdgesQuery,
  toCount,
  type MatchableEntity,
} from '../lib/graph/queries'
import { contentKindOf, titleFor, type ContentKind } from '../lib/contentKind'
import type { GraphEntityType, GraphRelationType } from '../lib/graph/types'
import { selectJson, toExecutableSql } from './db'
import type { EvalEnv } from './env'

// ── The shapes `POST /api/graph/retrieve` answers with ─────────────────────

export interface GraphViewEntity {
  id: number
  type: GraphEntityType
  label: string
  support: number
}
export interface GraphEdge {
  from: GraphViewEntity
  to: GraphViewEntity
  relationType: GraphRelationType
  support: number
}
export interface GraphDocumentRef {
  id: number
  title: string
  contentKind: ContentKind
}
export interface GraphRetrieval {
  entities: GraphViewEntity[]
  edges: GraphEdge[]
  documents: GraphDocumentRef[]
  terms: string[]
}

/** `MAX_QUERY_CHARS` in `apps/backend/src/endpoints/graph.ts`. Semantic, so reproduced. */
const MAX_QUERY_CHARS = 2000

/**
 * `readGraphRetrieval`, executed correctly.
 *
 * Same three statements, same order, same short-circuit on zero seeds. The only
 * difference from `lib/graph/queries.ts:readGraphRetrieval` is the transport.
 */
export async function readGraphRetrieval(
  env: EvalEnv,
  args: { organizationId: number; query: string; limit?: number },
): Promise<GraphRetrieval> {
  const minSupport = graphMinSupport()
  const seedLimit = Math.min(args.limit ?? MAX_RETRIEVE_SEEDS, MAX_RETRIEVE_SEEDS)
  const empty: GraphRetrieval = { entities: [], edges: [], documents: [], terms: [] }

  const query = args.query.trim().slice(0, MAX_QUERY_CHARS)
  if (query === '') return empty

  const candidateRows = await selectJson<Record<string, unknown>>(
    env,
    env.backendDb,
    toExecutableSql(matchableEntitiesQuery(args.organizationId, minSupport)),
  )
  const candidates: MatchableEntity[] = candidateRows.map((row) => ({
    id: Number(row.id),
    type: String(row.type) as GraphEntityType,
    label: String(row.label ?? ''),
    support: toCount(row.support),
    canonicalKey: String(row.canonical_key ?? ''),
  }))

  const seeds = seedEntitiesForQuery(candidates, query, seedLimit)
  if (seeds.length === 0) return empty

  const seedIds = seeds.map((entity) => entity.id)
  const [edgeRows, documentRows] = await Promise.all([
    selectJson<Record<string, unknown>>(
      env,
      env.backendDb,
      toExecutableSql(retrieveEdgesQuery(args.organizationId, seedIds, minSupport)),
    ),
    selectJson<Record<string, unknown>>(
      env,
      env.backendDb,
      toExecutableSql(retrieveDocumentsQuery(args.organizationId, seedIds, minSupport)),
    ),
  ])

  const edges: GraphEdge[] = edgeRows.map((row) => ({
    from: {
      id: Number(row.from_id),
      type: String(row.from_type) as GraphEntityType,
      label: String(row.from_label ?? ''),
      support: toCount(row.from_support),
    },
    to: {
      id: Number(row.to_id),
      type: String(row.to_type) as GraphEntityType,
      label: String(row.to_label ?? ''),
      support: toCount(row.to_support),
    },
    relationType: String(row.relation_type) as GraphRelationType,
    support: toCount(row.support),
  }))

  // `mapDocumentRow(row, false)` — the privacy gate on titles. A testimonio is
  // "Testimonio", never the free text an uploader typed. Not reachable in this
  // corpus (no published testimonio carries content), but it is the rule.
  const documents: GraphDocumentRef[] = documentRows.map((row) => {
    const contentKind = contentKindOf({ contentKind: row.content_kind })
    return {
      id: Number(row.id),
      title: titleFor(contentKind, typeof row.name === 'string' ? row.name : null),
      contentKind,
    }
  })

  return {
    entities: seeds.map(({ id, type, label, support }) => ({ id, type, label, support })),
    edges,
    documents,
    terms: expansionTerms(seeds, edges),
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// COPIES of `apps/web/src/lib/graph.ts`. Verbatim except for the type of an id.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `apps/web/src/lib/components/admin/summary.ts:foldText`.
 *
 * ⚠ NOT the backend's `canonicalKey`. This one folds `ñ` → `n` and does not
 * collapse internal whitespace. Two different folds sit on the two sides of the
 * wire; each is reproduced where it belongs.
 */
export function foldText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
}

export const MAX_EXPANSION_TERMS = 8
export const MAX_EXPANSION_CHARS = 200
export const CONTEXT_MAX_ENTITIES = 8
export const CONTEXT_MAX_NEIGHBOURS = 3

/** `apps/web/src/lib/graph.ts:expandGraphQuery`. */
export function expandGraphQuery(query: string, terms: readonly string[]): string {
  const base = query.trim()
  const haystack = foldText(base)
  const seen = new Set<string>()
  const kept: string[] = []
  let budget = MAX_EXPANSION_CHARS
  for (const raw of terms) {
    const term = typeof raw === 'string' ? raw.trim() : ''
    if (!term) continue
    const folded = foldText(term)
    if (!folded || seen.has(folded)) continue
    if (haystack.includes(folded)) continue
    if (term.length + 1 > budget) continue
    seen.add(folded)
    kept.push(term)
    budget -= term.length + 1
    if (kept.length >= MAX_EXPANSION_TERMS) break
  }
  return kept.length === 0 ? base : `${base} ${kept.join(' ')}`
}

function typeChipLabel(type: GraphEntityType): string {
  switch (type) {
    case 'tema':
      return 'tema'
    case 'lugar':
      return 'lugar'
    case 'evento':
      return 'evento'
    case 'organizacion':
      return 'organización'
    case 'persona':
      return 'persona'
    default:
      return String(type)
  }
}

function supportCopy(support: number): string {
  const n = Math.max(0, Math.floor(support))
  if (n === 0) return 'sin documentos que lo respalden'
  if (n === 1) return 'aparece en 1 documento'
  return `aparece en ${n.toLocaleString('es-MX')} documentos`
}

function supportShort(support: number): string {
  const n = Math.max(0, Math.floor(support))
  return n === 1 ? '1 documento' : `${n.toLocaleString('es-MX')} documentos`
}

function rankEntities(entities: readonly GraphViewEntity[]): GraphViewEntity[] {
  return [...entities].sort((a, b) => b.support - a.support || a.label.localeCompare(b.label, 'es'))
}

/**
 * `apps/web/src/lib/graph.ts:graphContextParagraph` — G2, the deterministic
 * Spanish block. NO MODEL CALL. ADR §8.1 says this is where the global-question
 * win is supposed to come from, so it is the thing under test.
 *
 * ⚠ The node index spans the SEEDS PLUS BOTH ENDPOINTS OF EVERY EDGE. `edges`
 * reaches one hop out, so a neighbour usually is not a seed; an index built
 * from `entities` alone silently empties the "Se conecta con" clause — which is
 * the clause that carries the aggregate.
 */
export function graphContextParagraph(retrieval: GraphRetrieval): string {
  const entities = rankEntities(retrieval.entities).slice(0, CONTEXT_MAX_ENTITIES)
  if (entities.length === 0) return ''

  const byId = new Map<number, GraphViewEntity>()
  for (const e of retrieval.entities) byId.set(e.id, e)
  for (const edge of retrieval.edges) {
    for (const end of [edge.from, edge.to]) if (!byId.has(end.id)) byId.set(end.id, end)
  }

  const neighboursOf = (id: number): Array<{ entity: GraphViewEntity; support: number }> => {
    const best = new Map<number, number>()
    for (const edge of retrieval.edges) {
      const otherId = edge.from.id === id ? edge.to.id : edge.to.id === id ? edge.from.id : null
      if (otherId === null) continue
      const entity = byId.get(otherId)
      if (!entity) continue
      const support = edge.support || entity.support
      const seen = best.get(otherId)
      if (seen === undefined || support > seen) best.set(otherId, support)
    }
    return [...best.entries()]
      .map(([otherId, support]) => ({ entity: byId.get(otherId)!, support }))
      .sort((a, b) => b.support - a.support || a.entity.label.localeCompare(b.entity.label, 'es'))
      .slice(0, CONTEXT_MAX_NEIGHBOURS)
  }

  const lines = entities.map((e) => {
    const head = `- ${e.label} (${typeChipLabel(e.type)}): ${supportCopy(e.support)}.`
    const near = neighboursOf(e.id)
    if (near.length === 0) return head
    const rendered = near
      .map((n) => `${n.entity.label} (${typeChipLabel(n.entity.type)}, ${supportShort(n.support)})`)
      .join('; ')
    return `${head} Se conecta con: ${rendered}.`
  })

  return [
    'Resumen del grafo de conocimiento del ecosistema, calculado sobre TODO el ' +
      'material publicado (no sobre los fragmentos de abajo). Las cifras cuentan ' +
      'documentos publicados distintos, no menciones. Solo aparecen entidades y ' +
      'conexiones que varios documentos respaldan.',
    '',
    ...lines,
    '',
    'Usa este resumen para responder preguntas generales sobre qué se repite en el ' +
      'corpus o qué aparece junto a qué. Para afirmaciones puntuales, apóyate en los ' +
      'fragmentos recuperados.',
  ].join('\n')
}
