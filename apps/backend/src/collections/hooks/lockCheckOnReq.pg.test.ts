/**
 * 🔴 A LOCK IS ONLY EVER REPORTED ON A ROW THE CALLER MAY ALREADY WRITE —
 * AGAINST A REAL POSTGRES, THROUGH PAYLOAD'S REST ROUTER WITH REAL JWTs.
 *
 * `hooks/lockCheckOnReq.ts` takes over Payload's lock check so that it reads
 * through `req`. A check that ran before access answered 423 on a row in
 * another ecosistema, and a bulk write listed every id its `where` matched:
 * any field of any row could be tested yes/no. Each case below sends the same
 * request with the foreign row locked and unlocked, and the two answers must be
 * the same.
 *
 * Payload's rule itself still holds on the caller's own rows: another user's
 * fresh lock refuses, their own lock does not, a lock older than the lock
 * duration does not (`utilities/checkDocumentLockStatus.js`, Payload 3.88).
 */

import { sql } from '@payloadcms/db-postgres'
import type { Payload, SanitizedConfig } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Deletes and the publish path go as far as a configured ai-service would take them.
vi.mock('@/lib/aiClient', () => {
  const anything: unknown = new Proxy(() => {}, {
    get: (_t, key) => (key === 'then' ? undefined : anything),
    apply: async () => ({ ok: true, ingestId: 'fake-ingest' }),
  })
  return { getAdminAIClient: () => anything, getAppAIClient: () => anything }
})

import { bootPayload, dockerOk, rowsOf, shutdown, startRealPostgres, type RealPostgres } from '@/lib/testing/realPostgres'

let pg: RealPostgres
let payload: Payload
let config: SanitizedConfig
let credentials: { salt: string; hash: string }
const PASSWORD = 'lock-check-pw'

// 1 olga, owner of A · 3 memo, member of A · 6 bea, owner of B.
const OLGA = 1
const MEMO = 3
const BEA = 6
const EMAIL: Record<number, string> = {
  [OLGA]: 'olga@example.invalid',
  [MEMO]: 'memo@example.invalid',
  [BEA]: 'bea@example.invalid',
}
// 61, 62 Memo's in A · 70 Bea's in B.
const OWN = 61
const OWN_2 = 62
const FOREIGN = 70

/** Payload's default lock duration (`checkDocumentLockStatus.js`, Payload 3.88); `documents` sets none. */
const LOCK_SECONDS = 300

