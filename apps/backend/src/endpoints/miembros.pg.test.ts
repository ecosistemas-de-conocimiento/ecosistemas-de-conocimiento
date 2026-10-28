/**
 * 🔴 `/api/miembros` — AN ECOSISTEMA'S RESPONSABLE MANAGES ITS PEOPLE, AND
 * NOTHING ELSE. Against a real Postgres, the real Payload config, real hooks.
 *
 * What is pinned: only a manager of THAT ecosistema (or a platform admin) gets
 * in; a role above the caller's is refused on every path (including the plain
 * collection API, the finding this lane fixes); adding an existing email says
 * nothing about that person's other ecosistemas; a new person gets a working
 * one-time password.
 *
 * ⚠ No docker → the suite SKIPS, with a console warning naming the reason.
 */

import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

import { sql } from '@payloadcms/db-postgres'
import { drizzle } from '@payloadcms/db-postgres/drizzle/node-postgres'
import type { MigrateUpArgs } from '@payloadcms/db-postgres'
import type { Endpoint, Payload, PayloadRequest } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { migrations } from '../migrations'
import { miembrosEndpoints } from './miembros'

const CONTAINER = `edc-backend-miembros-pg-${process.pid}`
const IMAGE = 'postgres:16-alpine'

const dockerOk = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0
if (!dockerOk) console.warn('[miembros.pg.test] docker is not usable — the real-Postgres tests SKIP.')

type Db = ReturnType<typeof drizzle>
let db: Db
let payload: Payload

const stopContainer = () => spawnSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' })

async function startPostgres(): Promise<string> {
  stopContainer()
  const run = spawnSync(
    'docker',
    [
      'run', '-d', '--rm', '--tmpfs', '/var/lib/postgresql/data', '--name', CONTAINER, '-p', '0:5432',
      '-e', 'POSTGRES_USER=postgres', '-e', 'POSTGRES_PASSWORD=postgres',
      '-e', 'POSTGRES_DB=miembros_test', IMAGE,
    ],
    { encoding: 'utf8' },
  )
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`)
  const port = spawnSync('docker', ['port', CONTAINER, '5432/tcp'], { encoding: 'utf8' })
    .stdout.split('\n')[0]?.trim().split(':').pop()
  if (!port) throw new Error('could not read the container port')
  return `postgres://postgres:postgres@127.0.0.1:${port}/miembros_test`
}

async function waitForQueries(candidate: Db): Promise<void> {
  const deadline = Date.now() + 25_000
  let last: unknown
  while (Date.now() < deadline) {
    try {
      await candidate.execute(sql`select 1`)
      return
    } catch (err) {
      last = err
      await delay(300)
    }
  }
  throw new Error(`postgres never answered: ${String(last)}`)
}

// ── People ────────────────────────────────────────────────────────────────
// 1 root (platform admin) · 2 olga, owner of A · 3 adan, admin of A ·
// 4 memo, member of A · 5 bea, owner of B (and nothing in A).
const ROOT = 1
const OLGA = 2
const ADAN = 3
const MEMO = 4
const BEA = 5
const ECO_A = 1
const ECO_B = 2

const endpoint = (method: string, path: string): Endpoint => {
  const found = miembrosEndpoints.find((e) => e.method === method && e.path === path)
  if (!found) throw new Error(`no ${method} ${path}`)
  return found
}

async function call(
  method: 'get' | 'post' | 'patch' | 'delete',
  as: number,
  opts: { query?: Record<string, string>; body?: Record<string, unknown>; id?: number } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const user = await payload.findByID({ collection: 'users', id: as, overrideAccess: true })
  const { createLocalReq } = await import('payload')
  const req = (await createLocalReq({ user: { ...user, collection: 'users' } as never }, payload)) as PayloadRequest
  const url = new URL('http://test.local/api/miembros')
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v)
  Object.assign(req, {
    searchParams: url.searchParams,
    routeParams: opts.id === undefined ? {} : { id: String(opts.id) },
    json: async () => opts.body ?? {},
  })
  const path = opts.id === undefined ? '/miembros' : '/miembros/:id'
  const res = await endpoint(method, path).handler(req)
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

