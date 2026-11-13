/**
 * 🔴 THE UPLOAD CONSENT, END TO END, AGAINST A REAL POSTGRES (Etapa 1
 * correction, 2026-11-12; `lib/uploadConsent.ts`, `collections/ConsentReceipts.ts`).
 *
 *   · `POST /api/documents` from a user: no version → 400, another → 409, the
 *     current one → the document and exactly one receipt, in one transaction
 *     (JSON and the multipart `_payload`);
 *   · server creates (no user, or `overrideAccess`) → no receipt, no error;
 *   · a document delete keeps the receipt (`document` NULL, the snapshot kept);
 *   · nobody creates, edits or deletes a receipt through REST; reads are the
 *     uploader's own rows, `holds:review` and the platform admin;
 *   · a receipt has no text column;
 *   · `GET /api/documents/:id/constancia`.
 *
 * Harness: `lib/testing/realPostgres`, Payload's REST router (`handleEndpoints`).
 */

import { sql } from '@payloadcms/db-postgres'
import type { Payload, SanitizedConfig } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/aiClient', () => {
  const anything: unknown = new Proxy(() => {}, {
    get: (_t, key) => (key === 'then' ? undefined : anything),
    apply: async () => ({ ok: true }),
  })
  return { getAdminAIClient: () => anything, getAppAIClient: () => anything }
})

import { UPLOAD_CONSENT_VERSION } from '@/lib/uploadConsent'
import { bootPayload, dockerOk, rowsOf, shutdown, startRealPostgres, type RealPostgres } from '@/lib/testing/realPostgres'

const PASSWORD = 'consent-receipts-pw'
let pg: RealPostgres
let payload: Payload
let config: SanitizedConfig
const tokens: Record<string, string> = {}

// 1 uploader (member), 2 another member, 3 reviewer (admin role: holds:review), 4 platform admin.
const EMAILS = { ana: 'ana@example.invalid', beto: 'beto@example.invalid', rita: 'rita@example.invalid', root: 'root@example.invalid' }

async function call(method: string, path: string, token?: string, body?: unknown): Promise<Response> {
  const { handleEndpoints } = await import('payload')
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `JWT ${token}`
  let payloadBody: BodyInit | undefined
  if (body instanceof FormData) payloadBody = body
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payloadBody = JSON.stringify(body)
  }
  return handleEndpoints({ config, request: new Request(`http://localhost${path}`, { method, headers, body: payloadBody }) })
}
async function login(email: string): Promise<string> {
  const res = await call('POST', '/api/users/login', undefined, { email, password: PASSWORD })
  return ((await res.json()) as { token: string }).token
}
const run = (s: string) => pg.db.execute(sql.raw(s))
const receipts = () => rowsOf(pg.db, sql`SELECT * FROM consent_receipts ORDER BY id`)
const docCount = async () => Number((await rowsOf(pg.db, sql`SELECT count(*)::int AS n FROM documents`))[0]!.n)
const note = (extra: Record<string, unknown> = {}) => ({ kind: 'markdown', name: 'nota secreta', bodyMarkdown: 'hola', ...extra })
const message = async (res: Response) => ((await res.json()) as { errors?: Array<{ message: string }> }).errors?.[0]?.message

