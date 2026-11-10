/**
 * 🔴 A GATED DOCUMENTO'S FILE NAME IS THE UPLOADER'S — OVER REST, AGAINST A REAL
 * POSTGRES.
 *
 * Audit 2026-11-10 (R4-01): `mayReadGatedOriginal` with scope `identity` was
 * `true` for any `documento`, so a member read the raw `name` of a colleague's
 * published documento filed for anonymisation (`GET /api/documents/:id`), and
 * `where[name][like]=…` confirmed which row named whom. A documento whose
 * `anonymise` is not `false` (true or NULL) is gated content for `name`,
 * `uploadedBy` and `session` now: the uploader and a platform admin read them,
 * anyone else gets the neutral title, and a `where` / `sort` on them only
 * reaches rows the caller may read.
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

const PASSWORD = 'gated-name-pw'
let pg: RealPostgres
let payload: Payload
let config: SanitizedConfig
const tokens: Record<string, string> = {}

const ANA = 1 // uploader of the gated rows
const BEN = 2 // member, same ecosistema
const RITA = 3 // investigador: holds `holds:review`
const PLATFORM = 9

const GATED = 20 // published documento, anonymise = true, cleared
const NULLED = 21 // published documento, anonymise = NULL (legacy): gated too
const PLAIN = 22 // published documento, anonymise = false
const HELD = 23 // documento, anonymise = true, held for review
const PROBE_A = 30 // BEN's own plain documentos: probes for a sort oracle
const PROBE_Z = 31

const GATED_NAME = 'Entrevista Juana Perez.pdf'
const NULLED_NAME = 'Notas Juana Nula.pdf'
const PLAIN_NAME = 'Guia Juana publica.pdf'

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

async function list(who: string, query: string): Promise<{ status: number; text: string; ids: number[] }> {
  const res = await rest('GET', `/api/documents?depth=0&limit=100&${query}`, tokens[who])
  const text = await res.text()
  const docs = ((JSON.parse(text) as { docs?: Row[] }).docs ?? []) as Row[]
  return { status: res.status, text, ids: docs.map((d) => Number(d.id)) }
}

const RAW = /Juana Perez|Juana Nula/

describe.skipIf(!dockerOk)('documents: a gated documento name over REST (real Postgres)', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-gated-name-${process.pid}`, 'gated_name')
    payload = await bootPayload(pg.url, 'gated-name-secret')
    config = await (await import('@payload-config')).default
    await pg.db.execute(sql.raw(`
      INSERT INTO users (id, email, is_platform_admin) VALUES
        (${ANA}, 'ana@example.invalid', false), (${BEN}, 'ben@example.invalid', false),
        (${RITA}, 'rita@example.invalid', false), (${PLATFORM}, 'platform@example.invalid', true);
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Uno', 'uno');
      INSERT INTO memberships (user_id, organization_id, role) VALUES
        (${ANA}, 1, 'member'), (${BEN}, 1, 'member'), (${RITA}, 1, 'investigador');
      INSERT INTO documents (id, organization_id, uploaded_by_id, publication_status, kind, content_kind, anonymise, anonymisation_status, redacted_text, held_text, extracted_text, name, created_at)
        VALUES (${GATED}, 1, ${ANA}, 'published', 'pdf', 'documento', true, 'ready', 'TEXTO [PERSONA]', NULL, 'RAW', '${GATED_NAME}', now() - interval '4 minutes'),
               (${NULLED}, 1, ${ANA}, 'published', 'pdf', 'documento', NULL, 'ready', 'TEXTO [PERSONA]', NULL, 'RAW', '${NULLED_NAME}', now() - interval '3 minutes'),
               (${PLAIN}, 1, ${ANA}, 'published', 'pdf', 'documento', false, 'n/a', NULL, NULL, 'PLAIN', '${PLAIN_NAME}', now() - interval '2 minutes'),
               (${HELD}, 1, ${ANA}, 'draft', 'pdf', 'documento', true, 'held', NULL, 'RETENIDO [PERSONA]', 'RAW', 'Retenido Juana Perez.pdf', now() - interval '1 minute'),
               (${PROBE_A}, 1, ${BEN}, 'published', 'pdf', 'documento', false, 'n/a', NULL, NULL, 'A', 'A sonda.pdf', now() - interval '6 minutes'),
               (${PROBE_Z}, 1, ${BEN}, 'published', 'pdf', 'documento', false, 'n/a', NULL, NULL, 'Z', 'Z sonda.pdf', now() - interval '5 minutes');
      INSERT INTO anonymisation_reviews (document_id, organization_id, reviewer_id, decision)
        VALUES (${GATED}, 1, ${RITA}, 'approved');
    `))
    for (const t of ['users', 'organizations', 'memberships', 'documents', 'anonymisation_reviews']) {
      await pg.db.execute(sql.raw(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), 1000)`))
    }
    for (const id of [ANA, BEN, RITA, PLATFORM]) {
      await payload.update({ collection: 'users', id, overrideAccess: true, data: { password: PASSWORD } as never })
    }
    tokens.ana = await login('ana@example.invalid')
    tokens.ben = await login('ben@example.invalid')
    tokens.rita = await login('rita@example.invalid')
    tokens.platform = await login('platform@example.invalid')
  }, 120_000)

  afterAll(async () => {
    await shutdown(pg, payload)
  })

  // ── where on `name` ──────────────────────────────────────────────────────

  const NAME_WHERES: Record<string, string> = {
    like: 'where[name][like]=Juana',
    equals: `where[name][equals]=${encodeURIComponent(GATED_NAME)}`,
    contains: 'where[name][contains]=Perez',
    in: `where[name][in]=${encodeURIComponent(`${GATED_NAME},${NULLED_NAME}`)}`,
    'nested and/or': 'where[and][0][or][0][name][like]=Juana&where[and][0][or][1][name][like]=Perez',
    'upper-case OR': 'where[OR][0][name][like]=Juana',
    'pinned to documento': 'where[contentKind][equals]=documento&where[name][like]=Juana',
    'pinned to documento, anonymise=true': 'where[contentKind][equals]=documento&where[anonymise][equals]=true&where[name][like]=Juana',
  }

  for (const [label, where] of Object.entries(NAME_WHERES)) {
    it(`a member's ${label} search on name never matches a gated documento`, async () => {
      const r = await list('ben', where)
      expect(r.status).toBe(200)
      expect(r.ids).not.toContain(GATED)
      expect(r.ids).not.toContain(NULLED)
      expect(r.text).not.toMatch(RAW)
    })
  }

  it('the same search from the uploader and from a platform admin finds them', async () => {
    for (const who of ['ana', 'platform']) {
      const r = await list(who, 'where[name][like]=Juana')
      expect(r.ids).toEqual(expect.arrayContaining([GATED, NULLED, PLAIN]))
    }
  })

  it('a count on name gives no oracle either', async () => {
    const res = await rest('GET', '/api/documents/count?where[name][like]=Perez', tokens.ben)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { totalDocs?: number }).totalDocs).toBe(0)
  })

  it('a non-gated documento is still found by name, also with the library query shape', async () => {
    expect((await list('ben', 'where[name][like]=Guia')).ids).toEqual([PLAIN])
    // `apps/web/src/lib/server/biblioteca.ts` `scopeQuery` + `libraryListQuery`.
    const library = [
      'where[organization][equals]=1',
      'where[publicationStatus][equals]=published',
      'where[or][0][and][0][contentKind][equals]=documento',
      'where[or][0][and][1][anonymise][equals]=false',
      'where[or][1][and][0][contentKind][equals]=documento',
      'where[or][1][and][1][anonymise][exists]=false',
      'where[or][2][and][0][anonymisationStatus][in]=ready,approved',
      'where[or][2][and][1][redactedText][exists]=true',
      'where[name][like]=Juana',
      'sort=-createdAt',
    ].join('&')
    const r = await list('ben', library)
    expect(r.status).toBe(200)
    expect(r.ids).toEqual([PLAIN])
    const own = await list('ana', library)
    expect(own.ids).toEqual([PLAIN, NULLED, GATED])
  })

  it('a query already pinned to documento AND anonymise=false passes through', async () => {
    const r = await list('ben', 'where[contentKind][equals]=documento&where[anonymise][equals]=false&where[name][like]=Juana')
    expect(r.ids).toEqual([PLAIN])
  })

  // ── the row ──────────────────────────────────────────────────────────────

  it("GET /api/documents/:id gives a member the neutral title, not the file name", async () => {
    for (const id of [GATED, NULLED]) {
      const res = await rest('GET', `/api/documents/${id}?depth=0`, tokens.ben)
      expect(res.status).toBe(200)
      const text = await res.text()
      expect(text).not.toMatch(RAW)
      const row = JSON.parse(text) as Row
      expect(row.name).toBe('Documento')
      expect(row.uploadedBy).toBeUndefined()
      expect(row.anonymise === false).toBe(false)
    }
  })

  it('a member\'s list carries no raw gated name, whatever the select', async () => {
    for (const q of ['', 'select[name]=true', 'select[anonymise]=false', 'select[name]=true&select[contentKind]=true&select[uploadedBy]=true']) {
      const r = await list('ben', q)
      expect(r.status).toBe(200)
      expect(r.ids).toContain(GATED)
      expect(r.text).not.toMatch(RAW)
    }
  })

  it("keepDocumentAuthor in the stored verdict shows colleagues the contributor, never the file name", async () => {
    const report = (v: boolean) =>
      pg.db.execute(sql.raw(`UPDATE documents SET anonymisation_report = '{"settings":{"keepDocumentAuthor":${v}}}'::jsonb WHERE id = ${GATED}`))
    try {
      await report(true)
      const on = JSON.parse(await (await rest('GET', `/api/documents/${GATED}?depth=0`, tokens.ben)).text()) as Row
      expect(on.uploadedBy).toBe(ANA)
      expect(on.name).toBe('Documento')
      await report(false)
      const off = (await (await rest('GET', `/api/documents/${GATED}?depth=0`, tokens.ben)).json()) as Row
      expect(off.uploadedBy).toBeUndefined()
    } finally {
      await pg.db.execute(sql.raw(`UPDATE documents SET anonymisation_report = NULL WHERE id = ${GATED}`))
    }
  })

  it('the uploader and a platform admin read the file name', async () => {
    for (const who of ['ana', 'platform']) {
      const row = (await (await rest('GET', `/api/documents/${GATED}?depth=0`, tokens[who])).json()) as Row
      expect(row.name).toBe(GATED_NAME)
    }
  })

  it('a member still reads a non-gated documento in full', async () => {
    const row = (await (await rest('GET', `/api/documents/${PLAIN}?depth=0`, tokens.ben)).json()) as Row
    expect(row.name).toBe(PLAIN_NAME)
    expect(row.uploadedBy).toBe(ANA)
  })

  // ── sort ─────────────────────────────────────────────────────────────────

  for (const [label, where] of [
    ['unfiltered', ''],
    ['pinned to documento', 'where[contentKind][equals]=documento&'],
    ['filtered on another column', 'where[publicationStatus][equals]=published&'],
  ] as const) {
    it(`sort on name does not move a gated row for a member (${label})`, async () => {
      const up = await list('ben', `${where}sort=name`)
      const down = await list('ben', `${where}sort=-name`)
      expect(up.status).toBe(200)
      expect(up.ids).toContain(GATED)
      // The probes "A…" and "Z…" would bracket "Entrevista…" if the sort ran.
      expect(down.ids).toEqual(up.ids)
    })
  }

  it('sort on name still runs where every row is readable', async () => {
    const q = 'where[contentKind][equals]=documento&where[anonymise][equals]=false'
    expect((await list('ben', `${q}&sort=name`)).ids).toEqual([PROBE_A, PLAIN, PROBE_Z])
    expect((await list('ben', `${q}&sort=-name`)).ids).toEqual([PROBE_Z, PLAIN, PROBE_A])
    expect((await list('ana', 'sort=name&where[uploadedBy][equals]=1')).ids).toEqual([GATED, PLAIN, NULLED, HELD])
  })

  // ── reviewers ────────────────────────────────────────────────────────────

  it("a reviewer's queue is unchanged: the held documento, under the neutral title", async () => {
    const { listHeldDocuments } = await import('@/lib/holdReview')
    const user = { ...(await payload.findByID({ collection: 'users', id: RITA, overrideAccess: true })), collection: 'users' }
    const queue = await listHeldDocuments({ payload, organizationId: 1, user })
    expect(queue.holds.map((h) => [h.id, h.title])).toEqual([[String(HELD), 'Documento retenido']])
  })

  it("a reviewer's decision log still lists, and cannot be searched by the gated name", async () => {
    const all = await rest('GET', '/api/anonymisation-reviews?depth=0', tokens.rita)
    expect(all.status).toBe(200)
    expect(((await all.json()) as { docs: Row[] }).docs.map((d) => d.document)).toEqual([GATED])
    const byName = await rest('GET', '/api/anonymisation-reviews?depth=0&where[document.name][like]=Juana', tokens.rita)
    expect(byName.status).toBe(200)
    expect(((await byName.json()) as { docs: Row[] }).docs).toEqual([])
  })
})
