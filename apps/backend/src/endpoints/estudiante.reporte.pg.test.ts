/**
 * 🔴 THE ACTIVITY REPORT AND A STUDENT'S TESTIMONIOS, on a real Payload +
 * Postgres (every migration) through the real endpoint and the real SQL.
 *
 * Pinned:
 *   · `studentTestimonios` OFF (the default): documentos only, a draft has no
 *     name, topics from published documentos only, and no `testimonios` key;
 *   · only PUBLISHED testimonios are listed: a draft — even one the gate
 *     cleared — or an unpublished one never reaches the teacher;
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
import { TESTIMONIO_CONSENT_VERSION as V } from '../lib/student/testimonioConsent'
import { bootPayload, dockerOk, shutdown, startRealPostgres, type RealPostgres } from '../lib/testing/realPostgres'
import { estudianteEndpoints } from './estudiante'
import { funcionesEndpoints } from './funciones'

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
  'cosecha', // a READY testimonio that is still a draft (row 21)
  'BORRADOR', // a topic only a draft documento carries
  'Rosa', // a chat session title (owner ruling Q23: counts only)
  'CHAT', // chat session titles
]

const reporte = estudianteEndpoints.find((e) => e.method === 'get' && e.path === '/estudiante/reporte') as Endpoint
const perfil = estudianteEndpoints.find((e) => e.method === 'patch' && e.path === '/estudiante/perfil') as Endpoint

async function savePerfil(as: number, body: Record<string, unknown>) {
  const { createLocalReq } = await import('payload')
  const user = await payload!.findByID({ collection: 'users', id: as, overrideAccess: true })
  const req = (await createLocalReq({ user: { ...user, collection: 'users' } as never }, payload!)) as PayloadRequest
  Object.assign(req, { searchParams: new URLSearchParams(), routeParams: {}, json: async () => body })
  const res = await perfil.handler(req)
  return { status: res.status, body: (await res.json()) as { perfil?: Record<string, unknown> } }
}

async function flipFeatures(as: number, organization: number, features: Record<string, boolean>) {
  const { createLocalReq } = await import('payload')
  const user = await payload!.findByID({ collection: 'users', id: as, overrideAccess: true })
  const req = (await createLocalReq({ user: { ...user, collection: 'users' } as never }, payload!)) as PayloadRequest
  Object.assign(req, { searchParams: new URLSearchParams(), routeParams: {}, json: async () => ({ organization, features }) })
  const e = funcionesEndpoints.find((x) => x.method === 'patch' && x.path === '/funciones') as Endpoint
  return (await e.handler(req)).status
}

const consentAt = async (user: number, org: number) =>
  ((await pg!.db.execute(
    sql.raw(`SELECT share_testimonios_at AS at FROM student_profiles WHERE user_id = ${user} AND organization_id = ${org}`),
  )) as unknown as { rows: Array<{ at: unknown }> }).rows[0]?.at ?? null

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
      INSERT INTO student_profiles (user_id, organization_id, share_with_peers, share_activity, share_testimonios_at, share_testimonios_version) VALUES
        (4, 1, false, true, now(), ${V}), (7, 1, true, true, now(), ${V}), (5, 2, false, true, now(), ${V});
      INSERT INTO documents (id, organization_id, uploaded_by_id, name, publication_status, content_kind,
                             anonymisation_status, extracted_text, body_markdown, redacted_text, held_text,
                             testimonio_title, created_at) VALUES
        (10, 1, 4, 'Mi ensayo', 'published', 'documento', 'n/a', 'texto', null, null, null, null, '2026-10-01'),
        (11, 1, 4, 'Borrador íntimo', 'draft', 'documento', 'n/a', 'texto', null, null, null, null, '2026-10-02'),
        (20, 1, 4, 'Testimonio de María López.mp3', 'published', 'testimonio', 'approved',
            'María López ORIGINAL', 'María CUERPO', 'Habló [Persona A] del río.', null, 'El río y la comunidad', '2026-10-03'),
        (21, 1, 4, 'María 2.mp3', 'draft', 'testimonio', 'ready',
            'María ORIGINAL dos', null, 'Contó [Persona B] la cosecha.', null, null, '2026-10-04'),
        (22, 1, 4, 'María 3.mp3', 'published', 'testimonio', 'held',
            'María ORIGINAL tres', null, 'RETENIDO viejo', 'Juan Pérez quedó', 'Título RETENIDO', '2026-10-05'),
        (23, 1, 4, 'María 4.mp3', 'published', 'testimonio', 'rejected',
            'María ORIGINAL cuatro', null, 'RECHAZADO viejo', null, null, '2026-10-06'),
        (24, 1, 4, 'María 5.mp3', 'published', 'testimonio', 'pending',
            'María ORIGINAL cinco', null, 'PENDIENTE viejo', null, null, '2026-10-07'),
        (25, 2, 4, 'Otra', 'published', 'testimonio', 'approved', null, null, 'OTRA ECO texto', null, null, '2026-10-08'),
        (30, 2, 5, 'beto voz', 'published', 'testimonio', 'approved', null, null, 'Texto de beto', null, null, '2026-10-09'),
        (40, 1, 7, 'Voz de Caro', 'published', 'testimonio', 'approved', null, null, 'Caro habló', null, null, '2026-10-10');
      INSERT INTO sessions (user_id, organization_id, title) VALUES
        (4, 1, '¿Qué dijo Rosa Secreta del río?'), (4, 1, 'CHAT privado dos'), (4, 1, 'CHAT tres'),
        (4, 1, 'New chat'), (4, 1, ''), (4, 2, 'CHAT en otra eco'), (7, 1, 'CHAT de Caro');
      INSERT INTO graph_entities (id, organization_id, type, label, canonical_key, public_figure) VALUES
        (100, 1, 'tema', 'tema publicado', 'tema publicado', false),
        (101, 1, 'tema', 'tema BORRADOR', 'tema borrador', false);
      INSERT INTO graph_mentions (organization_id, document_id, entity_id) VALUES (1, 10, 100), (1, 11, 101);
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

  it('🔴 chat sessions: the teacher gets the COUNT, never a title (owner ruling Q23), switch on or off', async () => {
    for (const features of [{ studentView: true }, { studentView: true, studentTestimonios: true }] as Array<Record<string, boolean>>) {
      await setFeatures(ECO_A, features)
      invalidateFeatures()
      const res = await report(INES, ECO_A, ANA)
      expect(res.status).toBe(200)
      // Ana's titled conversations in THIS ecosistema: 3 (not "New chat", not empty, not eco B).
      expect(res.body.reporte!.summary).toMatchObject({ conversations: 3 })
      expect('chatThemes' in res.body.reporte!).toBe(false)
      for (const s of ['Rosa', 'CHAT', 'río?']) expect(res.text).not.toContain(s)
    }
  })

  it('🔴 the teacher\'s report takes topics from PUBLISHED documentos only, never a draft\'s', async () => {
    const res = await report(INES, ECO_A, ANA)
    expect(res.body.reporte!.topics).toEqual(['tema publicado'])
    expect(res.text).not.toContain('BORRADOR')
  })

  it('🔴 a testimonio the student unpublishes leaves the teacher\'s report at once', async () => {
    await setFeatures(ECO_A, { studentView: true, studentTestimonios: true })
    invalidateFeatures()
    const ids = async () => ((await report(INES, ECO_A, ANA)).body.reporte!.testimonios as Array<{ id: number }>).map((t) => t.id)
    expect(await ids()).toContain(20)
    // Unpublishing leaves redacted_text and testimonio_title in place.
    await pg!.db.execute(sql.raw(`UPDATE documents SET publication_status = 'draft' WHERE id = 20`))
    try {
      expect(await ids()).not.toContain(20)
      expect((await report(INES, ECO_A, ANA)).text).not.toMatch(/Habló|El río/)
    } finally {
      await pg!.db.execute(sql.raw(`UPDATE documents SET publication_status = 'published' WHERE id = 20`))
    }
  })

  it('🔴 testimoniosOf itself nulls text and title on uncleared rows, and lists published rows only', async () => {
    const Q = await import('../lib/student/queries')
    const rows = await Q.testimoniosOf({ db: { drizzle: pg!.db as never } }, ECO_A, ANA)
    expect(rows.map((r) => [r.id, r.status, r.redactedText, r.title])).toEqual([
      [24, 'pending', null, null],
      [23, 'rejected', null, null],
      [22, 'held', null, null],
      [20, 'approved', 'Habló [Persona A] del río.', 'El río y la comunidad'],
    ])
  })

  describe('🔴 testimonios need their own consent (owner ruling Q20)', () => {
    const testimonios = async () => (await report(INES, ECO_A, ANA)).body.reporte!.testimonios
    beforeEach(async () => {
      await setFeatures(ECO_A, { studentView: true, studentTestimonios: true })
      invalidateFeatures()
    })
    afterAll(async () => {
      await pg!.db.execute(sql.raw(`UPDATE student_profiles SET share_activity = true, share_testimonios_at = now(), share_testimonios_version = ${V} WHERE user_id = ${ANA}`))
    })

    it('an activity consent given without it (switch was off) shows no testimonios; documentos still show', async () => {
      await pg!.db.execute(sql.raw(`UPDATE student_profiles SET share_testimonios_at = NULL WHERE user_id = ${ANA}`))
      const res = await report(INES, ECO_A, ANA)
      expect(res.status).toBe(200)
      expect('testimonios' in res.body.reporte!).toBe(false)
      expect((res.body.reporte!.uploads as unknown[]).length).toBe(2)
      expect(res.text).not.toMatch(/Habló|El río/)
    })

    it('🔴 a consent given under the earlier wording (version NULL or older) shows no testimonios (owner ruling Q20)', async () => {
      const Q = await import('../lib/student/queries')
      for (const version of ['NULL', String(V - 1)]) {
        await pg!.db.execute(
          sql.raw(`UPDATE student_profiles SET share_activity = true, share_testimonios_at = now(), share_testimonios_version = ${version} WHERE user_id = ${ANA}`),
        )
        expect(await testimonios()).toBeUndefined()
        expect(await Q.testimoniosOf({ db: { drizzle: pg!.db as never } }, ECO_A, ANA)).toEqual([])
        const mine = await savePerfil(ANA, { organization: ECO_A, shareWithPeers: false })
        expect(mine.body.perfil).toMatchObject({ shareActivity: true, shareTestimonios: false })
      }
    })

    it('🔴 accepting stores the version (read back through Payload as the same number); a stale page is refused', async () => {
      await pg!.db.execute(sql.raw(`UPDATE student_profiles SET share_testimonios_at = NULL, share_testimonios_version = NULL WHERE user_id = ${ANA}`))
      expect((await savePerfil(ANA, { organization: ECO_A, shareTestimonios: true })).status).toBe(409)
      expect((await savePerfil(ANA, { organization: ECO_A, shareTestimonios: true, consentVersion: V - 1 })).status).toBe(409)
      expect(await consentAt(ANA, ECO_A)).toBeNull()
      const ok = await savePerfil(ANA, { organization: ECO_A, shareTestimonios: true, consentVersion: V })
      expect(ok.body.perfil).toMatchObject({ shareTestimonios: true })
      const row = await pg!.db.execute(sql.raw(`SELECT share_testimonios_version::int AS v FROM student_profiles WHERE user_id = ${ANA} AND organization_id = 1`))
      expect((row as unknown as { rows: Array<{ v: number }> }).rows[0]?.v).toBe(V)
    })

    it('accepting records the moment and shows them; withdrawing clears it and hides them at once', async () => {
      await pg!.db.execute(sql.raw(`UPDATE student_profiles SET share_testimonios_at = NULL WHERE user_id = ${ANA}`))
      const accepted = await savePerfil(ANA, { organization: ECO_A, shareTestimonios: true, consentVersion: V })
      expect(accepted.status).toBe(200)
      expect(accepted.body.perfil).toMatchObject({ shareActivity: true, shareTestimonios: true })
      expect(await consentAt(ANA, ECO_A)).not.toBeNull()
      expect(((await testimonios()) as Array<{ id: number }>).map((t) => t.id)).toContain(20)

      const withdrawn = await savePerfil(ANA, { organization: ECO_A, shareTestimonios: false })
      expect(withdrawn.body.perfil).toMatchObject({ shareActivity: true, shareTestimonios: false })
      expect(await consentAt(ANA, ECO_A)).toBeNull()
      expect(await testimonios()).toBeUndefined()
    })

    it('withdrawing the activity consent clears the testimonio consent too', async () => {
      await savePerfil(ANA, { organization: ECO_A, shareTestimonios: true, consentVersion: V })
      await savePerfil(ANA, { organization: ECO_A, shareActivity: false })
      expect(await consentAt(ANA, ECO_A)).toBeNull()
      // Sharing activity again does not bring testimonios back by itself.
      await savePerfil(ANA, { organization: ECO_A, shareActivity: true })
      expect(await consentAt(ANA, ECO_A)).toBeNull()
      expect(await testimonios()).toBeUndefined()
    })

    it('🔴 a conflicting body (withdraw activity, give testimonios) is refused, and nothing moves', async () => {
      await pg!.db.execute(sql.raw(`UPDATE student_profiles SET share_activity = true, share_testimonios_at = NULL WHERE user_id = ${ANA}`))
      expect((await savePerfil(ANA, { organization: ECO_A, shareActivity: false, shareTestimonios: true, consentVersion: V })).status).toBe(400)
      expect(await consentAt(ANA, ECO_A)).toBeNull()
      const row = await pg!.db.execute(sql.raw(`SELECT share_activity FROM student_profiles WHERE user_id = ${ANA} AND organization_id = 1`))
      expect((row as unknown as { rows: Array<{ share_activity: boolean }> }).rows[0]?.share_activity).toBe(true)
    })

    it('giving the testimonio consent also turns activity sharing on', async () => {
      await pg!.db.execute(sql.raw(`UPDATE student_profiles SET share_activity = false, share_testimonios_at = NULL WHERE user_id = ${ANA}`))
      const res = await savePerfil(ANA, { organization: ECO_A, shareTestimonios: true, consentVersion: V })
      expect(res.status).toBe(200)
      expect(res.body.perfil).toMatchObject({ shareActivity: true, shareTestimonios: true })
      expect(((await testimonios()) as Array<{ id: number }>).map((t) => t.id)).toContain(20)
    })

    it('🔴 testimoniosOf itself checks the consent in the same read (no withdraw-then-read race)', async () => {
      const Q = await import('../lib/student/queries')
      const read = () => Q.testimoniosOf({ db: { drizzle: pg!.db as never } }, ECO_A, ANA)
      await pg!.db.execute(sql.raw(`UPDATE student_profiles SET share_activity = true, share_testimonios_at = now(), share_testimonios_version = ${V} WHERE user_id = ${ANA}`))
      expect((await read()).length).toBeGreaterThan(0)
      await pg!.db.execute(sql.raw(`UPDATE student_profiles SET share_testimonios_at = NULL WHERE user_id = ${ANA}`))
      expect(await read()).toEqual([])
      await pg!.db.execute(sql.raw(`UPDATE student_profiles SET share_activity = false, share_testimonios_at = now(), share_testimonios_version = ${V} WHERE user_id = ${ANA}`))
      expect(await read()).toEqual([])
    })

    it('🔴 switching studentTestimonios OFF clears every consent in that ecosistema; off→on needs fresh consent', async () => {
      await pg!.db.execute(sql.raw(`UPDATE student_profiles SET share_activity = true, share_testimonios_at = now(), share_testimonios_version = ${V}`))
      expect(((await testimonios()) as unknown[]).length).toBeGreaterThan(0)
      expect(await flipFeatures(1, ECO_A, { studentTestimonios: false })).toBe(200)
      expect(await consentAt(ANA, ECO_A)).toBeNull()
      expect(await consentAt(CARO, ECO_A)).toBeNull()
      // Another ecosistema's consents stay.
      expect(await consentAt(BETO, ECO_B)).not.toBeNull()
      expect(await flipFeatures(1, ECO_A, { studentTestimonios: true })).toBe(200)
      expect(await testimonios()).toBeUndefined()
      // Fresh consent brings them back.
      await savePerfil(ANA, { organization: ECO_A, shareTestimonios: true, consentVersion: V })
      expect(((await testimonios()) as unknown[]).length).toBeGreaterThan(0)
      // An unrelated save with the switch already off clears nothing new and keeps working.
      expect(await flipFeatures(1, ECO_A, { graph: false })).toBe(200)
      expect(await consentAt(ANA, ECO_A)).not.toBeNull()
    })

    it('🔴 the testimonio consent cannot be given while the switch is off (its wording is not shown)', async () => {
      await pg!.db.execute(sql.raw(`UPDATE student_profiles SET share_testimonios_at = NULL WHERE user_id = ${ANA}`))
      await setFeatures(ECO_A, { studentView: true })
      invalidateFeatures()
      expect((await savePerfil(ANA, { organization: ECO_A, shareTestimonios: true, consentVersion: V })).status).toBe(400)
      expect(await consentAt(ANA, ECO_A)).toBeNull()
    })
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
