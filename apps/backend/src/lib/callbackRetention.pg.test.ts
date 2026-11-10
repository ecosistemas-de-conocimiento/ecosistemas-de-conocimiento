/**
 * 🔴 CALLBACK BODIES GO AT 30 DAYS, AND DEDUPE SURVIVES (owner decision
 * 2026-11-10). Real Payload on a throwaway Postgres (`lib/testing/realPostgres.ts`);
 * the receiver is the real route, signed with the real HMAC.
 *
 * ⚠ No docker → the suite SKIPS.
 */
import { sql } from '@payloadcms/db-postgres'
import type { Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/aiClient', () => {
  const anything: unknown = new Proxy(() => {}, {
    get: (_t, key) => (key === 'then' ? undefined : anything),
    apply: async () => ({ ok: true }),
  })
  return { getAdminAIClient: () => anything, getAppAIClient: () => anything }
})

import { signCallback } from '@/lib/hmac'
import { bootPayload, dockerOk, rowsOf, shutdown, startRealPostgres, type RealPostgres } from '@/lib/testing/realPostgres'

import { purgeCallbackBodies } from './callbackRetention'

const SECRET = 'r'.repeat(64)
const DAY = 86_400_000

let pg: RealPostgres
let payload: Payload

const post = async (body: string) => {
  const { POST } = await import('@/app/api/ai-service/callback/route')
  const timestamp = Math.floor(Date.now() / 1000)
  return POST(
    new Request('http://backend.test/api/ai-service/callback', {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'x-aiservice-timestamp': String(timestamp),
        'x-aiservice-signature': signCallback({ timestamp, body, secret: SECRET }),
      },
    }),
  )
}

const ledger = async () =>
  rowsOf(pg.db, sql`SELECT correlation_key AS k, raw_body AS body FROM ai_service_callbacks ORDER BY correlation_key`)

describe.skipIf(!dockerOk)('callback body retention on a real Postgres', () => {
  beforeAll(async () => {
    process.env.CALLBACK_SECRET = SECRET
    pg = await startRealPostgres(`edc-callback-retention-${process.pid}`, 'callback_retention')
    payload = await bootPayload(pg.url, 'callback-retention-secret')
  }, 120_000)

  afterAll(async () => {
    delete process.env.CALLBACK_SECRET
    await shutdown(pg, payload)
  })

  it('🔴 bodies older than 30 days go, newer ones stay, and every row stays', async () => {
    for (const [key, age] of [['ing_old', 31], ['ing_edge', 29], ['ing_new', 0]] as const) {
      const res = await post(JSON.stringify({ event: 'ingest.progress', ingestId: key }))
      expect(await res.json()).toEqual({ ok: true, deduped: false, dispatched: true })
      await pg.db.execute(
        sql`UPDATE ai_service_callbacks SET received_at = ${new Date(Date.now() - age * DAY).toISOString()} WHERE correlation_key = ${key}`,
      )
    }

    expect(await purgeCallbackBodies(payload as never, 30)).toBe(1)

    const rows = await ledger()
    expect(rows.map((r) => r.k)).toEqual(['ing_edge', 'ing_new', 'ing_old'])
    expect(rows.find((r) => r.k === 'ing_old')?.body).toBeNull()
    expect(rows.find((r) => r.k === 'ing_edge')?.body).toContain('ing_edge')
    expect(rows.find((r) => r.k === 'ing_new')?.body).toContain('ing_new')
    // A second pass finds nothing left to purge.
    expect(await purgeCallbackBodies(payload as never, 30)).toBe(0)
  }, 30_000)

  it('🔴 a retry of a purged event is still deduped', async () => {
    const res = await post(JSON.stringify({ event: 'ingest.progress', ingestId: 'ing_old' }))
    expect(await res.json()).toEqual({ ok: true, deduped: true, dispatched: false })
    const rows = await ledger()
    expect(rows.filter((r) => r.k === 'ing_old')).toEqual([{ k: 'ing_old', body: null }])
  }, 30_000)
})
