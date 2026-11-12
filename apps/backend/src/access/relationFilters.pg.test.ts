/**
 * 🔴 NO FILTER OR SORT, ON ANY COLLECTION, READS WHAT THE CALLER COULD NOT
 * READ ROW BY ROW — OVER REST, AGAINST A REAL POSTGRES.
 *
 * Audit 2026-11-10 (wave 10): wave 9 closed relation crossings on `documents`
 * and the review logs only. As a colleague, `GET /api/media?where[uploadedBy.
 * email][like]=<substring>` returned the row for the real substring and
 * nothing for 'zzzz'; on `ratings`, `session.title`, `user.email` and
 * `message.content` did the same, so a private conversation's title and its
 * messages' text could be read out letter by letter. A manager could do the
 * same with `memberships?where[user.email]`, though no one but the account
 * itself reads a `users` row. Each probe here failed before
 * `access/relationFilters.ts` (measured on this branch's parent, c4f53632).
 *
 * Also here: the config walk that fails when a collection that needs the hook
 * lacks it, the >10-row case that fails if the id lookup loses
 * `pagination: false`, and what Payload itself does with the paths the hook
 * leaves to it (polymorphic relations, field reads).
 *
 * Driven through Payload's REST router (`handleEndpoints`, real JWT). Harness:
 * `lib/testing/realPostgres`.
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

import { resetRateLimits } from '@/lib/rateLimit'
import { bootPayload, dockerOk, shutdown, startRealPostgres, type RealPostgres } from '@/lib/testing/realPostgres'

const PASSWORD = 'relation-filters-pw'
let pg: RealPostgres
let payload: Payload
let config: SanitizedConfig
const tokens: Record<string, string> = {}

const ANA = 1 // investigador: the private rows below are hers
const BEN = 2 // member, same ecosistema
const RITA = 3 // investigador: may read rating comments in the ecosistema
const ADM = 4 // admin: manages the ecosistema's memberships
const PLATFORM = 9

const S_ANA = 40 // ANA's private conversation
const S_BEN = 41 // BEN's own
const PLAIN = 22 // ANA's published documento, every member reads it
const GATED = 20 // published documento under anonymisation: gated
const BENDOC = 30 // BEN's published documento
const M_ANA = 70 // the file behind PLAIN: every member reads it
const M_BEN = 71
const MSG_ANA = 60 // ANA's question, in S_ANA
const MSG_ANA_ANSWER = 61
const MSG_BEN = 62
const R_ANA = 80 // ANA's rating, with a comment
const R_BEN = 81
const TEAM = 5
const PROJECT = 6
/** ANA's extra conversations, each rated: more than Payload's default page of 10. */
const BULK = 15

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

/** The ids a list answers, sorted, or `HTTP<status>`: a refusal is an answer too. */
async function list(collection: string, who: string, query: string): Promise<number[] | string> {
  const res = await rest('GET', `/api/${collection}?depth=0&limit=100&${query}`, tokens[who])
  if (res.status !== 200) return `HTTP${res.status}`
  const docs = ((await res.json()) as { docs?: { id: unknown }[] }).docs ?? []
  return docs.map((d) => Number(d.id)).sort((x, y) => x - y)
}

/** The list in the order the backend gave it. */
async function ordered(collection: string, who: string, query: string): Promise<number[] | string> {
  const res = await rest('GET', `/api/${collection}?depth=0&limit=100&${query}`, tokens[who])
  if (res.status !== 200) return `HTTP${res.status}`
  return (((await res.json()) as { docs?: { id: unknown }[] }).docs ?? []).map((d) => Number(d.id))
}

async function count(collection: string, who: string, query: string): Promise<number | string> {
  const res = await rest('GET', `/api/${collection}/count?${query}`, tokens[who])
  if (res.status !== 200) return `HTTP${res.status}`
  return ((await res.json()) as { totalDocs?: number }).totalDocs ?? 'none'
}

/**
 * Each path that crossed into a row the caller may not read, the substring
 * that matched the hidden value, and who probes it. The emails are
 * `example.invalid`; `juana` sits in ANA's.
 */
