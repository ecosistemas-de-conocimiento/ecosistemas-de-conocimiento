/**
 * 🔴 ONE ACCOUNT CANNOT INFLATE `sessions` — THROUGH PAYLOAD'S REAL
 * `POST /api/sessions`, AGAINST A REAL POSTGRES (audit 2026-11-10, D1).
 *
 * Nothing bounded how many conversations a member opened; 20 000 made every
 * filter through `session.*` read 20 000 ids. `reserveSessionCreate` in
 * `Sessions.ts` counts each create before it runs, refunds a failed one, and
 * answers 429 with `Retry-After` past `SESSION_RATELIMIT_CREATE_USER_MAX` an
 * hour. Every test below failed on a3c9df9f.
 *
 * Harness: `lib/testing/realPostgres`; driven through `handleEndpoints`, real JWT.
 */

import { sql } from '@payloadcms/db-postgres'
import type { Payload, SanitizedConfig } from 'payload'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/aiClient', () => {
  const anything: unknown = new Proxy(() => {}, {
    get: (_t, key) => (key === 'then' ? undefined : anything),
    apply: async () => ({ ok: true, ingestId: 'fake-ingest' }),
  })
  return { getAdminAIClient: () => anything, getAppAIClient: () => anything }
})

import { rateLimits, resetRateLimits } from '@/lib/rateLimit'
import { bootPayload, dockerOk, shutdown, startRealPostgres, type RealPostgres } from '@/lib/testing/realPostgres'

const PASSWORD = 'session-create-limit-pw'
let pg: RealPostgres
let payload: Payload
let config: SanitizedConfig
const tokens: Record<string, string> = {}

const BEN = 2 // member of ecosistema 1 only
const CARLA = 3 // member of ecosistema 1 only
const LIMIT = 3

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
  if (!token) throw new Error('login failed')
  return token
}

/** `POST /api/sessions` as the web sends it; `organization` only to make it fail. */
const create = (who: string, organization?: number) =>
  rest('POST', '/api/sessions?depth=0', tokens[who], { title: 'Nueva', kind: 'generales', ...(organization ? { organization } : {}) })

describe.skipIf(!dockerOk)('one account opens a bounded number of conversations an hour (real Postgres)', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-session-create-limit-${process.pid}`, 'session_create_limit')
    payload = await bootPayload(pg.url, 'session-create-limit-secret')
    config = await (await import('@payload-config')).default
    await pg.db.execute(sql.raw(`
      INSERT INTO users (id, email) VALUES (${BEN}, 'ben@example.invalid'), (${CARLA}, 'carla@example.invalid');
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Uno', 'uno'), (2, 'Dos', 'dos');
      INSERT INTO memberships (user_id, organization_id, role) VALUES (${BEN}, 1, 'member'), (${CARLA}, 1, 'member');
    `))
    for (const t of ['users', 'organizations', 'memberships']) {
      await pg.db.execute(sql.raw(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), 1000)`))
    }
    for (const id of [BEN, CARLA]) {
      await payload.update({ collection: 'users', id, overrideAccess: true, data: { password: PASSWORD } as never })
    }
    tokens.ben = await login('ben@example.invalid')
    tokens.carla = await login('carla@example.invalid')
  }, 180_000)

  afterAll(async () => {
    await shutdown(pg, payload)
  })

  beforeEach(() => {
    process.env.SESSION_RATELIMIT_CREATE_USER_MAX = String(LIMIT)
    resetRateLimits()
  })

  afterEach(() => {
    delete process.env.SESSION_RATELIMIT_CREATE_USER_MAX
  })

  it('🔴 past the limit: 429 with Retry-After; a failed create is not counted; others are untouched', async () => {
    // Ecosistema 2 is not BEN's: 400, and the slot goes back.
    for (let i = 0; i < LIMIT; i++) expect((await create('ben', 2)).status).toBe(400)
    for (let i = 0; i < LIMIT; i++) expect((await create('ben')).status).toBe(201)
    const refused = await create('ben')
    expect(refused.status).toBe(429)
    const retryAfter = Number(refused.headers.get('Retry-After'))
    expect(retryAfter).toBeGreaterThan(0)
    expect(retryAfter).toBeLessThanOrEqual(3600)
    expect(JSON.stringify(await refused.json())).toMatch(/too many new conversations/i)
    expect((await create('carla')).status).toBe(201)
  })

  it('🔴 concurrent creates cannot all pass the check: exactly the limit is created', async () => {
    const statuses = (await Promise.all(Array.from({ length: 10 }, () => create('carla')))).map((r) => r.status)
    expect(statuses.filter((s) => s === 201)).toHaveLength(LIMIT)
    expect(statuses.filter((s) => s === 429)).toHaveLength(10 - LIMIT)
  }, 30_000)

  it('a create as the server (eval runs, seeds) is not counted', async () => {
    for (let i = 0; i < LIMIT; i++) expect((await create('ben')).status).toBe(201)
    expect((await create('ben')).status).toBe(429)
    // `endpoints/evals.ts`: local API, no user. `seed/semiosisDemo.ts`: a user, `overrideAccess`.
    const data = { user: BEN, organization: 1, kind: 'generales', title: 'Evaluación' } as never
    await expect(payload.create({ collection: 'sessions', data, overrideAccess: true, depth: 0 })).resolves.toBeTruthy()
    const ben = await payload.findByID({ collection: 'users', id: BEN, overrideAccess: true })
    await expect(payload.create({ collection: 'sessions', data, user: ben as never, overrideAccess: true, depth: 0 })).resolves.toBeTruthy()
  })

  it('the default is 60 an hour, env-tunable', () => {
    delete process.env.SESSION_RATELIMIT_CREATE_USER_MAX
    expect(rateLimits.sessionCreatePerUser()).toBe(60)
    process.env.SESSION_RATELIMIT_CREATE_USER_MAX = 'junk'
    expect(rateLimits.sessionCreatePerUser()).toBe(60)
    process.env.SESSION_RATELIMIT_CREATE_USER_MAX = '7'
    expect(rateLimits.sessionCreatePerUser()).toBe(7)
  })
})
