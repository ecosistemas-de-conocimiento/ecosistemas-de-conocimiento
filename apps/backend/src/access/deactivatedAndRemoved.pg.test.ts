/**
 * 🔴 A DEACTIVATED ACCOUNT IS OUT, A REMOVED MEMBER CANNOT PUBLISH, AND NOBODY
 * BUT A PLATFORM ADMIN CHANGES AN EMAIL — AGAINST A REAL POSTGRES.
 *
 * Audit 2026-11-10 (login y permisos A-01, A-02, A-03; carga C-07):
 *
 *   · A-01 / C-07 — `users.isActive = false` still signed in, read the
 *     published corpus, uploaded, published and retried.
 *   · A-02 — a member removed from an ecosistema still published their drafts
 *     into it.
 *   · A-03 — any account rewrote its own email, then a manager's `/miembros`
 *     add of that address linked it to someone else's membership.
 *
 * Driven through Payload's REST router (`handleEndpoints`, real JWT) and the
 * local API with `overrideAccess: false`. Harness: `lib/testing/realPostgres`.
 */

import { sql } from '@payloadcms/db-postgres'
import type { Payload, SanitizedConfig } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/aiClient', () => {
  const anything: unknown = new Proxy(() => {}, {
    get: (_t, key) => (key === 'then' ? undefined : anything),
    apply: async () => ({ ok: true, ingestId: 'fake-ingest' }),
  })
  return { getAdminAIClient: () => anything, getAppAIClient: () => anything }
})

import { bootPayload, dockerOk, rowsOf, shutdown, startRealPostgres, type RealPostgres } from '@/lib/testing/realPostgres'

const PASSWORD = 'deactivated-removed-pw'
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

async function login(email: string, password = PASSWORD): Promise<{ status: number; body: unknown; token?: string }> {
  const res = await rest('POST', '/api/users/login', undefined, { email, password })
  const body = (await res.json().catch(() => ({}))) as { token?: string }
  return { status: res.status, body, token: body.token }
}

const run = (s: string) => pg.db.execute(sql.raw(s))
const userRow = async (id: number) =>
  ({ ...(await payload.findByID({ collection: 'users', id, overrideAccess: true })), collection: 'users' }) as never
const sessionCount = async (id: number) =>
  Number((await rowsOf(pg.db, sql`SELECT count(*)::int AS n FROM users_sessions WHERE _parent_id = ${id}`))[0]?.n)

