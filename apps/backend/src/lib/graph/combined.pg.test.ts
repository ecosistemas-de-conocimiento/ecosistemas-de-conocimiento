/**
 * THE COMBINED GRAPH ("Todos mis ecosistemas") ON A REAL POSTGRES.
 *
 * Two kinds of check:
 *   · 🔴 SCOPING, through the real route handlers and real SQL: a member of
 *     ecosistemas 1+2 never sees ecosistema 3's entities, edges, co-mentions,
 *     documents or search hits; a 1-ecosistema member gets 403; an admin sees all.
 *   · MERGE/SUM: the combined answer equals the merge of the single-ecosistema
 *     answers `queries.ts` gives — the drift check between the two files.
 *
 * Same container pattern as `queries.pg.test.ts`. No docker → SKIP.
 */

import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

import { sql } from '@payloadcms/db-postgres'
import { drizzle } from '@payloadcms/db-postgres/drizzle/node-postgres'
import type { MigrateUpArgs } from '@payloadcms/db-postgres'
import type { PayloadRequest } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { up as baselineUp } from '../../migrations/20260908_092211_baseline'
import { graphEntityEndpoint, graphViewEndpoint } from '../../endpoints/graph'
import { readCombinedEntityDetail, readCombinedView, type CombinedView } from './combined'
import { readEntityView, type GraphEntityView, type GraphQueryPayload } from './queries'

const CONTAINER = `edc-backend-graph-combined-pg-${process.pid}`
const IMAGE = 'postgres:16-alpine'

