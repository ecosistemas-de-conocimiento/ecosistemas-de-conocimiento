/**
 * 🔴 NO FILTER OR SORT INFERS A GATED DOCUMENTO'S NAME — OVER REST, AGAINST A
 * REAL POSTGRES.
 *
 * Audit 2026-11-10, wave 8: the narrowing on `name` / `uploadedBy` / `session`
 * was a block list, and two paths it did not name still reached the gated name.
 *   · D1, any colleague: `where[mediaFile.filename][like]=Juana` (and a sort on
 *     it) — the media row carries the uploader's file name, and Payload does
 *     not apply `media`'s read access when a filter crosses a relation. Same on
 *     both review logs through `document.mediaFile.filename`.
 *   · D2, reviewers: `where[document.revisionOf.name][like]=Rosa` on both
 *     review logs, plus `/count` and a sort.
 * `constrainGatedQueriesAt` now allowlists the paths a query may use on rows
 * the caller cannot read in full (`GATED_FILTERABLE_PATHS`); any other path is
 * narrowed, at the row and at every `revisionOf` it crosses.
 *
 * Every probe compares the real substring with `Zzzz`: on gated rows a
 * colleague or reviewer must get the same answer for both.
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

const PASSWORD = 'infer-name-pw'
let pg: RealPostgres
let payload: Payload
let config: SanitizedConfig
const tokens: Record<string, string> = {}

const ANA = 1 // uploader of every gated row; investigador
const BEN = 2 // member, same ecosistema
const RITA = 3 // investigador: holds `holds:review`, uploaded nothing
const PLATFORM = 9

const GATED = 20 // published documento, anonymise = true, its media and session name Juana
const NULLED = 21 // published documento, anonymise = NULL: gated too
const PLAIN = 22 // published documento, anonymise = false
const PROBE_A = 30 // BEN's own plain documentos: probes for a sort oracle
const PROBE_Z = 31
const ORIG_G = 40 // gated originals whose name says Rosa…
const ORIG_P = 41
const REV_G = 42 // …a gated revision row of ORIG_G…
const REV_P = 43 // …and a plain one of ORIG_P: only the `revisionOf` hop closes this one
const GATED_ROWS = [GATED, NULLED]

type Row = Record<string, unknown>

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

/** Ids a list returns (documents: the row id; review logs: the documento id). */
async function ids(who: string, collection: string, query: string): Promise<{ status: number; ids: number[]; text: string }> {
  const res = await rest('GET', `/api/${collection}?depth=0&limit=100&${query}`, tokens[who])
  const text = await res.text()
  const docs = ((JSON.parse(text) as { docs?: Row[] }).docs ?? []) as Row[]
  const key = collection === 'documents' ? 'id' : 'document'
  return { status: res.status, ids: docs.map((d) => Number(d[key])), text }
}

async function count(who: string, collection: string, query: string): Promise<number> {
  const res = await rest('GET', `/api/${collection}/count?${query}`, tokens[who])
  expect(res.status).toBe(200)
  return ((await res.json()) as { totalDocs: number }).totalDocs
}

const onlyGated = (list: number[], gated: number[]) => list.filter((id) => gated.includes(id)).sort()

/**
 * The oracle check: the real substring and `Zzzz` give the same gated rows,
 * and the same count, to `who`. `real` must also be a probe that WOULD match
 * (the uploader control below proves it does).
 */
async function sameForRealAndFake(who: string, collection: string, path: string, real: string, gated: number[]) {
  const q = (v: string) => `where[${path}][like]=${encodeURIComponent(v)}`
  const hit = await ids(who, collection, q(real))
  const miss = await ids(who, collection, q('Zzzz'))
  expect(hit.status, hit.text.slice(0, 200)).toBe(200)
  expect(miss.status).toBe(200)
  expect(onlyGated(hit.ids, gated)).toEqual(onlyGated(miss.ids, gated))
  expect(onlyGated(hit.ids, gated)).toEqual([])
  const hitCount = await count(who, collection, q(real))
  const missCount = await count(who, collection, q('Zzzz'))
  // Any extra over `Zzzz` is a readable row (asserted per case below), never a gated one.
  expect(hitCount - missCount).toBe(hit.ids.length - miss.ids.length)
  return hit
}

const REVIEW_LOGS = ['anonymisation-reviews', 'anonymisation-setting-changes'] as const