describe.skipIf(!dockerOk)('deactivated accounts, removed members, frozen email', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-deactivated-removed-${process.pid}`, 'deactivated_removed')
    payload = await bootPayload(pg.url, 'deactivated-removed-secret')
    config = await (await import('@payload-config')).default
  }, 120_000)

  beforeEach(async () => {
    await run(`
      TRUNCATE ratings, messages, sessions, documents, media, memberships, organizations, users RESTART IDENTITY CASCADE;
      INSERT INTO users (id, email, is_platform_admin) VALUES (1, 'member@example.invalid', false),
        (2, 'colleague@example.invalid', false), (3, 'manager@example.invalid', false),
        (4, 'other@example.invalid', false), (9, 'platform@example.invalid', true);
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Uno', 'uno'), (2, 'Dos', 'dos');
      INSERT INTO memberships (id, user_id, organization_id, role) VALUES
        (1, 1, 1, 'member'), (2, 2, 1, 'member'), (3, 3, 1, 'admin'), (4, 4, 2, 'member');
      INSERT INTO media (id, uploaded_by_id, organization_id, prefix, filename, mime_type)
        VALUES (70, 1, 1, 'eco_1/u_1', 'mio.pdf', 'application/pdf');
      INSERT INTO documents (id, organization_id, uploaded_by_id, publication_status, kind, content_kind, anonymise, anonymisation_status, extracted_text, name, ingest_status)
        VALUES (50, 1, 2, 'published', 'pdf', 'documento', false, 'n/a', 'TEXTO PUBLICADO DEL COLEGA', 'colega.pdf', 'ready'),
               (51, 1, 1, 'draft', 'pdf', 'documento', false, 'n/a', 'BORRADOR DEL MIEMBRO', 'borrador.pdf', 'ready'),
               (52, 1, 1, 'draft', 'pdf', 'documento', false, 'n/a', 'FALLÓ AL INGERIR', 'fallido.pdf', 'failed');
      INSERT INTO sessions (id, user_id, organization_id) VALUES (10, 1, 1);
      INSERT INTO messages (id, session_id, role, content) VALUES (100, 10, 'assistant', 'respuesta');
      INSERT INTO ratings (id, message_id, session_id, organization_id, user_id, stars) VALUES (200, 100, 10, 1, 1, 4);
    `)
    for (const t of ['users', 'organizations', 'memberships', 'media', 'documents', 'sessions', 'messages', 'ratings']) {
      await run(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), 1000)`)
    }
    for (const id of [1, 2, 3, 4, 9]) {
      await payload.update({ collection: 'users', id, overrideAccess: true, data: { password: PASSWORD } as never })
    }
  }, 60_000)

  afterAll(async () => {
    await shutdown(pg, payload)
  })

  // ── A-01: sign-in and open sessions ──────────────────────────────────────

  it('A-01: a deactivated account cannot sign in, and gets exactly the wrong-password answer', async () => {
    const wrong = await login('member@example.invalid', 'not-the-password')
    await run(`UPDATE users SET is_active = false, login_attempts = 0 WHERE id = 1`)
    const refused = await login('member@example.invalid')
    expect(refused.status).toBe(wrong.status)
    expect(refused.status).toBe(401)
    expect(refused.token).toBeUndefined()
    expect(refused.body).toEqual(wrong.body)
    // The session Payload added before the hook ran is gone again.
    expect(await sessionCount(1)).toBe(0)
  })

  it('cleanup 2: a NULL isActive is off — no sign-in, and a live token stops reading', async () => {
    const before = await login('member@example.invalid')
    expect(before.status).toBe(200)
    await run(`UPDATE users SET is_active = NULL WHERE id = 1`)
    expect((await login('member@example.invalid')).status).toBe(401)
    const docs = await rest('GET', '/api/documents?depth=0', before.token)
    const ids = ((await docs.json()) as { docs?: Array<{ id: number }> }).docs?.map((d) => d.id) ?? []
    expect(ids).toEqual([])
  })

  it('A-01: deactivating through the API empties the sessions, so a live token is dead', async () => {
    const member = await login('member@example.invalid')
    const platform = await login('platform@example.invalid')
    expect((await (await rest('GET', '/api/users/me', member.token)).json()).user?.id).toBe(1)

    const patch = await rest('PATCH', '/api/users/1', platform.token, { isActive: false })
    expect(patch.status).toBe(200)
    expect(await sessionCount(1)).toBe(0)
    expect((await (await rest('GET', '/api/users/me', member.token)).json()).user).toBeNull()
    expect((await rest('POST', '/api/documents/51/publish', member.token)).status).toBe(401)
  })

  it('an ordinary profile edit keeps the sessions', async () => {
    const member = await login('member@example.invalid')
    expect((await rest('PATCH', '/api/users/1', member.token, { displayName: 'Ana' })).status).toBe(200)
    expect(await sessionCount(1)).toBe(1)
  })

  // ── A-01 / C-07: defence in depth, with a token whose session survived ────

  describe('a deactivated account with a session still on the row', () => {
    let token: string | undefined
    beforeEach(async () => {
      token = (await login('member@example.invalid')).token
      // Raw SQL: the row flips but `users_sessions` stays, so only access rules stand.
      await run(`UPDATE users SET is_active = false WHERE id = 1`)
    })

    it('reads no document, its own draft included', async () => {
      const res = await rest('GET', '/api/documents?depth=0', token)
      const ids = ((await res.json()) as { docs?: Array<{ id: number }> }).docs?.map((d) => d.id) ?? []
      expect(ids).toEqual([])
    })

    it('cannot publish, retry, rebuild the graph or edit a note', async () => {
      expect((await rest('POST', '/api/documents/51/publish', token)).status).toBe(404)
      expect((await rest('POST', '/api/documents/52/retry', token)).status).toBe(404)
      expect((await rest('POST', '/api/documents/51/graph-retry', token)).status).toBe(404)
      expect((await rest('PATCH', '/api/documents/51/note', token, { name: 'x.pdf' })).status).toBe(404)
      expect((await rowsOf(pg.db, sql`SELECT publication_status FROM documents WHERE id = 51`))[0]).toEqual({
        publication_status: 'draft',
      })
    })

    it('cannot create a document', async () => {
      await expect(
        payload.create({
          collection: 'documents',
          overrideAccess: false,
          user: await userRow(1),
          data: { name: 'nota.md', kind: 'markdown', bodyMarkdown: 'tras desactivar', organization: 1 } as never,
          context: { __skipDocsExtract: true },
        }),
      ).rejects.toMatchObject({ status: 403 })
    })

    it('cannot upload, read or delete a file (C-07)', async () => {
      await expect(
        payload.create({
          collection: 'media',
          overrideAccess: false,
          user: await userRow(1),
          data: {} as never,
          file: { data: Buffer.from('%PDF-1.4\n'), mimetype: 'application/pdf', name: 'x.pdf', size: 9 },
        }),
      ).rejects.toMatchObject({ status: 403 })
      expect([403, 404]).toContain((await rest('GET', '/api/media/70', token)).status)
      expect([403, 404]).toContain((await rest('DELETE', '/api/media/70', token)).status)
      expect((await rowsOf(pg.db, sql`SELECT id FROM media WHERE id = 70`)).length).toBe(1)
    })

    it('cannot change or delete its own rating', async () => {
      expect([403, 404]).toContain((await rest('PATCH', '/api/ratings/200', token, { stars: 1 })).status)
      expect([403, 404]).toContain((await rest('DELETE', '/api/ratings/200', token)).status)
      expect((await rowsOf(pg.db, sql`SELECT stars::int AS stars FROM ratings WHERE id = 200`))[0]).toEqual({ stars: 4 })
    })
  })

  // ── A-02: a removed or switched-off seat ─────────────────────────────────

  it('control: an active member publishes its draft', async () => {
    const { token } = await login('member@example.invalid')
    expect((await rest('POST', '/api/documents/51/publish', token)).status).toBe(202)
  })

  for (const [label, revoke] of [
    ['membership deleted', `DELETE FROM memberships WHERE id = 1`],
    ['membership switched off', `UPDATE memberships SET is_active = false WHERE id = 1`],
    ['ecosistema switched off', `UPDATE organizations SET is_active = false WHERE id = 1`],
  ] as const) {
    it(`A-02 (${label}): no publish, retry, graph rebuild or note edit; the draft still reads`, async () => {
      const { token } = await login('member@example.invalid')
      await run(revoke)
      expect((await rest('POST', '/api/documents/51/publish', token)).status).toBe(403)
      expect((await rest('POST', '/api/documents/52/retry', token)).status).toBe(403)
      expect((await rest('POST', '/api/documents/51/graph-retry', token)).status).toBe(403)
      expect((await rest('PATCH', '/api/documents/51/note', token, { name: 'x.pdf' })).status).toBe(403)
      const rows = await rowsOf(pg.db, sql`SELECT id, publication_status, ingest_status, name FROM documents WHERE id IN (51, 52) ORDER BY id`)
      expect(rows).toEqual([
        { id: 51, publication_status: 'draft', ingest_status: 'ready', name: 'borrador.pdf' },
        { id: 52, publication_status: 'draft', ingest_status: 'failed', name: 'fallido.pdf' },
      ])
      expect((await rest('GET', '/api/documents/51?depth=0', token)).status).toBe(200)
    })
  }

  // ── A-03: own email ──────────────────────────────────────────────────────

  it('A-03: an account cannot change its own email, so /miembros cannot hand it a membership', async () => {
    const other = await login('other@example.invalid')
    await rest('PATCH', '/api/users/4', other.token, { email: 'nueva.persona@example.invalid' })
    expect((await rowsOf(pg.db, sql`SELECT email FROM users WHERE id = 4`))[0]).toEqual({ email: 'other@example.invalid' })

    const manager = await login('manager@example.invalid')
    const add = await rest('POST', '/api/miembros', manager.token, {
      organization: 1,
      email: 'nueva.persona@example.invalid',
      name: 'Nueva Persona',
      role: 'admin',
    })
    expect(add.status).toBe(201)
    expect(await rowsOf(pg.db, sql`SELECT 1 FROM memberships WHERE organization_id = 1 AND user_id = 4`)).toEqual([])
  })

  it('A-03: a platform admin still changes an email', async () => {
    const platform = await login('platform@example.invalid')
    expect((await rest('PATCH', '/api/users/4', platform.token, { email: 'Cambiado@Example.invalid ' })).status).toBe(200)
    expect((await rowsOf(pg.db, sql`SELECT email FROM users WHERE id = 4`))[0]).toEqual({ email: 'cambiado@example.invalid' })
  })
})