const dockerOk = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0
if (!dockerOk) console.warn('[combined.pg.test] docker is not usable — these tests SKIP.')

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
// Ecosistemas 1 and 2 are the caller's; 3 is a stranger's.
//   1: 101 documento "El agua en Morelos" (Agua 11, Morelos 12, Juana 13 persona, Lluvia 16, náhuatl 15 noise)
//      102 documento (11, 12) · 103 DRAFT (Salud 14)
//      relations 11→12 afecta_a in 101 and 102
//   2: 201 documento "Dengue y agua" (agua 21, Morelos 22, Dengue 23, Lluvia 25)
//      202 testimonio, gate ready: raw "Juana Pérez…", redacted "[Persona A]…" (21, Juana 24 persona)
//      203 documento (22) · relations 21→22 afecta_a, 23→22 ocurre_en in 201
//   3: 301 documento "Un agua secreta" (Agua 31, Secreto C 32, Morelos 33)
//      relations 31→33 afecta_a, 31→32 relacionado_con
async function seed(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email) VALUES (1, 'graph-test@example.invalid');
    INSERT INTO organizations (id, name, slug) VALUES (1, 'Eco uno', 'uno'), (2, 'Eco dos', 'dos'), (3, 'Eco tres', 'tres');
    INSERT INTO documents (id, organization_id, uploaded_by_id, name, publication_status, content_kind,
                           anonymisation_status, extracted_text, redacted_text) VALUES
      (101, 1, 1, 'uno-a.pdf', 'published', 'documento',  'n/a',   'El agua en Morelos.', NULL),
      (102, 1, 1, 'uno-b.pdf', 'published', 'documento',  'n/a',   'Informe.', NULL),
      (103, 1, 1, 'uno-c.pdf', 'draft',     'documento',  'n/a',   'Borrador de salud.', NULL),
      (201, 2, 1, 'dos-a.pdf', 'published', 'documento',  'n/a',   'Dengue y agua.', NULL),
      (202, 2, 1, 'Testimonio de Juana Pérez.md', 'published', 'testimonio', 'ready',
                  'Juana Pérez habló del agua.', '[Persona A] habló del agua.'),
      (203, 2, 1, 'dos-c.pdf', 'published', 'documento',  'n/a',   'Morelos.', NULL),
      (301, 3, 1, 'tres-a.pdf', 'published', 'documento', 'n/a',   'Un agua secreta.', NULL);
    INSERT INTO graph_entities (id, organization_id, type, label, canonical_key) VALUES
      (11, 1, 'tema',    'Agua',      'agua'),
      (12, 1, 'lugar',   'Morelos',   'morelos'),
      (13, 1, 'persona', 'Juana',     'juana'),
      (14, 1, 'tema',    'Salud',     'salud'),
      (15, 1, 'tema',    'náhuatl',   'nahuatl'),
      (16, 1, 'tema',    'Lluvia',    'lluvia'),
      (21, 2, 'tema',    'agua',      'agua'),
      (22, 2, 'lugar',   'Morelos',   'morelos'),
      (23, 2, 'tema',    'Dengue',    'dengue'),
      (24, 2, 'persona', 'Juana',     'juana'),
      (25, 2, 'tema',    'Lluvia',    'lluvia'),
      (31, 3, 'tema',    'Agua',      'agua'),
      (32, 3, 'tema',    'Secreto C', 'secreto c'),
      (33, 3, 'lugar',   'Morelos',   'morelos');
    INSERT INTO graph_mentions (organization_id, document_id, entity_id, occurrences, snippet) VALUES
      (1, 101, 11, 3, 'El agua'), (1, 101, 12, 1, NULL), (1, 101, 13, 1, NULL), (1, 101, 16, 1, NULL),
      (1, 101, 15, 1, NULL), (1, 102, 11, 1, NULL), (1, 102, 12, 1, NULL), (1, 103, 14, 1, NULL),
      (2, 201, 21, 2, 'agua'), (2, 201, 22, 1, NULL), (2, 201, 23, 1, NULL), (2, 201, 25, 1, NULL),
      (2, 202, 21, 1, NULL), (2, 202, 24, 1, NULL), (2, 203, 22, 1, NULL),
      (3, 301, 31, 1, 'agua secreta'), (3, 301, 32, 1, NULL), (3, 301, 33, 1, NULL);
    INSERT INTO graph_relations (organization_id, document_id, from_entity_id, to_entity_id, type) VALUES
      (1, 101, 11, 12, 'afecta_a'), (1, 102, 11, 12, 'afecta_a'),
      (2, 201, 21, 22, 'afecta_a'), (2, 201, 23, 22, 'ocurre_en'),
      (3, 301, 31, 33, 'afecta_a'), (3, 301, 31, 32, 'relacionado_con');
  `)
}

// ── Fake request around the REAL database ───────────────────────────────────

const MEMBER = { id: 1, email: 'ana@example.test', isActive: true }
const ADMIN = { id: 2, email: 'root@example.test', isActive: true, isPlatformAdmin: true }

function request(
  url: string,
  opts: { user?: Record<string, unknown> | null; memberOf?: number[]; id?: string } = {},
): PayloadRequest {
  const memberOf = opts.memberOf ?? []
  return {
    user: opts.user === undefined ? MEMBER : opts.user,
    payload: {
      async find({ collection }: { collection: string }) {
        if (collection === 'memberships') {
          return { docs: memberOf.map((id) => ({ id, organization: id, role: 'member', isActive: true })) }
        }
        if (collection === 'organizations') {
          return { docs: memberOf.map((id) => ({ id, name: `Eco ${id}`, isActive: true })) }
        }
        return { docs: [] }
      },
      db: { drizzle: db },
    },
    searchParams: new URL(url, 'http://test.local').searchParams,
    routeParams: opts.id ? { id: opts.id } : {},
    headers: new Headers(),
  } as unknown as PayloadRequest
}

async function call(
  endpoint: typeof graphViewEndpoint,
  url: string,
  opts: Parameters<typeof request>[1] = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await endpoint.handler(request(url, opts))
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

/** Every id that could only have come from ecosistema 3. */
const ECO3_ONLY_ENTITIES = [31, 32, 33]
const ECO3_DOCUMENTS = [301]

describe.skipIf(!dockerOk)('combined graph on a real Postgres', () => {
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

  // ── Merge and sum ──────────────────────────────────────────────────────────

  it('merges entities by (type, canonical key) and sums supports per ecosistema', async () => {
    const view = await readCombinedView(payload, { organizationIds: [1, 2], minSupport: 1, minEdgeSupport: 1 })
    expect(view.ecosystems).toEqual([1, 2])
    expect(view.entities).toEqual([
      { id: 11, type: 'tema', label: 'Agua', support: 4, ecosystems: [1, 2], ecosystemSupport: [2, 2] },
      { id: 12, type: 'lugar', label: 'Morelos', support: 4, ecosystems: [1, 2], ecosystemSupport: [2, 2] },
      { id: 16, type: 'tema', label: 'Lluvia', support: 2, ecosystems: [1, 2], ecosystemSupport: [1, 1] },
      { id: 23, type: 'tema', label: 'Dengue', support: 1, ecosystems: [2], ecosystemSupport: [1] },
      // Juana of ecosistema 2 is only in a testimonio: gate 5 keeps her out.
      { id: 13, type: 'persona', label: 'Juana', support: 1, ecosystems: [1], ecosystemSupport: [1] },
    ])
    expect(view.publishedDocuments).toBe(5)
  })

  it('sums relation edges and co-mentions across ecosistemas', async () => {
    const view = await readCombinedView(payload, { organizationIds: [1, 2], minSupport: 1, minEdgeSupport: 1 })
    const relations = view.edges.filter((e) => e.kind === 'relation')
    expect(relations).toEqual([
      { from: 11, to: 12, kind: 'relation', support: 3, coMentions: 3, relationType: 'afecta_a', direction: 'out' },
      { from: 12, to: 23, kind: 'relation', support: 1, coMentions: 1, relationType: 'ocurre_en', direction: 'in' },
    ])
    const co = view.edges.filter((e) => e.kind === 'co-mention').map((e) => [e.from, e.to, e.support])
    expect(co).toEqual(
      expect.arrayContaining([
        [11, 16, 2],
        [12, 16, 2],
        [11, 13, 1],
        [11, 23, 1],
        [12, 13, 1],
        [13, 16, 1],
        [16, 23, 1],
      ]),
    )
    expect(co).toHaveLength(7)
  })

  it('equals the merge of the single-ecosistema views (nodes and edges)', async () => {
    const singles = await Promise.all(
      [1, 2].map((organizationId) =>
        readEntityView(payload, { organizationId, minSupport: 1, minEdgeSupport: 1 }),
      ),
    )
    const combined = await readCombinedView(payload, { organizationIds: [1, 2], minSupport: 1, minEdgeSupport: 1 })
    expect(singles.reduce((n, v) => n + v.entities.length, 0)).toBe(8)
    expect(singles.reduce((n, v) => n + v.edges.length, 0)).toBe(12)
    expect(normalise(combined)).toEqual(mergeSingles(singles))
  })

  it('🔴 applies the entity threshold per ecosistema, before summing', async () => {
    // Lluvia has one document in each ecosistema: 1 + 1 = 2 would pass a summed
    // threshold of 2. Per ecosistema it passes nowhere.
    const view = await readCombinedView(payload, { organizationIds: [1, 2], minSupport: 2, minEdgeSupport: 1 })
    expect(view.entities.map((e) => e.label)).toEqual(['Agua', 'Morelos'])
    // Lluvia, Juana, Dengue. Draft-only Salud and noise náhuatl are not candidates at all.
    expect(view.hidden).toBe(3)
  })

  it('🔴 applies the edge threshold per ecosistema, before summing', async () => {
    // Agua–Morelos: 2 docs in eco 1, 1 doc in eco 2. At an edge threshold of 2
    // only eco 1's evidence counts.
    const view = await readCombinedView(payload, { organizationIds: [1, 2], minSupport: 1, minEdgeSupport: 2 })
    const edge = view.edges.find((e) => e.from === 11 && e.to === 12)
    expect(edge).toMatchObject({ kind: 'relation', support: 2 })
  })

  it('opens a merged node from any of its ids, with documents from included ecosistemas only', async () => {
    const detail = await readCombinedEntityDetail(payload, { organizationIds: [1, 2], entityId: 21 })
    expect(detail?.entity).toMatchObject({ id: 11, label: 'Agua', support: 4, ecosystems: [1, 2] })
    expect(detail?.documents.map((d) => d.id).sort()).toEqual([101, 102, 201, 202])
    // 🔴 The testimonio's free-text name never leaves; no snippet for it either.
    expect(detail?.documents.find((d) => d.id === 202)).toEqual({
      id: 202,
      title: 'Testimonio',
      contentKind: 'testimonio',
      snippet: null,
    })
    expect(detail?.neighbours).toEqual([
      expect.objectContaining({
        entity: { id: 12, type: 'lugar', label: 'Morelos', support: 4 },
        relationType: 'afecta_a',
        support: 3,
        pairSupport: 3,
        direction: 'out',
      }),
    ])
    expect(detail?.neighbours[0]?.documents.map((d) => d.id)).toEqual([201, 102, 101])
  })

  it('reads incoming edges of a merged node the right way round', async () => {
    const detail = await readCombinedEntityDetail(payload, { organizationIds: [1, 2], entityId: 12 })
    expect(detail?.neighbours.map((n) => [n.entity.id, n.relationType, n.direction, n.support])).toEqual([
      [11, 'afecta_a', 'in', 3],
      [23, 'ocurre_en', 'in', 1],
    ])
  })

  // ── 🔴 Scoping, through the routes ─────────────────────────────────────────

  it('🔴 a member of 1+2 never sees ecosistema 3: entities, edges, co-mentions', async () => {
    const { status, body } = await call(graphViewEndpoint, '/api/graph/view?organization=all', { memberOf: [1, 2] })
    expect(status).toBe(200)
    const view = body as unknown as CombinedView
    expect(view.ecosystems).toEqual([1, 2])
    const ids = view.entities.map((e) => e.id)
    for (const id of ECO3_ONLY_ENTITIES) expect(ids).not.toContain(id)
    expect(view.entities.flatMap((e) => e.ecosystems)).not.toContain(3)
    // Agua's support is 4, not 5: eco 3's 301 is not counted.
    expect(view.entities.find((e) => e.id === 11)?.support).toBe(4)
    expect(view.entities.some((e) => e.label === 'Secreto C')).toBe(false)
    for (const edge of view.edges) {
      expect(ids).toContain(edge.from)
      expect(ids).toContain(edge.to)
    }
    // Agua–Morelos would be 4 with eco 3's relation and co-mention.
    expect(view.edges.find((e) => e.from === 11 && e.to === 12)).toMatchObject({ support: 3, coMentions: 3 })
    expect(view.publishedDocuments).toBe(5)
  })

  it('🔴 a member of 1+2 never sees ecosistema 3 documents or nodes in the entity panel', async () => {
    const agua = await call(graphEntityEndpoint, '/api/graph/entity/11?organization=all', {
      memberOf: [1, 2],
      id: '11',
    })
    expect(agua.status).toBe(200)
    const detail = agua.body as { documents: { id: number }[]; neighbours: { entity: { id: number }; documents: { id: number }[] }[] }
    const docIds = [...detail.documents, ...detail.neighbours.flatMap((n) => n.documents)].map((d) => d.id)
    for (const id of ECO3_DOCUMENTS) expect(docIds).not.toContain(id)
    for (const n of detail.neighbours) expect(ECO3_ONLY_ENTITIES).not.toContain(n.entity.id)

    // An id that exists only in ecosistema 3 is a plain 404.
    const secreto = await call(graphEntityEndpoint, '/api/graph/entity/32?organization=all', {
      memberOf: [1, 2],
      id: '32',
    })
    expect(secreto.status).toBe(404)
    // Eco 3's own Agua id does not open the merged node either.
    const foreignAgua = await call(graphEntityEndpoint, '/api/graph/entity/31?organization=all', {
      memberOf: [1, 2],
      id: '31',
    })
    expect(foreignAgua.status).toBe(404)
  })

  it('🔴 #31 search in the combined scope answers over 1+2 only', async () => {
    const secret = await call(graphViewEndpoint, '/api/graph/view?organization=all&q=secreta', { memberOf: [1, 2] })
    expect(secret.status).toBe(200)
    expect((secret.body as unknown as CombinedView).entities).toEqual([])
    const byName = await call(graphViewEndpoint, '/api/graph/view?organization=all&q=secreto', { memberOf: [1, 2] })
    expect((byName.body as unknown as CombinedView).entities).toEqual([])
    // The testimonio's RAW text holds "Pérez"; only redacted text is searched.
    const raw = await call(graphViewEndpoint, '/api/graph/view?organization=all&q=P%C3%A9rez', { memberOf: [1, 2] })
    expect((raw.body as unknown as CombinedView).entities).toEqual([])
    // A real hit keeps the merged node's id.
    const dengue = await call(graphViewEndpoint, '/api/graph/view?organization=all&q=dengue', { memberOf: [1, 2] })
    expect((dengue.body as unknown as CombinedView).entities.map((e) => e.id).sort((a, b) => a - b)).toEqual([
      11, 12, 16, 23,
    ])
  })

  it('🔴 a member of one ecosistema gets 403, a stranger 401', async () => {
    const one = await call(graphViewEndpoint, '/api/graph/view?organization=all', { memberOf: [1] })
    expect(one.status).toBe(403)
    const oneEntity = await call(graphEntityEndpoint, '/api/graph/entity/11?organization=all', {
      memberOf: [1],
      id: '11',
    })
    expect(oneEntity.status).toBe(403)
    const anon = await call(graphViewEndpoint, '/api/graph/view?organization=all', { user: null })
    expect(anon.status).toBe(401)
  })

  it('a platform admin sees every ecosistema, under the same gates', async () => {
    const { status, body } = await call(graphViewEndpoint, '/api/graph/view?organization=all', { user: ADMIN })
    expect(status).toBe(200)
    const view = body as unknown as CombinedView
    expect(view.ecosystems).toEqual([1, 2, 3])
    expect(view.entities.find((e) => e.id === 11)).toMatchObject({ support: 5, ecosystems: [1, 2, 3] })
    expect(view.entities.some((e) => e.label === 'Secreto C')).toBe(true)
    // Still no draft, no noise, no testimonio persona.
    const labels = view.entities.map((e) => e.label)
    expect(labels).not.toContain('Salud')
    expect(labels).not.toContain('náhuatl')
    expect(view.entities.find((e) => e.label === 'Juana')?.ecosystems).toEqual([1])
  })

  /**
   * 🔴 Gate 5 inside ONE ecosistema — the persona-only-from-documento probe.
   *   4: 401 documento (Rosa 41 persona, Agua 42, Morelos 43) · 402 testimonio (41, 42)
   *      relations 42→43 afecta_a (401); 41→42 relacionado_con (402: a persona end
   *      out of a testimonio — never counted); 43→41 ocurre_en (402: the persona
 *      at the `to` end — never counted either)
   *   5: 501 documento (agua 51)
   * Seeded last and removed after, so the admin test above sees ecosistemas 1–3.
   */
  describe('🔴 a persona with a documento AND a testimonio mention in one ecosistema', () => {
    const scope = { organizationIds: [4, 5], minSupport: 1, minEdgeSupport: 1 }
    beforeAll(async () => {
      await db.execute(sql`
        INSERT INTO organizations (id, name, slug) VALUES (4, 'Eco cuatro', 'cuatro'), (5, 'Eco cinco', 'cinco');
        INSERT INTO documents (id, organization_id, uploaded_by_id, name, publication_status, content_kind,
                               anonymisation_status, extracted_text, redacted_text) VALUES
          (401, 4, 1, 'cuatro-a.pdf', 'published', 'documento', 'n/a', 'Rosa y el agua.', NULL),
          (402, 4, 1, 'Testimonio de Rosa.md', 'published', 'testimonio', 'ready',
                      'Rosa habló del agua.', '[Persona A] habló del agua.'),
          (501, 5, 1, 'cinco-a.pdf', 'published', 'documento', 'n/a', 'Agua.', NULL);
        INSERT INTO graph_entities (id, organization_id, type, label, canonical_key) VALUES
          (41, 4, 'persona', 'Rosa',    'rosa'),
          (42, 4, 'tema',    'Agua',    'agua'),
          (43, 4, 'lugar',   'Morelos', 'morelos'),
          (51, 5, 'tema',    'agua',    'agua');
        INSERT INTO graph_mentions (organization_id, document_id, entity_id, occurrences, snippet) VALUES
          (4, 401, 41, 1, 'Rosa'), (4, 401, 42, 1, NULL), (4, 401, 43, 1, NULL),
          (4, 402, 41, 5, NULL), (4, 402, 42, 1, NULL),
          (5, 501, 51, 1, NULL);
        INSERT INTO graph_relations (organization_id, document_id, from_entity_id, to_entity_id, type) VALUES
          (4, 401, 42, 43, 'afecta_a'), (4, 402, 41, 42, 'relacionado_con'),
          (4, 402, 43, 41, 'ocurre_en');
      `)
    })
    afterAll(async () => {
      await db.execute(sql`
        DELETE FROM graph_relations WHERE organization_id IN (4, 5);
        DELETE FROM graph_mentions WHERE organization_id IN (4, 5);
        DELETE FROM graph_entities WHERE organization_id IN (4, 5);
        DELETE FROM documents WHERE organization_id IN (4, 5);
        DELETE FROM organizations WHERE id IN (4, 5);
      `)
    })

    it('lists only her documento in the combined panel, never her testimonio', async () => {
      const rosa = await readCombinedEntityDetail(payload, { ...scope, entityId: 41 })
      expect(rosa?.entity).toMatchObject({ id: 41, support: 1, ecosystems: [4] })
      expect(rosa?.documents.map((d) => d.id)).toEqual([401])
      expect(rosa?.neighbours).toEqual([])
    })

    it('draws no relation edge from the testimonio, and agrees with the single views', async () => {
      const view = await readCombinedView(payload, scope)
      expect(view.edges.filter((e) => e.kind === 'relation').map((e) => [e.from, e.to])).toEqual([[42, 43]])
      expect(view.edges.find((e) => e.from === 41 && e.to === 42)).toMatchObject({ kind: 'co-mention', support: 1 })
      const singles = await Promise.all(
        [4, 5].map((organizationId) => readEntityView(payload, { organizationId, minSupport: 1, minEdgeSupport: 1 })),
      )
      expect(normalise(view)).toEqual(mergeSingles(singles))
    })

    it('lists no persona neighbour and no testimonio evidence from the other end', async () => {
      const agua = await readCombinedEntityDetail(payload, { ...scope, entityId: 51 })
      expect(agua?.neighbours.map((n) => [n.entity.id, n.relationType, n.documents?.map((d) => d.id)])).toEqual([
        [43, 'afecta_a', [401]],
      ])
      // From the `from` end of 43→41: Agua only, never the persona.
      const morelos = await readCombinedEntityDetail(payload, { ...scope, entityId: 43 })
      expect(morelos?.neighbours.map((n) => [n.relationType, n.documents?.map((d) => d.id)])).toEqual([
        ['afecta_a', [401]],
      ])
    })
  })
})

// ── The merge, written independently in the test ───────────────────────────

const keyOf = (e: { type: string; label: string }): string => `${e.type}|${e.label.toLowerCase()}`

function mergeSingles(views: readonly GraphEntityView[]) {
  const nodes = new Map<string, number>()
  const pairKey = (a: string, b: string) => (a < b ? `${a}~${b}` : `${b}~${a}`)
  const sums = new Map<string, { rel: number; co: number; coMentions: number }>()
  for (const view of views) {
    const byId = new Map(view.entities.map((e) => [e.id, keyOf(e)]))
    for (const e of view.entities) nodes.set(keyOf(e), (nodes.get(keyOf(e)) ?? 0) + e.support)
    for (const edge of view.edges) {
      const k = pairKey(byId.get(edge.from)!, byId.get(edge.to)!)
      const s = sums.get(k) ?? { rel: 0, co: 0, coMentions: 0 }
      if (edge.kind === 'relation') s.rel += edge.support
      else s.co += edge.support
      s.coMentions += edge.coMentions
      sums.set(k, s)
    }
  }
  const edges = [...sums].map(([k, s]) => [
    k,
    s.rel > 0
      ? { kind: 'relation', support: s.rel, coMentions: s.coMentions }
      : { kind: 'co-mention', support: s.co, coMentions: s.coMentions },
  ] as const)
  return { nodes: Object.fromEntries([...nodes].sort()), edges: Object.fromEntries(edges.sort()) }
}

function normalise(view: CombinedView) {
  const byId = new Map(view.entities.map((e) => [e.id, keyOf(e)]))
  const pairKey = (a: string, b: string) => (a < b ? `${a}~${b}` : `${b}~${a}`)
  return {
    nodes: Object.fromEntries(view.entities.map((e) => [keyOf(e), e.support] as const).sort()),
    edges: Object.fromEntries(
      view.edges
        .map(
          (e) =>
            [pairKey(byId.get(e.from)!, byId.get(e.to)!), { kind: e.kind, support: e.support, coMentions: e.coMentions }] as const,
        )
        .sort(),
    ),
  }
}
