/**
 * 🔴 Booting Payload starts the daily callback body purge
 * (`lib/callbackRetention.ts`, owner decision 2026-11-10).
 */
import type { Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const started = vi.hoisted(() => [] as unknown[])

vi.mock('@/lib/callbackRetention', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/callbackRetention')>()),
  startCallbackRetentionJanitor: (payload: unknown) => {
    started.push(payload)
    return false
  },
}))

vi.mock('@/lib/aiClient', () => {
  const anything: unknown = new Proxy(() => {}, {
    get: (_t, key) => (key === 'then' ? undefined : anything),
    apply: async () => ({ ok: true }),
  })
  return { getAdminAIClient: () => anything, getAppAIClient: () => anything }
})

import { bootPayload, dockerOk, shutdown, startRealPostgres, type RealPostgres } from '@/lib/testing/realPostgres'

let pg: RealPostgres
let payload: Payload

describe.skipIf(!dockerOk)('payload onInit', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-oninit-retention-${process.pid}`, 'oninit_retention')
    payload = await bootPayload(pg.url, 'oninit-retention-secret')
  }, 120_000)

  afterAll(async () => {
    await shutdown(pg, payload)
  })

  it('starts the callback retention janitor once, with the booted payload', () => {
    expect(started).toHaveLength(1)
    expect(started[0]).toBe(payload)
  })
})
