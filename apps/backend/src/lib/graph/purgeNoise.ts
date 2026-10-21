/**
 * ONE-OFF CLEANUP: delete language and redaction-placeholder entities, with
 * their mentions and relations. Entry point: `scripts/purge-graph-noise.ts`.
 *
 * The read path already hides these rows (`queries.ts` gate 4) and the
 * extractor no longer writes them (`extract.ts` `dropNoiseEntities`); this
 * removes what was stored before. The match is {@link GRAPH_NOISE_KEY_PATTERN}
 * on `canonical_key` — the SAME pattern the read path binds, so the purge
 * deletes exactly the rows the view stopped showing, no more.
 *
 * 🔴 DRY RUN BY DEFAULT: counts only. `apply` deletes relations touching a
 * noise entity, then its mentions, then the entity, in one transaction.
 * Idempotent: a second apply finds nothing and deletes nothing.
 *
 * Scope: one ecosistema (`organizationId`) or every one (omit it).
 */
import { sql } from '@payloadcms/db-postgres'

import { GRAPH_NOISE_KEY_PATTERN } from './noise'
import type { GraphQueryPayload, GraphSql } from './queries'

export interface PurgeNoiseReport {
  apply: boolean
  organizationId: number | null
  entities: number
  mentions: number
  relations: number
  /** Up to 50 `org/type/label` samples, for the operator to eyeball. */
  sample: string[]
}

interface Executor {
  execute(query: GraphSql): Promise<unknown>
  transaction?<T>(fn: (tx: Executor) => Promise<T>): Promise<T>
}

const rowsOf = (result: unknown): Record<string, unknown>[] =>
  Array.isArray(result) ? result : ((result as { rows?: Record<string, unknown>[] })?.rows ?? [])

const num = (v: unknown): number => Number(v ?? 0) || 0

/** The noise entity ids in scope, as a subquery. */
function noiseIds(organizationId: number | null): GraphSql {
  const org = organizationId == null ? sql`` : sql` AND e.organization_id = ${organizationId}`
  return sql`SELECT e.id FROM graph_entities e WHERE e.canonical_key ~ ${GRAPH_NOISE_KEY_PATTERN}${org}`
}

export function purgeNoiseCountQuery(organizationId: number | null): GraphSql {
  const ids = noiseIds(organizationId)
  return sql`
    SELECT (SELECT COUNT(*) FROM (${ids}) x)::int AS entities,
           (SELECT COUNT(*) FROM graph_mentions m WHERE m.entity_id IN (${ids}))::int AS mentions,
           (SELECT COUNT(*) FROM graph_relations r
             WHERE r.from_entity_id IN (${ids}) OR r.to_entity_id IN (${ids}))::int AS relations`
}

export function purgeNoiseSampleQuery(organizationId: number | null): GraphSql {
  const org = organizationId == null ? sql`` : sql` AND e.organization_id = ${organizationId}`
  return sql`
    SELECT e.organization_id AS org, e.type AS type, e.label AS label
    FROM graph_entities e
    WHERE e.canonical_key ~ ${GRAPH_NOISE_KEY_PATTERN}${org}
    ORDER BY e.organization_id, e.type, e.label
    LIMIT 50`
}

export function purgeNoiseDeleteQueries(organizationId: number | null): GraphSql[] {
  const ids = noiseIds(organizationId)
  return [
    sql`DELETE FROM graph_relations r WHERE r.from_entity_id IN (${ids}) OR r.to_entity_id IN (${ids})`,
    sql`DELETE FROM graph_mentions m WHERE m.entity_id IN (${ids})`,
    sql`DELETE FROM graph_entities e WHERE e.id IN (${ids})`,
  ]
}

export async function purgeGraphNoise(
  payload: GraphQueryPayload,
  options: { apply?: boolean; organizationId?: number | null } = {},
): Promise<PurgeNoiseReport> {
  const apply = options.apply === true
  const organizationId = options.organizationId ?? null
  const db = payload.db.drizzle as unknown as Executor

  const counts = rowsOf(await db.execute(purgeNoiseCountQuery(organizationId)))[0] ?? {}
  const sample = rowsOf(await db.execute(purgeNoiseSampleQuery(organizationId))).map(
    (r) => `${String(r.org)}/${String(r.type)}/${String(r.label)}`,
  )
  const report: PurgeNoiseReport = {
    apply,
    organizationId,
    entities: num(counts.entities),
    mentions: num(counts.mentions),
    relations: num(counts.relations),
    sample,
  }
  if (!apply || report.entities === 0) return report

  const run = async (tx: Executor): Promise<void> => {
    for (const q of purgeNoiseDeleteQueries(organizationId)) await tx.execute(q)
  }
  if (typeof db.transaction === 'function') await db.transaction(run)
  else await run(db)
  return report
}