describe.skipIf(!dockerOk)('the lock check never answers before access', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-lock-check-${process.pid}`, 'lock_check')
    payload = await bootPayload(pg.url, 'lock-check-secret')
    config = await (await import('@payload-config')).default
    await payload.create({
      collection: 'users',
      data: { email: 'hash@example.invalid', password: PASSWORD } as never,
      overrideAccess: true,
    })
    const [row] = await rowsOf(pg.db, sql`SELECT salt, hash FROM users WHERE email = 'hash@example.invalid'`)
    credentials = { salt: String(row?.salt), hash: String(row?.hash) }
  }, 120_000)

  beforeEach(fresh)

  afterAll(async () => {
    await shutdown(pg, payload)
  })

  /** The same rows for every run, so two runs of a request can be compared. */
  async function fresh(): Promise<void> {
    const tables = (
      await rowsOf(pg.db, sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE 'payload_migrations%'`)
    ).map((r) => `"${String(r.tablename)}"`)
    await pg.db.execute(sql.raw(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`))
    await pg.db.execute(sql.raw(`
      INSERT INTO users (id, email, display_name, is_platform_admin, salt, hash) VALUES
        (1, 'olga@example.invalid', 'Olga', false, '${credentials.salt}', '${credentials.hash}'),
        (3, 'memo@example.invalid', 'Memo', false, '${credentials.salt}', '${credentials.hash}'),
        (6, 'bea@example.invalid', 'Bea', false, '${credentials.salt}', '${credentials.hash}');
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Eco A', 'eco-a'), (2, 'Eco B', 'eco-b');
      INSERT INTO memberships (id, user_id, organization_id, role) VALUES
        (1, 1, 1, 'owner'), (3, 3, 1, 'member'), (6, 6, 2, 'owner');
      INSERT INTO documents (id, organization_id, uploaded_by_id, publication_status, kind, content_kind, anonymise, anonymisation_status, extracted_text, body_markdown, name, ingest_status)
        VALUES (61, 1, 3, 'draft', 'markdown', 'documento', false, 'n/a', 'Notas.', 'Notas.', 'nota.md', 'ready'),
               (62, 1, 3, 'draft', 'markdown', 'documento', false, 'n/a', 'Otras.', 'Otras.', 'otra.md', 'ready'),
               (70, 2, 6, 'draft', 'markdown', 'documento', false, 'n/a', 'SECRETO de B.', 'SECRETO de B.', 'b.md', 'ready');
    `))
    for (const t of await rowsOf(pg.db, sql`SELECT sequencename FROM pg_sequences WHERE schemaname = 'public'`)) {
      await pg.db.execute(sql.raw(`SELECT setval('"${String(t.sequencename)}"', 1000)`))
    }
  }

  /** `holder` takes the admin panel's lock on a document; `ageSeconds` back-dates it. */
  async function lock(doc: number, holder: number, ageSeconds = 0): Promise<void> {
    const data = { document: { relationTo: 'documents', value: doc }, user: { relationTo: 'users', value: holder } }
    const row = await payload.create({ collection: 'payload-locked-documents', data: data as never, overrideAccess: true })
    if (ageSeconds > 0) {
      await pg.db.execute(sql`UPDATE payload_locked_documents SET updated_at = now() - make_interval(secs => ${ageSeconds}) WHERE id = ${row.id}`)
    }
  }

  async function rest(method: string, url: string, as: number, body?: unknown): Promise<Response> {
    const { handleEndpoints } = await import('payload')
    const headers: Record<string, string> = { Authorization: `JWT ${await tokenFor(as)}` }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const request = new Request(`http://localhost${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    return handleEndpoints({ config, request })
  }

  async function tokenFor(id: number): Promise<string> {
    const { handleEndpoints } = await import('payload')
    const request = new Request('http://localhost/api/users/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL[id], password: PASSWORD }),
    })
    const token = ((await (await handleEndpoints({ config, request })).json()) as { token?: string }).token
    if (!token) throw new Error(`login ${id}`)
    return token
  }

  /** What a caller learns from an answer: status, message, which rows and errors. Timestamps aside. */
  async function seen(res: Response): Promise<unknown> {
    const body = (await res.json()) as {
      message?: unknown
      errors?: unknown
      docs?: Array<{ id: unknown }>
      doc?: { id: unknown }
    }
    return { status: res.status, message: body.message, errors: body.errors, docs: body.docs?.map((d) => d.id), doc: body.doc?.id }
  }

  /** The same request on fresh rows, with nothing locked and with `doc` locked by `holder`. */
  async function bothWays(doc: number, holder: number, send: () => Promise<Response>): Promise<[unknown, unknown]> {
    await fresh()
    const unlocked = await seen(await send())
    await fresh()
    await lock(doc, holder)
    const locked = await seen(await send())
    return [unlocked, locked]
  }

  const SECRET_PROBE = `where[or][0][id][equals]=${OWN}&where[or][1][extractedText][like]=SECRETO`
  const FOREIGN_ECO = 'where[organization][equals]=2'

  it.each([
    ['PATCH', SECRET_PROBE],
    ['DELETE', SECRET_PROBE],
    ['PATCH', FOREIGN_ECO],
    ['DELETE', FOREIGN_ECO],
  ])('bulk %s ?%s: the same answer whether the foreign row is locked or not', async (method, query) => {
    const body = method === 'PATCH' ? { name: 'tocado.md' } : undefined
    const [unlocked, locked] = await bothWays(FOREIGN, BEA, () => rest(method, `/api/documents?${query}`, MEMO, body))
    expect(locked).toEqual(unlocked)
    expect(JSON.stringify(locked)).not.toContain(String(FOREIGN))
  }, 60_000)

  it.each(['PATCH', 'DELETE'])('%s by id on a foreign row: the same refusal whether it is locked or not', async (method) => {
    const body = method === 'PATCH' ? { name: 'tocado.md' } : undefined
    const [unlocked, locked] = await bothWays(FOREIGN, BEA, () => rest(method, `/api/documents/${FOREIGN}`, MEMO, body))
    expect(locked).toEqual(unlocked)
    expect([403, 404]).toContain((locked as { status: number }).status)
  }, 60_000)

  it.each(['PATCH', 'DELETE'])('%s by id on the caller\'s own row locked by someone else: 423, no id in the message', async (method) => {
    await lock(OWN, OLGA)
    const res = await rest(method, `/api/documents/${OWN}`, MEMO, method === 'PATCH' ? { name: 'tocado.md' } : undefined)
    expect(res.status).toBe(423)
    const { errors } = (await res.json()) as { errors: Array<{ message: string }> }
    expect(errors[0]?.message).toMatch(/locked/)
    expect(errors[0]?.message).not.toContain(String(OWN))
    const [row] = await rowsOf(pg.db, sql`SELECT name FROM documents WHERE id = ${OWN}`)
    expect(row?.name).toBe('nota.md')
  }, 30_000)

  it.each(['PATCH', 'DELETE'])('bulk %s: the caller\'s own locked row is refused, the other one is written', async (method) => {
    await lock(OWN, OLGA)
    const body = method === 'PATCH' ? { name: 'tocado.md' } : undefined
    const res = await rest(method, `/api/documents?where[id][in]=${OWN},${OWN_2}`, MEMO, body)
    // Payload's bulk rule: the refused row is reported in `errors`, the rest go through.
    expect(res.status).toBe(400)
    const out = (await res.json()) as { docs: Array<{ id: number }>; errors: Array<{ id: number; message: string }> }
    expect(out.docs.map((d) => d.id)).toEqual([OWN_2])
    expect(out.errors.map((e) => e.id)).toEqual([OWN])
    expect(out.errors[0]?.message).toMatch(/locked/)
    expect(out.errors[0]?.message).not.toContain(String(OWN))
    const rows = await rowsOf(pg.db, sql`SELECT id, name FROM documents WHERE id IN (61, 62) ORDER BY id`)
    expect(rows.map((r) => r.id)).toEqual(method === 'PATCH' ? [OWN, OWN_2] : [OWN])
    expect(rows[0]?.name).toBe('nota.md')
  }, 30_000)

  it.each(['PATCH', 'DELETE'])('%s by id on a row the caller locked himself goes through', async (method) => {
    await lock(OWN, MEMO)
    const res = await rest(method, `/api/documents/${OWN}`, MEMO, method === 'PATCH' ? { name: 'tocado.md' } : undefined)
    expect(res.status).toBe(200)
  }, 30_000)

  it.each(['PATCH', 'DELETE'])('%s by id on an unlocked own row goes through', async (method) => {
    const res = await rest(method, `/api/documents/${OWN}`, MEMO, method === 'PATCH' ? { name: 'tocado.md' } : undefined)
    expect(res.status).toBe(200)
  }, 30_000)

  it('a lock older than the lock duration does not refuse; one just inside it does', async () => {
    await lock(OWN, OLGA, LOCK_SECONDS + 60)
    expect((await rest('PATCH', `/api/documents/${OWN}`, MEMO, { name: 'tocado.md' })).status).toBe(200)
    await fresh()
    await lock(OWN, OLGA, LOCK_SECONDS - 60)
    expect((await rest('PATCH', `/api/documents/${OWN}`, MEMO, { name: 'tocado.md' })).status).toBe(423)
  }, 30_000)

  it('a write clears the caller\'s lock row, as Payload\'s own check does', async () => {
    await lock(OWN, MEMO)
    expect((await rest('PATCH', `/api/documents/${OWN}`, MEMO, { name: 'tocado.md' })).status).toBe(200)
    expect(await rowsOf(pg.db, sql`SELECT id FROM payload_locked_documents_rels WHERE documents_id = ${OWN}`)).toEqual([])
  }, 30_000)
})
