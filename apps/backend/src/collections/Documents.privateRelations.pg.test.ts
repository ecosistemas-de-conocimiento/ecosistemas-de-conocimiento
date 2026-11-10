/**
 * 🔴 A FILTER OR A SORT CANNOT READ SOMEONE ELSE'S CONVERSATION OR ACCOUNT
 * THROUGH A RELATIONSHIP — OVER REST, AGAINST A REAL POSTGRES.
 *
 * Audit 2026-11-10 (wave 9, R1): Payload does not apply `sessions`' or
 * `users`' read access when a `where` / `sort` crosses a relationship into
 * them. On a documento every member may read in full, `where[session.title]
 * [like]=…` matched the uploader's private conversation title (a session is
 * titled from its first message) and `where[uploadedBy.email][like]=…`
 * confirmed a colleague's email; on the review logs `document.session.title`,
 * `reviewer.email` and `actor.email` did the same. Measured before the fix:
 * the real substring returned the row, 'Zzzz' returned nothing.
 *
 * A path that crosses into another collection only matches rows of it the
 * caller may read there (`resolvePrivateCrossings`); a sort through one is
 * stripped. A filter on the relation's id is untouched.
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

const PASSWORD = 'private-relations-pw'
let pg: RealPostgres
let payload: Payload
let config: SanitizedConfig
const tokens: Record<string, string> = {}

const ANA = 1 // investigador: uploaded PLAIN, reviewed it, flipped its switches
const BEN = 2 // member, same ecosistema
const RITA = 3 // investigador: reads both review logs
const PLATFORM = 9

const S_ANA = 40 // ANA's private conversation
const S_BEN = 41 // BEN's own

const GATED = 20 // published documento, anonymise = true: gated
const PLAIN = 22 // ANA's published documento, anonymise = false: every member reads it
const BENDOC = 30 // BEN's published documento
const REV = 25 // a revision row of PLAIN (server-only staging)
const REV2 = 26 // a revision row of BENDOC

const R_PLAIN = 50 // review rows, and setting-change rows with the same ids
const R_BEN = 51
const R_REV = 52
const R_REV2 = 53

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

async function list(collection: string, who: string, query: string): Promise<number[]> {
  const res = await rest('GET', `/api/${collection}?depth=0&limit=100&${query}`, tokens[who])
  const text = await res.text()
  expect(res.status, `${collection} ${query}: ${text.slice(0, 200)}`).toBe(200)
  return ((JSON.parse(text) as { docs?: Row[] }).docs ?? []).map((d) => Number(d.id))
}

async function count(collection: string, who: string, query: string): Promise<number | undefined> {
  const res = await rest('GET', `/api/${collection}/count?${query}`, tokens[who])
  expect(res.status, `${collection}/count ${query}`).toBe(200)
  return ((await res.json()) as { totalDocs?: number }).totalDocs
}

/**
 * Each path, the substring that matches the hidden value, and who probes it.
 * The emails are `example.invalid`; `juana` sits in ANA's.
 */
const PROBES: { collection: string; path: string; real: string; who: string }[] = [
  { collection: 'documents', path: 'session.title', real: 'Juana', who: 'ben' },
  { collection: 'documents', path: 'uploadedInSession.title', real: 'Juana', who: 'ben' },
  { collection: 'documents', path: 'uploadedBy.email', real: 'juana', who: 'ben' },
  { collection: 'anonymisation-reviews', path: 'document.session.title', real: 'Juana', who: 'rita' },
  { collection: 'anonymisation-reviews', path: 'reviewer.email', real: 'juana', who: 'rita' },
  { collection: 'anonymisation-reviews', path: 'document.uploadedBy.email', real: 'juana', who: 'rita' },
  { collection: 'anonymisation-reviews', path: 'document.revisionOf.uploadedBy.email', real: 'juana', who: 'rita' },
  { collection: 'anonymisation-setting-changes', path: 'document.session.title', real: 'Juana', who: 'rita' },
  { collection: 'anonymisation-setting-changes', path: 'actor.email', real: 'juana', who: 'rita' },
  { collection: 'anonymisation-setting-changes', path: 'document.uploadedInSession.title', real: 'Juana', who: 'rita' },
  { collection: 'anonymisation-setting-changes', path: 'document.revisionOf.uploadedBy.email', real: 'juana', who: 'rita' },
]