describe.skipIf(!dockerOk)('no filter or sort infers a gated documento name (real Postgres)', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-infer-name-${process.pid}`, 'infer_name')
    payload = await bootPayload(pg.url, 'infer-name-secret')
    config = await (await import('@payload-config')).default
    await pg.db.execute(sql.raw(`
      INSERT INTO users (id, email, is_platform_admin) VALUES
        (${ANA}, 'ana@example.invalid', false), (${BEN}, 'ben@example.invalid', false),
        (${RITA}, 'rita@example.invalid', false), (${PLATFORM}, 'platform@example.invalid', true);
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Uno', 'uno');
      INSERT INTO memberships (user_id, organization_id, role) VALUES
        (${ANA}, 1, 'investigador'), (${BEN}, 1, 'member'), (${RITA}, 1, 'investigador');
      INSERT INTO media (id, uploaded_by_id, organization_id, filename) VALUES
        (50, ${ANA}, 1, 'Entrevista Juana Perez.pdf'), (51, ${ANA}, 1, 'Notas Juana Nula.pdf'),
        (52, ${ANA}, 1, 'Guia publica.pdf'), (53, ${BEN}, 1, 'A sonda.pdf'), (54, ${BEN}, 1, 'Z sonda.pdf');
      INSERT INTO sessions (id, user_id, organization_id, title) VALUES
        (60, ${ANA}, 1, 'Charla con Juana Perez'), (61, ${ANA}, 1, 'Charla abierta');
      INSERT INTO documents (id, organization_id, uploaded_by_id, publication_status, kind, content_kind, anonymise, anonymisation_status, redacted_text, extracted_text, name, media_file_id, revision_of_id, created_at)
        VALUES (${GATED}, 1, ${ANA}, 'published', 'pdf', 'documento', true, 'ready', 'TEXTO [PERSONA]', 'RAW', 'Documento 20', 50, NULL, now() - interval '4 minutes'),
               (${NULLED}, 1, ${ANA}, 'published', 'pdf', 'documento', NULL, 'ready', 'TEXTO [PERSONA]', 'RAW', 'Documento 21', 51, NULL, now() - interval '3 minutes'),
               (${PLAIN}, 1, ${ANA}, 'published', 'pdf', 'documento', false, 'n/a', NULL, 'PLAIN', 'Guia publica.pdf', 52, NULL, now() - interval '2 minutes'),
               (${PROBE_A}, 1, ${BEN}, 'published', 'pdf', 'documento', false, 'n/a', NULL, 'A', 'A sonda.pdf', 53, NULL, now() - interval '6 minutes'),
               (${PROBE_Z}, 1, ${BEN}, 'published', 'pdf', 'documento', false, 'n/a', NULL, 'Z', 'Z sonda.pdf', 54, NULL, now() - interval '5 minutes'),
               (${ORIG_G}, 1, ${ANA}, 'published', 'pdf', 'documento', true, 'ready', 'T', 'RAW', 'Acta Rosa Gomez.pdf', NULL, NULL, now() - interval '9 minutes'),
               (${ORIG_P}, 1, ${ANA}, 'published', 'pdf', 'documento', true, 'ready', 'T', 'RAW', 'Carta Rosa Gil.pdf', NULL, NULL, now() - interval '8 minutes'),
               (${REV_G}, 1, ${ANA}, 'draft', 'markdown', 'documento', true, 'n/a', NULL, 'R', 'Revision', NULL, ${ORIG_G}, now() - interval '7 minutes'),
               (${REV_P}, 1, ${ANA}, 'draft', 'markdown', 'documento', false, 'n/a', NULL, 'R', 'Revision abierta', NULL, ${ORIG_P}, now() - interval '7 minutes');
      INSERT INTO documents_rels ("order", parent_id, path, sessions_id) VALUES
        (1, ${GATED}, 'session', 60), (1, ${NULLED}, 'session', 60), (1, ${PLAIN}, 'session', 61);
      INSERT INTO anonymisation_reviews (document_id, organization_id, reviewer_id, decision) VALUES
        (${GATED}, 1, ${RITA}, 'approved'), (${NULLED}, 1, ${RITA}, 'approved'), (${PLAIN}, 1, ${RITA}, 'approved'),
        (${REV_G}, 1, ${RITA}, 'approved'), (${REV_P}, 1, ${RITA}, 'approved');
      INSERT INTO anonymisation_setting_changes (organization_id, document_id, actor_id, scope, key, before, after) VALUES
        (1, ${GATED}, ${ANA}, 'documento', 'keepDocumentAuthor', NULL, true),
        (1, ${NULLED}, ${ANA}, 'documento', 'keepDocumentAuthor', NULL, true),
        (1, ${PLAIN}, ${ANA}, 'documento', 'keepDocumentAuthor', NULL, false),
        (1, ${REV_G}, ${ANA}, 'documento', 'keepDocumentAuthor', NULL, true),
        (1, ${REV_P}, ${ANA}, 'documento', 'keepDocumentAuthor', NULL, true);
    `))
    for (const t of ['users', 'organizations', 'memberships', 'media', 'sessions', 'documents', 'documents_rels', 'anonymisation_reviews', 'anonymisation_setting_changes']) {
      await pg.db.execute(sql.raw(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), 1000)`))
    }
    for (const id of [ANA, BEN, RITA, PLATFORM]) {
      await payload.update({ collection: 'users', id, overrideAccess: true, data: { password: PASSWORD } as never })
    }
    for (const [who, email] of [['ana', 'ana'], ['ben', 'ben'], ['rita', 'rita'], ['platform', 'platform']]) {
      tokens[who] = await login(`${email}@example.invalid`)
    }
  }, 120_000)

  afterAll(async () => {
    await shutdown(pg, payload)
  })

  // ── D1: the media row's file name ────────────────────────────────────────

  it('D1: a colleague filtering documents on mediaFile.filename gets the same gated rows for Juana and Zzzz', async () => {
    await sameForRealAndFake('ben', 'documents', 'mediaFile.filename', 'Juana', GATED_ROWS)
  })

  it('D1: the same through the nested-object form, an upper-case OR and exists', async () => {
    for (const q of [
      'where[mediaFile][filename][like]=Juana',
      'where[OR][0][mediaFile.filename][like]=Juana',
      'where[And][0][or][0][mediaFile.filename][like]=Juana',
      'where[mediaFile.filename][exists]=true',
    ]) {
      const r = await ids('ben', 'documents', q)
      expect(onlyGated(r.ids, GATED_ROWS), q).toEqual([])
    }
  })

  it('D1: a sort on mediaFile.filename does not move a gated row for a colleague', async () => {
    for (const where of ['', 'where[publicationStatus][equals]=published&']) {
      const up = await ids('ben', 'documents', `${where}sort=mediaFile.filename`)
      const down = await ids('ben', 'documents', `${where}sort=-mediaFile.filename`)
      expect(up.status).toBe(200)
      expect(up.ids).toContain(GATED)
      // "A sonda" and "Z sonda" would bracket "Entrevista…" if the sort ran.
      expect(down.ids).toEqual(up.ids)
      const mixed = await ids('ben', 'documents', `${where}sort=-createdAt,mediaFile.filename`)
      expect(mixed.ids).toEqual((await ids('ben', 'documents', `${where}sort=-createdAt`)).ids)
    }
  })

  for (const log of REVIEW_LOGS) {
    it(`D1: a reviewer filtering ${log} on document.mediaFile.filename gets the same gated rows for Juana and Zzzz`, async () => {
      await sameForRealAndFake('rita', log, 'document.mediaFile.filename', 'Juana', GATED_ROWS)
    })
  }

  // ── D2: a gated original reached through revisionOf ──────────────────────

  for (const log of REVIEW_LOGS) {
    it(`D2: a reviewer filtering ${log} on document.revisionOf.name gets the same rows for Rosa and Zzzz`, async () => {
      await sameForRealAndFake('rita', log, 'document.revisionOf.name', 'Rosa', [REV_G, REV_P])
    })

    it(`D2: a sort on document.revisionOf.name does not move rows in ${log}`, async () => {
      const up = await ids('rita', log, 'sort=document.revisionOf.name')
      const down = await ids('rita', log, 'sort=-document.revisionOf.name')
      expect(up.status).toBe(200)
      expect(up.ids.length).toBe(5)
      expect(down.ids).toEqual(up.ids)
    })
  }

  // ── the rest of the identity: uploader and conversation ──────────────────

  it("uploadedBy.email: a colleague gets the same gated rows for the uploader's address and Zzzz", async () => {
    await sameForRealAndFake('ben', 'documents', 'uploadedBy.email', 'ana@', GATED_ROWS)
  })

  it('session.title: a colleague gets the same gated rows for Juana and Zzzz', async () => {
    await sameForRealAndFake('ben', 'documents', 'session.title', 'Juana', GATED_ROWS)
  })

  for (const log of REVIEW_LOGS) {
    it(`${log}: document.uploadedBy.email and document.session.title give a reviewer no oracle`, async () => {
      await sameForRealAndFake('rita', log, 'document.uploadedBy.email', 'ana@', GATED_ROWS)
      await sameForRealAndFake('rita', log, 'document.session.title', 'Juana', GATED_ROWS)
    })
  }

  // ── controls ─────────────────────────────────────────────────────────────

  it('the uploader and a platform admin still filter documents on every one of these paths', async () => {
    for (const who of ['ana', 'platform']) {
      expect((await ids(who, 'documents', 'where[mediaFile.filename][like]=Juana')).ids.sort(), who).toEqual([GATED, NULLED])
      expect((await ids(who, 'documents', 'where[session.title][like]=Juana')).ids.sort(), who).toEqual([GATED, NULLED])
      expect((await ids(who, 'documents', 'where[uploadedBy.email][like]=ana@')).ids, who).toEqual(expect.arrayContaining([GATED, NULLED, PLAIN]))
      expect((await ids(who, 'documents', 'where[mediaFile.filename][like]=Zzzz')).ids, who).toEqual([])
    }
    // The uploader's sort runs on her own rows.
    const mine = await ids('ana', 'documents', 'where[uploadedBy][equals]=1&where[publicationStatus][equals]=published&sort=mediaFile.filename')
    expect(mine.ids.slice(0, 3)).toEqual([GATED, PLAIN, NULLED])
  })

  it('the uploader (as a reviewer) and a platform admin still filter the review logs', async () => {
    for (const log of REVIEW_LOGS) {
      for (const who of ['ana', 'platform']) {
        expect((await ids(who, log, 'where[document.mediaFile.filename][like]=Juana')).ids.sort(), `${log} ${who}`).toEqual([GATED, NULLED])
        expect((await ids(who, log, 'where[document.revisionOf.name][like]=Rosa')).ids.sort(), `${log} ${who}`).toEqual([REV_G, REV_P])
      }
    }
  })

  it('a colleague still filters a readable row by these paths', async () => {
    expect((await ids('ben', 'documents', 'where[mediaFile.filename][like]=Guia')).ids).toEqual([PLAIN])
    expect((await ids('ben', 'documents', 'where[mediaFile.filename][like]=sonda&sort=mediaFile.filename')).ids).toEqual([PROBE_A, PROBE_Z])
    expect((await ids('ben', 'documents', 'where[mediaFile.filename][like]=sonda&sort=-mediaFile.filename')).ids).toEqual([PROBE_Z, PROBE_A])
    expect((await ids('rita', 'anonymisation-reviews', 'where[document.mediaFile.filename][like]=Guia')).ids).toEqual([PLAIN])
  })

  it("the web's real filters keep their gated rows", async () => {
    const all = (await ids('ben', 'documents', 'sort=-createdAt')).ids
    expect(all).toEqual(expect.arrayContaining([GATED, NULLED, PLAIN]))
    // `apps/web/src/lib/server/titleMatch.ts` `publishedTitlesQuery`.
    const titles = await ids('ben', 'documents', 'where[organization][equals]=1&where[publicationStatus][equals]=published&where[contentKind][in]=documento,testimonio&sort=-createdAt')
    expect(titles.ids).toEqual(expect.arrayContaining([GATED, NULLED, PLAIN]))
    // `apps/web/src/lib/server/biblioteca.ts` `scopeQuery` + `kindFilterWhere`, no search.
    const library = [
      'where[organization][equals]=1',
      'where[publicationStatus][equals]=published',
      'where[or][0][and][0][contentKind][equals]=documento',
      'where[or][0][and][1][anonymise][equals]=false',
      'where[or][1][and][0][contentKind][equals]=documento',
      'where[or][1][and][1][anonymise][exists]=false',
      'where[or][2][and][0][anonymisationStatus][in]=ready,approved',
      'where[or][2][and][1][redactedText][exists]=true',
      'where[kind][in]=pdf',
      'where[contentKind][equals]=documento',
      'sort=-createdAt',
    ].join('&')
    expect((await ids('ben', 'documents', library)).ids).toEqual(expect.arrayContaining([GATED, NULLED, PLAIN]))
    // `apps/web/src/lib/server/testimonioTitles.ts` and `admin.ts` shapes.
    expect((await ids('ben', 'documents', `where[id][in]=${GATED},${PLAIN}&where[publicationStatus][equals]=published`)).ids.sort()).toEqual([GATED, PLAIN])
    expect((await ids('ben', 'documents', 'where[organization][equals]=1&where[kind][equals]=pdf&sort=-createdAt')).ids).toEqual(expect.arrayContaining([GATED, NULLED]))
    // `apps/web/src/lib/server/sessionDocs.ts`: the uploader lists her conversation.
    expect((await ids('ana', 'documents', 'where[session][equals]=60&sort=createdAt')).ids).toEqual([GATED, NULLED])
    // A review log's own columns stay filterable for a reviewer.
    expect((await ids('rita', 'anonymisation-reviews', `where[decision][equals]=approved&where[document][equals]=${GATED}&sort=-createdAt`)).ids).toEqual([GATED])
  })
})
