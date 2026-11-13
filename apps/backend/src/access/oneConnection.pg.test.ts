/**
 * 🔴 NO WRITE ASKS THE POOL FOR A SECOND CONNECTION — AGAINST A REAL POSTGRES.
 *
 * A write holds one pool connection for its transaction. Anything inside it
 * (access rule, hook, field access) that reads without `req` waits for a
 * second; with enough writes at once every connection is held by a waiter and
 * the backend hangs for good (sign-ins 2026-11-10, `Users.concurrentLogins.pg.test.ts`;
 * `/api/miembros` adds 2026-11-10, `miembros.concurrentAdds.pg.test.ts`).
 *
 * The guard: each write below runs alone on a pool with ONE free connection and
 * a short checkout timeout. A nested checkout cannot be served, times out, and
 * the write fails, the first time and every time, with no load to arrange.
 *
 * 🔴 EVERY COLLECTION AND EVERY WRITING ENDPOINT HAS A CASE. The REST matrix
 * below takes its lists from the config: a new collection, global or non-GET
 * endpoint without a case fails "the matrix covers…". Cases go through
 * Payload's REST router as a signed-in caller, the way the web reaches them.
 */

import { rmSync } from 'node:fs'
import path from 'node:path'

import { sql } from '@payloadcms/db-postgres'
import type { Payload, PayloadRequest, SanitizedConfig } from 'payload'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The publish, retry and ingest paths go as far as a configured ai-service
// would take them, so their writes run too (same stub as the documents suites).
vi.mock('@/lib/aiClient', () => {
  const anything: unknown = new Proxy(() => {}, {
    get: (_t, key) => (key === 'then' ? undefined : anything),
    apply: async () => ({ ok: true, ingestId: 'fake-ingest' }),
  })
  return { getAdminAIClient: () => anything, getAppAIClient: () => anything }
})

import { miembrosEndpoints } from '@/endpoints/miembros'
import { DB_POOL_CONNECTION_TIMEOUT_MS } from '@/lib/dbPool'
import { resolveForOrganization, resolvePrincipal } from '@/lib/permissions'
import { sessionMemberships } from '@/lib/roles'
import { bootPayload, dockerOk, rowsOf, shutdown, startRealPostgres, type RealPostgres } from '@/lib/testing/realPostgres'
import { UPLOAD_CONSENT_VERSION } from '@/lib/uploadConsent'

type Pool = {
  options: { max: number; connectionTimeoutMillis?: number }
  _clients: unknown[]
  _idle: Array<{ client: unknown }>
  _remove(client: unknown): void
  totalCount: number
  idleCount: number
  waitingCount: number
}

let pg: RealPostgres
let payload: Payload
let config: SanitizedConfig
let pool: Pool
let saved: { max: number; connectionTimeoutMillis?: number }
/** One password hash for everyone, taken once: hashing per test costs seconds. */
let credentials: { salt: string; hash: string }
const PASSWORD = 'one-connection-pw'
// Payload's default `staticDir` for `media` is the slug, relative to cwd.
const MEDIA_DIR = path.resolve(process.cwd(), 'media')
const written: string[] = []

// 1 olga, owner of A · 2 adan, admin of A · 3 memo, member of A ·
// 4 pato, platform admin, in no ecosistema · 5 eva, estudiante of A.
const OLGA = 1
const ADAN = 2
const MEMO = 3
const PATO = 4
const EVA = 5
const ECO_A = 1
const EMAIL: Record<number, string> = {
  [OLGA]: 'olga@example.invalid',
  [ADAN]: 'adan@example.invalid',
  [MEMO]: 'memo@example.invalid',
  [PATO]: 'pato@example.invalid',
  [EVA]: 'eva@example.invalid',
}

async function reqAs(id: number): Promise<PayloadRequest> {
  const { createLocalReq } = await import('payload')
  const user = await payload.findByID({ collection: 'users', id, overrideAccess: true })
  return (await createLocalReq({ user: { ...user, collection: 'users' } as never }, payload)) as PayloadRequest
}

async function miembros(
  method: 'post' | 'patch' | 'delete',
  as: number,
  opts: { body?: Record<string, unknown>; id?: number },
): Promise<number> {
  const req = await reqAs(as)
  Object.assign(req, {
    routeParams: opts.id === undefined ? {} : { id: String(opts.id) },
    json: async () => opts.body ?? {},
  })
  const path = opts.id === undefined ? '/miembros' : '/miembros/:id'
  const found = miembrosEndpoints.find((e) => e.method === method && e.path === path)!
  return (await found.handler(req)).status
}

/**
 * Nothing checked out beyond what boot holds for good, and nobody waiting. A
 * hook's detached work (an ingest after commit) must not hold a connection
 * when the guard starts, or that connection comes back mid-op as a second
 * free one.
 */
