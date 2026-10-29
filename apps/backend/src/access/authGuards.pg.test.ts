/**
 * 🔴 REVOCATION REACHES CHAT, UNLOCK IS ADMIN-ONLY, AND TEAMS/PROJECTS STAY IN
 * THEIR ECOSISTEMA — AGAINST A REAL POSTGRES.
 *
 * Code audit 2026-10-28 (`plan/auditoria-codigo-2026-10-28.md`):
 *
 *   · item 4 (HIGH) — a deactivated user, a removed member or a switched-off
 *     ecosistema kept corpus access through conversations opened before the
 *     revoke, and kept writing turns into the shared corpus.
 *   · item 5 (HIGH) — any signed-in account could `POST /api/users/unlock` any
 *     other account; 200 vs 403 also told it which emails exist.
 *   · auth MEDIUM — an admin of ecosistema A could create teams and projects in
 *     B, or move its own there.
 *
 * Driven through the real Payload config: the local API with
 * `overrideAccess: false`, and Payload's REST router (`handleEndpoints`, real
 * JWT) for the wire-level checks.
 *
 * Harness: same as `payloadInternals.pg.test.ts` — throwaway
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

const CONTAINER = `edc-auth-guards-pg-${process.pid}`
const IMAGE = 'postgres:16-alpine'
const PASSWORD = 'auth-guards-test-pw'

function hasDocker(): boolean {
  return spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0
}

const dockerOk = hasDocker()
if (!dockerOk) {
  console.warn('[authGuards.pg.test] docker is not usable — the real-Postgres tests SKIP.')
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
      '-e', 'POSTGRES_DB=auth_guards_test', IMAGE,
    ],
    { encoding: 'utf8' },
  )
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`)
  const port = spawnSync('docker', ['port', CONTAINER, '5432/tcp'], { encoding: 'utf8' })
    .stdout.split('\n')[0]?.trim().split(':').pop()
  if (!port) throw new Error('could not read the container port')
  return `postgres://postgres:postgres@127.0.0.1:${port}/auth_guards_test`
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

const MEMBER = 1 // member of ecosistema 1, owns conversation 10
const ADMIN_A = 2 // admin of ecosistema 1 only
const PLATFORM = 3 // platform admin
const LOCKED = 4 // member of ecosistema 2, locked out of login
const SESSION = 10 // MEMBER's conversation in ecosistema 1

const asUser = async (id: number) =>
  ({ ...(await payload.findByID({ collection: 'users', id, overrideAccess: true })), collection: 'users' }) as never

async function tokenFor(id: number): Promise<string> {
  const user = (await payload.findByID({ collection: 'users', id, overrideAccess: true })) as unknown as { email: string }
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

const run = (statement: string) => db.execute(sql.raw(statement))

const count = async (table: string): Promise<number> =>
  Number(
    ((await run(`SELECT count(*)::int AS n FROM ${table}`)) as unknown as { rows: Array<{ n: number }> }).rows[0]?.n,
  )

const loginAttempts = async (id: number): Promise<number> =>
  Number(
    ((await run(`SELECT login_attempts AS n FROM users WHERE id = ${id}`)) as unknown as {
      rows: Array<{ n: number }>
    }).rows[0]?.n ?? 0,
  )

describe.skipIf(!dockerOk)('auth guards, on a real Postgres', () => {
  beforeAll(async () => {
    const url = await startPostgres()
    db = drizzle(url)
    await waitForQueries(db)
    for (const m of migrations) await m.up({ db, payload: {}, req: {} } as unknown as MigrateUpArgs)

    process.env.DATABASE_URI = url
    process.env.PAYLOAD_SECRET = 'auth-guards-test-secret'
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

  beforeEach(async () => {
    await run(`
      TRUNCATE messages, sessions, projects, teams, memberships, organizations, users RESTART IDENTITY CASCADE;
      INSERT INTO users (id, email) VALUES (1, 'member@example.invalid'), (2, 'admin-a@example.invalid');
      INSERT INTO users (id, email, is_platform_admin) VALUES (3, 'platform@example.invalid', true);
      INSERT INTO users (id, email) VALUES (4, 'locked@example.invalid');
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Uno', 'uno'), (2, 'Dos', 'dos');
      INSERT INTO memberships (id, user_id, organization_id, role)
        VALUES (1, 1, 1, 'member'), (2, 2, 1, 'admin'), (3, 4, 2, 'member');
      INSERT INTO sessions (id, user_id, organization_id) VALUES (10, 1, 1);
      INSERT INTO teams (id, name, slug, organization_id) VALUES (1, 'Equipo uno', 'e1', 1), (2, 'Equipo dos', 'e2', 2);
      INSERT INTO projects (id, name, slug, team_id) VALUES (1, 'Proyecto uno', 'p1', 1);
    `)
    // Explicit ids do not advance a serial; without this a create collides on
    // id 1 and fails for the wrong reason (a 400 that looks like a refusal).
    for (const table of ['users', 'organizations', 'memberships', 'sessions', 'teams', 'projects']) {
      await run(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), 100)`)
    }
    for (const id of [MEMBER, ADMIN_A, PLATFORM, LOCKED]) {
      await payload.update({ collection: 'users', id, overrideAccess: true, data: { password: PASSWORD } as never })
    }
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

  // ── item 4: revocation cuts chat ────────────────────────────────────────────

  const REVOKES: Array<[string, string]> = [
    ['the account is deactivated', `UPDATE users SET is_active = false WHERE id = ${MEMBER}`],
    ['the membership is switched off', `UPDATE memberships SET is_active = false WHERE id = 1`],
    ['the membership is removed', `DELETE FROM memberships WHERE id = 1`],
    ['the ecosistema is switched off', `UPDATE organizations SET is_active = false WHERE id = 1`],
  ]

  it('an active member still gets the corpora of their own conversation', async () => {
    const { corporaForSession } = await import('@/lib/corpus')
    const corpora = await corporaForSession(payload, SESSION, MEMBER)
    expect(corpora.all).toEqual(['eco-1', 'eco-1-draft-1'])
  }, 15_000)

  it.each(REVOKES)('🔴 corpora: refused once %s', async (_label, revoke) => {
    await run(revoke)
    const { corporaForSession, SessionNotOwnedError } = await import('@/lib/corpus')
    await expect(corporaForSession(payload, SESSION, MEMBER)).rejects.toBeInstanceOf(SessionNotOwnedError)
  }, 15_000)

  it.each(REVOKES)('🔴 GET /api/sessions/:id/corpora answers 404 once %s', async (_label, revoke) => {
    const token = await tokenFor(MEMBER) // minted BEFORE the revoke, as an open tab holds it
    await run(revoke)
    expect((await rest('GET', `/api/sessions/${SESSION}/corpora`, token)).status).toBe(404)
  }, 15_000)

  it.each(REVOKES)('🔴 no new turn is written once %s', async (_label, revoke) => {
    const user = await asUser(MEMBER)
    await run(revoke)
    await expect(
      payload.create({
        collection: 'messages',
        overrideAccess: false,
        user,
        data: { session: SESSION, role: 'user', content: 'after the revoke' } as never,
      }),
    ).rejects.toMatchObject({ status: expect.any(Number) })
    expect(await count('messages')).toBe(0)
  }, 15_000)

  it('an active member still writes turns into their conversation', async () => {
    await payload.create({
      collection: 'messages',
      overrideAccess: false,
      user: await asUser(MEMBER),
      data: { session: SESSION, role: 'user', content: 'hola' } as never,
    })
    expect(await count('messages')).toBe(1)
  }, 15_000)

  it('🔴 a deactivated account reads no conversations and no turns', async () => {
    await run(`UPDATE users SET is_active = false WHERE id = ${MEMBER}`)
    // Read AFTER the revoke: Payload's JWT strategy reloads the row per request.
    const user = await asUser(MEMBER)
    for (const collection of ['sessions', 'messages'] as const) {
      await expect(payload.find({ collection, overrideAccess: false, user })).rejects.toMatchObject({ status: 403 })
    }
  }, 15_000)

  // ── item 5: unlock is platform-admin only ──────────────────────────────────

  const lockOut = () => run(`UPDATE users SET login_attempts = 5, lock_until = now() + interval '1 hour' WHERE id = ${LOCKED}`)

  it('🔴 a member cannot unlock another account, and cannot tell real emails from fake ones', async () => {
    await lockOut()
    const token = await tokenFor(MEMBER)
    const real = await rest('POST', '/api/users/unlock', token, { email: 'locked@example.invalid' })
    const fake = await rest('POST', '/api/users/unlock', token, { email: 'nobody@example.invalid' })
    expect(real.status).toBe(403)
    expect(fake.status).toBe(real.status)
    expect(await loginAttempts(LOCKED)).toBe(5)
  }, 15_000)

  it('🔴 an ecosistema admin cannot unlock either', async () => {
    await lockOut()
    const res = await rest('POST', '/api/users/unlock', await tokenFor(ADMIN_A), { email: 'locked@example.invalid' })
    expect(res.status).toBe(403)
    expect(await loginAttempts(LOCKED)).toBe(5)
  }, 15_000)

  it('a platform admin can unlock', async () => {
    await lockOut()
    const res = await rest('POST', '/api/users/unlock', await tokenFor(PLATFORM), { email: 'locked@example.invalid' })
    expect(res.status).toBe(200)
    expect(await loginAttempts(LOCKED)).toBe(0)
  }, 15_000)

  // ── auth MEDIUM: teams and projects stay in their ecosistema ───────────────

  it('🔴 an admin of A cannot create a team in B', async () => {
    await expect(
      payload.create({
        collection: 'teams',
        overrideAccess: false,
        user: await asUser(ADMIN_A),
        data: { name: 'Intruso', slug: 'x', organization: 2 } as never,
      }),
    ).rejects.toMatchObject({ status: 400 })
    expect(await count('teams')).toBe(2)
  }, 15_000)

  it('🔴 an admin of A cannot move their team into B', async () => {
    await expect(
      payload.update({
        collection: 'teams',
        id: 1,
        overrideAccess: false,
        user: await asUser(ADMIN_A),
        data: { organization: 2 } as never,
      }),
    ).rejects.toMatchObject({ status: 400 })
    const row = ((await run(`SELECT organization_id AS o FROM teams WHERE id = 1`)) as unknown as {
      rows: Array<{ o: number }>
    }).rows[0]
    expect(Number(row?.o)).toBe(1)
  }, 15_000)

  it('an admin of A still creates and edits teams in A', async () => {
    const user = await asUser(ADMIN_A)
    await payload.create({ collection: 'teams', overrideAccess: false, user, data: { name: 'Nuevo', slug: 'n', organization: 1 } as never })
    await payload.update({ collection: 'teams', id: 1, overrideAccess: false, user, data: { name: 'Renombrado', organization: 1 } as never })
    expect(await count('teams')).toBe(3)
  }, 15_000)

  it('🔴 an admin of A cannot create a project under a team of B', async () => {
    await expect(
      payload.create({
        collection: 'projects',
        overrideAccess: false,
        user: await asUser(ADMIN_A),
        data: { name: 'Intruso', slug: 'x', team: 2 } as never,
      }),
    ).rejects.toMatchObject({ status: 400 })
    expect(await count('projects')).toBe(1)
  }, 15_000)

  it('🔴 an admin of A cannot move their project under a team of B', async () => {
    await expect(
      payload.update({
        collection: 'projects',
        id: 1,
        overrideAccess: false,
        user: await asUser(ADMIN_A),
        data: { team: 2 } as never,
      }),
    ).rejects.toMatchObject({ status: 400 })
    const row = ((await run(`SELECT team_id AS t FROM projects WHERE id = 1`)) as unknown as {
      rows: Array<{ t: number }>
    }).rows[0]
    expect(Number(row?.t)).toBe(1)
  }, 15_000)

  it('an admin of A still creates and edits projects in A; a platform admin writes anywhere', async () => {
    await payload.create({
      collection: 'projects',
      overrideAccess: false,
      user: await asUser(ADMIN_A),
      data: { name: 'Nuevo', slug: 'n', team: 1 } as never,
    })
    await payload.create({
      collection: 'projects',
      overrideAccess: false,
      user: await asUser(PLATFORM),
      data: { name: 'Plataforma', slug: 'pl', team: 2 } as never,
    })
    expect(await count('projects')).toBe(3)
  }, 15_000)
})

// ── the lock-down refuses to boot without the unlock rule ─────────────────────

describe('lockDownPayloadInternals and users.unlock', () => {
  it('🔴 throws when users.access.unlock is not the platform-admin rule', async () => {
    const { lockDownPayloadInternals } = await import('./payloadInternals')
    const collection = (slug: string, access: Record<string, unknown> = {}) => ({ slug, access })
    const fake = (unlock: unknown) =>
      ({
        collections: [
          collection('payload-locked-documents'),
          collection('payload-preferences'),
          collection('users', { unlock }),
        ],
      }) as unknown as SanitizedConfig
    expect(() => lockDownPayloadInternals(fake(() => true))).toThrow(/unlock/)
    const { isPlatformAdmin } = await import('./index')
    expect(() => lockDownPayloadInternals(fake(isPlatformAdmin))).not.toThrow()
  })
})
