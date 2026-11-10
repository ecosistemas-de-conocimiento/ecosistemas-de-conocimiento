/**
 * 🔴 `GET /api/published` NEVER HANDS A REVIEWER A GATED DOCUMENTO'S FILE NAME
 * — AGAINST A REAL POSTGRES.
 *
 * Audit 2026-11-10: the listing titled a gated documento by its `name`, so an
 * investigador who did not upload it read "Entrevista Juana Perez.pdf". Its
 * title is `documentTitleFor` now (the gate's redacted title, or "Documento");
 * the uploader and a platform admin, who may read `name`
 * (`mayReadGatedOriginal`, scope `identity`), still get it.
 *
 * Driven through the route handler with a real JWT. Harness:
 * `lib/testing/realPostgres`.
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

const PASSWORD = 'published-title-pw'
let pg: RealPostgres
let payload: Payload
let config: SanitizedConfig
const tokens: Record<string, string> = {}

const ANA = 1 // investigador, uploader of every row
const RITA = 2 // investigador, uploaded nothing
const PLATFORM = 9

const GATED = 20 // published documento, anonymise = true, no redacted title yet
const TITLED = 21 // published documento, anonymise = true, the gate's redacted title
const PLAIN = 22 // published documento, anonymise = false: not a review row
const VOZ = 23 // published testimonio with its generated title

const RAW = /Juana Perez|Pedro Lopez/

type Item = { id: string; title: string; contentKind: string }

async function login(email: string): Promise<string> {
  const { handleEndpoints } = await import('payload')
  const res = await handleEndpoints({
    config,
    request: new Request('http://localhost/api/users/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  })
  const token = ((await res.json()) as { token?: string }).token
  if (!token) throw new Error(`login failed for ${email}`)
  return token
}

async function listAs(who: string): Promise<{ status: number; text: string; byId: Map<number, Item> }> {
  const { GET } = await import('./route')
  const res = await GET(
    new Request('http://localhost/api/published?organization=1', { headers: { Authorization: `JWT ${tokens[who]}` } }),
  )
  const text = await res.text()
  const items = ((JSON.parse(text) as { items?: Item[] }).items ?? []) as Item[]
  return { status: res.status, text, byId: new Map(items.map((i) => [Number(i.id), i])) }
}

describe.skipIf(!dockerOk)('GET /api/published: a gated documento title (real Postgres)', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-published-title-${process.pid}`, 'published_title')
    payload = await bootPayload(pg.url, 'published-title-secret')
    config = await (await import('@payload-config')).default
    await pg.db.execute(sql.raw(`
      INSERT INTO users (id, email, is_platform_admin) VALUES
        (${ANA}, 'ana@example.invalid', false), (${RITA}, 'rita@example.invalid', false),
        (${PLATFORM}, 'platform@example.invalid', true);
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Uno', 'uno');
      INSERT INTO memberships (user_id, organization_id, role) VALUES
        (${ANA}, 1, 'investigador'), (${RITA}, 1, 'investigador');
      INSERT INTO documents (id, organization_id, uploaded_by_id, publication_status, kind, content_kind, anonymise, anonymisation_status, redacted_text, extracted_text, name, anonymisation_report, testimonio_title)
        VALUES (${GATED}, 1, ${ANA}, 'published', 'pdf', 'documento', true, 'ready', 'TEXTO [PERSONA]', 'RAW', 'Entrevista Juana Perez.pdf', NULL, NULL),
               (${TITLED}, 1, ${ANA}, 'published', 'pdf', 'documento', true, 'ready', 'TEXTO [PERSONA]', 'RAW', 'Entrevista Pedro Lopez.pdf', '{"redactedTitle":"Entrevista a [Persona A].pdf"}', NULL),
               (${PLAIN}, 1, ${ANA}, 'published', 'pdf', 'documento', false, 'n/a', NULL, 'PLAIN', 'Guia publica.pdf', NULL, NULL),
               (${VOZ}, 1, ${ANA}, 'published', 'audio', 'testimonio', false, 'ready', 'Vivo en [Lugar A].', 'RAW', 'grabacion Juana Perez.m4a', NULL, 'La siembra del maiz');
    `))
    for (const t of ['users', 'organizations', 'memberships', 'documents']) {
      await pg.db.execute(sql.raw(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), 1000)`))
    }
    for (const id of [ANA, RITA, PLATFORM]) {
      await payload.update({ collection: 'users', id, overrideAccess: true, data: { password: PASSWORD } as never })
    }
    tokens.ana = await login('ana@example.invalid')
    tokens.rita = await login('rita@example.invalid')
    tokens.platform = await login('platform@example.invalid')
  }, 120_000)

  afterAll(async () => {
    await shutdown(pg, payload)
  })

  it('🔴 a reviewer who did not upload it gets the neutral or redacted title, and no raw name anywhere', async () => {
    const r = await listAs('rita')
    expect(r.status).toBe(200)
    expect(r.byId.get(GATED)?.title).toBe('Documento')
    expect(r.byId.get(TITLED)?.title).toBe('Entrevista a [Persona A].pdf')
    expect(r.text).not.toMatch(RAW)
  })

  it('the uploader and a platform admin get the file name', async () => {
    for (const who of ['ana', 'platform']) {
      const r = await listAs(who)
      expect(r.status).toBe(200)
      expect(r.byId.get(GATED)?.title).toBe('Entrevista Juana Perez.pdf')
      expect(r.byId.get(TITLED)?.title).toBe('Entrevista Pedro Lopez.pdf')
    }
  })

  it('a testimonio keeps its generated title; a non-gated documento is not a review row, and keeps its name', async () => {
    const r = await listAs('rita')
    expect(r.byId.get(VOZ)).toMatchObject({ title: 'La siembra del maiz', contentKind: 'testimonio' })
    expect(r.byId.has(PLAIN)).toBe(false)
    const plain = await payload.findByID({ collection: 'documents', id: PLAIN, depth: 0, user: { id: RITA } as never, overrideAccess: false }).catch(() => null)
    expect((plain as { name?: unknown } | null)?.name).toBe('Guia publica.pdf')
  })
})
