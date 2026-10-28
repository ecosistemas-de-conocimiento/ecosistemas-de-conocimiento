/**
 * PERF REGRESSION for the read-side seed guard (`seedGuard.ts`), from the
 * fifth audit's probe (2026-10-28): with ~4.7k dead seeds the `IN (from, to)`
 * form of `liveEdge` took `/view` from 0.47 s to 7.3 s.
 *
 * ⚠ OPT-IN (`GRAPH_PERF=1`): timing is load-sensitive, so the default suite
 * skips it; `seedGuard.test.ts` pins the SQL shape on every run. The check is a
 * RATIO against a no-seed twin ecosistema, plus a loose absolute ceiling.
 *
 *     GRAPH_PERF=1 npx vitest run src/lib/graph/seedGuard.perf.pg.test.ts
 */
import { sql } from '@payloadcms/db-postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { dockerOk, shutdown, startRealPostgres, type RealPostgres } from '../testing/realPostgres'
import { readEntityView, type GraphQueryPayload } from './queries'

const enabled = dockerOk && process.env.GRAPH_PERF === '1'
/** Absolute ceiling for the seeded ecosistema (measured ~0.14 s at load 1.5). */
const BOUND_MS = 1000
/**
 * 🔴 THE MEANINGFUL CHECK: the seeded ecosistema against a twin with the same
 * graph and NO seeds. The correlated forms measured 6-25× slower than an
 * unguarded read; the kept shape is ~0.5-1×. A ratio is load-neutral where an
 * absolute bound is not.
 */
const MAX_RATIO = 3

let pg: RealPostgres | undefined

/** One ecosistema's graph; `seeds` adds ~5k DEAD seeds and their title edges. */
function orgFixture(org: number, docBase: number, entBase: number, seeds: boolean): string {
  return `
      INSERT INTO organizations (id, name, slug) VALUES (${org}, 'Org ${org}', 'org-${org}');
      INSERT INTO documents (id, organization_id, uploaded_by_id, name, publication_status, content_kind, kind)
        SELECT ${docBase} + d, ${org}, 1, 'nota-' || d, 'published', 'documento', 'markdown' FROM generate_series(1, 300) d;
      INSERT INTO graph_entities (id, organization_id, type, label, canonical_key)
        SELECT ${entBase} + e, ${org}, (ARRAY['tema','lugar','evento','tema'])[1 + e % 4]::enum_graph_entities_type, 'Nodo ' || e, 'nodo ' || e
        FROM generate_series(0, 999) e;
      -- model mentions over entities 0..899
      INSERT INTO graph_mentions (organization_id, document_id, entity_id, occurrences, seeded)
        SELECT DISTINCT ON (d, ent) ${org}, ${docBase} + d, ent, 1, false FROM (
          SELECT d, ${entBase} + CASE WHEN k = 0 THEN 0 ELSE (d * 7 + k * 13) % 900 END AS ent
            FROM generate_series(1, 300) d, generate_series(0, 14) k) x;
      INSERT INTO graph_relations (organization_id, document_id, from_entity_id, to_entity_id, type)
        SELECT ${org}, ${docBase} + d, ${entBase} + (d * 7 + k * 13) % 900, ${entBase} + (d * 7 + (k + 1) * 13) % 900, 'relacionado_con'
          FROM generate_series(1, 300) d, generate_series(1, 8) k
        ON CONFLICT DO NOTHING;
      ${
        seeds
          ? `-- DEAD seeds: entities 900..999 have no model mention anywhere
      INSERT INTO graph_mentions (organization_id, document_id, entity_id, occurrences, seeded)
        SELECT ${org}, ${docBase} + d, ${entBase} + 900 + k, 1, true FROM generate_series(1, 300) d, generate_series(0, 99) k
         WHERE (d + k) % 6 = 0;
      INSERT INTO graph_relations (organization_id, document_id, from_entity_id, to_entity_id, type)
        SELECT ${org}, m.document_id, ${entBase}, m.entity_id, 'relacionado_con' FROM graph_mentions m
         WHERE m.organization_id = ${org} AND m.seeded;`
          : ''
      }`
}

describe.skipIf(!enabled)('seed guard perf (opt-in)', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-seedguard-perf-${process.pid}`, 'seedguard_perf')
    // No bound parameters: a multi-statement simple query.
    await pg.db.execute(
      sql.raw(`
      INSERT INTO users (id, email) VALUES (1, 'a@example.invalid');
      ${orgFixture(8, 20000, 80000, true)}
      ${orgFixture(9, 30000, 90000, false)}
      ANALYZE documents; ANALYZE graph_entities; ANALYZE graph_mentions; ANALYZE graph_relations;
    `),
    )
  }, 120_000)

  afterAll(async () => {
    await shutdown(pg, undefined)
  })

  it(`/view with ~5k dead seeds: under ${BOUND_MS} ms and under ${MAX_RATIO}× its no-seed twin`, async () => {
    const P = { db: { drizzle: pg!.db } } as unknown as GraphQueryPayload
    const timeView = async (org: number) => {
      const times: number[] = []
      let view: Awaited<ReturnType<typeof readEntityView>> | undefined
      for (let i = 0; i < 5; i++) {
        const t = performance.now()
        view = await readEntityView(P, { organizationId: org, minSupport: 1, minEdgeSupport: 1 })
        times.push(performance.now() - t)
      }
      return { ms: [...times].sort((a, b) => a - b)[2]!, view: view! }
    }
    await timeView(9) // warm-up
    const twin = await timeView(9)
    const seeded = await timeView(8)
    console.log(
      `[seedGuard.perf] /view median: seeded=${Math.round(seeded.ms)} ms, no-seed twin=${Math.round(twin.ms)} ms, ` +
        `ratio=${(seeded.ms / twin.ms).toFixed(2)}`,
    )
    expect(seeded.view.entities.some((e) => e.id >= 80900)).toBe(false)
    // Same graph once the dead seeds are hidden: nothing else is lost.
    const rel = (v: typeof seeded.view, base: number) => v.entities.map((e) => e.id - base).sort((a, b) => a - b)
    expect(rel(seeded.view, 80000)).toEqual(rel(twin.view, 90000))
    expect(seeded.ms).toBeLessThan(BOUND_MS)
    expect(seeded.ms / twin.ms).toBeLessThan(MAX_RATIO)
  }, 120_000)
})