describe.skipIf(!dockerOk)('upload consent receipts', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-consent-receipts-${process.pid}`, 'consent_receipts')
    payload = await bootPayload(pg.url, 'consent-receipts-secret')
    config = await (await import('@payload-config')).default
  }, 120_000)

  beforeEach(async () => {
    await run(`
      DROP TRIGGER IF EXISTS refuse_receipt ON consent_receipts;
      TRUNCATE consent_receipts, documents, memberships, organizations, users RESTART IDENTITY CASCADE;
      INSERT INTO users (id, email, is_platform_admin) VALUES
        (1, '${EMAILS.ana}', false), (2, '${EMAILS.beto}', false), (3, '${EMAILS.rita}', false), (4, '${EMAILS.root}', true);
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Uno', 'uno');
      INSERT INTO memberships (user_id, organization_id, role) VALUES (1, 1, 'member'), (2, 1, 'member'), (3, 1, 'admin');
    `)
    for (const t of ['users', 'organizations', 'memberships']) await run(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), 100)`)
    for (const [who, email] of Object.entries(EMAILS)) {
      const [u] = (await payload.find({ collection: 'users', where: { email: { equals: email } }, overrideAccess: true })).docs
      await payload.update({ collection: 'users', id: u!.id, overrideAccess: true, data: { password: PASSWORD } as never })
      tokens[who] = await login(email)
    }
  }, 60_000)

  afterAll(async () => {
    await shutdown(pg, payload)
  })

  it('a user create without the version → 400 upload_consent_required, nothing written', async () => {
    const res = await call('POST', '/api/documents', tokens.ana, note())
    expect(res.status).toBe(400)
    expect(await message(res)).toBe('upload_consent_required')
    expect(await docCount()).toBe(0)
    expect(await receipts()).toEqual([])
  })

  it('a user create with another version → 409 consent_version_changed, nothing written', async () => {
    const res = await call('POST', '/api/documents', tokens.ana, note({ uploadConsentVersion: UPLOAD_CONSENT_VERSION - 1 }))
    expect(res.status).toBe(409)
    expect(await message(res)).toBe('consent_version_changed')
    expect(await docCount()).toBe(0)
  })

  it('the current version (JSON) → the document and exactly one receipt, with no text', async () => {
    const res = await call('POST', '/api/documents', tokens.ana, note({ uploadConsentVersion: UPLOAD_CONSENT_VERSION }))
    expect(res.status).toBe(201)
    const { doc } = (await res.json()) as { doc: { id: number; uploadConsentVersion?: unknown } }
    expect(doc.uploadConsentVersion).toBeUndefined()
    const rows = await receipts()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      document_id: doc.id,
      organization_id: 1,
      actor_id: 1,
      kind: 'upload',
      content_kind: 'documento',
    })
    expect(Number(rows[0]!.document_id_snapshot)).toBe(doc.id)
    expect(Number(rows[0]!.consent_version)).toBe(UPLOAD_CONSENT_VERSION)
    expect(JSON.stringify(rows[0])).not.toContain('nota secreta')
  })

  it('the multipart `_payload` carries it too (and is refused without it)', async () => {
    const form = (data: Record<string, unknown>) => {
      const f = new FormData()
      f.set('_payload', JSON.stringify(data))
      return f
    }
    const refused = await call('POST', '/api/documents', tokens.ana, form(note()))
    expect(refused.status).toBe(400)
    expect(await message(refused)).toBe('upload_consent_required')
    const ok = await call('POST', '/api/documents', tokens.ana, form(note({ uploadConsentVersion: UPLOAD_CONSENT_VERSION })))
    expect(ok.status).toBe(201)
    expect(await receipts()).toHaveLength(1)
  })

  it('🔴 a failed receipt rolls the document back (one transaction)', async () => {
    await run(`
      CREATE OR REPLACE FUNCTION refuse_receipt() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'no receipt'; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER refuse_receipt BEFORE INSERT ON consent_receipts FOR EACH ROW EXECUTE FUNCTION refuse_receipt();
    `)
    const res = await call('POST', '/api/documents', tokens.ana, note({ uploadConsentVersion: UPLOAD_CONSENT_VERSION }))
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(await docCount()).toBe(0)
  })

  it('server creates (no user, or overrideAccess as the seeds do) write no receipt and do not fail', async () => {
    await payload.create({ collection: 'documents', overrideAccess: true, data: { ...note(), organization: 1, uploadedBy: 1 } as never })
    const ana = await payload.findByID({ collection: 'users', id: 1, overrideAccess: true })
    await payload.create({ collection: 'documents', overrideAccess: true, user: ana, data: { ...note(), organization: 1 } as never })
    expect(await docCount()).toBe(2)
    expect(await receipts()).toEqual([])
  })

  it('a document delete keeps the receipt: document NULL, snapshot kept', async () => {
    const res = await call('POST', '/api/documents', tokens.ana, note({ uploadConsentVersion: UPLOAD_CONSENT_VERSION }))
    const { doc } = (await res.json()) as { doc: { id: number } }
    expect((await call('DELETE', `/api/documents/${doc.id}`, tokens.ana)).status).toBe(200)
    const rows = await receipts()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.document_id).toBeNull()
    expect(Number(rows[0]!.document_id_snapshot)).toBe(doc.id)
  })

  it('nobody creates, edits or deletes a receipt through REST, platform admin included', async () => {
    await call('POST', '/api/documents', tokens.ana, note({ uploadConsentVersion: UPLOAD_CONSENT_VERSION }))
    const [r] = await receipts()
    for (const who of ['ana', 'root'] as const) {
      const body = { documentIdSnapshot: 9, organization: 1, kind: 'upload', consentVersion: 1, contentKind: 'documento' }
      expect((await call('POST', '/api/consent-receipts', tokens[who], body)).status).toBe(403)
      expect((await call('PATCH', `/api/consent-receipts/${r!.id}`, tokens[who], { consentVersion: 9 })).status).toBe(403)
      expect((await call('DELETE', `/api/consent-receipts/${r!.id}`, tokens[who])).status).toBe(403)
    }
    expect(await receipts()).toEqual([r])
  })

  it('reads: the uploader its own rows, holds:review its ecosistema, the platform admin all; another member none', async () => {
    await call('POST', '/api/documents', tokens.ana, note({ uploadConsentVersion: UPLOAD_CONSENT_VERSION }))
    const seen = async (who: string) =>
      ((await (await call('GET', '/api/consent-receipts?depth=0', tokens[who])).json()) as { docs?: unknown[] }).docs?.length ?? 0
    expect(await seen('ana')).toBe(1)
    expect(await seen('rita')).toBe(1)
    expect(await seen('root')).toBe(1)
    expect(await seen('beto')).toBe(0)
  })

  it('🔴 a receipt has no text column (never a name, a title or content)', async () => {
    const cols = await rowsOf(
      pg.db,
      sql`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'consent_receipts' ORDER BY column_name`,
    )
    expect(cols.filter((c) => /char|text|json/.test(String(c.data_type)))).toEqual([])
  })

  describe('GET /api/documents/:id/constancia', () => {
    type Constancia = { receipt: Record<string, unknown> | null; document: Record<string, unknown> | null }
    const constancia = async (id: number, who?: string) => {
      const res = await call('GET', `/api/documents/${id}/constancia`, who ? tokens[who] : undefined)
      return { status: res.status, body: (await res.json()) as Constancia }
    }
    const upload = async () => {
      const res = await call('POST', '/api/documents', tokens.ana, note({ uploadConsentVersion: UPLOAD_CONSENT_VERSION }))
      return ((await res.json()) as { doc: { id: number } }).doc.id
    }

    it('the uploader gets the receipt and the document', async () => {
      const id = await upload()
      const [r] = await receipts()
      const { status, body } = await constancia(id, 'ana')
      expect(status).toBe(200)
      expect(body).toMatchObject({
        documentId: id,
        receipt: {
          id: r!.id,
          folio: `EDC-2026-${String(r!.id).padStart(6, '0')}`,
          consentVersion: UPLOAD_CONSENT_VERSION,
          contentKind: 'documento',
          ecosystem: { id: 1, name: 'Uno' },
        },
        document: { kind: 'markdown', contentKind: 'documento', title: 'nota secreta' },
      })
      expect(typeof body.receipt!.acceptedAt).toBe('string')
      expect(typeof body.document!.createdAt).toBe('string')
    })

    it('anyone else (a member, a reviewer, nobody signed in) gets 404 not_found; the platform admin 200', async () => {
      const id = await upload()
      for (const who of ['beto', 'rita', undefined]) {
        expect(await constancia(id, who)).toEqual({ status: 404, body: { error: 'not_found' } })
      }
      expect((await constancia(id, 'root')).status).toBe(200)
      expect(await constancia(99999, 'ana')).toEqual({ status: 404, body: { error: 'not_found' } })
    })

    it('after the delete: document null, the receipt still resolves by snapshot', async () => {
      const id = await upload()
      await call('DELETE', `/api/documents/${id}`, tokens.ana)
      const { status, body } = await constancia(id, 'ana')
      expect(status).toBe(200)
      expect(body.document).toBeNull()
      expect(body.receipt!.consentVersion).toBe(UPLOAD_CONSENT_VERSION)
      expect((await constancia(id, 'beto')).status).toBe(404)
    })

    it('a document from before the consent: receipt null', async () => {
      const doc = await payload.create({
        collection: 'documents',
        overrideAccess: true,
        data: { ...note(), organization: 1, uploadedBy: 1 } as never,
      })
      const { status, body } = await constancia(Number(doc.id), 'ana')
      expect(status).toBe(200)
      expect(body.receipt).toBeNull()
      expect(body.document!.kind).toBe('markdown')
    })
  })
})
