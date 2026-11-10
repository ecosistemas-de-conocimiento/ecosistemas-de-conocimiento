/**
 * 🔴 A ROOM SIGNING IN TOGETHER DOES NOT HANG THE BACKEND — AGAINST A REAL POSTGRES.
 *
 * Re-audit 2026-11-10 (N1): `refuseInactiveLogin` read the committed row on a
 * SECOND pool connection while the login's transaction held its first. On the
 * default pool of 10, 20 concurrent logins hung for good: 10 held, 18 waiting
 * (measured). The read now goes through the login's own `req`.
 */

import { sql } from '@payloadcms/db-postgres'
import type { Payload, SanitizedConfig } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/aiClient', () => {
  const anything: unknown = new Proxy(() => {}, {
    get: (_t, key) => (key === 'then' ? undefined : anything),
    apply: async () => ({ ok: true }),
  })
  return { getAdminAIClient: () => anything, getAppAIClient: () => anything }
})

import { bootPayload, dockerOk, shutdown, startRealPostgres, type RealPostgres } from '@/lib/testing/realPostgres'

const PASSWORD = 'concurrent-logins-pw'
const PEOPLE = 30
let pg: RealPostgres
let payload: Payload
let config: SanitizedConfig

async function login(email: string, ip: string): Promise<number> {
  const { handleEndpoints } = await import('payload')
  const res = await handleEndpoints({
    config,
    request: new Request('http://localhost/api/users/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  })
  return res.status
}

const within = <T,>(p: Promise<T>, ms: number): Promise<T | 'hung'> =>
  Promise.race([p, new Promise<'hung'>((r) => setTimeout(() => r('hung'), ms))])

describe.skipIf(!dockerOk)('concurrent sign-ins', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-concurrent-logins-${process.pid}`, 'concurrent_logins')
    payload = await bootPayload(pg.url, 'concurrent-logins-secret')
    config = await (await import('@payload-config')).default
    const ids = Array.from({ length: PEOPLE }, (_, i) => i + 1)
    await pg.db.execute(
      sql.raw(
        `TRUNCATE users RESTART IDENTITY CASCADE; INSERT INTO users (id, email, is_platform_admin) VALUES ${ids
          .map((i) => `(${i}, 'p${i}@example.invalid', false)`)
          .join(', ')};`,
      ),
    )
    for (const id of ids) {
      await payload.update({ collection: 'users', id, overrideAccess: true, data: { password: PASSWORD } as never })
    }
  }, 180_000)

  afterAll(async () => {
    await shutdown(pg, payload)
  })

  it(`${PEOPLE} people signing in at once all get in, more than the pool's 10 connections`, async () => {
    const all = Promise.all(
      Array.from({ length: PEOPLE }, (_, i) => login(`p${i + 1}@example.invalid`, `10.0.0.${i + 1}`)),
    )
    const statuses = await within(all, 30_000)
    expect(statuses).not.toBe('hung')
    expect(statuses).toEqual(Array.from({ length: PEOPLE }, () => 200))
  }, 60_000)
})
