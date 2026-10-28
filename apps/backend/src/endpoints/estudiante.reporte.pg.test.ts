/**
 * 🔴 THE ACTIVITY REPORT AND A STUDENT'S TESTIMONIOS, on a real Payload +
 * Postgres (every migration) through the real endpoint and the real SQL.
 *
 * Pinned:
 *   · `studentTestimonios` OFF (the default): documentos only, a draft has no
 *     name, and no `testimonios` key at all — the report as before;
 *   · ON: the teacher (owner / investigador of THAT ecosistema) sees each of the
 *     student's testimonios as its `redactedText` and neutral title only when
 *     the gate cleared it (`ready` / `approved`); held, rejected and pending are
 *     a status line. Never `name`, `extractedText`, `bodyMarkdown`, `heldText`;
 *   · another ecosistema's student or testimonio never appears;
 *   · a student cannot read anyone's report (their own included).
 *
 * ⚠ No docker → SKIPS.
 */

import { sql } from '@payloadcms/db-postgres'
import type { Endpoint, Payload, PayloadRequest } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { invalidateFeatures } from '../lib/features'
import { bootPayload, dockerOk, shutdown, startRealPostgres, type RealPostgres } from '../lib/testing/realPostgres'
import { estudianteEndpoints } from './estudiante'

if (!dockerOk) console.warn('[estudiante.reporte.pg.test] docker is not usable — SKIP.')

let pg: RealPostgres | undefined
let payload: Payload | undefined

// Users: 1 root (platform admin) · 2 inés, investigador of A · 3 olga, owner of A
// · 4 ana, estudiante of A · 5 beto, estudiante of B · 6 bea, investigador of B
// · 7 caro, estudiante of A.
const INES = 2
const OLGA = 3
const ANA = 4
const BETO = 5
const BEA = 6
const CARO = 7
const ECO_A = 1
const ECO_B = 2

/** Strings that sit only in columns a teacher must never read. */
const SECRETS = [
  'María', // name, extracted text
  'ORIGINAL', // extractedText
  'CUERPO', // bodyMarkdown
  'Juan', // heldText
  'RETENIDO', // stale redactedText / title on a held row
  'RECHAZADO', // stale redactedText on a rejected row
  'PENDIENTE', // stale redactedText on a pending row
  'Borrador íntimo', // a draft documento's name
  'OTRA ECO', // another ecosistema
  'beto', // another ecosistema's student
]

const reporte = estudianteEndpoints.find((e) => e.method === 'get' && e.path === '/estudiante/reporte') as Endpoint

async function report(as: number, organization: number, student: number) {
  const { createLocalReq } = await import('payload')
  const user = await payload!.findByID({ collection: 'users', id: as, overrideAccess: true })
  const req = (await createLocalReq({ user: { ...user, collection: 'users' } as never }, payload!)) as PayloadRequest
  const url = new URL(`http://test.local/api/estudiante/reporte?organization=${organization}&user=${student}`)
  Object.assign(req, { searchParams: url.searchParams, routeParams: {} })
  const res = await reporte.handler(req)
  const text = await res.text()
  return { status: res.status, text, body: JSON.parse(text) as { reporte?: Record<string, unknown> } }
}

const setFeatures = (org: number, features: Record<string, boolean>) =>
  pg!.db.execute(sql.raw(`UPDATE organizations SET features = '${JSON.stringify(features)}'::jsonb WHERE id = ${org}`))

