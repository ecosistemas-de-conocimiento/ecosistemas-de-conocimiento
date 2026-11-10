/**
 * Owner decision 2026-11-10: callback bodies are purged after 30 days, daily.
 * The real-Postgres half is `callbackRetention.pg.test.ts`.
 */
import { allowJanitors } from '@/lib/testing/janitors'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CALLBACK_RETENTION_DEFAULT_DAYS,
  CALLBACK_RETENTION_JANITOR_DEFAULT_MIN,
  callbackRetentionDaysFromEnv,
  purgeCallbackBodies,
  startCallbackRetentionJanitor,
  stopCallbackRetentionJanitor,
} from './callbackRetention'
import { JANITOR_FIRST_SWEEP_DEFAULT_MIN } from './janitorScheduler'

// Its own janitor arms here (`vitest.setup.ts` turns them all off).
allowJanitors()

function fake() {
  const queries: unknown[] = []
  const payload = {
    db: {
      drizzle: {
        async execute(q: unknown) {
          queries.push(q)
          return { rowCount: 2, rows: [{ id: 1 }, { id: 2 }] }
        },
      },
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }
  return { payload, queries }
}

afterEach(() => {
  stopCallbackRetentionJanitor()
  vi.useRealTimers()
  delete process.env.CALLBACK_RETENTION_JANITOR_ENABLED
  delete process.env.CALLBACK_RETENTION_JANITOR_INTERVAL_MIN
  delete process.env.CALLBACK_RETENTION_DAYS
})

describe('callbackRetentionDaysFromEnv', () => {
  it('30 by default; a bad or sub-day value falls back', () => {
    expect(CALLBACK_RETENTION_DEFAULT_DAYS).toBe(30)
    expect(callbackRetentionDaysFromEnv()).toBe(30)
    process.env.CALLBACK_RETENTION_DAYS = '7'
    expect(callbackRetentionDaysFromEnv()).toBe(7)
    for (const bad of ['0', '-3', 'abc', '0.5']) {
      process.env.CALLBACK_RETENTION_DAYS = bad
      expect(callbackRetentionDaysFromEnv(), bad).toBe(30)
    }
  })
})

describe('purgeCallbackBodies', () => {
  it('returns how many bodies it nulled', async () => {
    const { payload } = fake()
    expect(await purgeCallbackBodies(payload)).toBe(2)
  })
})

describe('startCallbackRetentionJanitor', () => {
  it('🔴 is on by default, daily: first sweep soon after boot (janitorScheduler), then every interval', async () => {
    expect(CALLBACK_RETENTION_JANITOR_DEFAULT_MIN).toBe(1440)
    vi.useFakeTimers()
    const { payload, queries } = fake()
    expect(startCallbackRetentionJanitor(payload as never)).toBe(true)
    expect(payload.logger.info).toHaveBeenCalledWith(
      { intervalMinutes: 1440, retentionDays: 30 },
      '[callback-retention-janitor] armed',
    )
    await vi.advanceTimersByTimeAsync(JANITOR_FIRST_SWEEP_DEFAULT_MIN * 60_000 - 1)
    expect(queries).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(queries).toHaveLength(1)
    expect(payload.logger.info).toHaveBeenCalledWith({ purged: 2 }, '[callback-retention-janitor] swept')
    await vi.advanceTimersByTimeAsync(1440 * 60_000)
    expect(queries).toHaveLength(2)
  })

  it('CALLBACK_RETENTION_JANITOR_ENABLED=false turns it off', () => {
    process.env.CALLBACK_RETENTION_JANITOR_ENABLED = 'false'
    const { payload } = fake()
    expect(startCallbackRetentionJanitor(payload as never)).toBe(false)
  })
})
