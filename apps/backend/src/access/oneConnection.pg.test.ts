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
 */

import { sql } from '@payloadcms/db-postgres'
import type { Payload, PayloadRequest } from 'payload'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { miembrosEndpoints } from '@/endpoints/miembros'
import { DB_POOL_CONNECTION_TIMEOUT_MS } from '@/lib/dbPool'
import { bootPayload, dockerOk, shutdown, startRealPostgres, type RealPostgres } from '@/lib/testing/realPostgres'

type Pool = {
  options: { max: number; connectionTimeoutMillis?: number }
  _clients: unknown[]
  _idle: Array<{ client: unknown }>
  _remove(client: unknown): void
}

let pg: RealPostgres
let payload: Payload
let pool: Pool
let saved: { max: number; connectionTimeoutMillis?: number }

// 1 olga, owner of A · 2 adan, admin of A · 3 memo, member of A.
const OLGA = 1
const ADAN = 2
const MEMO = 3
const ECO_A = 1

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

/** Every other connection out of reach: what the op takes next is its only one. */
async function oneFreeConnection<T>(op: () => Promise<T>): Promise<T> {
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
    pool = (payload.db as unknown as { pool: Pool }).pool
    saved = { max: pool.options.max, connectionTimeoutMillis: pool.options.connectionTimeoutMillis }
  }, 120_000)

  beforeEach(async () => {
    await pg.db.execute(sql.raw(`
      TRUNCATE memberships, projects, teams, organizations, users RESTART IDENTITY CASCADE;
      INSERT INTO users (id, email, display_name, is_platform_admin) VALUES
        (1, 'olga@example.invalid', 'Olga', false),
        (2, 'adan@example.invalid', 'Adán', false),
        (3, 'memo@example.invalid', 'Memo', false);
      SELECT setval('users_id_seq', 3);
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Eco A', 'eco-a');
      SELECT setval('organizations_id_seq', 1);
      INSERT INTO memberships (id, user_id, organization_id, role) VALUES
        (1, 1, 1, 'owner'), (2, 2, 1, 'admin'), (3, 3, 1, 'member');
      SELECT setval('memberships_id_seq', 3);
      INSERT INTO teams (id, name, slug, organization_id) VALUES (1, 'Equipo', 'equipo', 1);
      SELECT setval('teams_id_seq', 1);
    `))
  })

  afterEach(() => {
    Object.assign(pool.options, saved)
  })

  afterAll(async () => {
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
    const password = { password: 'one-connection-pw' } as never
    await payload.update({ collection: 'users', id: MEMO, data: password, overrideAccess: true })
    await oneFreeConnection(async () => {
      await payload.update({ collection: 'users', id: MEMO, data: { displayName: 'Memo B' }, overrideAccess: false, req })
      const login = await payload.login({
        collection: 'users',
        data: { email: 'memo@example.invalid', password: 'one-connection-pw' },
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

  // ⚠ KNOWN, OUTSIDE THIS GUARD'S FILES (measured 2026-11-10): each still reads
  // without `req` inside its write. `it.fails` turns red the day one is fixed;
  // then make it a plain `it`.
  it.fails('KNOWN: a project under a team (`organizationOf`, collections/Projects.ts:18)', async () => {
    const req = await reqAs(ADAN)
    await oneFreeConnection(async () => {
      const data = { name: 'P', slug: 'p', team: 1 } as never
      await payload.create({ collection: 'projects', data, overrideAccess: false, req })
    })
  }, 30_000)

  it.fails('KNOWN: an owner edits the ecosistema (`manageableOrganizations`, collections/Organizations.ts:37)', async () => {
    const req = await reqAs(OLGA)
    await oneFreeConnection(async () => {
      const data = { description: 'd' } as never
      await payload.update({ collection: 'organizations', id: ECO_A, data, overrideAccess: false, req })
    })
  }, 30_000)

  it.fails('KNOWN: a member opens a chat (`stampOwnerAndEcosystem`, collections/Sessions.ts:93)', async () => {
    const req = await reqAs(MEMO)
    await oneFreeConnection(async () => {
      const data = { user: MEMO, organization: ECO_A, kind: 'chat' } as never
      await payload.create({ collection: 'sessions', data, overrideAccess: false, req })
    })
  }, 30_000)
})