const roleOf = async (userId: number, orgId: number) =>
  ((await db.execute(
    sql.raw(`SELECT role FROM memberships WHERE user_id = ${userId} AND organization_id = ${orgId}`),
  )) as unknown as { rows: Array<{ role: string }> }).rows.map((r) => r.role)

describe.skipIf(!dockerOk)('/api/miembros on a real Postgres', () => {
  beforeAll(async () => {
    const url = await startPostgres()
    db = drizzle(url)
    await waitForQueries(db)
    for (const m of migrations) await m.up({ db, payload: {}, req: {} } as unknown as MigrateUpArgs)

    process.env.DATABASE_URI = url
    process.env.PAYLOAD_SECRET = 'miembros-test-secret'
    for (const v of [
      'TRANSCRIPTION_JANITOR_ENABLED',
      'PUBLISH_JANITOR_ENABLED',
      'EMBEDDING_JANITOR_ENABLED',
      'INGEST_RECOVERY_JANITOR_ENABLED',
    ]) {
      process.env[v] = 'false'
    }
    const { getPayload } = await import('payload')
    const { default: config } = await import('@payload-config')
    payload = await getPayload({ config })
  }, 90_000)

  beforeEach(async () => {
    await db.execute(sql.raw(`
      TRUNCATE memberships, organizations, users RESTART IDENTITY CASCADE;
      INSERT INTO users (id, email, display_name, is_platform_admin) VALUES
        (1, 'root@example.invalid', 'Root', true),
        (2, 'olga@example.invalid', 'Olga', false),
        (3, 'adan@example.invalid', 'Adán', false),
        (4, 'memo@example.invalid', 'Memo', false),
        (5, 'bea@example.invalid', 'Bea', false);
      SELECT setval('users_id_seq', 5);
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Eco A', 'eco-a'), (2, 'Eco Secreto', 'eco-secreto');
      SELECT setval('organizations_id_seq', 2);
      INSERT INTO memberships (id, user_id, organization_id, role) VALUES
        (1, 2, 1, 'owner'), (2, 3, 1, 'admin'), (3, 4, 1, 'member'), (4, 5, 2, 'owner');
      SELECT setval('memberships_id_seq', 4);
    `))
  })

  afterAll(async () => {
    const pool = (payload?.db as unknown as {
      pool?: { on(e: 'error', f: () => void): void; _clients?: Array<{ on(e: 'error', f: () => void): void }> }
    })?.pool
    pool?.on('error', () => {})
    for (const client of pool?._clients ?? []) client.on('error', () => {})
    await (db as unknown as { $client?: { end(): Promise<void> } })?.$client?.end()
    stopContainer()
  })

  it('the responsable lists their members — email, name and role, nothing more', async () => {
    const res = await call('get', OLGA, { query: { organization: String(ECO_A) } })
    expect(res.status).toBe(200)
    expect(res.body.myRole).toBe('owner')
    const members = res.body.members as Array<Record<string, unknown>>
    expect(members.map((m) => m.email).sort()).toEqual([
      'adan@example.invalid',
      'memo@example.invalid',
      'olga@example.invalid',
    ])
    for (const m of members) expect(Object.keys(m).sort()).toEqual(['email', 'id', 'name', 'role'])
  }, 30_000)

  it('🔴 a member, and a responsable of another ecosistema, get the same 403', async () => {
    for (const as of [MEMO, BEA]) {
      expect((await call('get', as, { query: { organization: String(ECO_A) } })).status).toBe(403)
      const add = await call('post', as, {
        body: { organization: ECO_A, email: 'x@example.invalid', name: 'X', role: 'member' },
      })
      expect(add.status).toBe(403)
    }
    expect((await call('get', OLGA, { query: { organization: '999' } })).status).toBe(403)
    const users = await payload.find({ collection: 'users', where: { email: { equals: 'x@example.invalid' } }, overrideAccess: true })
    expect(users.totalDocs).toBe(0)
  }, 30_000)

  it('a new email creates the person with a one-time password that works', async () => {
    const res = await call('post', OLGA, {
      body: { organization: ECO_A, email: ' Nueva@Example.invalid ', name: 'Nueva', role: 'investigador' },
    })
    expect(res.status).toBe(201)
    const password = res.body.temporaryPassword as string
    expect(password.length).toBeGreaterThanOrEqual(12)
    expect(res.body.member).toMatchObject({ email: 'nueva@example.invalid', name: 'Nueva', role: 'investigador' })

    const login = await payload.login({ collection: 'users', data: { email: 'nueva@example.invalid', password } })
    expect(login.token).toBeTruthy()
  }, 30_000)

  it('🔴 an existing email gets a membership and reveals nothing about their other ecosistemas', async () => {
    const res = await call('post', OLGA, {
      body: { organization: ECO_A, email: 'bea@example.invalid', name: 'Otro nombre', role: 'member' },
    })
    expect(res.status).toBe(201)
    const said = JSON.stringify(res.body)
    expect(said).not.toContain('Secreto')
    expect(said).not.toContain('secreto')
    expect(said).not.toContain('owner')
    expect(await roleOf(BEA, ECO_A)).toEqual(['member'])
    // Her account is untouched: the responsable does not rename other people.
    const bea = await payload.findByID({ collection: 'users', id: BEA, overrideAccess: true })
    expect(bea.displayName).toBe('Bea')

    const again = await call('post', OLGA, {
      body: { organization: ECO_A, email: 'bea@example.invalid', name: 'Bea', role: 'member' },
    })
    expect(again.status).toBe(409)
  }, 30_000)

  // ── Item 1: adding by email is not an "does this account exist?" oracle ──
  const shape = (body: Record<string, unknown>) => ({
    keys: Object.keys(body).sort(),
    memberKeys: Object.keys((body.member ?? {}) as object).sort(),
    passwordType: typeof body.temporaryPassword,
    passwordLength: String(body.temporaryPassword ?? '').length,
  })

  it('🔴 a known and an unknown email get the same answer', async () => {
    const known = await call('post', OLGA, {
      body: { organization: ECO_A, email: 'bea@example.invalid', name: 'Tecleado A', role: 'member' },
    })
    const unknown = await call('post', OLGA, {
      body: { organization: ECO_A, email: 'nadie@example.invalid', name: 'Tecleado B', role: 'member' },
    })
    expect(known.status).toBe(unknown.status)
    expect(shape(known.body)).toEqual(shape(unknown.body))
    // The name shown is the one the responsable typed — never the account's own.
    expect((known.body.member as { name?: unknown }).name).toBe('Tecleado A')
    expect((unknown.body.member as { name?: unknown }).name).toBe('Tecleado B')
    // The decoy password opens nothing: an existing account keeps its own.
    await expect(
      payload.login({
        collection: 'users',
        data: { email: 'bea@example.invalid', password: known.body.temporaryPassword as string },
      }),
    ).rejects.toBeTruthy()
    const raw = (await db.execute(sql.raw(`SELECT hash, salt FROM users WHERE id = ${BEA}`))) as unknown as {
      rows: Array<{ hash: string | null; salt: string | null }>
    }
    expect(raw.rows[0]).toEqual({ hash: null, salt: null })
  }, 30_000)

  it('🔴 a missing name is refused for a known email too, not only an unknown one', async () => {
    const base = { organization: ECO_A, name: '  ', role: 'member' }
    const known = await call('post', OLGA, { body: { ...base, email: 'bea@example.invalid' } })
    const unknown = await call('post', OLGA, { body: { ...base, email: 'nadie@example.invalid' } })
    expect(known.status).toBe(400)
    expect(known.body).toEqual(unknown.body)
    expect(await roleOf(BEA, ECO_A)).toEqual([])
  }, 30_000)

  it('🔴 a known and an unknown email take the same time class (both hash a password)', async () => {
    const time = async (email: string, name: string) => {
      const t0 = performance.now()
      const res = await call('post', OLGA, { body: { organization: ECO_A, email, name, role: 'member' } })
      expect(res.status).toBe(201)
      return performance.now() - t0
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
    const knownMs: number[] = []
    const unknownMs: number[] = []
    for (let i = 0; i < 5; i++) {
      unknownMs.push(await time(`nuevo${i}@example.invalid`, `N${i}`))
      knownMs.push(await time('bea@example.invalid', 'Bea'))
      await db.execute(sql.raw(`DELETE FROM memberships WHERE user_id = ${BEA} AND organization_id = ${ECO_A}`))
    }
    // Without the matching hash the known path is several times faster
    // (one pbkdf2 of 25 000 rounds is most of the unknown path's cost).
    expect(median(knownMs) / median(unknownMs)).toBeGreaterThan(0.5)
  }, 60_000)

  // ── Item 2: nobody leaves an ecosistema without a responsable ─────────────
  it('🔴 the only owner cannot remove themselves', async () => {
    const res = await call('delete', OLGA, { id: 1 })
    expect(res.status).toBe(409)
    expect(await roleOf(OLGA, ECO_A)).toEqual(['owner'])
    // Nor deactivate or demote their row over the plain collection API.
    const olga = await payload.findByID({ collection: 'users', id: OLGA, overrideAccess: true })
    await expect(
      payload.update({ collection: 'memberships', id: 1, data: { isActive: false } as never, overrideAccess: false, user: olga }),
    ).rejects.toBeTruthy()
    await expect(
      payload.delete({ collection: 'memberships', id: 1, overrideAccess: false, user: olga }),
    ).rejects.toBeTruthy()
    const row = (await db.execute(sql.raw(`SELECT is_active FROM memberships WHERE id = 1`))) as unknown as {
      rows: Array<{ is_active: boolean }>
    }
    expect(row.rows[0]?.is_active).toBe(true)
  }, 30_000)

  it('an owner with a co-owner, and an admin under an owner, may leave', async () => {
    expect((await call('delete', ADAN, { id: 2 })).status).toBe(200)
    expect(await roleOf(ADAN, ECO_A)).toEqual([])

    await db.execute(sql.raw(`UPDATE memberships SET role = 'owner' WHERE id = 3`))
    expect((await call('delete', OLGA, { id: 1 })).status).toBe(200)
    expect(await roleOf(OLGA, ECO_A)).toEqual([])
    // Now memo is the last owner, and the same rule holds for him.
    expect((await call('delete', MEMO, { id: 3 })).status).toBe(409)
  }, 30_000)

  it('🔴 the last person who manages members cannot leave an ecosistema with no owner', async () => {
    await db.execute(sql.raw(`DELETE FROM memberships WHERE id = 1`))
    expect((await call('delete', ADAN, { id: 2 })).status).toBe(409)
    expect(await roleOf(ADAN, ECO_A)).toEqual(['admin'])
  }, 30_000)

  // ── Audit follow-up 1: the rule holds under bulk writes and concurrency ──
  const activeOwners = async (orgId: number) =>
    ((await db.execute(
      sql.raw(`SELECT count(*)::int AS n FROM memberships WHERE organization_id = ${orgId} AND role = 'owner' AND is_active = true`),
    )) as unknown as { rows: Array<{ n: number }> }).rows[0]!.n
  const asUser = (id: number) => payload.findByID({ collection: 'users', id, overrideAccess: true })

  it('🔴 a bulk delete cannot take out the last owner', async () => {
    const olga = await asUser(OLGA)
    await payload
      .delete({ collection: 'memberships', where: { organization: { equals: ECO_A } }, overrideAccess: false, user: olga })
      .catch(() => undefined)
    expect(await activeOwners(ECO_A)).toBe(1)
  }, 30_000)

  it('🔴 a bulk deactivation of both owners leaves one owner', async () => {
    await db.execute(sql.raw(`UPDATE memberships SET role = 'owner' WHERE id = 3`))
    const olga = await asUser(OLGA)
    await payload
      .update({
        collection: 'memberships',
        where: { id: { in: [1, 3] } },
        data: { isActive: false } as never,
        overrideAccess: false,
        user: olga,
      })
      .catch(() => undefined)
    expect(await activeOwners(ECO_A)).toBeGreaterThanOrEqual(1)
    await payload
      .delete({ collection: 'memberships', where: { id: { in: [1, 3] } }, overrideAccess: false, user: olga })
      .catch(() => undefined)
    expect(await activeOwners(ECO_A)).toBeGreaterThanOrEqual(1)
  }, 30_000)

  it('🔴 two owners leaving at the same moment: one goes, one stays', async () => {
    await db.execute(sql.raw(`UPDATE memberships SET role = 'owner' WHERE id = 3`))
    const results = await Promise.all([call('delete', OLGA, { id: 1 }), call('delete', MEMO, { id: 3 })])
    expect(results.map((r) => r.status).sort()).toEqual([200, 409])
    expect(await activeOwners(ECO_A)).toBe(1)
  }, 30_000)

  // ── Audit follow-up 2: moving a row to another ecosistema is leaving ─────
  it('🔴 moving the only manager row out of an ecosistema is refused', async () => {
    // Eco C has one manager, Adán (admin); Adán also owns B.
    await db.execute(sql.raw(`
      INSERT INTO organizations (id, name, slug) VALUES (3, 'Eco C', 'eco-c');
      INSERT INTO memberships (id, user_id, organization_id, role) VALUES (5, 3, 3, 'admin'), (6, 3, 2, 'owner');
    `))
    const adan = await asUser(ADAN)
    await expect(
      payload.update({ collection: 'memberships', id: 5, data: { organization: ECO_B } as never, overrideAccess: false, user: adan }),
    ).rejects.toBeTruthy()
    expect(await roleOf(ADAN, 3)).toEqual(['admin'])

    // That write also trips the uniqueness hook (Adán is already in B), so pin
    // the last-responsable hook on its own, in a real transaction.
    const { createLocalReq, initTransaction, killTransaction } = await import('payload')
    const { refuseLeavingWithoutResponsable, LAST_RESPONSABLE_MESSAGE } = await import('../collections/Memberships')
    const req = (await createLocalReq({ user: { ...adan, collection: 'users' } as never }, payload)) as PayloadRequest
    await initTransaction(req)
    const originalDoc = await payload.findByID({ collection: 'memberships', id: 5, depth: 0, overrideAccess: true, req })
    await expect(
      Promise.resolve(
        refuseLeavingWithoutResponsable({
          data: { organization: ECO_B },
          operation: 'update',
          originalDoc,
          req,
        } as never),
      ),
    ).rejects.toThrow(LAST_RESPONSABLE_MESSAGE)
    await killTransaction(req)
  }, 30_000)

  it('🔴 an admin cannot move an owner out of the source ecosistema', async () => {
    // Adán: admin in A, owner in B. Olga's row is the owner of A.
    await db.execute(sql.raw(`INSERT INTO memberships (id, user_id, organization_id, role) VALUES (5, 3, 2, 'owner')`))
    // Memo co-owns A, so only the role ceiling (not the last-owner rule) can refuse.
    await db.execute(sql.raw(`UPDATE memberships SET role = 'owner' WHERE id = 3`))
    const adan = await asUser(ADAN)
    await expect(
      payload.update({ collection: 'memberships', id: 1, data: { organization: ECO_B } as never, overrideAccess: false, user: adan }),
    ).rejects.toBeTruthy()
    expect(await roleOf(OLGA, ECO_A)).toEqual(['owner'])
    expect(await roleOf(OLGA, ECO_B)).toEqual([])
  }, 30_000)

  // ── Audit follow-up 3: account ids are for managers only ─────────────────
  it('🔴 a plain member reads memberships without other people\'s account ids', async () => {
    const memo = await asUser(MEMO)
    const mine = await payload.find({ collection: 'memberships', overrideAccess: false, user: memo, depth: 0 })
    expect(mine.docs.length).toBe(3)
    for (const m of mine.docs) {
      if (m.id === 3) expect(String(m.user)).toBe(String(MEMO))
      else expect(m.user).toBeUndefined()
    }
    // The web's own query (memberships where user = me) still works.
    const own = await payload.find({
      collection: 'memberships',
      where: { user: { equals: MEMO } },
      overrideAccess: false,
      user: memo,
      depth: 1,
    })
    expect(own.docs.map((m) => m.id)).toEqual([3])

    const olga = await asUser(OLGA)
    const managed = await payload.find({ collection: 'memberships', overrideAccess: false, user: olga, depth: 0 })
    for (const m of managed.docs) expect(m.user).toBeDefined()
  }, 30_000)

  // ── Audit follow-up 4: a NULL isActive is inactive ─────────────────────────
  it('🔴 a membership with isActive NULL is revoked: adding re-activates it, no 409', async () => {
    await db.execute(sql.raw(`INSERT INTO memberships (id, user_id, organization_id, role, is_active) VALUES (5, 5, 1, 'member', NULL)`))
    const res = await call('post', OLGA, {
      body: { organization: ECO_A, email: 'bea@example.invalid', name: 'Bea', role: 'member' },
    })
    expect(res.status).toBe(201)
    const row = (await db.execute(sql.raw(`SELECT is_active FROM memberships WHERE id = 5`))) as unknown as {
      rows: Array<{ is_active: boolean | null }>
    }
    expect(row.rows[0]?.is_active).toBe(true)
  }, 30_000)

  // ── Item 3: adding someone from another ecosistema shows staff nothing new ─
  it('🔴 after adding a person from another ecosistema, staff see only this ecosistema', async () => {
    expect(
      (await call('post', OLGA, {
        body: { organization: ECO_A, email: 'bea@example.invalid', name: 'Visitante', role: 'member' },
      })).status,
    ).toBe(201)
    const olga = await payload.findByID({ collection: 'users', id: OLGA, overrideAccess: true })

    const rows = await payload.find({ collection: 'memberships', overrideAccess: false, user: olga, depth: 2, limit: 100 })
    const seen = JSON.stringify(rows.docs)
    expect(seen).not.toContain('Secreto')
    for (const m of rows.docs) expect(String((m.organization as { id?: unknown })?.id ?? m.organization)).toBe(String(ECO_A))

    const orgs = await payload.find({ collection: 'organizations', overrideAccess: false, user: olga })
    expect(orgs.docs.map((o) => o.id)).toEqual([ECO_A])
    const users = await payload.find({ collection: 'users', where: { id: { equals: BEA } }, overrideAccess: false, user: olga })
    expect(users.totalDocs).toBe(0)

    const list = await call('get', OLGA, { query: { organization: String(ECO_A) } })
    const bea = (list.body.members as Array<Record<string, unknown>>).find((m) => m.email === 'bea@example.invalid')
    expect(bea).toEqual({ id: expect.any(String), email: 'bea@example.invalid', name: 'Visitante', role: 'member' })
    expect(await roleOf(BEA, ECO_B)).toEqual(['owner'])
  }, 30_000)

  it('🔴 an admin cannot grant, change or remove a role above their own', async () => {
    const add = await call('post', ADAN, {
      body: { organization: ECO_A, email: 'z@example.invalid', name: 'Z', role: 'owner' },
    })
    expect(add.status).toBe(400)
    // No orphan account is left behind by the refused grant.
    const z = await payload.find({ collection: 'users', where: { email: { equals: 'z@example.invalid' } }, overrideAccess: true })
    expect(z.totalDocs).toBe(0)

    expect((await call('patch', ADAN, { id: 3, body: { role: 'owner' } })).status).toBe(400)
    expect((await call('patch', ADAN, { id: 1, body: { role: 'member' } })).status).toBe(400)
    expect((await call('delete', ADAN, { id: 1 })).status).toBe(403)
    expect(await roleOf(MEMO, ECO_A)).toEqual(['member'])
    expect(await roleOf(OLGA, ECO_A)).toEqual(['owner'])

    // Within reach still works.
    expect((await call('patch', ADAN, { id: 3, body: { role: 'investigador' } })).status).toBe(400)
    expect((await call('patch', ADAN, { id: 3, body: { role: 'estudiante' } })).status).toBe(200)
    expect(await roleOf(MEMO, ECO_A)).toEqual(['estudiante'])
    expect((await call('patch', ADAN, { id: 3, body: { role: 'member' } })).status).toBe(200)
  }, 30_000)

  it('🔴 the same ceiling holds on the plain collection API (the old finding)', async () => {
    const adan = await payload.findByID({ collection: 'users', id: ADAN, overrideAccess: true })
    await expect(
      payload.create({
        collection: 'memberships',
        data: { user: BEA, organization: ECO_A, role: 'owner' } as never,
        overrideAccess: false,
        user: adan,
      }),
    ).rejects.toBeTruthy()
    await expect(
      payload.update({ collection: 'memberships', id: 3, data: { role: 'owner' } as never, overrideAccess: false, user: adan }),
    ).rejects.toBeTruthy()
    await expect(
      payload.delete({ collection: 'memberships', id: 1, overrideAccess: false, user: adan }),
    ).rejects.toBeTruthy()
    expect(await roleOf(BEA, ECO_A)).toEqual([])
    expect(await roleOf(MEMO, ECO_A)).toEqual(['member'])
    expect(await roleOf(OLGA, ECO_A)).toEqual(['owner'])
  }, 30_000)

  it('the responsable changes a role and removes a member', async () => {
    const changed = await call('patch', OLGA, { id: 3, body: { role: 'owner' } })
    expect(changed.status).toBe(200)
    expect(changed.body.member).toMatchObject({ email: 'memo@example.invalid', role: 'owner' })
    expect((await call('delete', OLGA, { id: 2 })).status).toBe(200)
    expect(await roleOf(ADAN, ECO_A)).toEqual([])
  }, 30_000)

  it('🔴 a membership in another ecosistema is not found, and stays as it was', async () => {
    expect((await call('patch', OLGA, { id: 4, body: { role: 'member' } })).status).toBe(404)
    expect((await call('delete', OLGA, { id: 4 })).status).toBe(404)
    expect((await call('patch', OLGA, { id: 999, body: { role: 'member' } })).status).toBe(404)
    expect(await roleOf(BEA, ECO_B)).toEqual(['owner'])
  }, 30_000)

  it('a platform admin manages any ecosistema', async () => {
    const res = await call('post', ROOT, {
      body: { organization: ECO_B, email: 'memo@example.invalid', name: 'Memo', role: 'owner' },
    })
    expect(res.status).toBe(201)
    expect(await roleOf(MEMO, ECO_B)).toEqual(['owner'])
  }, 30_000)

  it('refuses a bad email, a missing name for a new person, and an unknown role', async () => {
    const base = { organization: ECO_A, email: 'n@example.invalid', name: 'N', role: 'member' }
    expect((await call('post', OLGA, { body: { ...base, email: 'no-arroba' } })).status).toBe(400)
    expect((await call('post', OLGA, { body: { ...base, name: '  ' } })).status).toBe(400)
    expect((await call('post', OLGA, { body: { ...base, role: 'superadmin' } })).status).toBe(400)
  }, 30_000)
})
