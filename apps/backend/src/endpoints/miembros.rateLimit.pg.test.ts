/**
 * 🔴 ONE MANAGER ADDS A BOUNDED NUMBER OF PEOPLE AN HOUR — THROUGH THE REAL
 * `POST /api/miembros`, AGAINST A REAL POSTGRES (audit 2026-11-10, D2 leftover).
 *
 * Every account brings its own per-person budgets (2 relation-filter slots, 30
 * such reads a minute), so adds without a bound multiplied one person's.
 * `reserveMemberAdd` in `miembros.ts` counts each add before it runs, gives a
 * failed one back, and answers 429 with `Retry-After` past
 * `MIEMBROS_RATELIMIT_ADD_USER_MAX` an hour.
 *
 * Harness: `lib/testing/realPostgres`; driven through `handleEndpoints`, real JWT.
 */

import { sql } from '@payloadcms/db-postgres'
import type { Payload, SanitizedConfig } from 'payload'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { rateLimits, resetRateLimits } from '@/lib/rateLimit'
import { bootPayload, dockerOk, rowsOf, shutdown, startRealPostgres, type RealPostgres } from '@/lib/testing/realPostgres'

const PASSWORD = 'miembros-add-limit-pw'
let pg: RealPostgres
let payload: Payload
let config: SanitizedConfig
const tokens: Record<string, string> = {}

// 1 root (platform admin) · 2 olga, owner of A · 3 adan, admin of A · 4 memo, member of A · 5 bea, owner of B.
const ECO_A = 1
const ECO_B = 2
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

let seq = 0
/** `POST /api/miembros` as the web sends it. A fresh email unless one is given. */
const add = (who: string, organization: number, opts: { email?: string; role?: string } = {}) =>
  rest('POST', '/api/miembros', tokens[who], {
    organization,
    email: opts.email ?? `nueva${++seq}@example.invalid`,
    name: 'Nueva',
    role: opts.role ?? 'member',
  })

const accounts = async () => Number((await rowsOf(pg.db, sql`SELECT count(*)::int AS n FROM users`))[0]!.n)

describe.skipIf(!dockerOk)('one manager adds a bounded number of people an hour (real Postgres)', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-miembros-add-limit-${process.pid}`, 'miembros_add_limit')
    payload = await bootPayload(pg.url, 'miembros-add-limit-secret')
    config = await (await import('@payload-config')).default
    await pg.db.execute(sql.raw(`
      INSERT INTO users (id, email, is_platform_admin) VALUES
        (1, 'root@example.invalid', true), (2, 'olga@example.invalid', false), (3, 'adan@example.invalid', false),
        (4, 'memo@example.invalid', false), (5, 'bea@example.invalid', false);
      INSERT INTO organizations (id, name, slug) VALUES (${ECO_A}, 'Uno', 'uno'), (${ECO_B}, 'Dos', 'dos');
      INSERT INTO memberships (user_id, organization_id, role, is_active) VALUES
        (2, ${ECO_A}, 'owner', true), (3, ${ECO_A}, 'admin', true), (4, ${ECO_A}, 'member', true), (5, ${ECO_B}, 'owner', true);
    `))
    for (const t of ['users', 'organizations', 'memberships']) {
      await pg.db.execute(sql.raw(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), 1000)`))
    }
    for (const id of [1, 2, 3, 5]) {
      await payload.update({ collection: 'users', id, overrideAccess: true, data: { password: PASSWORD } as never })
    }
    for (const who of ['root', 'olga', 'adan', 'bea']) tokens[who] = await login(`${who}@example.invalid`)
  }, 180_000)

  afterAll(async () => {
    await shutdown(pg, payload)
  })

  beforeEach(() => {
    process.env.MIEMBROS_RATELIMIT_ADD_USER_MAX = String(LIMIT)
    resetRateLimits()
  })

  afterEach(() => {
    delete process.env.MIEMBROS_RATELIMIT_ADD_USER_MAX
  })

  it('🔴 past the limit: 429 with Retry-After, no-store, and no account; failed adds are given back; another manager is untouched', async () => {
    // Failures first, LIMIT of each: they must not use up the budget.
    for (let i = 0; i < LIMIT; i++) expect((await add('olga', ECO_A, { email: 'memo@example.invalid' })).status).toBe(409)
    // A role above an admin's own is refused after the account is made; the account goes, and so does the slot.
    for (let i = 0; i < LIMIT; i++) expect((await add('adan', ECO_A, { role: 'owner' })).status).not.toBe(201)
    // A known email counts as a new one does, or the 429 would tell them apart.
    expect((await add('olga', ECO_A, { email: 'bea@example.invalid' })).status).toBe(201)
    for (let i = 1; i < LIMIT; i++) expect((await add('olga', ECO_A)).status).toBe(201)

    const before = await accounts()
    const refused = await add('olga', ECO_A)
    expect(refused.status).toBe(429)
    const retryAfter = Number(refused.headers.get('Retry-After'))
    expect(retryAfter).toBeGreaterThan(0)
    expect(retryAfter).toBeLessThanOrEqual(3600)
    expect(refused.headers.get('Cache-Control')).toBe('no-store')
    expect(JSON.stringify(await refused.json())).not.toMatch(/temporaryPassword/)
    expect(await accounts()).toBe(before)

    // Adán's failures were refunded: his whole budget is still there.
    for (let i = 0; i < LIMIT; i++) expect((await add('adan', ECO_A)).status).toBe(201)
    expect((await add('adan', ECO_A)).status).toBe(429)
    // Bea has her own budget.
    expect((await add('bea', ECO_B)).status).toBe(201)
  }, 60_000)

  it('🔴 concurrent adds cannot all pass the check: exactly the limit is added', async () => {
    const statuses = (await Promise.all(Array.from({ length: 10 }, () => add('bea', ECO_B)))).map((r) => r.status)
    expect(statuses.filter((s) => s === 201)).toHaveLength(LIMIT)
    expect(statuses.filter((s) => s === 429)).toHaveLength(10 - LIMIT)
  }, 60_000)

  it('a platform admin is not counted: they create accounts through POST /api/users anyway', async () => {
    for (let i = 0; i < LIMIT + 2; i++) expect((await add('root', ECO_A)).status).toBe(201)
  }, 60_000)

  it('the default is 50 an hour, env-tunable', () => {
    delete process.env.MIEMBROS_RATELIMIT_ADD_USER_MAX
    expect(rateLimits.memberAddPerUser()).toBe(50)
    process.env.MIEMBROS_RATELIMIT_ADD_USER_MAX = 'junk'
    expect(rateLimits.memberAddPerUser()).toBe(50)
    process.env.MIEMBROS_RATELIMIT_ADD_USER_MAX = '7'
    expect(rateLimits.memberAddPerUser()).toBe(7)
  })
})