let bootHeld = 0
async function settle(): Promise<void> {
  for (let quiet = 0, i = 0; i < 200 && quiet < 3; i++) {
    quiet = pool.totalCount - pool.idleCount <= bootHeld && pool.waitingCount === 0 ? quiet + 1 : 0
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** Every other connection out of reach: what the op takes next is its only one. */
async function oneFreeConnection<T>(op: () => Promise<T>): Promise<T> {
  await settle()
  for (const { client } of [...pool._idle]) pool._remove(client)
  pool.options.max = pool._clients.length + 1
  pool.options.connectionTimeoutMillis = 3_000
  try {
    return await op()
  } finally {
    Object.assign(pool.options, saved)
  }
}

describe.skipIf(!dockerOk)('writes on one free connection', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-one-connection-${process.pid}`, 'one_connection')
    payload = await bootPayload(pg.url, 'one-connection-secret')
    config = await (await import('@payload-config')).default
    pool = (payload.db as unknown as { pool: Pool }).pool
    saved = { max: pool.options.max, connectionTimeoutMillis: pool.options.connectionTimeoutMillis }
    // `@payloadcms/db-postgres` keeps its boot client checked out (see `shutdown`).
    bootHeld = pool.totalCount - pool.idleCount
    await payload.create({
      collection: 'users',
      data: { email: 'hash@example.invalid', password: PASSWORD } as never,
      overrideAccess: true,
    })
    const [row] = await rowsOf(pg.db, sql`SELECT salt, hash FROM users WHERE email = 'hash@example.invalid'`)
    credentials = { salt: String(row?.salt), hash: String(row?.hash) }
  }, 120_000)

  beforeEach(async () => {
    const tables = (
      await rowsOf(pg.db, sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE 'payload_migrations%'`)
    ).map((r) => `"${String(r.tablename)}"`)
    await pg.db.execute(sql.raw(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`))
    await pg.db.execute(sql.raw(`
      INSERT INTO users (id, email, display_name, is_platform_admin, salt, hash) VALUES
        (1, 'olga@example.invalid', 'Olga', false, '${credentials.salt}', '${credentials.hash}'),
        (2, 'adan@example.invalid', 'Adán', false, '${credentials.salt}', '${credentials.hash}'),
        (3, 'memo@example.invalid', 'Memo', false, '${credentials.salt}', '${credentials.hash}'),
        (4, 'pato@example.invalid', 'Pato', true, '${credentials.salt}', '${credentials.hash}'),
        (5, 'eva@example.invalid', 'Eva', false, '${credentials.salt}', '${credentials.hash}');
      INSERT INTO organizations (id, name, slug, features) VALUES
        (1, 'Eco A', 'eco-a', '{"studentView": true}'), (2, 'Eco B', 'eco-b', NULL);
      INSERT INTO memberships (id, user_id, organization_id, role) VALUES
        (1, 1, 1, 'owner'), (2, 2, 1, 'admin'), (3, 3, 1, 'member'), (4, 5, 1, 'estudiante');
      INSERT INTO teams (id, name, slug, organization_id) VALUES (1, 'Equipo', 'equipo', 1), (2, 'Otro', 'otro', 1);
      INSERT INTO projects (id, name, slug, team_id) VALUES (1, 'Proyecto', 'proyecto', 1);
      INSERT INTO sessions (id, user_id, organization_id, kind, title) VALUES (1, 3, 1, 'generales', 'Chat');
      INSERT INTO messages (id, session_id, role, content, corpus_status) VALUES
        (1, 1, 'assistant', 'Una respuesta.', 'pending'), (2, 1, 'user', 'Una pregunta.', 'pending');
      INSERT INTO documents (id, organization_id, uploaded_by_id, publication_status, kind, content_kind, anonymise, anonymisation_status, extracted_text, body_markdown, name, ingest_status)
        VALUES (51, 1, 3, 'draft', 'markdown', 'documento', false, 'n/a', 'Notas del taller.', 'Notas del taller.', 'nota.md', 'ready'),
               (52, 1, 3, 'published', 'markdown', 'documento', false, 'n/a', 'Ya compartida.', 'Ya compartida.', 'publicada.md', 'ready'),
               (53, 1, 3, 'draft', 'pdf', 'documento', false, 'n/a', 'Falló.', NULL, 'fallido.pdf', 'failed');
      INSERT INTO eval_runs (id, organization_id, status, triggered_by_id) VALUES (1, 1, 'running', 4);
    `))
    for (const t of await rowsOf(pg.db, sql`SELECT sequencename FROM pg_sequences WHERE schemaname = 'public'`)) {
      await pg.db.execute(sql.raw(`SELECT setval('"${String(t.sequencename)}"', 1000)`))
    }
    tokens.clear()
  })

  afterEach(() => {
    Object.assign(pool.options, saved)
  })

  afterAll(async () => {
    for (const f of written) rmSync(path.join(MEDIA_DIR, f), { force: true })
    await shutdown(pg, payload)
  })

  /** The pool's own words when a checkout cannot be served (pg-pool 3.14.0, `index.js`). */
  const starved = (err: unknown): boolean => {
    for (let e = err as { message?: unknown; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
      if (/timeout exceeded when trying to connect/.test(String(e.message))) return true
    }
    return false
  }

  it('the guard bites: a read without `req` inside a write fails', async () => {
    const req = await reqAs(OLGA)
    const { commitTransaction, initTransaction } = await import('payload')
    const err = await oneFreeConnection(async () => {
      await initTransaction(req)
      try {
        await payload.find({ collection: 'users', overrideAccess: true, limit: 1 })
      } finally {
        await commitTransaction(req)
      }
    }).catch((e: unknown) => e)
    expect(starved(err)).toBe(true)
  }, 20_000)

  it('a starved pool answers an error after its timeout, it does not hang', async () => {
    expect(saved.connectionTimeoutMillis).toBe(DB_POOL_CONNECTION_TIMEOUT_MS)
    for (const { client } of [...pool._idle]) pool._remove(client)
    pool.options.max = pool._clients.length
    const started = Date.now()
    const err = await Promise.race([
      payload.find({ collection: 'users', overrideAccess: true, limit: 1 }).catch((e: unknown) => e),
      new Promise((r) => setTimeout(() => r('hung'), DB_POOL_CONNECTION_TIMEOUT_MS + 5_000)),
    ])
    Object.assign(pool.options, saved)
    expect(starved(err)).toBe(true)
    expect(Date.now() - started).toBeGreaterThanOrEqual(DB_POOL_CONNECTION_TIMEOUT_MS - 100)
    // And the pool serves the next request.
    await payload.find({ collection: 'users', overrideAccess: true, limit: 1 })
  }, DB_POOL_CONNECTION_TIMEOUT_MS + 20_000)

  it('/api/miembros: add a new email, add a known one, change a role, remove', async () => {
    await payload.update({ collection: 'memberships', id: 3, data: { isActive: false } as never, overrideAccess: true })
    await oneFreeConnection(async () => {
      const fresh = { organization: ECO_A, email: 'nueva@example.invalid', name: 'Nueva', role: 'member' }
      expect(await miembros('post', OLGA, { body: fresh })).toBe(201)
      const known = { organization: ECO_A, email: 'memo@example.invalid', name: 'Memo', role: 'member' }
      expect(await miembros('post', ADAN, { body: known })).toBe(201)
      expect(await miembros('patch', OLGA, { id: 3, body: { role: 'admin' } })).toBe(200)
      expect(await miembros('delete', OLGA, { id: 3 })).toBe(200)
    })
  }, 30_000)

  it('memberships through the collection, with access: create, update, delete', async () => {
    const req = await reqAs(ADAN)
    await oneFreeConnection(async () => {
      const data = { user: OLGA, organization: ECO_A, role: 'member' } as never
      // Olga already has a row in A: the uniqueness hook answers, after every rule ran.
      const err = await payload.create({ collection: 'memberships', data, overrideAccess: false, req }).catch((e) => e)
      expect(starved(err)).toBe(false)
      expect(String((err as Error).message)).toMatch(/invalid: user/)
      const title = { title: 'Coordinador' } as never
      await payload.update({ collection: 'memberships', id: 3, data: title, overrideAccess: false, req })
      await payload.delete({ collection: 'memberships', id: 3, overrideAccess: false, req })
    })
  }, 30_000)

  it('a person edits their own account, and signs in', async () => {
    const req = await reqAs(MEMO)
    await oneFreeConnection(async () => {
      await payload.update({ collection: 'users', id: MEMO, data: { displayName: 'Memo B' }, overrideAccess: false, req })
      const login = await payload.login({
        collection: 'users',
        data: { email: 'memo@example.invalid', password: PASSWORD },
      })
      expect(login.token).toBeTruthy()
    })
  }, 30_000)

  it('a student reads the roster inside a write (`readMemberships`, its own query)', async () => {
    await pg.db.execute(sql`UPDATE memberships SET role = 'estudiante' WHERE id = 3`)
    const req = await reqAs(MEMO)
    const { commitTransaction, initTransaction } = await import('payload')
    await oneFreeConnection(async () => {
      await initTransaction(req)
      try {
        const seen = await payload.find({ collection: 'memberships', overrideAccess: false, req, depth: 0 })
        expect(seen.totalDocs).toBe(3)
      } finally {
        await commitTransaction(req)
      }
    })
  }, 30_000)

  it('teams, by an admin of the ecosistema', async () => {
    const req = await reqAs(ADAN)
    await oneFreeConnection(async () => {
      const data = { name: 'Otro', slug: 'otro', organization: ECO_A } as never
      await payload.create({ collection: 'teams', data, overrideAccess: false, req })
      await payload.update({ collection: 'teams', id: 1, data: { name: 'Equipo B' } as never, overrideAccess: false, req })
    })
  }, 30_000)

  it('a project under a team (`organizationOf`, collections/Projects.ts)', async () => {
    const req = await reqAs(ADAN)
    await oneFreeConnection(async () => {
      const data = { name: 'P', slug: 'p', team: 1 } as never
      await payload.create({ collection: 'projects', data, overrideAccess: false, req })
    })
  }, 30_000)

  it('an owner edits the ecosistema (`manageableOrganizations`, collections/Organizations.ts)', async () => {
    const req = await reqAs(OLGA)
    await oneFreeConnection(async () => {
      const data = { name: 'Eco A bis' } as never
      await payload.update({ collection: 'organizations', id: ECO_A, data, overrideAccess: false, req })
    })
  }, 30_000)

  it('an owner renames the slug (`ownerOnlyField`, collections/Organizations.ts)', async () => {
    const req = await reqAs(OLGA)
    const row = await oneFreeConnection(() =>
      payload.update({ collection: 'organizations', id: ECO_A, data: { slug: 'eco-a-bis' } as never, overrideAccess: false, req }),
    )
    // Field access answered "owner", so the slug was kept, not stripped.
    expect((row as { slug?: unknown }).slug).toBe('eco-a-bis')
  }, 30_000)

  it('a member opens a chat (`stampOwnerAndEcosystem`, collections/Sessions.ts)', async () => {
    const req = await reqAs(MEMO)
    await oneFreeConnection(async () => {
      const data = { organization: ECO_A, kind: 'generales' } as never
      await payload.create({ collection: 'sessions', data, overrideAccess: false, req })
    })
  }, 30_000)

  it('the session payload and the principal, read inside a write (`lib/roles.ts`, `lib/permissions.ts`)', async () => {
    const req = await reqAs(MEMO)
    const { commitTransaction, initTransaction } = await import('payload')
    await oneFreeConnection(async () => {
      await initTransaction(req)
      try {
        expect(await sessionMemberships(payload, MEMO, req)).toEqual([{ organization: '1', slug: 'eco-a', role: 'member' }])
        expect((await resolvePrincipal(payload, EMAIL[MEMO]!, req))?.projects).toHaveProperty('eco-a')
        expect(await resolvePrincipal(payload, EMAIL[PATO]!, req)).toMatchObject({ isPlatformAdmin: true })
        expect(await resolveForOrganization(payload, EMAIL[MEMO]!, 'eco-a', req)).not.toBeNull()
      } finally {
        await commitTransaction(req)
      }
    })
  }, 30_000)

  // -------------------------------------------------------------------------
  // The REST matrix
  // -------------------------------------------------------------------------

  async function rest(method: string, url: string, token?: string, body?: unknown): Promise<Response> {
    const { handleEndpoints } = await import('payload')
    const headers: Record<string, string> = {}
    if (token) headers.Authorization = `JWT ${token}`
    let payloadBody: BodyInit | undefined
    if (body instanceof FormData) payloadBody = body
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      payloadBody = JSON.stringify(body)
    }
    return handleEndpoints({ config, request: new Request(`http://localhost${url}`, { method, headers, body: payloadBody }) })
  }

  const tokens = new Map<number, string>()
  async function tokenFor(id: number): Promise<string> {
    const cached = tokens.get(id)
    if (cached) return cached
    const res = await rest('POST', '/api/users/login', undefined, { email: EMAIL[id], password: PASSWORD })
    const token = ((await res.json()) as { token?: string }).token
    if (!token) throw new Error(`login ${id}: ${res.status}`)
    tokens.set(id, token)
    return token
  }

  /** A markdown upload as the web sends it; returns the media id. */
  async function upload(as: number): Promise<number> {
    const res = await rest('POST', '/api/media', await tokenFor(as), mediaForm())
    expect(res.status).toBe(201)
    const doc = ((await res.json()) as { doc: { id: number; filename: string } }).doc
    written.push(doc.filename)
    return doc.id
  }
  const mediaForm = (): FormData => {
    const form = new FormData()
    form.append('file', new Blob(['# Notas\n\nDel taller.\n'], { type: 'text/markdown' }), 'notas.md')
    return form
  }

  type Case = {
    as: number
    method: 'POST' | 'PATCH' | 'DELETE'
    /** `:media` is the id `before` returned. */
    url: string
    body?: unknown | (() => unknown)
    status: number | number[]
    before?: () => Promise<number | void>
  }

  const denied = (slug: string, as: number): Record<'create' | 'update' | 'delete', Case[]> => ({
    create: [{ as, method: 'POST', url: `/api/${slug}`, body: {}, status: 403 }],
    update: [{ as, method: 'PATCH', url: `/api/${slug}/1`, body: {}, status: 403 }],
    delete: [{ as, method: 'DELETE', url: `/api/${slug}/1`, status: 403 }],
  })

  /**
   * Per collection: create, update, delete. The caller is the person who would
   * really do it, a member first; a platform admin too where the path differs.
   */
  const COLLECTIONS: Record<string, Record<'create' | 'update' | 'delete', Case[]>> = {
    users: {
      create: [
        { as: PATO, method: 'POST', url: '/api/users', body: { email: 'nuevo@example.invalid', password: PASSWORD }, status: 201 },
        { as: MEMO, method: 'POST', url: '/api/users', body: { email: 'otro@example.invalid', password: PASSWORD }, status: 403 },
      ],
      update: [
        { as: MEMO, method: 'PATCH', url: `/api/users/${MEMO}`, body: { displayName: 'Memo B' }, status: 200 },
        { as: PATO, method: 'PATCH', url: `/api/users/${MEMO}`, body: { isActive: false }, status: 200 },
      ],
      delete: [
        {
          as: PATO,
          method: 'DELETE',
          url: '/api/users/6',
          before: () => pg.db.execute(sql`INSERT INTO users (id, email) VALUES (6, 'sola@example.invalid')`).then(() => undefined),
          status: 200,
        },
        { as: MEMO, method: 'DELETE', url: `/api/users/${EVA}`, status: 403 },
      ],
    },
    organizations: {
      create: [{ as: PATO, method: 'POST', url: '/api/organizations', body: { name: 'Eco C', slug: 'eco-c' }, status: 201 }],
      update: [
        { as: OLGA, method: 'PATCH', url: `/api/organizations/${ECO_A}`, body: { name: 'Eco A bis', slug: 'eco-a-bis' }, status: 200 },
        // The anonymisation switches: audited, and a re-gate starts after commit.
        { as: OLGA, method: 'PATCH', url: `/api/organizations/${ECO_A}`, body: { features: { keepCitedAuthors: true } }, status: 200 },
        { as: PATO, method: 'PATCH', url: `/api/organizations/${ECO_A}`, body: { features: { keepPublicFigures: true, studentTestimonios: false } }, status: 200 },
        { as: ADAN, method: 'PATCH', url: `/api/organizations/${ECO_A}`, body: { name: 'No' }, status: 403 },
      ],
      delete: [{ as: PATO, method: 'DELETE', url: '/api/organizations/2', status: 200 }],
    },
    memberships: {
      create: [{ as: ADAN, method: 'POST', url: '/api/memberships', body: { user: PATO, organization: ECO_A, role: 'member' }, status: 201 }],
      update: [{ as: ADAN, method: 'PATCH', url: '/api/memberships/3', body: { title: 'Coordinador' }, status: 200 }],
      delete: [{ as: ADAN, method: 'DELETE', url: '/api/memberships/3', status: 200 }],
    },
    teams: {
      create: [{ as: ADAN, method: 'POST', url: '/api/teams', body: { name: 'Nuevo', slug: 'nuevo', organization: ECO_A }, status: 201 }],
      update: [{ as: ADAN, method: 'PATCH', url: '/api/teams/1', body: { name: 'Equipo B' }, status: 200 }],
      delete: [{ as: ADAN, method: 'DELETE', url: '/api/teams/2', status: 200 }],
    },
    projects: {
      create: [{ as: ADAN, method: 'POST', url: '/api/projects', body: { name: 'P', slug: 'p', team: 1 }, status: 201 }],
      update: [{ as: ADAN, method: 'PATCH', url: '/api/projects/1', body: { name: 'P bis', team: 2 }, status: 200 }],
      delete: [{ as: ADAN, method: 'DELETE', url: '/api/projects/1', status: 200 }],
    },
    documents: {
      create: [
        {
          as: MEMO,
          method: 'POST',
          url: '/api/documents',
          before: () => upload(MEMO),
          body: (media: number) => ({
            uploadConsentVersion: UPLOAD_CONSENT_VERSION,
            session: [1],
            kind: 'markdown',
            contentKind: 'documento',
            mode: 'rag-retrieve',
            name: 'notas.md',
            mediaFile: media,
            isPinned: false,
            ingestStatus: 'pending',
          }),
          status: 201,
        },
        // Mis documentos: no conversation, the ecosistema named.
        {
          as: MEMO,
          method: 'POST',
          url: '/api/documents',
          before: () => upload(MEMO),
          body: (media: number) => ({ uploadConsentVersion: UPLOAD_CONSENT_VERSION, session: [], organization: ECO_A, kind: 'markdown', contentKind: 'documento', name: 'b.md', mediaFile: media, ingestStatus: 'pending' }),
          status: 201,
        },
      ],
      update: [
        { as: MEMO, method: 'PATCH', url: '/api/documents/51', body: { name: 'nota bis.md' }, status: 200 },
        { as: MEMO, method: 'PATCH', url: '/api/documents/51', body: { contentKind: 'testimonio' }, status: [200, 400, 403] },
      ],
      delete: [
        { as: MEMO, method: 'DELETE', url: '/api/documents/51', status: 200 },
        { as: MEMO, method: 'DELETE', url: '/api/documents/52', status: 200 },
      ],
    },
    media: {
      create: [{ as: MEMO, method: 'POST', url: '/api/media', body: mediaForm, status: 201 }],
      update: [{ as: MEMO, method: 'PATCH', url: '/api/media/:media', before: () => upload(MEMO), body: { alt: 'x' }, status: 200 }],
      delete: [{ as: MEMO, method: 'DELETE', url: '/api/media/:media', before: () => upload(MEMO), status: 200 }],
    },
    sessions: {
      create: [{ as: MEMO, method: 'POST', url: '/api/sessions', body: { organization: ECO_A, kind: 'generales' }, status: 201 }],
      update: [
        { as: MEMO, method: 'PATCH', url: '/api/sessions/1', body: { title: 'Otro' }, status: 200 },
        // Payload's lock rule still holds (`hooks/lockCheckOnReq.ts`): someone else's fresh lock refuses.
        {
          as: MEMO,
          method: 'PATCH',
          url: '/api/sessions/1',
          before: async () => {
            const data = { document: { relationTo: 'sessions', value: 1 }, user: { relationTo: 'users', value: PATO } }
            await payload.create({ collection: 'payload-locked-documents', data: data as never, overrideAccess: true })
          },
          body: { title: 'Otro' },
          status: 423,
        },
      ],
      // Its turns, ratings and the uploads that are only its own go with it.
      delete: [
        {
          as: MEMO,
          method: 'DELETE',
          url: '/api/sessions/1',
          before: async () => {
            const media = await upload(MEMO)
            const res = await rest('POST', '/api/documents', await tokenFor(MEMO), {
              uploadConsentVersion: UPLOAD_CONSENT_VERSION, session: [1], kind: 'markdown', contentKind: 'documento', name: 'c.md', mediaFile: media, ingestStatus: 'pending',
            })
            expect(res.status).toBe(201)
            await pg.db.execute(sql`INSERT INTO ratings (message_id, user_id, session_id, organization_id, stars) VALUES (1, 3, 1, 1, 4)`)
          },
          status: 200,
        },
      ],
    },
    messages: {
      create: [{ as: MEMO, method: 'POST', url: '/api/messages', body: { session: 1, role: 'user', content: 'Hola' }, status: 201 }],
      update: [{ as: MEMO, method: 'PATCH', url: '/api/messages/2', body: { content: 'Otra' }, status: 200 }],
      delete: [{ as: MEMO, method: 'DELETE', url: '/api/messages/2', status: 200 }],
    },
    ratings: {
      create: [{ as: MEMO, method: 'POST', url: '/api/ratings', body: { message: 1, stars: 2, reason: 'invented' }, status: 201 }],
      update: [
        {
          as: MEMO,
          method: 'PATCH',
          url: '/api/ratings/7',
          before: () => pg.db.execute(sql`INSERT INTO ratings (id, message_id, user_id, session_id, organization_id, stars) VALUES (7, 1, 3, 1, 1, 4)`).then(() => undefined),
          body: { stars: 5, comment: 'Bien' },
          status: 200,
        },
      ],
      delete: [
        {
          as: MEMO,
          method: 'DELETE',
          url: '/api/ratings/7',
          before: () => pg.db.execute(sql`INSERT INTO ratings (id, message_id, user_id, session_id, organization_id, stars) VALUES (7, 1, 3, 1, 1, 4)`).then(() => undefined),
          status: 200,
        },
      ],
    },
    'anonymisation-reviews': denied('anonymisation-reviews', PATO),
    'anonymisation-setting-changes': denied('anonymisation-setting-changes', PATO),
    'consent-receipts': denied('consent-receipts', PATO),
    graphEntities: denied('graphEntities', PATO),
    graphMentions: denied('graphMentions', PATO),
    graphRelations: denied('graphRelations', PATO),
    studentProfiles: denied('studentProfiles', PATO),
    suggestions: denied('suggestions', PATO),
    aiServiceCallbacks: denied('aiServiceCallbacks', PATO),
    'eval-items': {
      create: [{ as: PATO, method: 'POST', url: '/api/eval-items', body: { organization: ECO_A, kind: 'pregunta', question: '¿Qué?' }, status: 201 }],
      update: [
        {
          as: PATO,
          method: 'PATCH',
          url: '/api/eval-items/1',
          before: () => pg.db.execute(sql`INSERT INTO eval_items (id, organization_id, kind, question) VALUES (1, 1, 'pregunta', '¿Qué?')`).then(() => undefined),
          body: { question: '¿Cómo?' },
          status: 200,
        },
      ],
      delete: [
        {
          as: PATO,
          method: 'DELETE',
          url: '/api/eval-items/1',
          before: () => pg.db.execute(sql`INSERT INTO eval_items (id, organization_id, kind, question) VALUES (1, 1, 'pregunta', '¿Qué?')`).then(() => undefined),
          status: 200,
        },
      ],
    },
    'eval-runs': {
      create: [{ as: PATO, method: 'POST', url: '/api/eval-runs', body: { organization: ECO_A, status: 'queued' }, status: 201 }],
      update: [{ as: PATO, method: 'PATCH', url: '/api/eval-runs/1', body: { progress: { done: 1 } }, status: 200 }],
      delete: [{ as: PATO, method: 'DELETE', url: '/api/eval-runs/1', status: 200 }],
    },
  }

  const GLOBALS: Record<string, Case[]> = {
    'platform-settings': [
      { as: PATO, method: 'POST', url: '/api/globals/platform-settings', body: { detectorFallback: 'none' }, status: 200 },
    ],
  }

  /** Every non-GET custom endpoint, by `METHOD /api/path` as the config mounts it. */
  const ENDPOINTS: Record<string, Case[]> = {
    // Payload's auth routes, on the one auth collection.
    'POST /api/users/login': [{ as: MEMO, method: 'POST', url: '/api/users/login', body: { email: EMAIL[MEMO], password: PASSWORD }, status: 200 }],
    'POST /api/users/logout': [{ as: MEMO, method: 'POST', url: '/api/users/logout', status: 200 }],
    'POST /api/users/refresh-token': [{ as: MEMO, method: 'POST', url: '/api/users/refresh-token', status: 200 }],
    'POST /api/users/forgot-password': [
      { as: MEMO, method: 'POST', url: '/api/users/forgot-password', body: { email: EMAIL[MEMO] }, status: 200 },
    ],
    'POST /api/users/reset-password': [
      { as: MEMO, method: 'POST', url: '/api/users/reset-password', body: { token: 'nope', password: PASSWORD }, status: [400, 403] },
    ],
    'POST /api/users/unlock': [{ as: PATO, method: 'POST', url: '/api/users/unlock', body: { email: EMAIL[MEMO] }, status: 200 }],
    // Verification is off here (no `_verificationToken` field): Payload answers 500 itself.
    // The time bound in `runCase` is what tells it from a starved checkout.
    'POST /api/users/verify/:id': [{ as: MEMO, method: 'POST', url: '/api/users/verify/nope', status: [400, 403, 404, 500] }],
    'POST /api/users/first-register': [
      { as: MEMO, method: 'POST', url: '/api/users/first-register', body: { email: 'primera@example.invalid', password: PASSWORD }, status: 403 },
    ],
    'POST /api/ratings/upsert': [
      { as: MEMO, method: 'POST', url: '/api/ratings/upsert', body: { message: 1, stars: 3 }, status: [200, 201] },
    ],
    'POST /api/documents/:id/publish': [{ as: MEMO, method: 'POST', url: '/api/documents/51/publish', status: 202 }],
    'POST /api/documents/:id/unpublish': [{ as: MEMO, method: 'POST', url: '/api/documents/52/unpublish', status: 202 }],
    'PATCH /api/documents/:id/note': [
      { as: MEMO, method: 'PATCH', url: '/api/documents/51/note', body: { name: 'n.md', bodyMarkdown: 'Notas nuevas.' }, status: 200 },
    ],
    'POST /api/documents/:id/retry': [{ as: MEMO, method: 'POST', url: '/api/documents/53/retry', status: 202 }],
    'POST /api/documents/:id/graph-retry': [{ as: MEMO, method: 'POST', url: '/api/documents/51/graph-retry', status: [202, 409] }],
    'PATCH /api/documents/:id/anonimizacion': [
      { as: MEMO, method: 'PATCH', url: '/api/documents/51/anonimizacion', body: { keepCitedAuthors: true }, status: [200, 409] },
    ],
    'POST /api/documents/:id/anonimizacion/reintentar': [
      { as: MEMO, method: 'POST', url: '/api/documents/51/anonimizacion/reintentar', status: [200, 202, 400, 409] },
    ],
    'POST /api/organizations/:id/anonimizacion/reintentar': [
      { as: OLGA, method: 'POST', url: `/api/organizations/${ECO_A}/anonimizacion/reintentar`, status: [200, 202, 409] },
    ],
    'POST /api/miembros': [
      { as: OLGA, method: 'POST', url: '/api/miembros', body: { organization: ECO_A, email: 'nueva@example.invalid', name: 'Nueva', role: 'member' }, status: 201 },
    ],
    'PATCH /api/miembros/:id': [{ as: OLGA, method: 'PATCH', url: '/api/miembros/3', body: { role: 'admin' }, status: 200 }],
    'DELETE /api/miembros/:id': [{ as: OLGA, method: 'DELETE', url: '/api/miembros/3', status: 200 }],
    'PATCH /api/funciones': [
      { as: OLGA, method: 'PATCH', url: '/api/funciones', body: { organization: ECO_A, features: { graph: false } }, status: 200 },
    ],
    'PATCH /api/funciones/estilo': [
      { as: PATO, method: 'PATCH', url: '/api/funciones/estilo', body: { organization: ECO_A, answerStyles: { generales: 'Breve.' } }, status: 200 },
    ],
    'PATCH /api/plataforma': [{ as: PATO, method: 'PATCH', url: '/api/plataforma', body: { detectorFallback: 'none' }, status: [200, 400] }],
    'PATCH /api/estudiante/perfil': [
      { as: EVA, method: 'PATCH', url: '/api/estudiante/perfil', body: { organization: ECO_A, shareWithPeers: true, shareActivity: true }, status: 200 },
    ],
    'POST /api/sugerencias': [
      { as: EVA, method: 'POST', url: '/api/sugerencias', body: { organization: ECO_A, kind: 'contenido', text: 'Más notas.' }, status: 201 },
    ],
    'POST /api/evals/session': [{ as: PATO, method: 'POST', url: '/api/evals/session', body: { run: 1 }, status: 201 }],
    // Reads only; listed so the completeness check holds.
    'POST /api/evals/gate': [{ as: PATO, method: 'POST', url: '/api/evals/gate', body: { item: 999 }, status: 404 }],
    'POST /api/evals/seed': [
      {
        as: PATO,
        method: 'POST',
        url: '/api/evals/seed',
        before: () => pg.db.execute(sql`UPDATE organizations SET slug = 'prevencion-dengue' WHERE id = 2`).then(() => undefined),
        body: { organization: 2 },
        status: 201,
      },
    ],
    'POST /api/v1/identity/token': [
      {
        as: MEMO,
        method: 'POST',
        url: '/api/v1/identity/token',
        // A throwaway signing key for this process only.
        before: async () => {
          const { generateKeyPairSync } = await import('node:crypto')
          const { privateKey, publicKey } = generateKeyPairSync('ed25519')
          process.env.AUTH_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
          process.env.AUTH_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'pem' }).toString()
          process.env.AUTH_ISSUER = 'https://one-connection.example.invalid'
          process.env.AUTH_KEY_ID = 'one-connection'
          ;(await import('@/lib/jwt/keys')).resetKeyCache()
        },
        body: { audience: 'eco-a' },
        status: 200,
      },
    ],
    'POST /api/graph/retrieve': [{ as: MEMO, method: 'POST', url: '/api/graph/retrieve', body: { organization: ECO_A, query: 'taller' }, status: [200, 404] }],
  }

  /** Payload's own collections; nobody writes them over REST. */
  const INTERNAL = /^payload-/

  it('the matrix covers every collection, global and writing endpoint in the config', () => {
    const slugs = config.collections.map((c) => c.slug).filter((s) => !INTERNAL.test(s))
    expect(Object.keys(COLLECTIONS).sort()).toEqual([...slugs].sort())
    for (const slug of slugs) {
      for (const op of ['create', 'update', 'delete'] as const) expect(COLLECTIONS[slug]![op].length, `${slug} ${op}`).toBeGreaterThan(0)
    }
    expect(Object.keys(GLOBALS).sort()).toEqual(config.globals.map((g) => g.slug).sort())
    // Payload's own routes (CRUD, auth, versions) are one shared set of handlers,
    // added to every collection; the CRUD ones are the per-collection cases above.
    const seen = new Map<unknown, number>()
    for (const c of config.collections) {
      for (const e of (Array.isArray(c.endpoints) ? c.endpoints : []) as Array<{ handler: unknown }>) {
        seen.set(e.handler, (seen.get(e.handler) ?? 0) + 1)
      }
    }
    const mounted: string[] = []
    const add = (prefix: string, eps: unknown) => {
      for (const e of (Array.isArray(eps) ? eps : []) as Array<{ method: string; path: string; handler: unknown }>) {
        if (e.method !== 'get' && (seen.get(e.handler) ?? 0) <= 1) mounted.push(`${e.method.toUpperCase()} /api${prefix}${e.path}`)
      }
    }
    add('', config.endpoints)
    for (const c of config.collections) if (!INTERNAL.test(c.slug)) add(`/${c.slug}`, c.endpoints)
    expect(Object.keys(ENDPOINTS).sort()).toEqual([...new Set(mounted)].sort())
  })

  async function runCase(c: Case): Promise<void> {
    const made = await c.before?.()
    const token = await tokenFor(c.as)
    const body = typeof c.body === 'function' ? (c.body as (m?: number) => unknown)(made ?? undefined) : c.body
    const url = c.url.replace(':media', String(made))
    const started = Date.now()
    const res = await oneFreeConnection(() => rest(c.method, url, token, body))
    const ms = Date.now() - started
    const text = await res.text()
    const want = Array.isArray(c.status) ? c.status : [c.status]
    expect(want, `${c.method} ${url} as ${c.as} → ${res.status} ${text.slice(0, 300)}`).toContain(res.status)
    // A starved checkout answers only after the guard's 3 s timeout; anything
    // near it waited on a second connection, whatever the status says.
    expect(ms, `${c.method} ${url} took ${ms} ms`).toBeLessThan(2_000)
  }

  const label = (c: Case) => `${c.method} ${c.url} as ${EMAIL[c.as]!.split('@')[0]}`
  for (const [slug, ops] of Object.entries(COLLECTIONS)) {
    for (const op of ['create', 'update', 'delete'] as const) {
      for (const c of ops[op]) it(`REST ${slug} ${op}: ${label(c)}`, () => runCase(c), 30_000)
    }
  }
  for (const [slug, cases] of Object.entries(GLOBALS)) {
    for (const c of cases) it(`REST global ${slug}: ${label(c)}`, () => runCase(c), 30_000)
  }
  for (const [route, cases] of Object.entries(ENDPOINTS)) {
    for (const c of cases) it(`REST ${route}: ${label(c)}`, () => runCase(c), 30_000)
  }
})
