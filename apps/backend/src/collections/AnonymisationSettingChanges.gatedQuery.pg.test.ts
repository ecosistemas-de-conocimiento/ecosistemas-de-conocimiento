/**
 * 🔴 THE SWITCH LOG CANNOT BE SEARCHED BY A GATED DOCUMENTO'S NAME — OVER
 * REST, AGAINST A REAL POSTGRES.
 *
 * Audit 2026-11-10: `anonymisation-setting-changes` had no
 * `constrainGatedQueriesAt('document.')`, so a reviewer (`holds:review`) who
 * did not upload the documento filtered `where[document.name][like]=Juana`
 * and got 1 row, `=Zzzz` 0: an oracle on the gated file name. Same rule as
 * `anonymisation-reviews` now: such a where only reaches rows whose documento
 * the caller may read, and a sort on it is stripped.
 *
 * Also measured here: the other relationships to `documents` that a user can
 * query over REST (`sessions.contextScope`, `messages.contextRefs`).
 *
 * Driven through Payload's REST router (`handleEndpoints`, real JWT). Harness:
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

const PASSWORD = 'setting-changes-pw'
let pg: RealPostgres
let payload: Payload
let config: SanitizedConfig
const tokens: Record<string, string> = {}

const ANA = 1 // uploader of the gated rows
const RITA = 3 // investigador: holds `holds:review`, did not upload them
const PLATFORM = 9

const GATED = 20 // documento, anonymise = true
const NULLED = 21 // documento, anonymise = NULL: gated too
const PLAIN = 22 // documento, anonymise = false

const GATED_NAME = 'Entrevista Juana Perez.pdf'
const NULLED_NAME = 'Notas Juana Nula.pdf'
const PLAIN_NAME = 'Guia publica.pdf'

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

async function login(email: string): Promise<string> {
  const res = await rest('POST', '/api/users/login', undefined, { email, password: PASSWORD })
  const token = ((await res.json()) as { token?: string }).token
  if (!token) throw new Error(`login failed for ${email}`)
  return token
}

type Row = Record<string, unknown>

async function changes(who: string, query: string): Promise<{ status: number; docs: number[] }> {
  const res = await rest('GET', `/api/anonymisation-setting-changes?depth=0&limit=100&${query}`, tokens[who])
  const body = (await res.json()) as { docs?: Row[] }
  return { status: res.status, docs: (body.docs ?? []).map((d) => Number(d.document)) }
}

describe.skipIf(!dockerOk)('anonymisation-setting-changes: no oracle on a gated documento name (real Postgres)', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-setting-changes-${process.pid}`, 'setting_changes')
    payload = await bootPayload(pg.url, 'setting-changes-secret')
    config = await (await import('@payload-config')).default
    await pg.db.execute(sql.raw(`
      INSERT INTO users (id, email, is_platform_admin) VALUES
        (${ANA}, 'ana@example.invalid', false), (${RITA}, 'rita@example.invalid', false),
        (${PLATFORM}, 'platform@example.invalid', true);
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Uno', 'uno');
      INSERT INTO memberships (user_id, organization_id, role) VALUES
        (${ANA}, 1, 'investigador'), (${RITA}, 1, 'investigador');
      INSERT INTO documents (id, organization_id, uploaded_by_id, publication_status, kind, content_kind, anonymise, anonymisation_status, redacted_text, extracted_text, name)
        VALUES (${GATED}, 1, ${ANA}, 'published', 'pdf', 'documento', true, 'ready', 'TEXTO [PERSONA]', 'RAW', '${GATED_NAME}'),
               (${NULLED}, 1, ${ANA}, 'published', 'pdf', 'documento', NULL, 'ready', 'TEXTO [PERSONA]', 'RAW', '${NULLED_NAME}'),
               (${PLAIN}, 1, ${ANA}, 'published', 'pdf', 'documento', false, 'n/a', NULL, 'PLAIN', '${PLAIN_NAME}');
      INSERT INTO anonymisation_setting_changes (organization_id, document_id, actor_id, scope, key, before, after)
        VALUES (1, ${GATED}, ${ANA}, 'documento', 'keepDocumentAuthor', NULL, true),
               (1, ${NULLED}, ${ANA}, 'documento', 'keepCitedAuthors', NULL, true),
               (1, ${PLAIN}, ${ANA}, 'documento', 'keepDocumentAuthor', NULL, false);
    `))
    for (const t of ['users', 'organizations', 'memberships', 'documents', 'anonymisation_setting_changes']) {
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

  it('a reviewer reads the whole log', async () => {
    const r = await changes('rita', '')
    expect(r.status).toBe(200)
    expect(r.docs.sort()).toEqual([GATED, NULLED, PLAIN])
  })

  it("a reviewer's search on document.name gets 0 rows for the real name and for a fake one", async () => {
    for (const q of [
      'where[document.name][like]=Juana',
      `where[document.name][equals]=${encodeURIComponent(GATED_NAME)}`,
      'where[document.name][like]=Nula',
      'where[document.name][like]=Zzzz',
      'where[or][0][document.name][like]=Juana',
    ]) {
      const r = await changes('rita', q)
      expect(r.status, q).toBe(200)
      expect(r.docs, q).toEqual([])
    }
    const count = await rest('GET', '/api/anonymisation-setting-changes/count?where[document.name][like]=Juana', tokens.rita)
    expect(((await count.json()) as { totalDocs?: number }).totalDocs).toBe(0)
  })

  it('a reviewer still finds a non-gated documento by name', async () => {
    expect((await changes('rita', 'where[document.name][like]=Guia')).docs).toEqual([PLAIN])
  })

  it("a reviewer's sort on document.name does not move the gated rows", async () => {
    const up = await changes('rita', 'sort=document.name')
    const down = await changes('rita', 'sort=-document.name')
    expect(up.status).toBe(200)
    expect(up.docs).toHaveLength(3)
    expect(down.docs).toEqual(up.docs)
  })

  it('the uploader and a platform admin still search by the file name', async () => {
    for (const who of ['ana', 'platform']) {
      expect((await changes(who, 'where[document.name][like]=Juana')).docs.sort(), who).toEqual([GATED, NULLED])
      expect((await changes(who, 'where[document.name][like]=Zzzz')).docs, who).toEqual([])
    }
  })
  // ── the polymorphic refs to `documents`: no hook needed, measured ──────────

  it("sessions.contextScope / messages.contextRefs: a reference to a gated documento cannot be queried through", async () => {
    // A reviewer CAN point her own conversation at a colleague's gated documento:
    const ids: number[] = []
    for (const value of [GATED, PLAIN]) {
      const res = await rest('POST', '/api/sessions', tokens.rita, { title: `s${value}`, organization: 1, contextScope: [{ relationTo: 'documents', value }] })
      expect(res.status).toBe(201)
      ids.push(Number(((await res.json()) as { doc: Row }).doc.id))
    }
    const msg = await rest('POST', '/api/messages', tokens.rita, { session: ids[0], role: 'user', content: 'x', contextRefs: [{ relationTo: 'documents', value: GATED }] })
    expect(msg.status).toBe(201)
    // …but Payload refuses a where through a polymorphic relationship, real name or fake:
    for (const [collection, field] of [['sessions', 'contextScope'], ['messages', 'contextRefs']]) {
      for (const q of [`where[${field}.name][like]=Juana`, `where[${field}.value.name][like]=Juana`, `where[${field}.value.name][like]=Zzzz`]) {
        const r = await rest('GET', `/api/${collection}?depth=0&${q}`, tokens.rita)
        expect(r.status, `${collection} ${q}`).toBe(400)
      }
    }
    // …and a sort through it does not order by the documento's name.
    const order = async (sort: string) =>
      ((await (await rest('GET', `/api/sessions?depth=0&sort=${sort}`, tokens.rita)).json()) as { docs: Row[] }).docs.map((d) => d.id)
    for (const f of ['contextScope.name', 'contextScope.value.name']) {
      expect(await order(`-${f}`), f).toEqual(await order(f))
    }
  })
})
