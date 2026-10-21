/**
 * THE GRAPH READ PATH, AGAINST A REAL POSTGRES, THROUGH THE REAL DRIVER.
 *
 * 🔴 WHY THIS FILE EXISTS. `queries.test.ts` reads the SQL through its own
 * `renderSql`, which binds a JS array as ONE parameter. Drizzle does not: its
 * `sqlToQuery` expands an interpolated array into `($6, $7, …)`. So
 * `= ANY(${ids}::int[])` passed every unit test and failed in production —
 * `POST /api/graph/retrieve` answered HTTP 500 for any query that matched an
 * entity (measured 2026-10-17: `cannot cast type record to integer[]`; one seed
 * gives `malformed array literal`). Only the real driver renders the real SQL,
 * so only a real database catches this class of bug.
 *
 * ── HOW ──────────────────────────────────────────────────────────────────────
 *
 *   · A throwaway `postgres:16-alpine` container on a kernel-assigned host port
 *     (`-p 0:5432`), same pattern as `services/ai-service/src/test/pg-container.ts`.
 *     It never touches the shared dev database.
 *   · The schema is the PRODUCTION baseline migration's own `up()`, run through
 *     the same drizzle node-postgres driver Payload uses for `payload.db.drizzle`.
 *   · Rows are seeded by plain SQL. Assertions are on what Postgres returned.
 *
 * ⚠ No docker → the suite SKIPS, with a console warning naming the reason.
 */

import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

import { sql } from '@payloadcms/db-postgres'
import { drizzle } from '@payloadcms/db-postgres/drizzle/node-postgres'
import type { MigrateUpArgs } from '@payloadcms/db-postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { up as baselineUp } from '../../migrations/20260908_092211_baseline'
import { purgeGraphNoise } from './purgeNoise'
import {
  matchableEntitiesQuery,
  readEntityDetail,
  readEntityView,
  readGraphRetrieval,
  retrieveDocumentsQuery,
  retrieveEdgesQuery,
  viewEdgesQuery,
  type GraphQueryPayload,
} from './queries'

const CONTAINER = `edc-backend-graph-queries-pg-${process.pid}`
const IMAGE = 'postgres:16-alpine'

function hasDocker(): boolean {
  return spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0
}

const dockerOk = hasDocker()
if (!dockerOk) {
  console.warn('[queries.pg.test] docker is not usable — the real-Postgres graph tests SKIP.')
}

type Db = ReturnType<typeof drizzle>
let db: Db
let payload: GraphQueryPayload

function stopContainer(): void {
  spawnSync('docker', ['rm', '-fv', CONTAINER], { stdio: 'ignore' })
}

async function startPostgres(): Promise<string> {
  stopContainer()
  const run = spawnSync(
    'docker',
    [
      // `--tmpfs` for the data dir: no anonymous volume is left behind.
      'run', '-d', '--rm', '--tmpfs', '/var/lib/postgresql/data', '--name', CONTAINER, '-p', '0:5432',
      '-e', 'POSTGRES_USER=postgres', '-e', 'POSTGRES_PASSWORD=postgres',
      '-e', 'POSTGRES_DB=graph_test', IMAGE,
    ],
    { encoding: 'utf8' },
  )
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`)
  const port = spawnSync('docker', ['port', CONTAINER, '5432/tcp'], { encoding: 'utf8' })
    .stdout.split('\n')[0]?.trim().split(':').pop()
  if (!port) throw new Error('could not read the container port')
  return `postgres://postgres:postgres@127.0.0.1:${port}/graph_test`
}

async function waitForQueries(candidate: Db): Promise<void> {
  const deadline = Date.now() + 25_000
  let last: unknown
  while (Date.now() < deadline) {
    try {
      await candidate.execute(sql`select 1`)
      return
    } catch (err) {
      last = err
      await delay(300)
    }
  }
  throw new Error(`postgres never answered: ${String(last)}`)
}

