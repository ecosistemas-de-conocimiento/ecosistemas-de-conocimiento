/**
 * `total` on the view: entities ABOVE the threshold before `MAX_VIEW_ENTITIES`
 * cuts the list (owner 2026-10-28: `/grafo` says "1,500 de N entidades").
 *
 * 🔴 The count must carry every gate the list does, the seed guard included.
 * Org 8 holds ~5k DEAD seeds on 100 extra nodes; org 9 is its no-seed twin.
 * A reference COUNT written WITHOUT the seed guard must equal `total` on the
 * twin (the guard changes nothing where there are no seeds) and exceed it on
 * the seeded org (the guard is what removes the dead seeds from the count).
 */
import { sql } from '@payloadcms/db-postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { dockerOk, rowsOf, shutdown, startRealPostgres, type RealPostgres } from '../testing/realPostgres'
import { readCombinedView } from './combined'
import { entityViewQuery, MAX_VIEW_ENTITIES, readEntityView, type GraphQueryPayload } from './queries'

const ABOVE = 1800 // nodes with 2 published documents each
const BELOW = 50 // nodes with 1 published document
const DEAD = 100 // nodes only dead seeds name (org 8 only)
const MIN = 2

let pg: RealPostgres | undefined
let P: GraphQueryPayload

function orgFixture(org: number, docBase: number, entBase: number, seeds: boolean): string {
  return `
    INSERT INTO organizations (id, name, slug) VALUES (${org}, 'Org ${org}', 'org-${org}');
    INSERT INTO documents (id, organization_id, uploaded_by_id, name, publication_status, content_kind, kind)
      SELECT ${docBase} + d, ${org}, 1, 'nota-' || d, 'published', 'documento', 'markdown' FROM generate_series(1, 400) d;
    -- one draft: its mentions must never count
    INSERT INTO documents (id, organization_id, uploaded_by_id, name, publication_status, content_kind, kind)
      VALUES (${docBase} + 999, ${org}, 1, 'borrador', 'draft', 'documento', 'markdown');
    INSERT INTO graph_entities (id, organization_id, type, label, canonical_key)
      SELECT ${entBase} + e, ${org}, (ARRAY['tema','lugar','evento','tema'])[1 + e % 4]::enum_graph_entities_type,
             'Nodo ' || e, 'nodo ' || e
      FROM generate_series(0, ${ABOVE + BELOW + DEAD - 1}) e;
    INSERT INTO graph_mentions (organization_id, document_id, entity_id, occurrences, seeded)
      SELECT ${org}, ${docBase} + 1 + e % 400, ${entBase} + e, 1, false FROM generate_series(0, ${ABOVE + BELOW - 1}) e;
    INSERT INTO graph_mentions (organization_id, document_id, entity_id, occurrences, seeded)
      SELECT ${org}, ${docBase} + 1 + (e % 400 + 1 + e % 7) % 400, ${entBase} + e, 1, false
      FROM generate_series(0, ${ABOVE - 1}) e;
    -- the draft names the BELOW nodes a second time: still below
    INSERT INTO graph_mentions (organization_id, document_id, entity_id, occurrences, seeded)
      SELECT ${org}, ${docBase} + 999, ${entBase} + e, 1, false FROM generate_series(${ABOVE}, ${ABOVE + BELOW - 1}) e;
    ${
      seeds
        ? `INSERT INTO graph_mentions (organization_id, document_id, entity_id, occurrences, seeded)
      SELECT ${org}, ${docBase} + d, ${entBase} + ${ABOVE + BELOW} + k, 1, true
      FROM generate_series(1, 400) d, generate_series(0, ${DEAD - 1}) k WHERE (d + k) % 8 = 0;`
        : ''
    }`
}

/** The same count with NO seed guard: tenant, published, threshold only. */
async function unguardedCount(org: number): Promise<number> {
  const rows = await rowsOf(
    pg!.db,
    sql`SELECT COUNT(*)::int AS n FROM (
          SELECT m.entity_id FROM graph_mentions m
          JOIN documents d ON d.id = m.document_id AND d.organization_id = ${org} AND d.publication_status = 'published'
          WHERE m.organization_id = ${org}
          GROUP BY m.entity_id HAVING COUNT(DISTINCT m.document_id) >= ${MIN}) x`,
  )
  return Number(rows[0]!.n)
}

