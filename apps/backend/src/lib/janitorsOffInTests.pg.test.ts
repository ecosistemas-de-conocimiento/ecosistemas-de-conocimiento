/**
 * 🔴 NO JANITOR ARMS IN A TEST RUN UNLESS THE TEST ASKS (`vitest.setup.ts`).
 *
 * Boots Payload the way several real-Postgres files do, with `getPayload`
 * directly and no `*_JANITOR_ENABLED=false` of its own, and checks that
 * `onInit` armed nothing. Without the setup, the janitors that are on by
 * default arm here and this fails. The session janitor keeps its own timer
 * (`sessionJanitorScheduler.ts`) and is opt-in, so it is switched on here to
 * prove the setup, not its default, keeps it off.
 */
import type { Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest'

import { armedJanitors } from './janitorScheduler'
import { sessionJanitorArmed } from './sessionJanitorScheduler'
import { dockerOk, shutdown, startRealPostgres, type RealPostgres } from './testing/realPostgres'

let pg: RealPostgres
let payload: Payload
let warn: MockInstance

describe.skipIf(!dockerOk)('a test run arms no janitor', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-janitors-off-${process.pid}`, 'janitors_off')
    process.env.DATABASE_URI = pg.url
    process.env.PAYLOAD_SECRET = 'janitors-off-secret'
    for (const v of Object.keys(process.env)) if (/_JANITOR_ENABLED$/.test(v)) delete process.env[v]
    process.env.SESSION_JANITOR_ENABLED = 'true'
    const { getPayload } = await import('payload')
    const { default: configP } = await import('@payload-config')
    // Spy on the logger before `onInit` writes to it: the boot line is in there.
    const config = await configP
    const onInit = config.onInit!
    config.onInit = async (p) => {
      warn = vi.spyOn(p.logger, 'warn')
      await onInit(p)
    }
    payload = await getPayload({ config })
  }, 120_000)

  afterAll(async () => {
    delete process.env.SESSION_JANITOR_ENABLED
    await shutdown(pg, payload)
  })

  it('onInit ran and armed nothing', () => {
    expect(armedJanitors()).toEqual([])
    expect(sessionJanitorArmed()).toBe(false)
  })

  it('🔴 and said so at boot, once', () => {
    const lines = warn.mock.calls.map((c) => String(c.at(-1))).filter((l) => l.startsWith('[janitors]'))
    expect(lines).toEqual(['[janitors] EDC_JANITORS_DISABLED=1: no janitor arms in this process'])
  })
})
