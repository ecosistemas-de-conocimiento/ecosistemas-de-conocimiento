/**
 * 🔴 A RESPONSABLE ADDING PEOPLE IN A BURST DOES NOT HANG THE BACKEND — AGAINST
 * A REAL POSTGRES.
 *
 * Measured 2026-11-11 on torre: 2 to 8 concurrent adds answered in 215-353 ms;
 * 10 still hung after 15 s and the stuck pool took the next test down too.
 * Each add's writes hold a pool connection inside their transaction, and a read
 * made without `req` asked the pool for a second one; on the default pool of 10
 * ten adds waited on each other for good.
 */

import { sql } from '@payloadcms/db-postgres'
import type { Payload, PayloadRequest } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { bootPayload, dockerOk, shutdown, startRealPostgres, type RealPostgres } from '@/lib/testing/realPostgres'

import { miembrosEndpoints } from './miembros'

const ADDS = 16
let pg: RealPostgres
let payload: Payload

async function add(as: number, email: string): Promise<number> {
  const { createLocalReq } = await import('payload')
  const user = await payload.findByID({ collection: 'users', id: as, overrideAccess: true })
  const req = (await createLocalReq({ user: { ...user, collection: 'users' } as never }, payload)) as PayloadRequest
  Object.assign(req, { json: async () => ({ organization: 1, email, name: email.split('@')[0], role: 'member' }) })
  const handler = miembrosEndpoints.find((e) => e.method === 'post' && e.path === '/miembros')!.handler
  return (await handler(req)).status
}

const within = <T,>(p: Promise<T>, ms: number): Promise<T | 'hung'> =>
  Promise.race([p, new Promise<'hung'>((r) => setTimeout(() => r('hung'), ms))])

describe.skipIf(!dockerOk)('concurrent adds to /api/miembros', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-miembros-burst-${process.pid}`, 'miembros_burst')
    payload = await bootPayload(pg.url, 'miembros-burst-secret')
    await pg.db.execute(sql.raw(`
      TRUNCATE memberships, organizations, users RESTART IDENTITY CASCADE;
      INSERT INTO users (id, email, display_name, is_platform_admin) VALUES (1, 'olga@example.invalid', 'Olga', false);
      SELECT setval('users_id_seq', 1);
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Eco A', 'eco-a');
      SELECT setval('organizations_id_seq', 1);
      INSERT INTO memberships (id, user_id, organization_id, role) VALUES (1, 1, 1, 'owner');
      SELECT setval('memberships_id_seq', 1);
    `))
  }, 120_000)

  afterAll(async () => {
    await shutdown(pg, payload)
  })

  it(`${ADDS} adds at once by one responsable all land, more than the pool's 10 connections`, async () => {
    const all = Promise.all(Array.from({ length: ADDS }, (_, i) => add(1, `p${i}@example.invalid`)))
    const statuses = await within(all, 15_000)
    expect(statuses).not.toBe('hung')
    expect(statuses).toEqual(Array.from({ length: ADDS }, () => 201))
    const rows = (await pg.db.execute(sql`SELECT count(*)::int AS n FROM memberships WHERE organization_id = 1`)) as unknown as {
      rows: Array<{ n: number }>
    }
    expect(rows.rows[0]?.n).toBe(ADDS + 1)
  }, 60_000)
})
