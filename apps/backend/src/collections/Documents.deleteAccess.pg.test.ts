/**
 * 🔴 DELETING A DOCUMENT — AGAINST A REAL POSTGRES. Two owner decisions of
 * 2026-11-10:
 *
 *   · someone removed (membership deleted or switched off, ecosistema switched
 *     off) cannot delete what they already published; their own draft, always
 *     (`uploaderMayDelete`);
 *   · the delete keeps another person's `anonymisation-reviews` rows, with the
 *     document id in `documentIdSnapshot`; only the deleting user's own go
 *     (`deleteOwnReviewRowsHook`, FK `ON DELETE set null`).
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

const PASSWORD = 'delete-access-pw'
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
const docIds = async () => (await rowsOf(pg.db, sql`SELECT id FROM documents ORDER BY id`)).map((r) => r.id)
const reviews = () =>
  rowsOf(pg.db, sql`SELECT id, document_id, document_id_snapshot::int AS snapshot, reviewer_id FROM anonymisation_reviews ORDER BY id`)

describe.skipIf(!dockerOk)('who may delete a document, and what stays', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-delete-access-${process.pid}`, 'delete_access')
    payload = await bootPayload(pg.url, 'delete-access-secret')
    config = await (await import('@payload-config')).default
  }, 120_000)

  beforeEach(async () => {
    // 81 a draft and 82 a published documento, both member 1's. Reviews on 82:
    // 90 by reviewer 2 (another person), 91 by member 1.
    await run(`
      TRUNCATE anonymisation_reviews, documents, media, memberships, organizations, users RESTART IDENTITY CASCADE;
      INSERT INTO users (id, email, is_platform_admin) VALUES
        (1, 'member@example.invalid', false), (2, 'reviewer@example.invalid', false), (3, 'admin@example.invalid', true);
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Uno', 'uno');
      INSERT INTO memberships (id, user_id, organization_id, role) VALUES (1, 1, 1, 'member'), (2, 2, 1, 'investigador');
      INSERT INTO documents (id, organization_id, uploaded_by_id, publication_status, kind, content_kind, anonymise,
                             anonymisation_status, extracted_text, name, ingest_status)
        VALUES (81, 1, 1, 'draft', 'pdf', 'documento', false, 'n/a', 'BORRADOR', 'borrador.pdf', 'ready'),
               (82, 1, 1, 'published', 'pdf', 'documento', false, 'n/a', 'PUBLICADO', 'publicado.pdf', 'ready');
      INSERT INTO anonymisation_reviews (id, document_id, document_id_snapshot, organization_id, reviewer_id, decision)
        VALUES (90, 82, 82, 1, 2, 'approved'), (91, 82, 82, 1, 1, 'approved');
    `)
    for (const t of ['users', 'organizations', 'memberships', 'documents', 'anonymisation_reviews']) {
      await run(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), 1000)`)
    }
    for (const id of [1, 2, 3]) {
      await payload.update({ collection: 'users', id, overrideAccess: true, data: { password: PASSWORD } as never })
    }
  }, 60_000)

  afterAll(async () => {
    await shutdown(pg, payload)
  })

  it('control: an active member deletes their published document', async () => {
    const token = await login('member@example.invalid')
    expect((await rest('DELETE', '/api/documents/82', token)).status).toBe(200)
    expect(await docIds()).toEqual([81])
  })

  for (const [label, revoke] of [
    ['membership deleted', `DELETE FROM memberships WHERE id = 1`],
    ['membership switched off', `UPDATE memberships SET is_active = false WHERE id = 1`],
    ['ecosistema switched off', `UPDATE organizations SET is_active = false WHERE id = 1`],
  ] as const) {
    it(`${label}: the published document stays; their own draft can still go`, async () => {
      const token = await login('member@example.invalid')
      await run(revoke)
      expect([403, 404]).toContain((await rest('DELETE', '/api/documents/82', token)).status)
      expect(await docIds()).toEqual([81, 82])
      expect((await rest('DELETE', '/api/documents/81', token)).status).toBe(200)
      expect(await docIds()).toEqual([82])
    })
  }

  it('a platform admin deletes it', async () => {
    await run(`DELETE FROM memberships WHERE id = 1`)
    expect((await rest('DELETE', '/api/documents/82', await login('admin@example.invalid'))).status).toBe(200)
    expect(await docIds()).toEqual([81])
  })

  it("the delete keeps another person's review row, unlinked, with the snapshot; the deleter's own goes", async () => {
    const token = await login('member@example.invalid')
    expect((await rest('DELETE', '/api/documents/82', token)).status).toBe(200)
    expect(await reviews()).toEqual([{ id: 90, document_id: null, snapshot: 82, reviewer_id: 2 }])
  })

  it('a review written through Payload gets its snapshot', async () => {
    const created = await payload.create({
      collection: 'anonymisation-reviews',
      overrideAccess: true,
      data: { document: 81, organization: 1, reviewer: 2, decision: 'rejected' } as never,
    })
    expect((await reviews()).find((r) => r.id === created.id)).toMatchObject({ document_id: 81, snapshot: 81 })
  })
})
