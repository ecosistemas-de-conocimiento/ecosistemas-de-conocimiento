/**
 * PERF REGRESSION for the combined node panel (`readCombinedEntityDetail`),
 * from the audit's probe (2026-10-28, throwaway postgres:16): on an ecosistema
 * the size of dev org 6 the panel for a hub entity took 4.7-5.5 s, with or
 * without the seed guard.
 *
 * The cause was the shape `combinedViewEdgesQuery` and `viewEdgesQuery` had
 * already shed: Postgres estimates an aggregated CTE at ~1 row, so a JOIN
 * between two of them is a nested loop over both. `merged … IN (SELECT … FROM
 * focal)`, with `focal` a self-join of `member`, re-ran that self-join once per
 * merged node (482 × 482 × 482 comparisons). `combined.test.ts` pins the new
 * shape; this file checks the planner actually honours it.
 *
 * ⚠ THE BOUND IS RELATIVE TO THE FIXTURE, NOT A WALL-CLOCK NUMBER. The single-
 * ecosistema panel (`readEntityDetail`) reads the same rows through base-table
 * joins and was never affected, so it is the reference. Measured on this
 * fixture (2026-10-28, local docker postgres:16, one run each) the combined
 * panel took 5439 ms against 185 ms single (29×) before the fix, and 193 ms
 * against 265 ms (0.7×) after. A ratio is load-neutral where milliseconds
 * are not. `statement_timeout` stops a runaway plan instead of the test.
 */
import { sql } from '@payloadcms/db-postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { dockerOk, shutdown, startRealPostgres, type RealPostgres } from '../testing/realPostgres'
import { readCombinedEntityDetail } from './combined'
import { readEntityDetail, type GraphQueryPayload } from './queries'

/**
 * Combined panel ÷ single-ecosistema panel, same hub. Measured before: 29× (this
 * lane) and 16.8× (the audit's run). After: 0.7×. 4× leaves room for load
 * noise and still fails the old shape.
 */
const MAX_RATIO = 4
const ORG = 9
const HUB = 90000

let pg: RealPostgres | undefined

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!

async function medianMs(run: (payload: GraphQueryPayload) => Promise<unknown>, n = 5): Promise<number> {
  const times: number[] = []
  for (let i = 0; i < n; i++) {
    await pg!.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '8s'`)
      const start = performance.now()
      await run({ db: { drizzle: tx } } as unknown as GraphQueryPayload)
      times.push(performance.now() - start)
    })
  }
  return median(times)
}

describe.skipIf(!dockerOk)('combined node panel on an ecosistema the size of dev org 6', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-combined-detail-${process.pid}`, 'combined_detail')
    // No bound parameters: a multi-statement simple query.
    await pg.db.execute(
      sql.raw(`
      INSERT INTO users (id, email) VALUES (1, 'a@example.invalid');
      INSERT INTO organizations (id, name, slug) VALUES (9, 'Nueve', 'nueve'), (10, 'Diez', 'diez');
      -- The rest of the installation, which is what makes the planner guess ~1 row for org 9.
      INSERT INTO documents (id, organization_id, uploaded_by_id, name, publication_status, content_kind)
        SELECT 10000 + d, 10, 1, 'otro-' || d, 'published', 'documento' FROM generate_series(1, 1200) d;
      INSERT INTO graph_entities (id, organization_id, type, label, canonical_key)
        SELECT 100000 + e, 10, 'tema', 'Otra ' || e, 'otra ' || e FROM generate_series(1, 8000) e;
      INSERT INTO graph_mentions (organization_id, document_id, entity_id, occurrences)
        SELECT DISTINCT 10, 10000 + 1 + (e * 31 + k) % 1200, 100000 + e, 1
        FROM generate_series(1, 8000) e, generate_series(0, 1) k;
      -- Org 9: 80 documents, 550 entities, twelve per document plus a hub every document names.
      INSERT INTO documents (id, organization_id, uploaded_by_id, name, publication_status, content_kind)
        SELECT 9000 + d, 9, 1, 'doc-' || d, 'published', 'documento' FROM generate_series(1, 80) d;
      INSERT INTO graph_entities (id, organization_id, type, label, canonical_key, public_figure)
        SELECT 90000 + e, 9, (ARRAY['tema','lugar','evento','persona'])[1 + e % 4]::enum_graph_entities_type,
               'Entidad ' || e, 'entidad ' || e, e % 8 = 3
        FROM generate_series(0, 549) e;
      INSERT INTO graph_mentions (organization_id, document_id, entity_id, occurrences)
        SELECT DISTINCT 9, 9000 + d, 90000 + CASE WHEN k = 0 THEN 0 ELSE (d * 7 + k * 13) % 550 END, 1
        FROM generate_series(1, 80) d, generate_series(0, 11) k;
      INSERT INTO graph_relations (organization_id, document_id, from_entity_id, to_entity_id, type)
        SELECT 9, 9000 + d, 90000 + (d * 7 + k * 13) % 550, 90000 + (d * 7 + (k + 1) * 13) % 550, 'relacionado_con'
        FROM generate_series(1, 80) d, generate_series(1, 8) k;
      -- The hub relates to everything its documents name: hundreds of neighbours.
      INSERT INTO graph_relations (organization_id, document_id, from_entity_id, to_entity_id, type)
        SELECT 9, m.document_id, ${HUB}, m.entity_id, 'parte_de'
        FROM graph_mentions m WHERE m.organization_id = 9 AND m.entity_id <> ${HUB};
      ANALYZE documents; ANALYZE graph_entities; ANALYZE graph_mentions; ANALYZE graph_relations;
    `),
    )
  }, 120_000)

  afterAll(async () => {
    await shutdown(pg, undefined)
  })

  it(`answers for a hub within ${MAX_RATIO}× the single-ecosistema panel`, async () => {
    const args = { entityId: HUB, minSupport: 1, minEdgeSupport: 1 }
    const single = await readEntityDetail({ db: { drizzle: pg!.db } } as unknown as GraphQueryPayload, {
      ...args,
      organizationId: ORG,
    })
    const combined = await readCombinedEntityDetail({ db: { drizzle: pg!.db } } as unknown as GraphQueryPayload, {
      ...args,
      organizationIds: [ORG],
    })
    // The fixture is what it claims: a visible hub with a full neighbour list.
    expect(combined?.entity.id).toBe(HUB)
    expect(combined?.neighbours.length).toBeGreaterThanOrEqual(20)
    // One ecosistema merged with itself is the single-ecosistema answer.
    expect(combined?.neighbours.map((n) => [n.entity.id, n.relationType, n.support, n.pairSupport])).toEqual(
      single?.neighbours.map((n) => [n.entity.id, n.relationType, n.support, n.pairSupport]),
    )

    const singleMs = await medianMs((payload) => readEntityDetail(payload, { ...args, organizationId: ORG }))
    const combinedMs = await medianMs((payload) =>
      readCombinedEntityDetail(payload, { ...args, organizationIds: [ORG] }),
    )
    console.log(`combined node panel: ${combinedMs.toFixed(0)} ms, single ${singleMs.toFixed(0)} ms`)
    expect(combinedMs).toBeLessThan(MAX_RATIO * Math.max(singleMs, 10))
  }, 120_000)
})