const PROBES: { collection: string; path: string; real: string; who: string }[] = [
  { collection: 'media', path: 'uploadedBy.email', real: 'juana', who: 'ben' },
  { collection: 'ratings', path: 'session.title', real: 'Juana', who: 'ben' },
  { collection: 'ratings', path: 'user.email', real: 'juana', who: 'ben' },
  { collection: 'ratings', path: 'message.content', real: 'secreta', who: 'ben' },
  { collection: 'ratings', path: 'message.session.title', real: 'Juana', who: 'ben' },
  // RITA reads every rating in the ecosistema, but not ANA's conversation.
  { collection: 'ratings', path: 'message.content', real: 'secreta', who: 'rita' },
  // ADM manages memberships, but reads no `users` row but their own.
  { collection: 'memberships', path: 'user.email', real: 'juana', who: 'adm' },
]

describe.skipIf(!dockerOk)('every collection: a filter reads only what the caller may read (real Postgres)', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-relation-filters-${process.pid}`, 'relation_filters')
    payload = await bootPayload(pg.url, 'relation-filters-secret')
    config = await (await import('@payload-config')).default
    await pg.db.execute(sql.raw(`
      INSERT INTO users (id, email, is_platform_admin) VALUES
        (${ANA}, 'ana.juana@example.invalid', false), (${BEN}, 'ben@example.invalid', false),
        (${RITA}, 'rita@example.invalid', false), (${ADM}, 'adm@example.invalid', false),
        (${PLATFORM}, 'platform@example.invalid', true);
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Uno', 'uno');
      INSERT INTO teams (id, name, slug, organization_id) VALUES (${TEAM}, 'Equipo', 'equipo', 1);
      INSERT INTO projects (id, name, slug, team_id) VALUES (${PROJECT}, 'Proyecto', 'proyecto', ${TEAM});
      INSERT INTO memberships (user_id, organization_id, role) VALUES
        (${ANA}, 1, 'investigador'), (${BEN}, 1, 'member'), (${RITA}, 1, 'investigador'), (${ADM}, 1, 'admin');
      INSERT INTO sessions (id, user_id, organization_id, title) VALUES
        (${S_ANA}, ${ANA}, 1, 'Charla Juana privada'), (${S_BEN}, ${BEN}, 1, 'Charla Ben propia');
      INSERT INTO media (id, uploaded_by_id, organization_id, filename, mime_type) VALUES
        (${M_ANA}, ${ANA}, 1, 'Plain.pdf', 'application/pdf'), (${M_BEN}, ${BEN}, 1, 'Ben.pdf', 'application/pdf');
      INSERT INTO documents (id, organization_id, uploaded_by_id, uploaded_in_session_id, media_file_id, publication_status, kind, content_kind, anonymise, anonymisation_status, redacted_text, extracted_text, name, created_at)
        VALUES (${GATED}, 1, ${ANA}, NULL, NULL, 'published', 'pdf', 'documento', true, 'ready', 'TEXTO', 'RAW', 'Gated.pdf', now() - interval '4 minutes'),
               (${PLAIN}, 1, ${ANA}, ${S_ANA}, ${M_ANA}, 'published', 'pdf', 'documento', false, 'n/a', NULL, 'PLAIN', 'Plain.pdf', now() - interval '3 minutes'),
               (${BENDOC}, 1, ${BEN}, ${S_BEN}, ${M_BEN}, 'published', 'pdf', 'documento', false, 'n/a', NULL, 'BEN', 'Ben.pdf', now() - interval '2 minutes');
      INSERT INTO documents_rels (parent_id, path, sessions_id, "order") VALUES
        (${PLAIN}, 'session', ${S_ANA}, 1), (${BENDOC}, 'session', ${S_BEN}, 1);
      INSERT INTO messages (id, session_id, role, content) VALUES
        (${MSG_ANA}, ${S_ANA}, 'user', 'pregunta secreta de Juana'),
        (${MSG_ANA_ANSWER}, ${S_ANA}, 'assistant', 'respuesta secreta para Juana'),
        (${MSG_BEN}, ${S_BEN}, 'assistant', 'respuesta para Ben');
      -- BEN's own conversation and message reference the gated documento.
      INSERT INTO sessions_rels (parent_id, path, documents_id, "order") VALUES (${S_BEN}, 'contextScope', ${GATED}, 1);
      INSERT INTO messages_rels (parent_id, path, documents_id, "order") VALUES (${MSG_BEN}, 'contextRefs', ${GATED}, 1);
      INSERT INTO ratings (id, message_id, session_id, organization_id, user_id, stars, reason, comment) VALUES
        (${R_ANA}, ${MSG_ANA_ANSWER}, ${S_ANA}, 1, ${ANA}, 2, 'other', 'comentario secreto de Juana'),
        (${R_BEN}, ${MSG_BEN}, ${S_BEN}, 1, ${BEN}, 5, NULL, NULL);
      INSERT INTO sessions (id, user_id, organization_id, title)
        SELECT 100 + g, ${ANA}, 1, 'Juana bulk ' || g FROM generate_series(1, ${BULK}) g;
      INSERT INTO messages (id, session_id, role, content)
        SELECT 100 + g, 100 + g, 'assistant', 'bulk' FROM generate_series(1, ${BULK}) g;
      INSERT INTO ratings (id, message_id, session_id, organization_id, user_id, stars)
        SELECT 100 + g, 100 + g, 100 + g, 1, ${ANA}, 4 FROM generate_series(1, ${BULK}) g;
    `))
    for (const t of ['users', 'organizations', 'teams', 'projects', 'memberships', 'sessions', 'media', 'documents', 'documents_rels', 'messages', 'ratings']) {
      await pg.db.execute(sql.raw(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), 1000)`))
    }
    // Payload's own rows: ANA's preference, and her lock on her conversation.
    await pg.db.execute(sql.raw(`
      INSERT INTO payload_preferences (id, key, value) VALUES (1, 'juana-pref', '{}');
      INSERT INTO payload_preferences_rels (parent_id, path, users_id, "order") VALUES (1, 'user', ${ANA}, 1);
      INSERT INTO payload_locked_documents (id) VALUES (1);
      INSERT INTO payload_locked_documents_rels (parent_id, path, sessions_id, users_id) VALUES
        (1, 'document', ${S_ANA}, NULL), (1, 'user', NULL, ${ANA});
    `))
    for (const id of [ANA, BEN, RITA, ADM, PLATFORM]) {
      await payload.update({ collection: 'users', id, overrideAccess: true, data: { password: PASSWORD } as never })
    }
    tokens.ana = await login('ana.juana@example.invalid')
    tokens.ben = await login('ben@example.invalid')
    tokens.rita = await login('rita@example.invalid')
    tokens.adm = await login('adm@example.invalid')
    tokens.platform = await login('platform@example.invalid')
  }, 180_000)

  afterAll(async () => {
    await shutdown(pg, payload)
  })

  // Each test sends many filters through a relation as one member: more than
  // `rateLimits.relationReadPerUser` a minute. That bucket has its own tests.
  beforeEach(() => resetRateLimits())

  // ── the oracle: the real substring and 'Zzzz' answer the same ─────────────

  for (const { collection, path, real, who } of PROBES) {
    it(`🔴 ${collection} as ${who}: where[${path}] gives no oracle on the list or the count`, async () => {
      const hit = `where[${path}][like]=${real}`
      const miss = `where[${path}][like]=Zzzz`
      expect(await list(collection, who, hit)).toEqual(await list(collection, who, miss))
      expect(await count(collection, who, hit)).toBe(await count(collection, who, miss))
      // The nested-object spelling and an upper-case OR reach the same column.
      const nested = (v: string) => `where[OR][0][${path.split('.').join('][')}][like]=${v}`
      expect(await list(collection, who, nested(real))).toEqual(await list(collection, who, nested('Zzzz')))
    })
  }

  it('🔴 a bulk PATCH answers no differently: memberships as their manager', async () => {
    // `PATCH /api/<slug>?where=…` returns the rows it matched. ADM may write
    // every membership of the ecosistema, but reads no `users` row but their own.
    const patch = async (v: string) => {
      const res = await rest('PATCH', `/api/memberships?depth=0&where[user.email][like]=${v}`, tokens.adm, {})
      const body = (await res.json()) as { docs?: unknown[] }
      return `${res.status}:${(body.docs ?? []).length}`
    }
    expect(await patch('juana')).toBe(await patch('Zzzz'))
  })

  it('🔴 ratings: sort=session.title / user.email does not move a row', async () => {
    for (const path of ['session.title', 'user.email', 'message.content']) {
      const up = await ordered('ratings', 'rita', `where[id][in]=${R_ANA},${R_BEN}&sort=${path}`)
      expect(await ordered('ratings', 'rita', `where[id][in]=${R_ANA},${R_BEN}&sort=-${path}`), path).toEqual(up)
    }
  })

  it('🔴 media: sort=uploadedBy.email does not move a row', async () => {
    const up = await ordered('media', 'ben', `where[id][in]=${M_ANA},${M_BEN}&sort=uploadedBy.email`)
    expect(up).toHaveLength(2)
    expect(await ordered('media', 'ben', `where[id][in]=${M_ANA},${M_BEN}&sort=-uploadedBy.email`)).toEqual(up)
  })

  // ── field reads: a field the caller may not read in every row ─────────────

  it('🔴 ratings.comment: a member who cannot read it cannot filter or sort by it', async () => {
    // Payload asks `canReadRatingComment` without a row, so it refuses the
    // path itself (400) for anyone but a platform admin, the author included.
    for (const who of ['ben', 'rita', 'ana']) {
      expect(await list('ratings', who, 'where[comment][like]=secreto'), who).toBe('HTTP400')
      expect(await list('ratings', who, 'where[comment][like]=Zzzz'), who).toBe('HTTP400')
      expect(await count('ratings', who, 'where[comment][like]=secreto'), who).toBe('HTTP400')
    }
    // A sort on it is stripped, like a sort through a relation.
    const up = await ordered('ratings', 'rita', `where[id][in]=${R_ANA},${R_BEN}&sort=comment`)
    expect(up).toHaveLength(2)
    expect(await ordered('ratings', 'rita', `where[id][in]=${R_ANA},${R_BEN}&sort=-comment`)).toEqual(up)
    expect(await list('ratings', 'platform', 'where[comment][like]=secreto')).toEqual([R_ANA])
  })

  it('🔴 users: a hidden field cannot be filtered on, even on the own row', async () => {
    expect(await list('users', 'ben', 'where[lockUntil][exists]=false')).toBe('HTTP400')
    expect(await list('users', 'ben', 'where[resetPasswordToken][exists]=false')).toBe('HTTP400')
    expect(await list('users', 'ben', 'where[email][like]=ben')).toEqual([BEN])
  })

  // ── what Payload itself refuses, and rows that hold nothing private ───────

  it('a path through a polymorphic relationship is refused by Payload, hit or miss', async () => {
    for (const [collection, who, path, real] of [
      ['sessions', 'ben', 'contextScope.value.name', 'Gated'],
      ['messages', 'ben', 'contextRefs.value.name', 'Gated'],
      ['payload-preferences', 'ben', 'user.value.email', 'juana'],
      ['payload-locked-documents', 'ben', 'document.value.title', 'Juana'],
      ['payload-locked-documents', 'ben', 'user.value.email', 'juana'],
    ] as const) {
      const hit = await list(collection, who, `where[${path}][like]=${real}`)
      expect(hit, `${collection} ${path}`).toEqual(await list(collection, who, `where[${path}][like]=Zzzz`))
      expect(hit, `${collection} ${path}`).not.toEqual(expect.arrayContaining([expect.any(Number)]))
    }
  })

  it('collections whose relations reach only rows the caller reads anyway', async () => {
    // teams and projects: `organization` / `team` are read by the same tenancy rule.
    expect(await list('teams', 'ben', 'where[organization.name][like]=Uno')).toEqual([TEAM])
    expect(await list('projects', 'ben', 'where[team.name][like]=Equip')).toEqual([PROJECT])
    // sessions and messages: own rows only, so `user` / `session` are the caller's.
    expect(await list('sessions', 'ben', 'where[user.email][like]=ben')).toEqual([S_BEN])
    expect(await list('messages', 'ben', 'where[session.title][like]=Ben')).toEqual([MSG_BEN])
    expect(await list('sessions', 'ben', 'where[title][like]=Juana')).toEqual([])
    // Server-only and platform-only collections refuse a member outright.
    for (const collection of ['graphEntities', 'graphMentions', 'graphRelations', 'studentProfiles', 'suggestions', 'eval-items', 'eval-runs']) {
      expect(await list(collection, 'ben', 'where[organization.name][like]=Uno'), collection).toBe('HTTP403')
    }
  })

  // ── controls ──────────────────────────────────────────────────────────────

  it("the caller's own rows still filter through a relation", async () => {
    expect(await list('ratings', 'ana', 'where[message.content][like]=respuesta')).toEqual([R_ANA])
    expect(await list('ratings', 'ben', 'where[session.title][like]=Ben')).toEqual([R_BEN])
    expect(await list('ratings', 'ana', 'where[user.email][like]=juana')).toHaveLength(BULK + 1)
    expect(await list('media', 'ana', 'where[uploadedBy.email][like]=juana')).toEqual([M_ANA])
    expect(await list('media', 'ben', 'where[uploadedBy.email][like]=ben')).toEqual([M_BEN])
    expect(await list('memberships', 'adm', 'where[user.email][like]=adm')).toHaveLength(1)
  })

  it('🔴 the id lookup is not cut at a page: more than 10 readable rows on the far side', async () => {
    // ANA's BULK + 1 conversations all match; Payload's default page is 10.
    expect(await count('ratings', 'ana', 'where[session.title][like]=Juana')).toBe(BULK + 1)
    expect(await list('ratings', 'ana', 'where[session.title][like]=Juana')).toHaveLength(BULK + 1)
  })

  it('a platform admin filters and sorts through every relationship', async () => {
    expect(await list('media', 'platform', 'where[uploadedBy.email][like]=juana')).toEqual([M_ANA])
    expect(await list('ratings', 'platform', 'where[message.content][like]=secreta')).toEqual([R_ANA])
    expect(await list('ratings', 'platform', 'where[session.title][like]=privada')).toEqual([R_ANA])
    expect(await list('ratings', 'platform', 'where[user.email][like]=ben')).toEqual([R_BEN])
    expect(await list('memberships', 'platform', 'where[user.email][like]=juana')).toHaveLength(1)
    const up = await ordered('ratings', 'platform', `where[id][in]=${R_ANA},${R_BEN}&sort=session.title`)
    expect(await ordered('ratings', 'platform', `where[id][in]=${R_ANA},${R_BEN}&sort=-session.title`)).toEqual([...(up as number[])].reverse())
  })

  it("the web's own filters still work", async () => {
    // `routes/api/sessions/[id]/ratings`: the caller's rating in a conversation, and by message.
    expect(await list('ratings', 'ben', `where[and][0][session][equals]=${S_BEN}&where[and][1][user][equals]=${BEN}`)).toEqual([R_BEN])
    expect(await list('ratings', 'ben', `where[message][equals]=${MSG_BEN}`)).toEqual([R_BEN])
    // `lib/server/admin.ts`: the ecosistema's ratings and members, newest first.
    expect(await list('ratings', 'rita', 'where[organization][equals]=1&sort=-createdAt')).toHaveLength(BULK + 2)
    expect(await list('memberships', 'adm', 'where[organization][equals]=1')).toHaveLength(4)
    // `lib/server/ecosystem.ts`: the caller's own memberships.
    expect(await list('memberships', 'ben', `where[user][equals]=${BEN}`)).toHaveLength(1)
    // `routes/api/sessions`: the conversation list.
    expect(await list('sessions', 'ben', 'where[organization][equals]=1&sort=-lastUsedAt,-createdAt')).toEqual([S_BEN])
    // `routes/api/sessions/[id]/messages`, `routes/api/generate`.
    expect(await list('messages', 'ben', `where[session][equals]=${S_BEN}&sort=createdAt`)).toEqual([MSG_BEN])
    expect(await list('messages', 'ben', `where[session][equals]=${S_BEN}&where[role][equals]=assistant&sort=-createdAt`)).toEqual([MSG_BEN])
    // `lib/server/admin.ts`, `lib/server/biblioteca.ts`: users by id.
    expect(await list('users', 'ben', `where[id][in]=${BEN}`)).toEqual([BEN])
    // `lib/server/admin.ts`: the ecosistema directory.
    expect(await list('organizations', 'ben', 'where[or][0][name][like]=Uno&where[or][1][slug][like]=Uno&sort=name')).toEqual([1])
  })

  // ── wiring ────────────────────────────────────────────────────────────────

  it('🔴 every collection that relates to another or hides a field carries the hook', async () => {
    const { needsRelationFilters, relationFilterHook } = await import('./relationFilters')
    const needing = config.collections.filter((c) => needsRelationFilters(c.flattenedFields as never))
    // The walk itself is checked: these must be among what it finds.
    expect(needing.map((c) => c.slug)).toEqual(
      expect.arrayContaining(['documents', 'media', 'ratings', 'memberships', 'sessions', 'messages', 'users', 'payload-locked-documents', 'payload-preferences']),
    )
    for (const c of needing) expect(c.hooks.beforeOperation, c.slug).toContain(relationFilterHook)
    // Exactly once, and last: a collection's own hook judges the query as sent.
    for (const c of needing) expect(c.hooks.beforeOperation.at(-1), c.slug).toBe(relationFilterHook)
    for (const c of needing) expect(c.hooks.beforeOperation.filter((h) => h === relationFilterHook), c.slug).toHaveLength(1)
    // No global has a relationship or a hidden field to filter on.
    for (const g of config.globals) expect(needsRelationFilters(g.flattenedFields as never), g.slug).toBe(false)
  })
})
