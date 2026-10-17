/**
 * The GraphRAG leg, measured through the PRODUCTION read path.
 *
 * `readGraphRetrieval` below is `lib/graph/queries.ts:readGraphRetrieval`
 * itself — same statements, same seed matching, same row mapping. Only the
 * transport differs: the harness cannot open a `pg` pool (see `db.ts`), so the
 * `payload.db.drizzle.execute` it hands in renders each drizzle statement with
 * `toExecutableSql` and runs it through `psql`.
 *
 * ── HISTORY ─────────────────────────────────────────────────────────────────
 *
 * Until 2026-10-17 this file carried its OWN copy of `readGraphRetrieval`, and
 * inlined the seed-id array as `ARRAY[…]`, because the shipped statements bound
 * a JS array into `= ANY(${ids}::int[])`. Drizzle expands that into `($6, $7)`,
 * so `POST /api/graph/retrieve` answered HTTP 500 for every query that matched
 * an entity (`RESULTS.md` §1). The statements now build `ARRAY[$6, $7]::int[]`
 * from scalar parameters (`queries.ts:intArray`, pinned by
 * `queries.pg.test.ts`), so the copy is gone and the "with graph" arm measures
 * what ships.
 *
 * ── WHAT IS STILL A COPY ────────────────────────────────────────────────────
 *
 * `apps/backend` cannot import `apps/web`'s `$lib`, so `foldText`,
 * `expandGraphQuery`, `graphContextParagraph` and the three copy helpers it
 * uses are reproduced below. `harness.test.ts` pins them against the cases
 * `apps/web/src/lib/graph.test.ts` asserts.
 */

import {
  readGraphRetrieval as readGraphRetrievalProduction,
  type GraphQueryPayload,
  type GraphRetrieval,
  type GraphSql,
  type GraphViewEntity,
} from '../lib/graph/queries'
import type { GraphEntityType } from '../lib/graph/types'
import { selectJson, toExecutableSql } from './db'
import type { EvalEnv } from './env'

export type {
  GraphDocumentRef,
  GraphEdge,
  GraphRetrieval,
  GraphViewEntity,
} from '../lib/graph/queries'

/** `MAX_QUERY_CHARS` in `apps/backend/src/endpoints/graph.ts`. Semantic, so reproduced. */
const MAX_QUERY_CHARS = 2000

/** `payload.db.drizzle`, as far as the graph read path needs it, over `psql`. */
function psqlPayload(env: EvalEnv): GraphQueryPayload {
  return {
    db: {
      drizzle: {
        execute: async (query: GraphSql) => ({
          rows: await selectJson<Record<string, unknown>>(
            env,
            env.backendDb,
            toExecutableSql(query),
          ),
        }),
      },
    },
  }
}

/**
 * `POST /api/graph/retrieve`, minus HTTP: the endpoint's query trim, then the
 * production `readGraphRetrieval`.
 */
export async function readGraphRetrieval(
  env: EvalEnv,
  args: { organizationId: number; query: string; limit?: number },
): Promise<GraphRetrieval> {
  const query = args.query.trim().slice(0, MAX_QUERY_CHARS)
  if (query === '') return { entities: [], edges: [], documents: [], terms: [] }
  return readGraphRetrievalProduction(psqlPayload(env), {
    organizationId: args.organizationId,
    query,
    limit: args.limit,
  })
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
