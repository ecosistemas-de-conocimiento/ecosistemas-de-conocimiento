/**
 * PERF REGRESSION for the read-side seed guard (`seedGuard.ts`), from the
 * fifth audit's probe (2026-10-28): with ~4.7k dead seeds the `IN (from, to)`
 * form of `liveEdge` took `/view` from 0.47 s to 7.3 s.
 *
 * ⚠ OPT-IN (`GRAPH_PERF=1`): a timing bound is load-sensitive, so the default
 * suite skips it; `seedGuard.test.ts` pins the SQL shape on every run.
 *
 *     GRAPH_PERF=1 npx vitest run src/lib/graph/seedGuard.perf.pg.test.ts
 */
import { sql } from '@payloadcms/db-postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { dockerOk, shutdown, startRealPostgres, type RealPostgres } from '../testing/realPostgres'
import { readEntityView, type GraphQueryPayload } from './queries'

const enabled = dockerOk && process.env.GRAPH_PERF === '1'
const BOUND_MS = 3000

let pg: RealPostgres | undefined

describe.skipIf(!enabled)('seed guard perf (opt-in)', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-seedguard-perf-${process.pid}`, 'seedguard_perf')
    // No bound parameters: a multi-statement simple query.
    await pg.db.execute(sql.raw(`
      INSERT INTO users (id, email) VALUES (1, 'a@example.invalid');
      INSERT INTO organizations (id, name, slug) VALUES (8, 'Ocho', 'ocho');
      INSERT INTO documents (id, organization_id, uploaded_by_id, name, publication_status, content_kind, kind)
        SELECT 20000 + d, 8, 1, 'nota-' || d, 'published', 'documento', 'markdown' FROM generate_series(1, 300) d;
      INSERT INTO graph_entities (id, organization_id, type, label, canonical_key)
        SELECT 80000 + e, 8, (ARRAY['tema','lugar','evento','tema'])[1 + e % 4]::enum_graph_entities_type, 'Nodo ' || e, 'nodo ' || e
        FROM generate_series(0, 999) e;
      -- model mentions over entities 0..899
      INSERT INTO graph_mentions (organization_id, document_id, entity_id, occurrences, seeded)
        SELECT DISTINCT ON (d, ent) 8, 20000 + d, ent, 1, false FROM (
          SELECT d, 80000 + CASE WHEN k = 0 THEN 0 ELSE (d * 7 + k * 13) % 900 END AS ent
            FROM generate_series(1, 300) d, generate_series(0, 14) k) x;
      -- DEAD seeds: entities 900..999 have no model mention anywhere (~16 per doc)
      INSERT INTO graph_mentions (organization_id, document_id, entity_id, occurrences, seeded)
        SELECT 8, 20000 + d, 80900 + k, 1, true FROM generate_series(1, 300) d, generate_series(0, 99) k
         WHERE (d + k) % 6 = 0;
      INSERT INTO graph_relations (organization_id, document_id, from_entity_id, to_entity_id, type)
        SELECT 8, 20000 + d, 80000 + (d * 7 + k * 13) % 900, 80000 + (d * 7 + (k + 1) * 13) % 900, 'relacionado_con'
          FROM generate_series(1, 300) d, generate_series(1, 8) k
        ON CONFLICT DO NOTHING;
      INSERT INTO graph_relations (organization_id, document_id, from_entity_id, to_entity_id, type)
        SELECT 8, m.document_id, 80000, m.entity_id, 'relacionado_con' FROM graph_mentions m WHERE m.seeded;
      ANALYZE documents; ANALYZE graph_entities; ANALYZE graph_mentions; ANALYZE graph_relations;
    `))
  }, 120_000)

  afterAll(async () => {
    await shutdown(pg, undefined)
  })

  it(`/view with ~5k dead seeds stays under ${BOUND_MS} ms (median of 3)`, async () => {
    const P = { db: { drizzle: pg!.db } } as unknown as GraphQueryPayload
    const dead = (await pg!.db.execute(sql`SELECT count(*)::int AS n FROM graph_mentions WHERE seeded`)) as unknown as {
      rows: { n: number }[]
    }
    const times: number[] = []
    let view: Awaited<ReturnType<typeof readEntityView>> | undefined
    for (let i = 0; i < 3; i++) {
      const t = performance.now()
      view = await readEntityView(P, { organizationId: 8, minSupport: 1, minEdgeSupport: 1 })
      times.push(performance.now() - t)
    }
    const median = [...times].sort((a, b) => a - b)[1]!
    console.log(`[seedGuard.perf] dead seeds=${dead.rows[0]!.n} /view median=${Math.round(median)} ms`)
    expect(view!.entities.some((e) => e.id >= 80900)).toBe(false)
    expect(median).toBeLessThan(BOUND_MS)
  }, 120_000)
})
