/**
 * 🔴 A REASON COLUMN WRITTEN BEFORE 2026-11-10 NEVER SERVES ITS RAW TEXT —
 * AGAINST A REAL POSTGRES, THROUGH PAYLOAD'S REST ROUTER (real JWT).
 *
 * Audit 2026-11-11: rows stored before the write-side `safeErrMessage` still
 * hold drizzle's `Failed query: …\nparams: …`, and `GET /api/documents/:id`
 * handed it to anyone who reads the row. The `afterRead` guard
 * (`lib/storedReason.ts`) withholds it for the uploader, a colleague, and a
 * platform admin (no exception: see that module's header). The `code:` stays.
 *
 * Harness: `lib/testing/realPostgres`.
 */

import { sql } from '@payloadcms/db-postgres'
import type { Payload, SanitizedConfig } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/aiClient', () => {
  const anything: unknown = new Proxy(() => {}, {
    get: (_t, key) => (key === 'then' ? undefined : anything),
    apply: async () => ({ ok: true }),
  })
  return { getAdminAIClient: () => anything, getAppAIClient: () => anything }
})

import { bootPayload, dockerOk, shutdown, startRealPostgres, type RealPostgres } from '@/lib/testing/realPostgres'

const PASSWORD = 'stored-reason-pw'
let pg: RealPostgres
let payload: Payload
let config: SanitizedConfig
const tokens: Record<string, string> = {}

const ANA = 1 // investigador, uploaded the document, owns the conversation
const RITA = 2 // investigador, same ecosistema
const PLATFORM = 9

const DOC = 20 // published documento: every member of the ecosistema reads it
const MSG = 40

/** What drizzle stored: the query and the row it was writing. */
const DRIZZLE = 'Failed query: update "documents" set "extracted_text" = $1 where "documents"."id" = $2\nparams: Juana Perez vive en Milpa Alta,20'
const ROW_TEXT = /Juana Perez|Milpa Alta|Failed query|extracted_text/

async function rest(path: string, token: string): Promise<Response> {
  const { handleEndpoints } = await import('payload')
  return handleEndpoints({ config, request: new Request(`http://localhost${path}`, { headers: { Authorization: `JWT ${token}` } }) })
}

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

describe.skipIf(!dockerOk)('stored reason columns: no raw database text over REST (real Postgres)', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-stored-reason-${process.pid}`, 'stored_reason')
    payload = await bootPayload(pg.url, 'stored-reason-secret')
    config = await (await import('@payload-config')).default
    const raw = DRIZZLE.replace(/'/g, "''")
    await pg.db.execute(sql.raw(`
      INSERT INTO users (id, email, is_platform_admin) VALUES
        (${ANA}, 'ana@example.invalid', false), (${RITA}, 'rita@example.invalid', false),
        (${PLATFORM}, 'platform@example.invalid', true);
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Uno', 'uno');
      INSERT INTO memberships (user_id, organization_id, role) VALUES
        (${ANA}, 1, 'investigador'), (${RITA}, 1, 'investigador');
      INSERT INTO documents (id, organization_id, uploaded_by_id, publication_status, kind, content_kind, anonymise, anonymisation_status, extracted_text, name,
                             publication_error, ingest_error, anonymisation_error, graph_error)
        VALUES (${DOC}, 1, ${ANA}, 'published', 'pdf', 'documento', false, 'n/a', 'PLAIN', 'Guia publica.pdf',
                E'${raw.replace(/\n/g, '\\n')}', E'ingest_failed: ${raw.replace(/\n/g, '\\n')}',
                E'verify: ${raw.replace(/\n/g, '\\n')}', E'graph_failed: ${raw.replace(/\n/g, '\\n')}');
      INSERT INTO sessions (id, user_id, organization_id, title) VALUES (30, ${ANA}, 1, 'Riego');
      INSERT INTO messages (id, session_id, role, content, corpus_error)
        VALUES (${MSG}, 30, 'user', 'hola', E'ingest_failed: ${raw.replace(/\n/g, '\\n')}');
    `))
    for (const t of ['users', 'organizations', 'memberships', 'documents', 'sessions', 'messages']) {
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

  it('the row really holds the raw text (the fixture is what old writes left)', async () => {
    const stored = (await pg.db.execute(sql`SELECT publication_error FROM documents WHERE id = ${DOC}`)) as unknown as {
      rows: Array<{ publication_error: string }>
    }
    expect(stored.rows[0]?.publication_error).toMatch(ROW_TEXT)
  })

  it.each(['ana', 'rita', 'platform'])('🔴 GET /api/documents/:id as %s: no row text, the code kept', async (who) => {
    const res = await rest(`/api/documents/${DOC}?depth=0`, tokens[who]!)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toMatch(ROW_TEXT)
    const doc = JSON.parse(text) as Record<string, unknown>
    expect(doc.publicationError).toBe('[database error text withheld]')
    expect(doc.ingestError).toBe('ingest_failed: [database error text withheld]')
    expect(doc.anonymisationError).toBe('verify: [database error text withheld]')
  })

  it('🔴 a list read gets the same', async () => {
    const res = await rest(`/api/documents?depth=0&where[id][equals]=${DOC}`, tokens.rita!)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('[database error text withheld]')
    expect(text).not.toMatch(ROW_TEXT)
  })

  it('🔴 GET /api/messages/:id: corpusError withheld for the conversation owner', async () => {
    const res = await rest(`/api/messages/${MSG}?depth=0`, tokens.ana!)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toMatch(ROW_TEXT)
    expect((JSON.parse(text) as { corpusError?: unknown }).corpusError).toBe('ingest_failed: [database error text withheld]')
  })
})
