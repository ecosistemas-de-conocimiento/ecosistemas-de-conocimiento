/**
 * 🔴 A STALE WRITE DOES NOT SWITCH A DEACTIVATED ACCOUNT BACK ON — AGAINST A
 * REAL POSTGRES.
 *
 * Audit 2026-11-10: a login racing a deactivation wrote the row it had read
 * before the password check back over the deactivation (`isActive: true`), and
 * signed in. A self-PATCH that read the row first did the same. Each race is
 * forced here at the exact point it happens, so neither depends on timing.
 *
 * Harness: `lib/testing/realPostgres`, Payload's REST router (`handleEndpoints`).
 */

import { sql } from '@payloadcms/db-postgres'
import type { CollectionBeforeChangeHook, CollectionBeforeLoginHook, Payload, SanitizedConfig } from 'payload'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/aiClient', () => {
  const anything: unknown = new Proxy(() => {}, {
    get: (_t, key) => (key === 'then' ? undefined : anything),
    apply: async () => ({ ok: true }),
  })
  return { getAdminAIClient: () => anything, getAppAIClient: () => anything }
})

import { bootPayload, dockerOk, rowsOf, shutdown, startRealPostgres, type RealPostgres } from '@/lib/testing/realPostgres'

const PASSWORD = 'login-race-pw'
let pg: RealPostgres
let payload: Payload
let config: SanitizedConfig

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

const login = async (email: string) => {
  const res = await rest('POST', '/api/users/login', undefined, { email, password: PASSWORD })
  const body = (await res.json().catch(() => ({}))) as { token?: string }
  return { status: res.status, token: body.token }
}

/** What an admin's "Desactivar" does, in its own transaction. */
const deactivate = () =>
  payload.update({ collection: 'users', id: 1, overrideAccess: true, data: { isActive: false } as never })

const row = async () =>
  (await rowsOf(pg.db, sql`SELECT is_active, (SELECT count(*)::int FROM users_sessions WHERE _parent_id = 1) AS sessions FROM users WHERE id = 1`))[0]

describe.skipIf(!dockerOk)('a stale write racing a deactivation', () => {
  let hooks: { beforeLogin: CollectionBeforeLoginHook[]; beforeChange: CollectionBeforeChangeHook[] }
  let saved: { beforeLogin: CollectionBeforeLoginHook[]; beforeChange: CollectionBeforeChangeHook[] }

  beforeAll(async () => {
    pg = await startRealPostgres(`edc-login-race-${process.pid}`, 'login_race')
    payload = await bootPayload(pg.url, 'login-race-secret')
    config = await (await import('@payload-config')).default
    hooks = payload.collections.users.config.hooks as never
    saved = { beforeLogin: [...hooks.beforeLogin], beforeChange: [...hooks.beforeChange] }
  }, 120_000)

  beforeEach(async () => {
    await pg.db.execute(sql.raw(`
      TRUNCATE users RESTART IDENTITY CASCADE;
      INSERT INTO users (id, email, is_platform_admin) VALUES (1, 'member@example.invalid', false);
    `))
    await payload.update({ collection: 'users', id: 1, overrideAccess: true, data: { password: PASSWORD } as never })
  }, 60_000)

  afterEach(() => {
    vi.restoreAllMocks()
    hooks.beforeLogin.splice(0, hooks.beforeLogin.length, ...saved.beforeLogin)
    hooks.beforeChange.splice(0, hooks.beforeChange.length, ...saved.beforeChange)
  })

  afterAll(async () => {
    await shutdown(pg, payload)
  })

  it('a deactivation that commits between the login read and its session write: refused, stays off', async () => {
    const original = payload.db.updateOne.bind(payload.db)
    let armed = true
    vi.spyOn(payload.db, 'updateOne').mockImplementation(async (args) => {
      // `addSessionToUser`: the whole row read before the password check.
      if (armed && args.collection === 'users' && Array.isArray((args.data as { sessions?: unknown }).sessions)) {
        armed = false
        await deactivate()
      }
      return original(args)
    })
    const res = await login('member@example.invalid')
    expect(armed).toBe(false)
    expect(res.status).toBe(401)
    expect(res.token).toBeUndefined()
    expect(await row()).toEqual({ is_active: false, sessions: 0 })
  })

  it('a deactivation that comes after the session write waits for the login, then lands: off, no session', async () => {
    let pending: Promise<unknown> | undefined
    hooks.beforeLogin.unshift(async ({ user }) => {
      // The login holds the row lock here; the deactivation queues on it.
      pending = deactivate()
      await new Promise((r) => setTimeout(r, 300))
      return user
    })
    const res = await login('member@example.invalid')
    expect(res.status).toBe(200)
    await pending
    expect(await row()).toEqual({ is_active: false, sessions: 0 })
    expect((await (await rest('GET', '/api/users/me', res.token)).json()).user).toBeNull()
  })

  it('a self-PATCH that read the row before a deactivation committed does not switch it back on', async () => {
    const { token } = await login('member@example.invalid')
    let armed = true
    hooks.beforeChange.unshift(async ({ data, req }) => {
      // `originalDoc` is already read; the deactivation commits before the write.
      if (armed && req.user?.id === 1) {
        armed = false
        await deactivate()
      }
      return data
    })
    const res = await rest('PATCH', '/api/users/1', token, { displayName: 'Ana' })
    expect(armed).toBe(false)
    expect(res.status).toBe(200)
    expect(await row()).toEqual({ is_active: false, sessions: 0 })
  })

  it('control: an ordinary self-PATCH keeps the account on and the session', async () => {
    const { token } = await login('member@example.invalid')
    expect((await rest('PATCH', '/api/users/1', token, { displayName: 'Ana', isActive: false })).status).toBe(200)
    expect(await row()).toEqual({ is_active: true, sessions: 1 })
  })
})
