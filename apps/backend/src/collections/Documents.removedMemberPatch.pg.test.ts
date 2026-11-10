/**
 * 🔴 A REMOVED MEMBER CANNOT PATCH THEIR DRAFT INTO ANOTHER INGEST — AGAINST A
 * REAL POSTGRES.
 *
 * Audit 2026-11-10 (A-02, retry bypass): `/retry` and `/publish` asked for a
 * `documents:write` seat, but `PATCH /api/documents/:id` asked only "are you
 * the uploader". New `extractedText` with `ingestStatus: 'pending'`, or a
 * plain rename of a `failed` row, re-ran the ingest on the ecosistema's budget.
 *
 * Harness: `lib/testing/realPostgres`, Payload's REST router (`handleEndpoints`).
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

const PASSWORD = 'removed-patch-pw'
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

const login = async (email: string) => {
  const res = await rest('POST', '/api/users/login', undefined, { email, password: PASSWORD })
  return ((await res.json()) as { token?: string }).token
}

const run = (s: string) => pg.db.execute(sql.raw(s))
const docs = () =>
  rowsOf(pg.db, sql`SELECT id, name, extracted_text, ingest_status FROM documents WHERE id IN (51, 52) ORDER BY id`)
const STORED = [
  { id: 51, name: 'borrador.pdf', extracted_text: 'BORRADOR DEL MIEMBRO', ingest_status: 'ready' },
  { id: 52, name: 'fallido.pdf', extracted_text: 'FALLÓ AL INGERIR', ingest_status: 'failed' },
]

describe.skipIf(!dockerOk)('PATCH on a document needs a documents:write seat', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-removed-patch-${process.pid}`, 'removed_patch')
    payload = await bootPayload(pg.url, 'removed-patch-secret')
    config = await (await import('@payload-config')).default
  }, 120_000)

  beforeEach(async () => {
    await run(`
      TRUNCATE documents, media, memberships, organizations, users RESTART IDENTITY CASCADE;
      INSERT INTO users (id, email, is_platform_admin) VALUES (1, 'member@example.invalid', false);
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Uno', 'uno');
      INSERT INTO memberships (id, user_id, organization_id, role) VALUES (1, 1, 1, 'member');
      INSERT INTO documents (id, organization_id, uploaded_by_id, publication_status, kind, content_kind, anonymise, anonymisation_status, extracted_text, name, ingest_status)
        VALUES (51, 1, 1, 'draft', 'pdf', 'documento', false, 'n/a', 'BORRADOR DEL MIEMBRO', 'borrador.pdf', 'ready'),
               (52, 1, 1, 'draft', 'pdf', 'documento', false, 'n/a', 'FALLÓ AL INGERIR', 'fallido.pdf', 'failed');
    `)
    for (const t of ['users', 'organizations', 'memberships', 'documents']) {
      await run(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), 1000)`)
    }
    await payload.update({ collection: 'users', id: 1, overrideAccess: true, data: { password: PASSWORD } as never })
  }, 60_000)

  afterAll(async () => {
    await shutdown(pg, payload)
  })

  it('control: an active member renames its draft', async () => {
    const token = await login('member@example.invalid')
    expect((await rest('PATCH', '/api/documents/51', token, { name: 'nuevo.pdf' })).status).toBe(200)
    expect((await docs())[0]).toMatchObject({ id: 51, name: 'nuevo.pdf' })
  })

  for (const [label, revoke] of [
    ['membership deleted', `DELETE FROM memberships WHERE id = 1`],
    ['membership switched off', `UPDATE memberships SET is_active = false WHERE id = 1`],
    ['ecosistema switched off', `UPDATE organizations SET is_active = false WHERE id = 1`],
  ] as const) {
    it(`A-02 (${label}): no text edit back to pending, no rename of a failed row`, async () => {
      const token = await login('member@example.invalid')
      await run(revoke)
      const edit = await rest('PATCH', '/api/documents/51', token, {
        extractedText: 'TEXTO NUEVO',
        ingestStatus: 'pending',
        ingestId: null,
      })
      expect([403, 404]).toContain(edit.status)
      expect([403, 404]).toContain((await rest('PATCH', '/api/documents/52', token, { name: 'otra.pdf' })).status)
      expect(await docs()).toEqual(STORED)
    })
  }
})
