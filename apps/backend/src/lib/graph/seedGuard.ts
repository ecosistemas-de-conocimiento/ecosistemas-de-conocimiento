/**
 * 🔴 THE READ-SIDE BELT FOR WIKILINK SEEDS (audit 2026-10-28, item 1).
 *
 * A `graph_mentions.seeded = true` row exists only because a note's
 * `[[wikilink]]` attached to a node some OTHER note's model run named. The
 * writer prunes seeds whose node has no model-written mention left
 * (`writer.ts` `pruneDeadSeeds`). These fragments make every graph read
 * ignore such a seed anyway, so a missed prune (a document deleted by cascade,
 * a crash between statements) can never show a node only seeds keep alive.
 *
 *   · {@link liveMention}: a mention counts when the model wrote it, or when
 *     a model-written mention of the same node exists in the ecosistema.
 *   · {@link liveEdge}: an edge counts unless one of its ends is a DEAD seed
 *     in the edge's own document (seed edges are title → link).
 *
 * Each sub-SELECT carries a `seed-guard` SQL comment, which `gateSites.testutil.ts`
 * uses to tell these existence checks from real read sites.
 *
 * The alias is a fixed literal from the calling query, never user input.
 */
import { sql } from '@payloadcms/db-postgres'

type GraphSql = ReturnType<typeof sql>

const ALIAS = /^[a-z]{1,3}$/

function aliasOf(alias: string): GraphSql {
  if (!ALIAS.test(alias)) throw new Error(`seedGuard: bad alias "${alias}"`)
  return sql.raw(alias) as unknown as GraphSql
}

/**
 * The dead seeds, as `(document_id, entity_id)` pairs: a `seeded` mention whose
 * node has no model-written mention left. UNCORRELATED on purpose, so Postgres
 * computes it once per statement and probes it as a hashed SubPlan (`NOT IN`
 * over NOT NULL columns), instead of re-running a correlated EXISTS per row.
 * Only seeding ecosistemas have `seeded` rows, so the set stays small.
 */
function deadSeeds(): GraphSql {
  return sql`SELECT dm.document_id, dm.entity_id /* seed-guard */ FROM graph_mentions dm
        WHERE dm.seeded = true
          AND NOT EXISTS (
            SELECT 1 /* seed-guard */ FROM graph_mentions lm
             WHERE lm.organization_id = dm.organization_id AND lm.entity_id = dm.entity_id AND lm.seeded = false)`
}

/** ` AND <alias> is a live mention` — append to an ON or WHERE clause. */
export function liveMention(alias: string): GraphSql {
  const m = aliasOf(alias)
  return sql`
     AND (${m}.document_id, ${m}.entity_id) NOT IN (${deadSeeds()})`
}

/**
 * ` AND <alias> is a live edge` — append to an ON or WHERE clause: neither end
 * is a dead seed in the edge's own document (seed edges are title → link).
 *
 * ⚠ PERFORMANCE. A correlated `EXISTS (… dm.entity_id IN (from, to) …)` was
 * measured by the audit (2026-10-28, throwaway postgres:16, 4.7k dead seeds) at
 * 0.47 s → 7.3 s for `/view`; splitting it into two correlated NOT EXISTS was
 * 2.0 s on this branch's perf fixture (`seedGuard.perf.pg.test.ts`). Two
 * `NOT IN` probes of one uncorrelated set is the shape kept. `seedGuard.test.ts`
 * pins it.
 */
export function liveEdge(alias: string): GraphSql {
  const r = aliasOf(alias)
  return sql`
     AND (${r}.document_id, ${r}.from_entity_id) NOT IN (${deadSeeds()})
     AND (${r}.document_id, ${r}.to_entity_id) NOT IN (${deadSeeds()})`
}
