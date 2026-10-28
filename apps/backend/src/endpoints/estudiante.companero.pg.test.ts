/**
 * 🔴 A CLASSMATE'S PAGE (`GET /api/estudiante/companero`), on a real Payload +
 * Postgres (every migration) through the real endpoints and the real SQL.
 *
 * Pinned:
 *   · the overview's peer cards carry an opaque slug, never the user id, and
 *     its topics carry their graph entity ids;
 *   · an opted-in peer of the same ecosistema: name, the topics we share from
 *     their PUBLISHED documentos, their PUBLISHED documentos' titles;
 *   · never a draft (title or topic), never a testimonio, never another
 *     ecosistema's document;
 *   · a peer who never opted in, a slug from another ecosistema, the caller's
 *     own slug, a raw user id → 404;
 *   · withdrawing `shareWithPeers` is an immediate 404; opting in again
 *     brings back the same slug;
 *   · `studentView` off → 404.
 *
 * ⚠ No docker → SKIPS.
 */

import { sql } from '@payloadcms/db-postgres'
import type { Endpoint, Payload, PayloadRequest } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { invalidateFeatures } from '../lib/features'
import { bootPayload, dockerOk, shutdown, startRealPostgres, type RealPostgres } from '../lib/testing/realPostgres'
import { estudianteEndpoints } from './estudiante'

if (!dockerOk) console.warn('[estudiante.companero.pg.test] docker is not usable — SKIP.')

let pg: RealPostgres | undefined
let payload: Payload | undefined

// 1 ana: estudiante of A and B (the caller) · 2 beto: estudiante of A, opted in
// · 3 caro: estudiante of A, NOT opted in · 4 dani: estudiante of B, opted in.
const ANA = 1
const BETO = 2
const CARO = 3
const ECO_A = 1
const ECO_B = 2

/** Strings that sit only where a classmate must never look. */
const SECRETS = ['Borrador de Beto', 'tema BORRADOR', 'Testimonio de Beto', 'Beto en B', 'Ensayo de Caro', 'Dani en B']

const find = (method: string, path: string) =>
  estudianteEndpoints.find((e) => e.method === method && e.path === path) as Endpoint

async function call(method: string, path: string, as: number, qs: string, body?: unknown) {
  const { createLocalReq } = await import('payload')
  const user = await payload!.findByID({ collection: 'users', id: as, overrideAccess: true })
  const req = (await createLocalReq({ user: { ...user, collection: 'users' } as never }, payload!)) as PayloadRequest
  const url = new URL(`http://test.local/api${path}?${qs}`)
  Object.assign(req, { searchParams: url.searchParams, routeParams: {}, json: async () => body ?? {} })
  const res = await find(method, path).handler(req)
  const text = await res.text()
  return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown> }
}

type Card = { id: string; name: string; topics: Array<{ id: number; label: string }> }
const overview = (as: number, org: number) => call('get', '/estudiante', as, `organization=${org}`)
const companero = (as: number, org: number, id: string) =>
  call('get', '/estudiante/companero', as, new URLSearchParams({ organization: String(org), id }).toString())
const share = (as: number, org: number, on: boolean) =>
  call('patch', '/estudiante/perfil', as, '', { organization: org, shareWithPeers: on })

const setFeatures = (org: number, features: Record<string, boolean>) =>
  pg!.db.execute(sql.raw(`UPDATE organizations SET features = '${JSON.stringify(features)}'::jsonb WHERE id = ${org}`))

async function slugOf(as: number, org: number, name: string): Promise<string> {
  const res = await overview(as, org)
  expect(res.status).toBe(200)
  const card = (res.body.companeros as Card[]).find((c) => c.name === name)
  expect(card, `${name} on ${as}'s overview`).toBeTruthy()
  return card!.id
}

