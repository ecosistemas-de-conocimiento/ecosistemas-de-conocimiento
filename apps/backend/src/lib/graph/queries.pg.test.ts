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
import { GRAPH_NOISE_KEY_PATTERN, isGraphNoiseLabel } from './noise'
import { canonicalKey } from './normalise'
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
//   🔴 Org 3 — labels that CONTAIN a placeholder (e31 "mercado de Domicilio C",
//   e32 "[Persona B] y su hija") beside real words that look like one (e33
//   "Personas con discapacidad", e34 "Personal docente", e35 "visitas a
//   domicilio"), all in docs 301,302; e31 → e33, e32 → e34, e33 → e35.
//   🔴 Org 4 — co-mentions and pair merging, at threshold 1 (see `seedCoMentions`).
const ORG = 1
const OTHER_ORG = 2
const LOOKALIKE_ORG = 3
const COMENTION_ORG = 4
const MIN = 2

async function seed(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email) VALUES (1, 'graph-test@example.invalid');
    INSERT INTO organizations (id, name, slug) VALUES (1, 'Org uno', 'uno'), (2, 'Org dos', 'dos'), (3, 'Org tres', 'tres');
    INSERT INTO documents (id, organization_id, uploaded_by_id, name, publication_status, content_kind) VALUES
      (101, 1, 1, 'informe-a.pdf', 'published', 'documento'),
      (102, 1, 1, 'informe-b.pdf', 'published', 'documento'),
      (103, 1, 1, 'relato.md',     'published', 'testimonio'),
      (104, 1, 1, 'borrador.md',   'draft',     'documento'),
      (201, 2, 1, 'ajeno-1.pdf',   'published', 'documento'),
      (202, 2, 1, 'ajeno-2.pdf',   'published', 'documento'),
      (301, 3, 1, 'mercado-1.pdf', 'published', 'documento'),
      (302, 3, 1, 'mercado-2.pdf', 'published', 'documento');
    INSERT INTO graph_entities (id, organization_id, type, label, canonical_key) VALUES
      (11, 1, 'tema',  'Consulta previa', 'consulta previa'),
      (12, 1, 'lugar', 'Oaxaca',          'oaxaca'),
      (13, 1, 'tema',  'Agua',            'agua'),
      (14, 1, 'tema',  'náhuatl',         'nahuatl'),
      (15, 1, 'tema',  '[Persona A]',     '[persona a]'),
      (16, 1, 'lugar', 'Domicilio 1',     'domicilio 1'),
      (21, 2, 'tema',  'Consulta previa', 'consulta previa'),
      (22, 2, 'tema',  'amuzgo',          'amuzgo'),
      (31, 3, 'lugar', 'mercado de Domicilio C',    'mercado de domicilio c'),
      (32, 3, 'tema',  '[Persona B] y su hija',     '[persona b] y su hija'),
      (33, 3, 'tema',  'Personas con discapacidad', 'personas con discapacidad'),
      (34, 3, 'tema',  'Personal docente',          'personal docente'),
      (35, 3, 'tema',  'visitas a domicilio',       'visitas a domicilio');
    INSERT INTO graph_mentions (organization_id, document_id, entity_id, occurrences) VALUES
      (1, 101, 11, 4), (1, 102, 11, 1), (1, 103, 11, 2), (1, 104, 11, 9),
      (1, 101, 12, 1), (1, 102, 12, 3),
      (1, 101, 13, 1),
      (1, 101, 14, 5), (1, 102, 14, 5), (1, 101, 15, 2), (1, 102, 15, 2),
      (1, 101, 16, 1), (1, 102, 16, 1),
      (2, 201, 21, 1), (2, 202, 21, 1), (2, 201, 22, 1), (2, 202, 22, 1),
      (3, 301, 31, 1), (3, 302, 31, 1), (3, 301, 32, 1), (3, 302, 32, 1), (3, 301, 33, 1), (3, 302, 33, 1),
      (3, 301, 34, 1), (3, 302, 34, 1), (3, 301, 35, 1), (3, 302, 35, 1);
    INSERT INTO graph_relations (organization_id, document_id, from_entity_id, to_entity_id, type) VALUES
      (1, 101, 11, 12, 'ocurre_en'), (1, 102, 11, 12, 'ocurre_en'),
      (1, 101, 11, 13, 'relacionado_con'), (1, 102, 11, 13, 'relacionado_con'),
      (1, 101, 11, 14, 'relacionado_con'), (1, 102, 11, 14, 'relacionado_con'),
      (1, 101, 11, 15, 'relacionado_con'), (1, 102, 11, 15, 'relacionado_con'),
      (1, 101, 16, 12, 'ubicado_en'),      (1, 102, 16, 12, 'ubicado_en'),
      (2, 201, 21, 22, 'relacionado_con'), (2, 202, 21, 22, 'relacionado_con'),
      (3, 301, 31, 33, 'relacionado_con'), (3, 302, 31, 33, 'relacionado_con'),
      (3, 301, 32, 34, 'relacionado_con'), (3, 302, 32, 34, 'relacionado_con'),
      (3, 301, 33, 35, 'relacionado_con'), (3, 302, 33, 35, 'relacionado_con');
  `)
}

/**
 * Org 4, every threshold at 1.
 *   401 documento: 41 Agua, 42 Morelos, 43 Sequía, 44 Juana (persona), 45 náhuatl, 46 [Persona C]
 *   402 documento: 41, 42, 47 Comité, 48 Salud
 *   403 testimonio: 41, 44 (a persona out of a testimonio: never counted), 49 Pedro (persona, only here)
 *   404 draft:      41, 47, 48
 * Relations: 41→42 afecta_a (401), 42→41 afecta_a (402), 41→42 relacionado_con (402)
 *            ⇒ ONE pair edge, support 2, label afecta_a (2 docs), direction both.
 *            41→43 relacionado_con (401) and 43→41 afecta_a (401)
 *            ⇒ support 1, a tie, broken alphabetically: afecta_a, seen from 41 as `in`.
 *            41→45 relacionado_con (401), to a noise entity ⇒ never drawn.
 */
async function seedCoMentions(): Promise<void> {
  await db.execute(sql`
    INSERT INTO organizations (id, name, slug) VALUES (4, 'Org cuatro', 'cuatro');
    INSERT INTO documents (id, organization_id, uploaded_by_id, name, publication_status, content_kind) VALUES
      (401, 4, 1, 'informe-1.pdf', 'published', 'documento'),
      (402, 4, 1, 'informe-2.pdf', 'published', 'documento'),
      (403, 4, 1, 'relato.md',     'published', 'testimonio'),
      (404, 4, 1, 'borrador.md',   'draft',     'documento');
    INSERT INTO graph_entities (id, organization_id, type, label, canonical_key) VALUES
      (41, 4, 'tema',         'Agua',        'agua'),
      (42, 4, 'lugar',        'Morelos',     'morelos'),
      (43, 4, 'evento',       'Sequía',      'sequia'),
      (44, 4, 'persona',      'Juana',       'juana'),
      (45, 4, 'tema',         'náhuatl',     'nahuatl'),
      (46, 4, 'tema',         '[Persona C]', '[persona c]'),
      (47, 4, 'organizacion', 'Comité',      'comite'),
      (48, 4, 'tema',         'Salud',       'salud'),
      (49, 4, 'persona',      'Pedro',       'pedro');
    INSERT INTO graph_mentions (organization_id, document_id, entity_id, occurrences) VALUES
      (4, 401, 41, 1), (4, 401, 42, 1), (4, 401, 43, 1), (4, 401, 44, 1), (4, 401, 45, 1), (4, 401, 46, 1),
      (4, 402, 41, 1), (4, 402, 42, 1), (4, 402, 47, 1), (4, 402, 48, 1),
      (4, 403, 41, 1), (4, 403, 44, 1), (4, 403, 49, 1),
      (4, 404, 41, 1), (4, 404, 47, 1), (4, 404, 48, 1);
    INSERT INTO graph_relations (organization_id, document_id, from_entity_id, to_entity_id, type) VALUES
      (4, 401, 41, 42, 'afecta_a'), (4, 402, 42, 41, 'afecta_a'), (4, 402, 41, 42, 'relacionado_con'),
      (4, 401, 41, 43, 'relacionado_con'), (4, 401, 43, 41, 'afecta_a'),
      (4, 401, 41, 45, 'relacionado_con');
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
    await seedCoMentions()
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
    expect(view.edges).toEqual([
      { from: 11, to: 12, kind: 'relation', support: 2, coMentions: 2, relationType: 'ocurre_en', direction: 'out' },
    ])
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

  it('🔴 Postgres and JavaScript give the same verdict on every label (one regex, two engines)', async () => {
    const labels = [
      'mercado de Domicilio C', '[Persona B] y su hija', 'Persona B y su hija', '[Persona A]', 'Persona A',
      'Domicilio 1', 'Domicilio A, Morelos', 'Dato omitido', 'fuente: Dato omitido', '[Lugar B]', 'Persona Á',
      'Personas con discapacidad', 'Personal docente', 'Personal de salud', 'visitas a domicilio', 'Domicilios',
      'de persona a persona', 'lugar de origen', 'domicilio a domicilio', 'persona sorda', 'impersona a',
      'náhuatl', 'lengua náhuatl', 'traducción del zapoteco al español', 'campaña de Persona Ñ',
    ]
    const values = sql.join(labels.map((l) => sql`(${canonicalKey(l)})`), sql`, `)
    const pg = rows(
      await db.execute(sql`SELECT k, k ~ ${GRAPH_NOISE_KEY_PATTERN} AS noise FROM (VALUES ${values}) v(k)`),
    )
    expect(pg.map((r) => [r.k, r.noise])).toEqual(labels.map((l) => [canonicalKey(l), isGraphNoiseLabel(l)]))
    // And the JS side says what the owner asked for.
    expect(labels.filter(isGraphNoiseLabel)).toEqual([
      'mercado de Domicilio C', '[Persona B] y su hija', 'Persona B y su hija', '[Persona A]', 'Persona A',
      'Domicilio 1', 'Domicilio A, Morelos', 'Dato omitido', 'fuente: Dato omitido', '[Lugar B]', 'Persona Á',
      'náhuatl', 'lengua náhuatl',
    ])
  })

  it('🔴 gate 4: a label that CONTAINS a placeholder is hidden; look-alike real words stay', async () => {
    const view = await readEntityView(payload, { organizationId: LOOKALIKE_ORG, minSupport: MIN })
    expect(view.entities.map((e) => e.id).sort()).toEqual([33, 34, 35])
    // The relation pair, plus the one co-mention between two real entities;
    // nothing reaches 31 or 32.
    expect(view.edges).toEqual([
      { from: 33, to: 35, kind: 'relation', support: 2, coMentions: 2, relationType: 'relacionado_con', direction: 'out' },
      { from: 33, to: 34, kind: 'co-mention', support: 2, coMentions: 2 },
      { from: 34, to: 35, kind: 'co-mention', support: 2, coMentions: 2 },
    ])
    for (const id of [31, 32]) {
      expect(
        await readEntityDetail(payload, { organizationId: LOOKALIKE_ORG, entityId: id, minSupport: MIN }),
      ).toBeNull()
    }
    const matchable = rows(await db.execute(matchableEntitiesQuery(LOOKALIKE_ORG, MIN)))
    expect(matchable.map((r) => r.id).sort()).toEqual([33, 34, 35])
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
  describe('org 4 — pair merging and co-mentions, every threshold at 1', () => {
    const at1 = { organizationId: COMENTION_ORG, minSupport: 1, minEdgeSupport: 1 }
    const REL_41_42 = { from: 41, to: 42, kind: 'relation', support: 2, coMentions: 2, relationType: 'afecta_a', direction: 'both' }
    const REL_41_43 = { from: 41, to: 43, kind: 'relation', support: 1, coMentions: 1, relationType: 'afecta_a', direction: 'in' }
    const co = (from: number, to: number) => ({ from, to, kind: 'co-mention', support: 1, coMentions: 1 })

    it('lists every gated entity: no noise, no persona out of a testimonio', async () => {
      const view = await readEntityView(payload, at1)
      expect(view.entities.map((e) => e.id).sort()).toEqual([41, 42, 43, 44, 47, 48])
      // Juana counts 401 only; 403 is a testimonio.
      expect(view.entities.find((e) => e.id === 44)?.support).toBe(1)
      // Pedro is a persona named only by a testimonio.
      expect(await readEntityDetail(payload, { ...at1, entityId: 49 })).toBeNull()
    })

    it('merges types and directions into one edge per pair, and adds every co-mention', async () => {
      const view = await readEntityView(payload, at1)
      expect(view.edges).toEqual([
        REL_41_42,
        REL_41_43,
        co(41, 44), co(41, 47), co(41, 48), co(42, 43), co(42, 44), co(42, 47), co(42, 48),
        co(43, 44), co(47, 48),
      ])
      const ends = view.edges.flatMap((e) => [e.from, e.to])
      // 🔴 Noise and the testimonio-only persona are never an end.
      for (const id of [45, 46, 49]) expect(ends).not.toContain(id)
    })

    it('caps co-mentions at the top K per node; relation pairs take no slot', async () => {
      const result = rows(
        await db.execute(
          viewEdgesQuery(COMENTION_ORG, [41, 42, 43, 44, 45, 46, 47, 48, 49], {
            entity: 1, edge: 1, coMention: 1, topK: 1,
          }),
        ),
      )
      expect(result.map((r) => [r.kind, r.from_id, r.to_id])).toEqual([
        ['relation', 41, 42],
        ['relation', 41, 43],
        // Each node nominates its strongest partner, ties to the lower id:
        // 41→44, 42→43, 43→42, 44→41, 47→41, 48→41.
        ['co-mention', 41, 44],
        ['co-mention', 41, 47],
        ['co-mention', 41, 48],
        ['co-mention', 42, 43],
      ])
    })

    it('drops co-mentions below GRAPH_MIN_COMENTION_DOCS; a draft does not count', async () => {
      const result = rows(
        await db.execute(
          viewEdgesQuery(COMENTION_ORG, [41, 42, 43, 44, 47, 48], { entity: 1, edge: 1, coMention: 2 }),
        ),
      )
      // 41–42 shares two documents but is a relation; 47–48 shares 402 and the
      // draft 404, which is one published document.
      expect(result.filter((r) => r.kind === 'co-mention')).toEqual([])
    })

    it('a pair edge needs GRAPH_MIN_EDGE_DOCS over the PAIR, and the panel agrees', async () => {
      const view = await readEntityView(payload, { ...at1, minEdgeSupport: 2 })
      expect(view.edges.filter((e) => e.kind === 'relation')).toEqual([REL_41_42])
      // 41–43 falls back to a co-mention.
      expect(view.edges).toContainEqual(co(41, 43))

      const panel = await readEntityDetail(payload, { ...at1, minEdgeSupport: 2, entityId: 41 })
      expect(panel?.neighbours.map((n) => [n.entity.id, n.relationType, n.support, n.pairSupport])).toEqual([
        [42, 'afecta_a', 2, 2],
        [42, 'relacionado_con', 1, 2],
      ])
      // Evidence for a one-document type of an above-threshold pair is listed.
      expect(panel?.neighbours[1]?.documents.map((d) => d.id)).toEqual([402])
    })

    it('the panel keeps the per-type breakdown and the direction seen from the focus', async () => {
      const panel = await readEntityDetail(payload, { ...at1, entityId: 43 })
      expect(panel?.neighbours.map((n) => [n.entity.id, n.relationType, n.direction, n.pairSupport])).toEqual([
        [41, 'afecta_a', 'out', 1],
        [41, 'relacionado_con', 'in', 1],
      ])
    })
  })

  // ⚠ LAST: these mutate the seeded world.
  it('purge-graph-noise: the dry run counts and mutates nothing', async () => {
    const count = async () =>
      rows(await db.execute(sql`SELECT (SELECT COUNT(*) FROM graph_entities)::int AS e,
        (SELECT COUNT(*) FROM graph_mentions)::int AS m, (SELECT COUNT(*) FROM graph_relations)::int AS r`))[0]
    const before = await count()
    const all = await purgeGraphNoise(payload, {})
    // Org 4 adds two noise entities (náhuatl, [Persona C]), their two mentions and one relation.
    expect(all).toMatchObject({ apply: false, entities: 8, mentions: 14, relations: 13 })
    const one = await purgeGraphNoise(payload, { organizationId: ORG })
    expect(one).toMatchObject({ entities: 3, mentions: 6, relations: 6 })
    expect([...one.sample].sort()).toEqual(['1/lugar/Domicilio 1', '1/tema/[Persona A]', '1/tema/náhuatl'])
    expect(await count()).toEqual(before)
  })

  it('purge-graph-noise: apply deletes only matching rows, scoped, and is idempotent', async () => {
    const report = await purgeGraphNoise(payload, { apply: true, organizationId: ORG })
    expect(report).toMatchObject({ apply: true, entities: 3, mentions: 6, relations: 6 })
    const ids = rows(await db.execute(sql`SELECT id FROM graph_entities ORDER BY id`)).map((r) => r.id)
    expect(ids).toEqual([11, 12, 13, 21, 22, 31, 32, 33, 34, 35, 41, 42, 43, 44, 45, 46, 47, 48, 49]) // orgs 2–4 were out of scope
    const rels = rows(await db.execute(sql`SELECT COUNT(*)::int AS n FROM graph_relations WHERE organization_id = 1`))
    expect(rels[0].n).toBe(4)
    const again = await purgeGraphNoise(payload, { apply: true, organizationId: ORG })
    expect(again).toMatchObject({ entities: 0, mentions: 0, relations: 0 })
    // The real graph is untouched.
    const view = await readEntityView(payload, { organizationId: ORG, minSupport: MIN })
    expect(view.edges).toEqual([
      { from: 11, to: 12, kind: 'relation', support: 2, coMentions: 2, relationType: 'ocurre_en', direction: 'out' },
    ])
  })

  it('🔴 purge-graph-noise: deletes rows that CONTAIN a placeholder, keeps the look-alikes', async () => {
    const dry = await purgeGraphNoise(payload, { organizationId: LOOKALIKE_ORG })
    expect([...dry.sample].sort()).toEqual(['3/lugar/mercado de Domicilio C', '3/tema/[Persona B] y su hija'])
    const report = await purgeGraphNoise(payload, { apply: true, organizationId: LOOKALIKE_ORG })
    expect(report).toMatchObject({ entities: 2, mentions: 4, relations: 4 })
    const ids = rows(
      await db.execute(sql`SELECT id FROM graph_entities WHERE organization_id = 3 ORDER BY id`),
    ).map((r) => r.id)
    expect(ids).toEqual([33, 34, 35])
    const rels = rows(
      await db.execute(sql`SELECT from_entity_id AS f, to_entity_id AS t FROM graph_relations WHERE organization_id = 3`),
    )
    expect(rels.map((r) => [r.f, r.t])).toEqual([[33, 35], [33, 35]])
  })
})