async function medianMs(fn: () => Promise<unknown>, runs = 5): Promise<number> {
  const times: number[] = []
  for (let i = 0; i < runs; i++) {
    const t = performance.now()
    await fn()
    times.push(performance.now() - t)
  }
  return Math.round([...times].sort((a, b) => a - b)[Math.floor(runs / 2)]!)
}

describe.skipIf(!dockerOk)('view total above threshold (real Postgres)', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-view-total-${process.pid}`, 'view_total')
    await pg.db.execute(
      sql.raw(`
      INSERT INTO users (id, email) VALUES (1, 'a@example.invalid');
      ${orgFixture(8, 20000, 80000, true)}
      ${orgFixture(9, 30000, 90000, false)}
      ANALYZE documents; ANALYZE graph_entities; ANALYZE graph_mentions; ANALYZE graph_relations;
    `),
    )
    P = { db: { drizzle: pg.db } } as unknown as GraphQueryPayload
  }, 120_000)

  afterAll(async () => {
    await shutdown(pg, undefined)
  })

  it('a capped view lists MAX_VIEW_ENTITIES and counts every node above the threshold', async () => {
    const view = await readEntityView(P, { organizationId: 9, minSupport: MIN })
    expect(view.entities).toHaveLength(MAX_VIEW_ENTITIES)
    expect(view.total).toBe(ABOVE)
    expect(view.hidden).toBe(BELOW)
  })

  it('🔴 no-seed org: the guarded total equals the unguarded count', async () => {
    const view = await readEntityView(P, { organizationId: 9, minSupport: MIN })
    expect(await unguardedCount(9)).toBe(ABOVE)
    expect(view.total).toBe(await unguardedCount(9))
  })

  it('🔴 seeded org: the guard removes dead seeds from the total, same as its twin', async () => {
    const seeded = await readEntityView(P, { organizationId: 8, minSupport: MIN })
    expect(await unguardedCount(8)).toBe(ABOVE + DEAD) // what the count would be without the guard
    expect(seeded.total).toBe(ABOVE)
    expect(seeded.entities.some((e) => e.id >= 80000 + ABOVE + BELOW)).toBe(false)
  })

  it('an uncapped view: total equals the list length (type filter)', async () => {
    const view = await readEntityView(P, { organizationId: 9, minSupport: MIN, type: 'lugar' })
    expect(view.total).toBe(ABOVE / 4)
    expect(view.entities).toHaveLength(view.total)
  })

  it('an empty view still carries total 0', async () => {
    const view = await readEntityView(P, { organizationId: 9, minSupport: 1000 })
    expect(view.entities).toEqual([])
    expect(view.total).toBe(0)
  })

  it('the combined view counts merged nodes above the threshold, dead seeds excluded', async () => {
    const view = await readCombinedView(P, { organizationIds: [8, 9], minSupport: MIN })
    expect(view.entities).toHaveLength(MAX_VIEW_ENTITIES)
    expect(view.total).toBe(ABOVE) // same canonical keys in both orgs → one node each
    const lugar = await readCombinedView(P, { organizationIds: [8, 9], minSupport: MIN, type: 'lugar' })
    expect(lugar.total).toBe(lugar.entities.length)
  })

  it('timing on this fixture (logged, not asserted)', async () => {
    await readEntityView(P, { organizationId: 9, minSupport: MIN }) // warm-up
    const single = await medianMs(() => readEntityView(P, { organizationId: 8, minSupport: MIN }))
    const combined = await medianMs(() => readCombinedView(P, { organizationIds: [8, 9], minSupport: MIN }))
    const plan = await rowsOf(
      pg!.db,
      sql`EXPLAIN (ANALYZE, FORMAT JSON) ${entityViewQuery({ organizationId: 8, minSupport: MIN })}`,
    )
    const json = plan[0]!['QUERY PLAN'] as Array<{ 'Execution Time': number }>
    console.log(
      `[viewTotal] median readEntityView org 8 (seeded)=${single} ms, readCombinedView [8,9]=${combined} ms, ` +
        `entity statement execution=${json[0]!['Execution Time'].toFixed(1)} ms`,
    )
    expect(single).toBeGreaterThan(0)
  }, 60_000)
})
