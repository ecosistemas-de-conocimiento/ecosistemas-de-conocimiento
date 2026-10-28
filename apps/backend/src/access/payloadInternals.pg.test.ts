/**
 * 🔴 PAYLOAD'S OWN LOCK AND PREFERENCE ROWS ARE NOT A SIDE DOOR.
 *
 * The finding (audit, measured, 2026-10-28): Payload 3.88 ships
 * `payload-locked-documents` with `Boolean(user)` on every operation. Any
 * signed-in member could list every lock (who is editing what, in every
 * ecosistema) and create, move or delete locks on rows in an ecosistema they do
 * not belong to. `payload-preferences` scopes read/delete to the owner but
 * leaves `update` at `Boolean(user)`, so a member could PATCH someone else's
 * row by id.
 *
 * Driven through Payload's real REST router (`handleEndpoints`, real JWT) and,
 * for the admin panel's own lock read, the local API exactly as
 * `@payloadcms/ui` `handleFormStateLocking` calls it.
 *
 * Harness: same as `refuseDuplicate.pg.test.ts` — throwaway
 * `postgres:16-alpine` on tmpfs, every migration, ai-service stubbed.
 *
 * ⚠ No docker → the suite SKIPS, with a console warning naming the reason.
 */

import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

import { sql } from '@payloadcms/db-postgres'
import { drizzle } from '@payloadcms/db-postgres/drizzle/node-postgres'
import type { MigrateUpArgs } from '@payloadcms/db-postgres'
import type { Payload, SanitizedConfig } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/aiClient', () => {
  const anything: unknown = new Proxy(() => {}, {
    get: (_t, key) => (key === 'then' ? undefined : anything),
    apply: async () => ({ ok: true }),
  })
  return { getAdminAIClient: () => anything, getAppAIClient: () => anything }
})

import { migrations } from '../migrations'

const CONTAINER = `edc-payload-internals-pg-${process.pid}`
const IMAGE = 'postgres:16-alpine'
const PASSWORD = 'payload-internals-test-pw'
const LOCKS = 'payload-locked-documents'
const PREFS = 'payload-preferences'

function hasDocker(): boolean {
  return spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0
}

const dockerOk = hasDocker()
if (!dockerOk) {
  console.warn('[payloadInternals.pg.test] docker is not usable — the real-Postgres tests SKIP.')
}

type Db = ReturnType<typeof drizzle>
let db: Db
let payload: Payload
let config: SanitizedConfig

function stopContainer(): void {
  spawnSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' })
}

