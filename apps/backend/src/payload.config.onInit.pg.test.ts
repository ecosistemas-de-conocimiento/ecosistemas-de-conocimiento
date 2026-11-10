/**
 * 🔴 C-05 WIRED (review 2026-11-10, R-04): booting Payload starts the daily
 * graph orphan sweep. `startGraphOrphanJanitor` existed and nothing called it,
 * so a deleted document's `graph_entities` (names) stayed for good.
 */
import type { Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const started = vi.hoisted(() => [] as unknown[])

vi.mock('@/lib/graph/orphanJanitor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/graph/orphanJanitor')>()),
  startGraphOrphanJanitor: (payload: unknown) => {
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
    pg = await startRealPostgres(`edc-oninit-${process.pid}`, 'oninit')
    payload = await bootPayload(pg.url, 'oninit-secret')
  }, 120_000)

  afterAll(async () => {
    await shutdown(pg, payload)
  })

  it('starts the graph orphan janitor once, with the booted payload', () => {
    expect(started).toHaveLength(1)
    expect(started[0]).toBe(payload)
  })
})
