/**
 * 🔴 ONE IP CANNOT KEEP SOMEONE ELSE'S ACCOUNT LOCKED — THROUGH PAYLOAD'S REAL
 * `POST /api/users/login` (audit 2026-11-10, A-11).
 *
 * The hooks are spliced into the loaded config's `users` collection here,
 * exactly as `Users.ts` spreads `loginRateLimitHooks`, so this suite proves the
 * wiring (Payload calls `beforeOperation` with `operation: 'login'`, carries
 * `req.context` to `afterError`, and answers our `APIError` with its 429)
 * before that line lands.
 *
 * Harness: same as `authGuards.pg.test.ts` — throwaway `postgres:16-alpine` on
 * tmpfs, every migration, ai-service stubbed.
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
import { loginRateLimitHooks } from './loginRateLimit'
import { resetRateLimits, useDefaultRateLimitStore } from './rateLimit'

const CONTAINER = `edc-login-ratelimit-pg-${process.pid}`
const IMAGE = 'postgres:16-alpine'
const PASSWORD = 'login-ratelimit-test-pw'

function hasDocker(): boolean {
  return spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0
}

const dockerOk = hasDocker()
if (!dockerOk) {
  console.warn('[loginRateLimit.pg.test] docker is not usable — the real-Postgres tests SKIP.')
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
      '-e', 'POSTGRES_DB=login_ratelimit_test', IMAGE,
    ],
    { encoding: 'utf8' },
  )
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`)
  const port = spawnSync('docker', ['port', CONTAINER, '5432/tcp'], { encoding: 'utf8' })
    .stdout.split('\n')[0]?.trim().split(':').pop()
  if (!port) throw new Error('could not read the container port')
  return `postgres://postgres:postgres@127.0.0.1:${port}/login_ratelimit_test`
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

const VICTIM = 'victim@example.invalid'
const COLLEAGUE = 'colleague@example.invalid'
const ATTACKER_IP = '203.0.113.7'
const VICTIM_IP = '198.51.100.20'

async function login(xff: string, password: string, email = VICTIM): Promise<Response> {
  const { handleEndpoints } = await import('payload')
  return handleEndpoints({
    config,
    request: new Request('http://localhost/api/users/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': xff },
      body: JSON.stringify({ email, password }),
    }),
  })
}

const run = (statement: string) => db.execute(sql.raw(statement))

const loginAttempts = async (email = VICTIM): Promise<number> =>
  Number(
    ((await run(`SELECT login_attempts AS n FROM users WHERE email = '${email}'`)) as unknown as {
      rows: Array<{ n: number }>
    }).rows[0]?.n ?? 0,
  )

const statuses = (responses: Response[]) => {
  const out: Record<number, number> = {}
  for (const r of responses) out[r.status] = (out[r.status] ?? 0) + 1
  return out
}

describe.skipIf(!dockerOk)('login rate limits, on a real Postgres', () => {
  beforeAll(async () => {
    const url = await startPostgres()
    db = drizzle(url)
    await waitForQueries(db)
    for (const m of migrations) await m.up({ db, payload: {}, req: {} } as unknown as MigrateUpArgs)

    process.env.DATABASE_URI = url
    process.env.PAYLOAD_SECRET = 'login-ratelimit-test-secret'
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
    const users = config.collections.find((c) => c.slug === 'users')
    if (!users) throw new Error('no users collection')
    // Idempotent once `Users.ts` spreads the hooks itself.
    for (const [name, list] of Object.entries(loginRateLimitHooks)) {
      const hooks = users.hooks as unknown as Record<string, unknown[]>
      hooks[name] = [...(hooks[name] ?? []).filter((h) => !list.includes(h as never)), ...list]
    }
    payload = await getPayload({ config })
  }, 90_000)

  beforeEach(async () => {
    useDefaultRateLimitStore()
    resetRateLimits()
    // The shipped defaults: 4 per (IP, email) per 10 minutes, 100 per IP an hour.
    delete process.env.IDENTITY_RATELIMIT_LOGIN_FAIL_IP_EMAIL_MAX
    delete process.env.IDENTITY_RATELIMIT_LOGIN_FAIL_IP_MAX
    await run(`
      TRUNCATE memberships, organizations, users RESTART IDENTITY CASCADE;
      INSERT INTO users (id, email) VALUES (1, '${VICTIM}'), (2, '${COLLEAGUE}');
    `)
    await run(`SELECT setval(pg_get_serial_sequence('users', 'id'), 100)`)
    for (const id of [1, 2]) {
      await payload.update({ collection: 'users', id, overrideAccess: true, data: { password: PASSWORD } as never })
    }
  }, 30_000)

  afterAll(async () => {
    delete process.env.IDENTITY_RATELIMIT_LOGIN_FAIL_IP_MAX
    delete process.env.IDENTITY_RATELIMIT_LOGIN_FAIL_IP_EMAIL_MAX
    // ⚠ Payload's pool cannot be ended (see Sessions.ownerGuard.pg.test.ts).
    const pool = (payload?.db as unknown as {
      pool?: { on(e: 'error', f: () => void): void; _clients?: Array<{ on(e: 'error', f: () => void): void }> }
    })?.pool
    pool?.on('error', () => {})
    for (const client of pool?._clients ?? []) client.on('error', () => {})
    await (db as unknown as { $client?: { end(): Promise<void> } })?.$client?.end()
    stopContainer()
  })

  it('stops an IP before it can lock the account, and the owner still signs in', async () => {
    for (let i = 0; i < 4; i += 1) expect((await login(ATTACKER_IP, 'wrong')).status).toBe(401)
    expect(await loginAttempts()).toBe(4)

    const refused = await login(ATTACKER_IP, 'wrong')
    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('Retry-After'))).toBeGreaterThan(0)
    // Refused before the password check: Payload's counter did not move.
    expect(await loginAttempts()).toBe(4)

    expect((await login(VICTIM_IP, PASSWORD)).status).toBe(200)
  })

  it('a concurrent burst of 50 reaches the password check at most 4 times, and never locks', async () => {
    // The bug this guards: the guard only looked and the count came after the
    // check, so 200 concurrent wrong passwords all reached it (review repro).
    const burst = await Promise.all(Array.from({ length: 50 }, () => login(ATTACKER_IP, 'wrong')))
    // Every 401 is one password check; a 429 never reached it.
    expect(statuses(burst)).toEqual({ 401: 4, 429: 46 })
    expect(await loginAttempts()).toBe(4)
    expect(await loginAttempts()).toBeLessThan(5) // Payload's lock is at 5

    // Same IP, another account: a shared NAT is not shut out.
    expect((await login(ATTACKER_IP, PASSWORD, COLLEAGUE)).status).toBe(200)
    // And the owner, from elsewhere, is not locked out.
    expect((await login(VICTIM_IP, PASSWORD)).status).toBe(200)
  })

  it('the per-IP ceiling holds under a concurrent burst across many emails', async () => {
    process.env.IDENTITY_RATELIMIT_LOGIN_FAIL_IP_MAX = '10'
    const burst = await Promise.all(
      Array.from({ length: 30 }, (_, i) => login(ATTACKER_IP, 'wrong', `nobody${i}@example.invalid`)),
    )
    expect(statuses(burst)).toEqual({ 401: 10, 429: 20 })
  })

  it('a forged left X-Forwarded-For entry does not buy a fresh budget', async () => {
    for (let i = 0; i < 4; i += 1) await login(`10.0.0.${i}, ${ATTACKER_IP}`, 'wrong')
    expect((await login(`192.0.2.1, ${ATTACKER_IP}`, 'wrong')).status).toBe(429)
  })

  it('does not count successful sign-ins', async () => {
    for (let i = 0; i < 10; i += 1) expect((await login(VICTIM_IP, PASSWORD)).status).toBe(200)
    for (let i = 0; i < 4; i += 1) expect((await login(VICTIM_IP, 'wrong')).status).toBe(401)
  }, 30_000) // 14 sequential password hashes
})