async function startPostgres(): Promise<string> {
  stopContainer()
  const run = spawnSync(
    'docker',
    [
      'run', '-d', '--rm', '--tmpfs', '/var/lib/postgresql/data', '--name', CONTAINER, '-p', '0:5432',
      '-e', 'POSTGRES_USER=postgres', '-e', 'POSTGRES_PASSWORD=postgres',
      '-e', 'POSTGRES_DB=payload_internals_test', IMAGE,
    ],
    { encoding: 'utf8' },
  )
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`)
  const port = spawnSync('docker', ['port', CONTAINER, '5432/tcp'], { encoding: 'utf8' })
    .stdout.split('\n')[0]?.trim().split(':').pop()
  if (!port) throw new Error('could not read the container port')
  return `postgres://postgres:postgres@127.0.0.1:${port}/payload_internals_test`
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

const MEMBER = 1 // member of ecosistema 1
const OTHER = 2 // member of ecosistema 2 — the lock owner the member must not see
const ADMIN = 3 // platform admin
const INACTIVE = 4 // deactivated member of ecosistema 1

const count = async (table: string): Promise<number> =>
  Number(
    ((await db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table}`))) as unknown as {
      rows: Array<{ n: number }>
    }).rows[0]?.n,
  )

const asUser = async (id: number) =>
  ({ ...(await payload.findByID({ collection: 'users', id, overrideAccess: true })), collection: 'users' }) as never

async function tokenFor(id: number): Promise<string> {
  const user = (await payload.findByID({ collection: 'users', id, overrideAccess: true })) as { email: string }
  const { token } = await payload.login({ collection: 'users', data: { email: user.email, password: PASSWORD } })
  if (!token) throw new Error('login returned no token')
  return token
}

async function rest(method: string, path: string, token: string, body?: unknown): Promise<Response> {
  const { handleEndpoints } = await import('payload')
  return handleEndpoints({
    config,
    request: new Request(`http://localhost${path}`, {
      method,
      headers: { Authorization: `JWT ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  })
}

/** A lock row, written the way the admin panel writes it (`payload.db.create`). */
async function seedLock(owner: number, organization: number): Promise<number> {
  const lock = await payload.db.create({
    collection: LOCKS,
    data: { document: { relationTo: 'organizations', value: organization }, user: { relationTo: 'users', value: owner } },
  })
  return Number(lock.id)
}

async function seedPreference(owner: number, key: string): Promise<number> {
  const pref = await payload.db.create({
    collection: PREFS,
    data: { key, user: { relationTo: 'users', value: owner }, value: { owner } },
  })
  return Number(pref.id)
}

const lockOwner = async (id: number): Promise<number | undefined> =>
  ((await db.execute(sql.raw(`SELECT users_id FROM payload_locked_documents_rels WHERE parent_id = ${id} AND path = 'user'`))) as unknown as {
    rows: Array<{ users_id: number }>
  }).rows[0]?.users_id

describe.skipIf(!dockerOk)("Payload's lock and preference rows, on a real Postgres", () => {
  beforeAll(async () => {
    const url = await startPostgres()
    db = drizzle(url)
    await waitForQueries(db)
    for (const m of migrations) await m.up({ db, payload: {}, req: {} } as unknown as MigrateUpArgs)

    process.env.DATABASE_URI = url
    process.env.PAYLOAD_SECRET = 'payload-internals-test-secret'
    for (const v of [
      'TRANSCRIPTION_JANITOR_ENABLED',
      'PUBLISH_JANITOR_ENABLED',
      'EMBEDDING_JANITOR_ENABLED',
      'INGEST_RECOVERY_JANITOR_ENABLED',
    ]) {
      process.env[v] = 'false'
    }
    const { getPayload } = await import('payload')
    config = await (await import('@payload-config')).default
    payload = await getPayload({ config })
  }, 90_000)

  let adminLock: number
  let otherLock: number
  let memberLock: number
  let otherPref: number

  beforeEach(async () => {
    await db.execute(sql.raw(`
      TRUNCATE payload_locked_documents, payload_preferences, memberships, organizations, users RESTART IDENTITY CASCADE;
      INSERT INTO users (id, email) VALUES (1, 'member@example.invalid'), (2, 'other@example.invalid');
      INSERT INTO users (id, email, is_platform_admin) VALUES (3, 'admin@example.invalid', true);
      INSERT INTO users (id, email, is_active) VALUES (4, 'inactive@example.invalid', false);
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Uno', 'uno'), (2, 'Dos', 'dos');
      INSERT INTO memberships (user_id, organization_id, role) VALUES (1, 1, 'member'), (2, 2, 'member'), (4, 1, 'member');
    `))
    for (const id of [MEMBER, OTHER, ADMIN, INACTIVE]) {
      await payload.update({ collection: 'users', id, overrideAccess: true, data: { password: PASSWORD } as never })
    }
    adminLock = await seedLock(ADMIN, 1)
    otherLock = await seedLock(OTHER, 2)
    memberLock = await seedLock(MEMBER, 1)
    otherPref = await seedPreference(OTHER, 'nav')
  }, 30_000)

  afterAll(async () => {
    // ⚠ Payload's pool cannot be ended (see Sessions.ownerGuard.pg.test.ts).
    const pool = (payload?.db as unknown as {
      pool?: { on(e: 'error', f: () => void): void; _clients?: Array<{ on(e: 'error', f: () => void): void }> }
    })?.pool
    pool?.on('error', () => {})
    for (const client of pool?._clients ?? []) client.on('error', () => {})
    await (db as unknown as { $client?: { end(): Promise<void> } })?.$client?.end()
    stopContainer()
  })

  // ── locks ──────────────────────────────────────────────────────────────────

  it('a member lists only their own lock rows — not who else is editing what', async () => {
    const res = await rest('GET', `/api/${LOCKS}?depth=0&limit=100`, await tokenFor(MEMBER))
    expect(res.status).toBe(200)
    const ids = ((await res.json()) as { docs: Array<{ id: number }> }).docs.map((d) => d.id)
    expect(ids).toEqual([memberLock])
  }, 15_000)

  it("a member reading another person's lock by id gets 404", async () => {
    const token = await tokenFor(MEMBER)
    for (const id of [adminLock, otherLock]) {
      expect((await rest('GET', `/api/${LOCKS}/${id}`, token)).status).toBe(404)
    }
  }, 15_000)

  it('a member cannot create a lock — not on their own ecosistema, not on another', async () => {
    const token = await tokenFor(MEMBER)
    for (const organization of [1, 2]) {
      const res = await rest('POST', `/api/${LOCKS}`, token, {
        document: { relationTo: 'organizations', value: organization },
        user: { relationTo: 'users', value: MEMBER },
      })
      expect(res.status, `org ${organization}`).toBe(403)
    }
    expect(await count('payload_locked_documents')).toBe(3)
  }, 15_000)

  it("a member cannot take over or move anyone's lock, their own included", async () => {
    const token = await tokenFor(MEMBER)
    for (const id of [otherLock, adminLock, memberLock]) {
      const res = await rest('PATCH', `/api/${LOCKS}/${id}`, token, {
        user: { relationTo: 'users', value: MEMBER },
        document: { relationTo: 'organizations', value: 2 },
      })
      expect(res.status, `lock ${id}`).toBeGreaterThanOrEqual(400)
      expect(res.status).toBeLessThan(500)
    }
    expect(await lockOwner(otherLock)).toBe(OTHER)
    expect(await lockOwner(adminLock)).toBe(ADMIN)
  }, 15_000)

  it("a member cannot delete another person's lock, by id or in bulk", async () => {
    const token = await tokenFor(MEMBER)
    // Payload's delete-by-id answers 403 (not 404) when the row is outside the
    // WHERE — measured. Lock ids are not worth an existence oracle fight.
    expect([403, 404]).toContain((await rest('DELETE', `/api/${LOCKS}/${otherLock}`, token)).status)
    await rest('DELETE', `/api/${LOCKS}?where[id][exists]=true`, token)
    expect(await lockOwner(otherLock)).toBe(OTHER)
    expect(await lockOwner(adminLock)).toBe(ADMIN)
  }, 15_000)

  it('a member can still release their own lock (the panel does this on leaving a document)', async () => {
    const res = await rest('DELETE', `/api/${LOCKS}/${memberLock}`, await tokenFor(MEMBER))
    expect(res.status).toBe(200)
    expect(await count('payload_locked_documents')).toBe(2)
  }, 15_000)

  it("the panel's own lock read does not throw for a member (handleFormStateLocking calls it unguarded)", async () => {
    const found = await payload.find({
      collection: LOCKS,
      depth: 1,
      limit: 1,
      overrideAccess: false,
      pagination: false,
      user: await asUser(MEMBER),
      where: { and: [{ 'document.relationTo': { equals: 'organizations' } }, { 'document.value': { equals: 2 } }] },
    })
    expect(found.docs).toEqual([])
  }, 15_000)

  it('a deactivated account reads and writes no lock at all', async () => {
    await expect(
      payload.find({ collection: LOCKS, overrideAccess: false, user: await asUser(INACTIVE) }),
    ).rejects.toMatchObject({ status: 403 })
  }, 15_000)

  it('a platform admin keeps full control of locks — read all, create, take over, delete', async () => {
    const token = await tokenFor(ADMIN)
    const list = await rest('GET', `/api/${LOCKS}?depth=0&limit=100`, token)
    expect(((await list.json()) as { docs: unknown[] }).docs).toHaveLength(3)
    const created = await rest('POST', `/api/${LOCKS}`, token, {
      document: { relationTo: 'organizations', value: 2 },
      user: { relationTo: 'users', value: ADMIN },
    })
    expect(created.status).toBe(201)
    const patched = await rest('PATCH', `/api/${LOCKS}/${otherLock}`, token, { user: { relationTo: 'users', value: ADMIN } })
    expect(patched.status).toBe(200)
    expect(await lockOwner(otherLock)).toBe(ADMIN)
    expect((await rest('DELETE', `/api/${LOCKS}/${memberLock}`, token)).status).toBe(200)
  }, 20_000)

  // ── preferences ────────────────────────────────────────────────────────────

  it("a member cannot overwrite another person's preference row by id", async () => {
    const res = await rest('PATCH', `/api/${PREFS}/${otherPref}`, await tokenFor(MEMBER), { value: { hijacked: true } })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    const row = ((await db.execute(sql.raw(`SELECT value FROM payload_preferences WHERE id = ${otherPref}`))) as unknown as {
      rows: Array<{ value: unknown }>
    }).rows[0]
    expect(row?.value).toEqual({ owner: OTHER })
    expect(
      ((await db.execute(sql.raw(`SELECT users_id FROM payload_preferences_rels WHERE parent_id = ${otherPref}`))) as unknown as {
        rows: Array<{ users_id: number }>
      }).rows[0]?.users_id,
    ).toBe(OTHER)
  }, 15_000)

  it("a member cannot bulk-update other people's preferences", async () => {
    await rest('PATCH', `/api/${PREFS}?where[id][exists]=true`, await tokenFor(MEMBER), { value: { hijacked: true } })
    const row = ((await db.execute(sql.raw(`SELECT value FROM payload_preferences WHERE id = ${otherPref}`))) as unknown as {
      rows: Array<{ value: unknown }>
    }).rows[0]
    expect(row?.value).toEqual({ owner: OTHER })
  }, 15_000)

  it("the panel's own preference routes still work for a member (save, read back, update own)", async () => {
    const token = await tokenFor(MEMBER)
    expect((await rest('POST', `/api/${PREFS}/nav`, token, { value: { open: true } })).status).toBe(200)
    const got = await rest('GET', `/api/${PREFS}/nav`, token)
    expect(((await got.json()) as { value: unknown }).value).toEqual({ open: true })
    const own = ((await db.execute(sql.raw(
      `SELECT p.id FROM payload_preferences p JOIN payload_preferences_rels r ON r.parent_id = p.id WHERE r.users_id = ${MEMBER}`,
    ))) as unknown as { rows: Array<{ id: number }> }).rows[0]?.id
    expect((await rest('PATCH', `/api/${PREFS}/${own}`, token, { value: { open: false } })).status).toBe(200)
  }, 15_000)
})