describe.skipIf(!dockerOk)('companero page (real Payload + Postgres)', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-backend-companero-pg-${process.pid}`, 'companero_test')
    payload = await bootPayload(pg.url, 'companero-test-secret')
    await pg.db.execute(
      sql.raw(`
      INSERT INTO users (id, email, display_name, is_platform_admin) VALUES
        (1, 'ana@x.invalid', 'Ana', false), (2, 'beto@x.invalid', 'Beto', false),
        (3, 'caro@x.invalid', 'Caro', false), (4, 'dani@x.invalid', 'Dani', false);
      SELECT setval('users_id_seq', 4);
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Eco A', 'eco-a'), (2, 'Eco B', 'eco-b');
      SELECT setval('organizations_id_seq', 2);
      INSERT INTO memberships (user_id, organization_id, role) VALUES
        (1, 1, 'estudiante'), (1, 2, 'estudiante'), (2, 1, 'estudiante'), (3, 1, 'estudiante'), (4, 2, 'estudiante');
      INSERT INTO student_profiles (user_id, organization_id, share_with_peers, share_activity) VALUES
        (1, 1, false, false), (2, 1, true, false), (3, 1, false, true), (4, 2, true, false);
      INSERT INTO documents (id, organization_id, uploaded_by_id, name, publication_status, content_kind,
                             anonymisation_status, redacted_text, created_at) VALUES
        (10, 1, 2, 'Ensayo de Beto', 'published', 'documento', 'n/a', null, '2026-10-01'),
        (11, 1, 2, 'Borrador de Beto', 'draft', 'documento', 'n/a', null, '2026-10-02'),
        (12, 1, 2, 'Testimonio de Beto', 'published', 'testimonio', 'approved', 'Habló [Persona A].', '2026-10-03'),
        (13, 2, 2, 'Beto en B', 'published', 'documento', 'n/a', null, '2026-10-04'),
        (20, 1, 1, 'Ensayo de Ana', 'published', 'documento', 'n/a', null, '2026-10-05'),
        (30, 1, 3, 'Ensayo de Caro', 'published', 'documento', 'n/a', null, '2026-10-06'),
        (40, 2, 4, 'Dani en B', 'published', 'documento', 'n/a', null, '2026-10-07'),
        (41, 2, 1, 'Ana en B', 'published', 'documento', 'n/a', null, '2026-10-08');
      INSERT INTO graph_entities (id, organization_id, type, label, canonical_key, public_figure) VALUES
        (100, 1, 'tema', 'tema compartido', 'tema compartido', false),
        (101, 1, 'tema', 'tema BORRADOR', 'tema borrador', false),
        (102, 1, 'tema', 'tema solo de beto', 'tema solo de beto', false),
        (200, 2, 'tema', 'tema de b', 'tema de b', false);
      INSERT INTO graph_mentions (organization_id, document_id, entity_id) VALUES
        (1, 10, 100), (1, 20, 100), (1, 30, 100),
        (1, 11, 101), (1, 20, 101), (1, 12, 101),
        (1, 10, 102),
        (2, 40, 200), (2, 41, 200);
    `),
    )
  }, 120_000)

  beforeEach(async () => {
    await setFeatures(ECO_A, { studentView: true })
    await setFeatures(ECO_B, { studentView: true })
    invalidateFeatures()
  })

  afterAll(async () => {
    await shutdown(pg, payload)
  })

  it('the overview: topics carry entity ids; peer cards carry an opaque slug, never the user id', async () => {
    const res = await overview(ANA, ECO_A)
    expect(res.status).toBe(200)
    expect(res.body.temas).toEqual(expect.arrayContaining([{ id: 100, label: 'tema compartido' }]))
    const cards = res.body.companeros as Card[]
    // Caro shares a topic but never opted in.
    expect(cards.map((c) => c.name)).toEqual(['Beto'])
    expect(cards[0]!.id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(cards[0]!.id).not.toContain(String(BETO))
    expect(cards[0]!.topics).toEqual([{ id: 100, label: 'tema compartido' }])
    expect(res.text).not.toMatch(/"id":\s*2[,}]/)
  })

  it('an opted-in peer: name, shared PUBLISHED topics, PUBLISHED documento titles only', async () => {
    const slug = await slugOf(ANA, ECO_A, 'Beto')
    const res = await companero(ANA, ECO_A, slug)
    expect(res.status).toBe(200)
    expect(res.body.companero).toEqual({
      id: slug,
      name: 'Beto',
      temas: [{ id: 100, label: 'tema compartido' }],
      trabajos: [{ id: 10, name: 'Ensayo de Beto' }],
    })
    for (const secret of SECRETS) expect([secret, res.text.includes(secret)]).toEqual([secret, false])
  })

  it('🔴 never opted in, another ecosistema, my own slug, a raw id, junk → 404', async () => {
    const beto = await slugOf(ANA, ECO_A, 'Beto')
    const dani = await slugOf(ANA, ECO_B, 'Dani')
    // Dani is opted in, but in B: his B slug means nothing in A, Beto's A slug nothing in B.
    expect((await companero(ANA, ECO_B, dani)).status).toBe(200)
    expect((await companero(ANA, ECO_A, dani)).status).toBe(404)
    expect((await companero(ANA, ECO_B, beto)).status).toBe(404)
    // A raw user id or junk is the same 404.
    for (const id of [String(CARO), String(BETO), 'x', '', 'a'.repeat(22)]) {
      expect([id, (await companero(ANA, ECO_A, id)).status]).toEqual([id, 404])
    }
    // My own slug, as Beto sees it once I opt in, is not a page for me.
    expect((await share(ANA, ECO_A, true)).status).toBe(200)
    const mine = await slugOf(BETO, ECO_A, 'Ana')
    expect((await companero(ANA, ECO_A, mine)).status).toBe(404)
    expect((await companero(BETO, ECO_A, mine)).status).toBe(200)
    expect((await share(ANA, ECO_A, false)).status).toBe(200)
  })

  it('🔴 a student not opted in is a 404 even with the right slug', async () => {
    // Caro opts in, Ana reads her slug, Caro withdraws.
    expect((await share(CARO, ECO_A, true)).status).toBe(200)
    const caro = await slugOf(ANA, ECO_A, 'Caro')
    expect((await companero(ANA, ECO_A, caro)).status).toBe(200)
    expect((await share(CARO, ECO_A, false)).status).toBe(200)
    const res = await companero(ANA, ECO_A, caro)
    expect(res.status).toBe(404)
    expect(res.text).not.toContain('Caro')
  })

  it('🔴 withdrawing consent is an immediate 404; opting in again brings the same slug back', async () => {
    const slug = await slugOf(ANA, ECO_A, 'Beto')
    expect((await share(BETO, ECO_A, false)).status).toBe(200)
    expect((await companero(ANA, ECO_A, slug)).status).toBe(404)
    expect(((await overview(ANA, ECO_A)).body.companeros as Card[]).map((c) => c.name)).toEqual([])
    expect((await share(BETO, ECO_A, true)).status).toBe(200)
    expect(await slugOf(ANA, ECO_A, 'Beto')).toBe(slug)
    expect((await companero(ANA, ECO_A, slug)).status).toBe(200)
  })

  it('studentView off → 404', async () => {
    const slug = await slugOf(ANA, ECO_A, 'Beto')
    await setFeatures(ECO_A, {})
    invalidateFeatures()
    expect((await companero(ANA, ECO_A, slug)).status).toBe(404)
  })

  it('🔴 an unpublished documento leaves the page at once', async () => {
    const slug = await slugOf(ANA, ECO_A, 'Beto')
    await pg!.db.execute(sql.raw(`UPDATE documents SET publication_status = 'draft' WHERE id = 10`))
    const res = await companero(ANA, ECO_A, slug)
    expect(res.status).toBe(200)
    expect((res.body.companero as { trabajos: unknown[] }).trabajos).toEqual([])
    expect(res.text).not.toContain('Ensayo de Beto')
    await pg!.db.execute(sql.raw(`UPDATE documents SET publication_status = 'published' WHERE id = 10`))
  })
})
