/**
 * 🔴 THE PER-DOCUMENT ANONYMISATION SWITCHES ARE WRITTEN BY
 * `PATCH /api/documents/:id/anonimizacion` ONLY — AGAINST A REAL POSTGRES.
 *
 * Review 2026-11-10 (R-01): `keepPublicFigures` was `platformAdminOnly`, so a
 * platform admin's collection update (REST, local API, the admin panel) changed
 * which names a published document shows with no `anonymisation-setting-changes`
 * row and no re-gate. Every switch is now `gateWritesOnly`, like
 * `keepDocumentAuthor` and `keepCitedAuthors` always were.
 */

import { sql } from '@payloadcms/db-postgres'
import type { Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/aiClient', () => {
  const anything: unknown = new Proxy(() => {}, {
    get: (_t, key) => (key === 'then' ? undefined : anything),
    apply: async () => ({ ok: true, ingestId: 'fake-ingest' }),
  })
  return { getAdminAIClient: () => anything, getAppAIClient: () => anything }
})

import { bootPayload, dockerOk, rowsOf, shutdown, startRealPostgres, type RealPostgres } from '@/lib/testing/realPostgres'
import { UPLOAD_CONSENT_VERSION } from '@/lib/uploadConsent'

const SWITCHES = ['keepPublicFigures', 'keepDocumentAuthor', 'keepCitedAuthors'] as const
const COLUMN = {
  keepPublicFigures: 'keep_public_figures',
  keepDocumentAuthor: 'keep_document_author',
  keepCitedAuthors: 'keep_cited_authors',
} as const

let pg: RealPostgres
let payload: Payload

const run = (s: string) => pg.db.execute(sql.raw(s))
const root = async () =>
  ({ ...(await payload.findByID({ collection: 'users', id: 9, overrideAccess: true })), collection: 'users' }) as never
const row = async () =>
  (
    await rowsOf(
      pg.db,
      sql`SELECT keep_public_figures, keep_document_author, keep_cited_authors, ingest_status, publication_status,
                 public_figures_kept FROM documents WHERE id = 50`,
    )
  )[0]!
const auditRows = async () =>
  Number((await rowsOf(pg.db, sql`SELECT count(*)::int AS n FROM anonymisation_setting_changes`))[0]?.n)

describe.skipIf(!dockerOk)('per-document anonymisation switches: no collection write', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-switch-writes-${process.pid}`, 'switch_writes')
    payload = await bootPayload(pg.url, 'switch-writes-secret')
  }, 120_000)

  beforeEach(async () => {
    await run(`
      TRUNCATE anonymisation_setting_changes, documents, memberships, organizations, users RESTART IDENTITY CASCADE;
      INSERT INTO users (id, email, is_platform_admin) VALUES (1, 'member@example.invalid', false),
        (9, 'platform@example.invalid', true);
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Uno', 'uno');
      INSERT INTO memberships (id, user_id, organization_id, role) VALUES (1, 1, 1, 'member'), (2, 9, 1, 'admin');
      INSERT INTO documents (id, organization_id, uploaded_by_id, name, kind, content_kind, anonymise,
                             ingest_status, publication_status, anonymisation_status,
                             keep_public_figures, keep_document_author, keep_cited_authors, public_figures_kept)
        VALUES (50, 1, 1, 'ensayo.pdf', 'pdf', 'documento', true, 'ready', 'published', 'ready',
                true, true, true, '["Octavio Paz"]'::jsonb);
    `)
  })

  afterAll(async () => {
    await shutdown(pg, payload)
  })

  for (const name of SWITCHES) {
    it(`a platform admin's local-API update leaves ${name} as it was: no audit row, no re-gate`, async () => {
      const before = await row()
      await payload.update({
        collection: 'documents',
        id: 50,
        data: { [name]: false } as never,
        user: await root(),
        overrideAccess: false,
      })
      const after = await row()
      expect(after[COLUMN[name]]).toBe(true)
      expect(after).toEqual(before)
      expect(await auditRows()).toBe(0)
    })
  }

  it('a platform admin cannot set a switch on create either', async () => {
    const doc = (await payload.create({
      collection: 'documents',
      data: { uploadConsentVersion: UPLOAD_CONSENT_VERSION, name: 'nuevo.md', organization: 1, keepPublicFigures: true } as never,
      user: await root(),
      overrideAccess: false,
    })) as { id: number }
    const [created] = await rowsOf(pg.db, sql`SELECT keep_public_figures FROM documents WHERE id = ${doc.id}`)
    expect(created?.keep_public_figures).toBeNull()
  })
})