describe.skipIf(!dockerOk)('activity report × testimonios (real Payload + Postgres)', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-backend-reporte-pg-${process.pid}`, 'reporte_test')
    payload = await bootPayload(pg.url, 'reporte-test-secret')
    await pg.db.execute(
      sql.raw(`
      INSERT INTO users (id, email, display_name, is_platform_admin) VALUES
        (1, 'root@x.invalid', 'Root', true), (2, 'ines@x.invalid', 'Inés', false),
        (3, 'olga@x.invalid', 'Olga', false), (4, 'ana@x.invalid', 'Ana', false),
        (5, 'beto@x.invalid', 'beto', false), (6, 'bea@x.invalid', 'Bea', false),
        (7, 'caro@x.invalid', 'Caro', false);
      SELECT setval('users_id_seq', 7);
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Eco A', 'eco-a'), (2, 'Eco B', 'eco-b');
      SELECT setval('organizations_id_seq', 2);
      INSERT INTO memberships (user_id, organization_id, role) VALUES
        (2, 1, 'investigador'), (3, 1, 'owner'), (4, 1, 'estudiante'), (7, 1, 'estudiante'),
        (5, 2, 'estudiante'), (6, 2, 'investigador');
      INSERT INTO student_profiles (user_id, organization_id, share_with_peers, share_activity) VALUES
        (4, 1, false, true), (7, 1, true, true), (5, 2, false, true);
      INSERT INTO documents (id, organization_id, uploaded_by_id, name, publication_status, content_kind,
                             anonymisation_status, extracted_text, body_markdown, redacted_text, held_text,
                             testimonio_title, created_at) VALUES
        (10, 1, 4, 'Mi ensayo', 'published', 'documento', 'n/a', 'texto', null, null, null, null, '2026-10-01'),
        (11, 1, 4, 'Borrador íntimo', 'draft', 'documento', 'n/a', 'texto', null, null, null, null, '2026-10-02'),
        (20, 1, 4, 'Testimonio de María López.mp3', 'published', 'testimonio', 'approved',
            'María López ORIGINAL', 'María CUERPO', 'Habló [Persona A] del río.', null, 'El río y la comunidad', '2026-10-03'),
        (21, 1, 4, 'María 2.mp3', 'draft', 'testimonio', 'ready',
            'María ORIGINAL dos', null, 'Contó [Persona B] la cosecha.', null, null, '2026-10-04'),
        (22, 1, 4, 'María 3.mp3', 'draft', 'testimonio', 'held',
            'María ORIGINAL tres', null, 'RETENIDO viejo', 'Juan Pérez quedó', 'Título RETENIDO', '2026-10-05'),
        (23, 1, 4, 'María 4.mp3', 'draft', 'testimonio', 'rejected',
            'María ORIGINAL cuatro', null, 'RECHAZADO viejo', null, null, '2026-10-06'),
        (24, 1, 4, 'María 5.mp3', 'draft', 'testimonio', 'pending',
            'María ORIGINAL cinco', null, 'PENDIENTE viejo', null, null, '2026-10-07'),
        (25, 2, 4, 'Otra', 'published', 'testimonio', 'approved', null, null, 'OTRA ECO texto', null, null, '2026-10-08'),
        (30, 2, 5, 'beto voz', 'published', 'testimonio', 'approved', null, null, 'Texto de beto', null, null, '2026-10-09'),
        (40, 1, 7, 'Voz de Caro', 'published', 'testimonio', 'approved', null, null, 'Caro habló', null, null, '2026-10-10');
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

  it('switch OFF (default): documentos only, no draft names, no testimonios — the report as before', async () => {
    for (const as of [INES, OLGA]) {
      const res = await report(as, ECO_A, ANA)
      expect(res.status).toBe(200)
      const r = res.body.reporte!
      expect('testimonios' in r).toBe(false)
      expect(r.uploads).toEqual([
        { id: 11, name: null, createdAt: expect.any(String), status: 'draft', kind: 'documento' },
        { id: 10, name: 'Mi ensayo', createdAt: expect.any(String), status: 'published', kind: 'documento' },
      ])
      expect(r.summary).toMatchObject({ documents: 2, published: 1 })
      for (const secret of [...SECRETS, 'Habló', 'cosecha', 'Testimonio']) expect([as, secret, res.text.includes(secret)]).toEqual([as, secret, false])
    }
  })

  it('🔴 switch ON: the teacher sees the redacted text and neutral title of cleared testimonios, a status line otherwise', async () => {
    await setFeatures(ECO_A, { studentView: true, studentTestimonios: true })
    invalidateFeatures()
    for (const as of [INES, OLGA]) {
      const res = await report(as, ECO_A, ANA)
      expect(res.status).toBe(200)
      expect(res.body.reporte!.testimonios).toEqual([
        { id: 24, createdAt: expect.any(String), state: 'pending' },
        { id: 23, createdAt: expect.any(String), state: 'rejected' },
        { id: 22, createdAt: expect.any(String), state: 'held' },
        { id: 21, createdAt: expect.any(String), state: 'visible', title: 'Testimonio', text: 'Contó [Persona B] la cosecha.' },
        {
          id: 20,
          createdAt: expect.any(String),
          state: 'visible',
          title: 'El río y la comunidad',
          text: 'Habló [Persona A] del río.',
        },
      ])
      // Documents keep the OFF rules.
      expect((res.body.reporte!.uploads as unknown[]).length).toBe(2)
      for (const secret of SECRETS) expect([as, secret, res.text.includes(secret)]).toEqual([as, secret, false])
    }
  })

  it('🔴 another ecosistema\'s student is never reachable, switch on or off', async () => {
    await setFeatures(ECO_A, { studentView: true, studentTestimonios: true })
    await setFeatures(ECO_B, { studentView: true, studentTestimonios: true })
    invalidateFeatures()
    // Inés (A) asking for beto (B) inside A: no such consenting student here.
    expect((await report(INES, ECO_A, BETO)).status).toBe(404)
    // Inés asking inside B: not a member → the same 404 as "off".
    expect((await report(INES, ECO_B, BETO)).status).toBe(404)
    // Bea (B) asking for ana, who is not a student of B.
    expect((await report(BEA, ECO_B, ANA)).status).toBe(404)
    // Bea reads beto in B, and only B's rows.
    const beto = await report(BEA, ECO_B, BETO)
    expect(beto.status).toBe(200)
    expect(beto.body.reporte!.testimonios).toEqual([
      { id: 30, createdAt: expect.any(String), state: 'visible', title: 'Testimonio', text: 'Texto de beto' },
    ])
    expect(beto.text).not.toContain('OTRA ECO')
  })

  it('🔴 a student cannot read a report — a peer\'s or their own', async () => {
    await setFeatures(ECO_A, { studentView: true, studentTestimonios: true })
    invalidateFeatures()
    for (const [as, student] of [[CARO, ANA], [ANA, CARO], [ANA, ANA]] as const) {
      const res = await report(as, ECO_A, student)
      expect([as, student, res.status]).toEqual([as, student, 403])
      for (const s of ['Habló', 'Caro habló']) expect(res.text).not.toContain(s)
    }
  })
})