// ── The seeded world ─────────────────────────────────────────────────────────
//
// Org 1 is under test; org 2 holds a same-labelled entity that must never leak.
// With minSupport = 2:
//   e1 "Consulta previa" — published docs 101,102,103 (+ draft 104, not counted) → support 3
//   e2 "Oaxaca"          — published docs 101,102                                → support 2
//   e3 "Agua"            — published doc 101 only                                → below threshold
//   e1 → e2 ocurre_en in 101 and 102                                             → edge support 2
//   e1 → e3 relacionado_con in 101,102 — but e3 is below threshold               → never returned
//   🔴 NOISE (gate 4) — above threshold and connected, and still never returned:
//   e4 "náhuatl" (language), e5 "[Persona A]", e6 "Domicilio 1" — docs 101,102,
//   e1 → e4 / e1 → e5 / e6 → e2 in 101 and 102. e22 "amuzgo" sits in org 2.
const ORG = 1
const OTHER_ORG = 2
const MIN = 2

async function seed(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email) VALUES (1, 'graph-test@example.invalid');
    INSERT INTO organizations (id, name, slug) VALUES (1, 'Org uno', 'uno'), (2, 'Org dos', 'dos');
    INSERT INTO documents (id, organization_id, uploaded_by_id, name, publication_status, content_kind) VALUES
      (101, 1, 1, 'informe-a.pdf', 'published', 'documento'),
      (102, 1, 1, 'informe-b.pdf', 'published', 'documento'),
      (103, 1, 1, 'relato.md',     'published', 'testimonio'),
      (104, 1, 1, 'borrador.md',   'draft',     'documento'),
      (201, 2, 1, 'ajeno-1.pdf',   'published', 'documento'),
      (202, 2, 1, 'ajeno-2.pdf',   'published', 'documento');
    INSERT INTO graph_entities (id, organization_id, type, label, canonical_key) VALUES
      (11, 1, 'tema',  'Consulta previa', 'consulta previa'),
      (12, 1, 'lugar', 'Oaxaca',          'oaxaca'),
      (13, 1, 'tema',  'Agua',            'agua'),
      (14, 1, 'tema',  'náhuatl',         'nahuatl'),
      (15, 1, 'tema',  '[Persona A]',     '[persona a]'),
      (16, 1, 'lugar', 'Domicilio 1',     'domicilio 1'),
      (21, 2, 'tema',  'Consulta previa', 'consulta previa'),
      (22, 2, 'tema',  'amuzgo',          'amuzgo');
    INSERT INTO graph_mentions (organization_id, document_id, entity_id, occurrences) VALUES
      (1, 101, 11, 4), (1, 102, 11, 1), (1, 103, 11, 2), (1, 104, 11, 9),
      (1, 101, 12, 1), (1, 102, 12, 3),
      (1, 101, 13, 1),
      (1, 101, 14, 5), (1, 102, 14, 5), (1, 101, 15, 2), (1, 102, 15, 2),
      (1, 101, 16, 1), (1, 102, 16, 1),
      (2, 201, 21, 1), (2, 202, 21, 1), (2, 201, 22, 1), (2, 202, 22, 1);
    INSERT INTO graph_relations (organization_id, document_id, from_entity_id, to_entity_id, type) VALUES
      (1, 101, 11, 12, 'ocurre_en'), (1, 102, 11, 12, 'ocurre_en'),
      (1, 101, 11, 13, 'relacionado_con'), (1, 102, 11, 13, 'relacionado_con'),
      (1, 101, 11, 14, 'relacionado_con'), (1, 102, 11, 14, 'relacionado_con'),
      (1, 101, 11, 15, 'relacionado_con'), (1, 102, 11, 15, 'relacionado_con'),
      (1, 101, 16, 12, 'ubicado_en'),      (1, 102, 16, 12, 'ubicado_en'),
      (2, 201, 21, 22, 'relacionado_con'), (2, 202, 21, 22, 'relacionado_con');
  `)
}

function rows(result: unknown): Record<string, unknown>[] {
  return (result as { rows: Record<string, unknown>[] }).rows
}

describe.skipIf(!dockerOk)('graph queries on a real Postgres (drizzle node-postgres)', () => {
  beforeAll(async () => {
    const url = await startPostgres()
    db = drizzle(url)
    await waitForQueries(db)
    await baselineUp({ db, payload: {}, req: {} } as unknown as MigrateUpArgs)
    await seed()
    payload = { db: { drizzle: db } } as GraphQueryPayload
  }, 60_000)

  afterAll(async () => {
    await (db as unknown as { $client?: { end(): Promise<void> } })?.$client?.end()
    stopContainer()
  })

  it('readGraphRetrieval answers a one-seed query with the real neighbourhood', async () => {
    const result = await readGraphRetrieval(payload, {
      organizationId: ORG,
      query: '¿qué dice el material sobre la consulta previa?',
      minSupport: MIN,
    })

    expect(result.entities).toEqual([{ id: 11, type: 'tema', label: 'Consulta previa', support: 3 }])
    expect(result.edges).toEqual([
      {
        from: { id: 11, type: 'tema', label: 'Consulta previa', support: 3 },
        to: { id: 12, type: 'lugar', label: 'Oaxaca', support: 2 },
        relationType: 'ocurre_en',
        support: 2,
      },
    ])
    // Draft 104 is excluded; 101 has the most occurrences; the testimonio's
    // free-text name never reaches the wire.
    expect(result.documents).toEqual([
      { id: 101, title: 'informe-a.pdf', contentKind: 'documento' },
      { id: 103, title: 'Testimonio', contentKind: 'testimonio' },
      { id: 102, title: 'informe-b.pdf', contentKind: 'documento' },
    ])
    expect(result.terms).toEqual(['Oaxaca'])
  })

  it('readGraphRetrieval answers a multi-seed query (the `record to integer[]` case)', async () => {
    const result = await readGraphRetrieval(payload, {
      organizationId: ORG,
      query: 'consulta previa en Oaxaca',
      minSupport: MIN,
    })

    expect(result.entities.map((e) => e.id).sort()).toEqual([11, 12])
    expect(result.edges).toHaveLength(1)
    // 101 and 102 mention both seeds; 103 only one.
    expect(result.documents.map((d) => d.id)).toEqual([101, 102, 103])
    // Both endpoints are seeds, so there is nothing new to expand with.
    expect(result.terms).toEqual([])
  })

  it('retrieveEdgesQuery / retrieveDocumentsQuery run with one id, many ids and none', async () => {
    const one = rows(await db.execute(retrieveDocumentsQuery(ORG, [12], MIN)))
    expect(one.map((r) => r.id)).toEqual([102, 101])

    const many = rows(await db.execute(retrieveEdgesQuery(ORG, [11, 12, 13], MIN)))
    expect(many.map((r) => [r.from_id, r.to_id, r.relation_type])).toEqual([[11, 12, 'ocurre_en']])

    expect(rows(await db.execute(retrieveEdgesQuery(ORG, [], MIN)))).toEqual([])
    expect(rows(await db.execute(retrieveDocumentsQuery(ORG, [], MIN)))).toEqual([])
  })

  it('readEntityView carries the whole-graph edges among the listed entities', async () => {
    const view = await readEntityView(payload, { organizationId: ORG, minSupport: MIN })
    expect(view.entities.map((e) => e.id)).toEqual([11, 12])
    // e1–e3 is evidenced twice but e3 is below threshold, so it never shows.
    expect(view.edges).toEqual([{ from: 11, to: 12, support: 2 }])
    expect(rows(await db.execute(viewEdgesQuery(ORG, [], MIN)))).toEqual([])
    // Another org's ids name nothing here.
    expect(rows(await db.execute(viewEdgesQuery(ORG, [21, 11], MIN)))).toEqual([])
  })

  it('readEntityDetail reports which way each edge points, from the focal entity', async () => {
    const fromConsulta = await readEntityDetail(payload, { organizationId: ORG, entityId: 11, minSupport: MIN })
    expect(fromConsulta?.neighbours.map((n) => [n.entity.id, n.direction])).toEqual([[12, 'out']])
    const fromOaxaca = await readEntityDetail(payload, { organizationId: ORG, entityId: 12, minSupport: MIN })
    expect(fromOaxaca?.neighbours.map((n) => [n.entity.id, n.direction])).toEqual([[11, 'in']])
  })

  it('🔴 gate 4: stored language and placeholder rows are hidden from every read', async () => {
    const view = await readEntityView(payload, { organizationId: ORG, minSupport: MIN })
    expect(view.entities.map((e) => e.id)).toEqual([11, 12])
    expect(view.hidden).toBe(1) // only "Agua"; noise is neither shown nor counted
    for (const id of [14, 15, 16]) {
      expect(await readEntityDetail(payload, { organizationId: ORG, entityId: id, minSupport: MIN })).toBeNull()
    }
    const matchable = rows(await db.execute(matchableEntitiesQuery(ORG, MIN)))
    expect(matchable.map((r) => r.id).sort()).toEqual([11, 12])
    const edges = rows(await db.execute(retrieveEdgesQuery(ORG, [11, 12, 14, 15, 16], MIN)))
    expect(edges.map((r) => [r.from_id, r.to_id])).toEqual([[11, 12]])
    expect(rows(await db.execute(retrieveDocumentsQuery(ORG, [14, 15, 16], MIN)))).toEqual([])
  })

  it('never crosses the ecosistema boundary, even when handed another org’s ids', async () => {
    const other = await readGraphRetrieval(payload, {
      organizationId: OTHER_ORG,
      query: 'consulta previa',
      minSupport: MIN,
    })
    expect(other.entities).toEqual([{ id: 21, type: 'tema', label: 'Consulta previa', support: 2 }])
    expect(other.documents.map((d) => d.id)).toEqual([202, 201])

    expect(rows(await db.execute(retrieveDocumentsQuery(ORG, [21], MIN)))).toEqual([])
  })
  // ⚠ LAST: these mutate the seeded world.
  it('purge-graph-noise: the dry run counts and mutates nothing', async () => {
    const count = async () =>
      rows(await db.execute(sql`SELECT (SELECT COUNT(*) FROM graph_entities)::int AS e,
        (SELECT COUNT(*) FROM graph_mentions)::int AS m, (SELECT COUNT(*) FROM graph_relations)::int AS r`))[0]
    const before = await count()
    const all = await purgeGraphNoise(payload, {})
    expect(all).toMatchObject({ apply: false, entities: 4, mentions: 8, relations: 8 })
    const one = await purgeGraphNoise(payload, { organizationId: ORG })
    expect(one).toMatchObject({ entities: 3, mentions: 6, relations: 6 })
    expect([...one.sample].sort()).toEqual(['1/lugar/Domicilio 1', '1/tema/[Persona A]', '1/tema/náhuatl'])
    expect(await count()).toEqual(before)
  })

  it('purge-graph-noise: apply deletes only matching rows, scoped, and is idempotent', async () => {
    const report = await purgeGraphNoise(payload, { apply: true, organizationId: ORG })
    expect(report).toMatchObject({ apply: true, entities: 3, mentions: 6, relations: 6 })
    const ids = rows(await db.execute(sql`SELECT id FROM graph_entities ORDER BY id`)).map((r) => r.id)
    expect(ids).toEqual([11, 12, 13, 21, 22]) // org 2's "amuzgo" was out of scope
    const rels = rows(await db.execute(sql`SELECT COUNT(*)::int AS n FROM graph_relations WHERE organization_id = 1`))
    expect(rels[0].n).toBe(4)
    const again = await purgeGraphNoise(payload, { apply: true, organizationId: ORG })
    expect(again).toMatchObject({ entities: 0, mentions: 0, relations: 0 })
    // The real graph is untouched.
    const view = await readEntityView(payload, { organizationId: ORG, minSupport: MIN })
    expect(view.edges).toEqual([{ from: 11, to: 12, support: 2 }])
  })
})