describe.skipIf(!dockerOk)('a filter through a relationship reads only what the caller may read (real Postgres)', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-private-relations-${process.pid}`, 'private_relations')
    payload = await bootPayload(pg.url, 'private-relations-secret')
    config = await (await import('@payload-config')).default
    await pg.db.execute(sql.raw(`
      INSERT INTO users (id, email, is_platform_admin) VALUES
        (${ANA}, 'ana.juana@example.invalid', false), (${BEN}, 'ben@example.invalid', false),
        (${RITA}, 'rita@example.invalid', false), (${PLATFORM}, 'platform@example.invalid', true);
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Uno', 'uno');
      INSERT INTO memberships (user_id, organization_id, role) VALUES
        (${ANA}, 1, 'investigador'), (${BEN}, 1, 'member'), (${RITA}, 1, 'investigador');
      INSERT INTO sessions (id, user_id, organization_id, title) VALUES
        (${S_ANA}, ${ANA}, 1, 'Charla Juana privada'), (${S_BEN}, ${BEN}, 1, 'Charla Ben propia');
      INSERT INTO documents (id, organization_id, uploaded_by_id, uploaded_in_session_id, revision_of_id, publication_status, kind, content_kind, anonymise, anonymisation_status, redacted_text, extracted_text, name, created_at)
        VALUES (${GATED}, 1, ${ANA}, NULL, NULL, 'published', 'pdf', 'documento', true, 'ready', 'TEXTO [PERSONA]', 'RAW', 'Gated.pdf', now() - interval '4 minutes'),
               (${PLAIN}, 1, ${ANA}, ${S_ANA}, NULL, 'published', 'pdf', 'documento', false, 'n/a', NULL, 'PLAIN', 'Plain.pdf', now() - interval '3 minutes'),
               (${BENDOC}, 1, ${BEN}, ${S_BEN}, NULL, 'published', 'pdf', 'documento', false, 'n/a', NULL, 'BEN', 'Ben.pdf', now() - interval '2 minutes'),
               (${REV}, 1, ${BEN}, NULL, ${PLAIN}, 'draft', 'pdf', 'documento', false, 'n/a', NULL, 'REV', 'Rev.pdf', now() - interval '1 minute'),
               (${REV2}, 1, ${BEN}, NULL, ${BENDOC}, 'draft', 'pdf', 'documento', false, 'n/a', NULL, 'REV2', 'Rev2.pdf', now());
      INSERT INTO documents_rels (parent_id, path, sessions_id, "order") VALUES
        (${PLAIN}, 'session', ${S_ANA}, 1), (${BENDOC}, 'session', ${S_BEN}, 1);
      INSERT INTO anonymisation_reviews (id, document_id, organization_id, reviewer_id, decision) VALUES
        (${R_PLAIN}, ${PLAIN}, 1, ${ANA}, 'approved'), (${R_BEN}, ${BENDOC}, 1, ${RITA}, 'approved'),
        (${R_REV}, ${REV}, 1, ${RITA}, 'approved'), (${R_REV2}, ${REV2}, 1, ${RITA}, 'approved');
      INSERT INTO anonymisation_setting_changes (id, organization_id, document_id, actor_id, scope, key, before, after) VALUES
        (${R_PLAIN}, 1, ${PLAIN}, ${ANA}, 'documento', 'keepDocumentAuthor', NULL, true),
        (${R_BEN}, 1, ${BENDOC}, ${RITA}, 'documento', 'keepDocumentAuthor', NULL, true),
        (${R_REV}, 1, ${REV}, ${RITA}, 'documento', 'keepDocumentAuthor', NULL, true),
        (${R_REV2}, 1, ${REV2}, ${RITA}, 'documento', 'keepDocumentAuthor', NULL, true);
    `))
    for (const t of ['users', 'organizations', 'memberships', 'sessions', 'documents', 'documents_rels', 'anonymisation_reviews', 'anonymisation_setting_changes']) {
      await pg.db.execute(sql.raw(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), 1000)`))
    }
    for (const id of [ANA, BEN, RITA, PLATFORM]) {
      await payload.update({ collection: 'users', id, overrideAccess: true, data: { password: PASSWORD } as never })
    }
    tokens.ana = await login('ana.juana@example.invalid')
    tokens.ben = await login('ben@example.invalid')
    tokens.rita = await login('rita@example.invalid')
    tokens.platform = await login('platform@example.invalid')
  }, 120_000)

  afterAll(async () => {
    await shutdown(pg, payload)
  })

  // ── the oracle: the real substring and 'Zzzz' answer the same ─────────────

  for (const { collection, path, real, who } of PROBES) {
    it(`🔴 ${collection}: where[${path}] gives no oracle on the list or the count`, async () => {
      const hit = `where[${path}][like]=${real}`
      const miss = `where[${path}][like]=Zzzz`
      expect(await list(collection, who, hit)).toEqual(await list(collection, who, miss))
      expect(await count(collection, who, hit)).toBe(await count(collection, who, miss))
      // The nested-object spelling and an upper-case OR reach the same column.
      const nested = `where[OR][0][${path.split('.').join('][')}][like]=${real}`
      expect(await list(collection, who, nested)).toEqual([])
    })

    it(`🔴 ${collection}: sort=${path} does not move a row`, async () => {
      // Pinned to documentos every member reads in full, so the gated-row
      // narrowing keeps the sort and only this rule can stop it.
      const at = collection === 'documents' ? '' : 'document.'
      const pinAt = (p: string) => `where[${p}contentKind][equals]=documento&where[${p}anonymise][equals]=false&`
      const pin = pinAt(at) + (path.includes('revisionOf.') ? pinAt(`${at}revisionOf.`) : '')
      const up = await list(collection, who, `${pin}sort=${path}`)
      expect(up.length).toBeGreaterThan(1)
      expect(await list(collection, who, `${pin}sort=-${path}`)).toEqual(up)
    })
  }

  // ── controls ──────────────────────────────────────────────────────────────

  it("the caller's own conversation and account still filter", async () => {
    expect(await list('documents', 'ana', 'where[session.title][like]=Juana')).toEqual([PLAIN])
    expect(await list('documents', 'ana', 'where[uploadedInSession.title][like]=Juana')).toEqual([PLAIN])
    expect(await list('documents', 'ben', 'where[session.title][like]=Ben')).toEqual([BENDOC])
    expect(await count('documents', 'ben', 'where[uploadedInSession.title][like]=Ben')).toBe(1)
    expect((await list('documents', 'ana', 'where[uploadedBy.email][like]=juana')).sort()).toEqual([GATED, PLAIN])
    expect((await list('anonymisation-reviews', 'rita', 'where[reviewer.email][like]=rita')).sort()).toEqual([R_BEN, R_REV, R_REV2])
    expect((await list('anonymisation-setting-changes', 'rita', 'where[actor.email][like]=rita')).sort()).toEqual([R_BEN, R_REV, R_REV2])
  })

  it('a platform admin filters and sorts through every relationship', async () => {
    expect(await list('documents', 'platform', 'where[session.title][like]=Juana')).toEqual([PLAIN])
    expect(await list('documents', 'platform', 'where[uploadedBy.email][like]=juana')).toEqual(expect.arrayContaining([GATED, PLAIN]))
    expect(await list('anonymisation-reviews', 'platform', 'where[reviewer.email][like]=juana')).toEqual([R_PLAIN])
    expect(await list('anonymisation-reviews', 'platform', 'where[document.revisionOf.uploadedBy.email][like]=juana')).toEqual([R_REV])
    expect(await list('anonymisation-setting-changes', 'platform', 'where[actor.email][like]=juana')).toEqual([R_PLAIN])
    const up = await list('anonymisation-reviews', 'platform', 'sort=reviewer.email')
    expect(await list('anonymisation-reviews', 'platform', 'sort=-reviewer.email')).not.toEqual(up)
  })

  it("the web's own filters still work: session equals, uploadedBy equals me", async () => {
    // `routes/api/sessions/[id]/documents`, `lib/server/sessionDocs.ts`.
    expect(await list('documents', 'ana', `where[session][equals]=${S_ANA}`)).toEqual([PLAIN])
    expect(await list('documents', 'ben', `where[session][equals]=${S_BEN}&sort=createdAt`)).toEqual([BENDOC])
    // `routes/api/documentos`: "Mis documentos".
    expect(await list('documents', 'ben', `where[uploadedBy][equals]=${BEN}&where[organization][equals]=1&sort=-createdAt`)).toEqual([BENDOC])
    // The relation's id says nothing private: id-level filters pass.
    expect(await list('documents', 'ben', `where[session.id][equals]=${S_BEN}`)).toEqual([BENDOC])
    expect(await list('documents', 'ben', `where[uploadedBy][in]=${BEN}`)).toEqual([BENDOC])
    expect(await list('anonymisation-reviews', 'rita', `where[reviewer][equals]=${ANA}`)).toEqual([R_PLAIN])
  })

  // ── redactedText: `exists` only on a gated row ────────────────────────────

  it('🔴 redactedText answers `exists` on a gated row, and nothing else', async () => {
    // The biblioteca's clause (`lib/server/biblioteca.ts`) still reaches it.
    expect(await list('documents', 'ben', 'where[redactedText][exists]=true')).toEqual([GATED])
    expect(await list('documents', 'ben', 'where[redactedText][like]=PERSONA')).toEqual([])
    expect(await list('documents', 'ana', 'where[redactedText][like]=PERSONA')).toEqual([GATED])
  })
})
