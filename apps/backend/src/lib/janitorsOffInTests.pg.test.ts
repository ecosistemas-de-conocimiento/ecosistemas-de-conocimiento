/**
 * 🔴 NO JANITOR ARMS IN A TEST RUN UNLESS THE TEST ASKS (`vitest.setup.ts`).
 *
 * Boots Payload the way several real-Postgres files do, with `getPayload`
 * directly and no `*_JANITOR_ENABLED=false` of its own, and checks that
 * `onInit` armed nothing. Without the setup, the janitors that are on by
 * default arm here and this fails.
 */
import type { Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { armedJanitors } from './janitorScheduler'
import { dockerOk, shutdown, startRealPostgres, type RealPostgres } from './testing/realPostgres'

let pg: RealPostgres
let payload: Payload

describe.skipIf(!dockerOk)('a test run arms no janitor', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-janitors-off-${process.pid}`, 'janitors_off')
    process.env.DATABASE_URI = pg.url
    process.env.PAYLOAD_SECRET = 'janitors-off-secret'
    for (const v of Object.keys(process.env)) if (/_JANITOR_ENABLED$/.test(v)) delete process.env[v]
    const { getPayload } = await import('payload')
    const { default: config } = await import('@payload-config')
    payload = await getPayload({ config })
  }, 120_000)

  afterAll(async () => {
    await shutdown(pg, payload)
  })

  it('onInit ran and armed nothing', () => {
    expect(armedJanitors()).toEqual([])
  })
})
