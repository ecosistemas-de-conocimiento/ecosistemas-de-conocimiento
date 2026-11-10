/**
 * 🔴 A STUDENT DOES NOT SEE THE WHOLE ROSTER — against a real Postgres.
 *
 * Owner decision 2026-11-10 (audit "login y permisos", Pregunta 5): through
 * `GET /api/memberships` a student listed every person in the ecosistema, with
 * `personName` and role, including classmates who never opted in to
 * `shareWithPeers`. Now a student sees their own row, staff, and the classmates
 * who opted in THERE. Every other role keeps the whole roster.
 *
 * Driven through Payload's REST router (`handleEndpoints`, real JWT).
 * Harness: `lib/testing/realPostgres`. No docker → SKIPS.
 */

import { sql } from '@payloadcms/db-postgres'
import type { Payload, SanitizedConfig } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/aiClient', () => {
  const anything: unknown = new Proxy(() => {}, {
    get: (_t, key) => (key === 'then' ? undefined : anything),
    apply: async () => ({ ok: true, ingestId: 'fake-ingest' }),
  })
  return { getAdminAIClient: () => anything, getAppAIClient: () => anything }
})

import { bootPayload, dockerOk, shutdown, startRealPostgres, type RealPostgres } from '@/lib/testing/realPostgres'

const PASSWORD = 'student-roster-pw'
let pg: RealPostgres
let payload: Payload
let config: SanitizedConfig

async function rest(method: string, path: string, token?: string, body?: unknown): Promise<Response> {
  const { handleEndpoints } = await import('payload')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `JWT ${token}`
  return handleEndpoints({
    config,
    request: new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  })
}

async function tokenOf(email: string): Promise<string> {
  const res = await rest('POST', '/api/users/login', undefined, { email, password: PASSWORD })
  const body = (await res.json()) as { token?: string }
  expect(res.status, email).toBe(200)
  return body.token!
}

/** The membership ids this caller reads, optionally narrowed to one ecosistema. */
async function rosterOf(email: string, organization?: number): Promise<number[]> {
  const where = organization === undefined ? '' : `&where[organization][equals]=${organization}`
  const res = await rest('GET', `/api/memberships?depth=0&limit=100&sort=id${where}`, await tokenOf(email))
  expect(res.status).toBe(200)
  return ((await res.json()) as { docs: Array<{ id: number }> }).docs.map((d) => d.id)
}

const run = (s: string) => pg.db.execute(sql.raw(s))

describe.skipIf(!dockerOk)('a student sees only staff and opted-in classmates (real Postgres)', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-student-roster-${process.pid}`, 'student_roster')
    payload = await bootPayload(pg.url, 'student-roster-secret')
    config = await (await import('@payload-config')).default
    // Ecosistema 1: Ana (1) is a student. Bea (2) shares, Carla (3) said no
    // here but yes in ecosistema 2, Dani (4) never answered, Eva (5) shares but
    // her membership is revoked. Teacher (6), admin (7), owner (8).
    // Ecosistema 2: Ana is admin there; Fer (9) is a student who never shared.
    await run(`
      INSERT INTO users (id, email) VALUES (1, 'ana@x.invalid'), (2, 'bea@x.invalid'), (3, 'carla@x.invalid'),
        (4, 'dani@x.invalid'), (5, 'eva@x.invalid'), (6, 'teacher@x.invalid'), (7, 'admin@x.invalid'),
        (8, 'owner@x.invalid'), (9, 'fer@x.invalid');
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Uno', 'uno'), (2, 'Dos', 'dos');
      INSERT INTO memberships (id, user_id, organization_id, role, person_name, is_active) VALUES
        (11, 1, 1, 'estudiante', 'Ana', true), (12, 2, 1, 'estudiante', 'Bea', true),
        (13, 3, 1, 'estudiante', 'Carla', true), (14, 4, 1, 'estudiante', 'Dani', true),
        (15, 5, 1, 'estudiante', 'Eva', false), (16, 6, 1, 'investigador', 'Profe', true),
        (17, 7, 1, 'admin', 'Admin', true), (18, 8, 1, 'owner', 'Dueña', true),
        (21, 1, 2, 'admin', 'Ana', true), (22, 9, 2, 'estudiante', 'Fer', true),
        (23, 3, 2, 'estudiante', 'Carla', true), (24, 8, 2, 'owner', 'Dueña', true);
      INSERT INTO student_profiles (id, user_id, organization_id, share_with_peers) VALUES
        (1, 2, 1, true), (2, 3, 1, false), (3, 3, 2, true), (4, 5, 1, true);
    `)
    for (const t of ['users', 'organizations', 'memberships', 'student_profiles']) {
      await run(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), 1000)`)
    }
    for (let id = 1; id <= 9; id++) {
      await payload.update({ collection: 'users', id, overrideAccess: true, data: { password: PASSWORD } as never })
    }
  }, 120_000)

  afterAll(async () => {
    await shutdown(pg, payload)
  })

  it('🔴 a student does not see a classmate who did not opt in', async () => {
    const seen = await rosterOf('ana@x.invalid', 1)
    expect(seen).not.toContain(13) // said no here (yes elsewhere does not count)
    expect(seen).not.toContain(14) // never answered
    expect(seen).not.toContain(15) // opted in, but revoked
  })

  it('🔴 a student sees themself, an opted-in classmate and every staff row', async () => {
    expect(await rosterOf('ana@x.invalid', 1)).toEqual([11, 12, 16, 17, 18])
  })

  it('a student by id gets the same answer as by list', async () => {
    const token = await tokenOf('ana@x.invalid')
    expect((await rest('GET', '/api/memberships/14?depth=0', token)).status).toBe(404)
    expect((await rest('GET', '/api/memberships/12?depth=0', token)).status).toBe(200)
  })

  it('each ecosistema by the caller’s role in it: a student in 1 who is admin in 2 sees all of 2', async () => {
    expect(await rosterOf('ana@x.invalid')).toEqual([11, 12, 16, 17, 18, 21, 22, 23, 24])
  })

  it('a student opted in elsewhere still sees only their own ecosistema’s sharers', async () => {
    // Carla: student in both. In 1, Bea shares; in 2, Fer does not (Ana is staff there).
    expect(await rosterOf('carla@x.invalid')).toEqual([12, 13, 16, 17, 18, 21, 23, 24])
  })

  it('🔴 a teacher, an admin and an owner still see everyone', async () => {
    const all1 = [11, 12, 13, 14, 15, 16, 17, 18]
    expect(await rosterOf('teacher@x.invalid')).toEqual(all1)
    expect(await rosterOf('admin@x.invalid')).toEqual(all1)
    expect(await rosterOf('owner@x.invalid')).toEqual([...all1, 21, 22, 23, 24])
  })
})
