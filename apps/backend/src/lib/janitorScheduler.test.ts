/**
 * The first sweep runs soon after boot, not one interval later: a daily
 * janitor on a backend restarted more than once a day never ran (audit 2026-11-10).
 */

import { allowJanitors } from '@/lib/testing/janitors'
import type { Payload } from 'payload'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  armedJanitors,
  JANITOR_FIRST_SWEEP_DEFAULT_MIN,
  JANITORS_DISABLED_VAR,
  JANITOR_FIRST_SWEEP_MIN_VAR,
  janitorFirstSweepMs,
  startJanitor,
  stopJanitor,
} from './janitorScheduler'

// Its own janitor arms here (`vitest.setup.ts` turns them all off).
allowJanitors()

const MIN = 60_000
const DAY = 1440 * MIN
const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() }

function arm(intervalMs: number, sweep = vi.fn(async () => {})) {
  startJanitor({ logger } as unknown as Payload, {
    prefix: 'test-janitor',
    enabledVar: 'TEST_JANITOR_ENABLED',
    enabled: () => true,
    intervalMs: () => intervalMs,
    disabledDetail: '',
    sweep,
  })
  return sweep
}

describe('startJanitor: the first sweep', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    delete process.env[JANITOR_FIRST_SWEEP_MIN_VAR]
  })
  afterEach(() => {
    stopJanitor('test-janitor')
    vi.useRealTimers()
    delete process.env[JANITOR_FIRST_SWEEP_MIN_VAR]
  })

  it('a daily janitor sweeps at the short delay, then every interval', async () => {
    const sweep = arm(DAY)
    await vi.advanceTimersByTimeAsync(JANITOR_FIRST_SWEEP_DEFAULT_MIN * MIN - 1)
    expect(sweep).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(sweep).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(DAY - 1)
    expect(sweep).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(sweep).toHaveBeenCalledTimes(2)
  })

  it('a sweep that throws does not disarm it', async () => {
    const sweep = arm(DAY, vi.fn(async () => Promise.reject(new Error('boom'))))
    await vi.advanceTimersByTimeAsync(JANITOR_FIRST_SWEEP_DEFAULT_MIN * MIN + DAY)
    expect(sweep).toHaveBeenCalledTimes(2)
  })

  it('stopJanitor before the first sweep cancels it', async () => {
    const sweep = arm(DAY)
    stopJanitor('test-janitor')
    await vi.advanceTimersByTimeAsync(2 * DAY)
    expect(sweep).not.toHaveBeenCalled()
  })

  it('🔴 EDC_JANITORS_DISABLED=1 (the test setup) arms nothing and sweeps nothing', async () => {
    process.env[JANITORS_DISABLED_VAR] = '1'
    try {
      const sweep = arm(MIN)
      expect(armedJanitors()).toEqual([])
      await vi.advanceTimersByTimeAsync(2 * DAY)
      expect(sweep).not.toHaveBeenCalled()
    } finally {
      delete process.env[JANITORS_DISABLED_VAR]
    }
  })

  it('the delay: env-tunable, never longer than the interval, junk falls back', () => {
    expect(janitorFirstSweepMs(DAY)).toBe(JANITOR_FIRST_SWEEP_DEFAULT_MIN * MIN)
    expect(janitorFirstSweepMs(MIN)).toBe(MIN)
    process.env[JANITOR_FIRST_SWEEP_MIN_VAR] = '5'
    expect(janitorFirstSweepMs(DAY)).toBe(5 * MIN)
    process.env[JANITOR_FIRST_SWEEP_MIN_VAR] = '0'
    expect(janitorFirstSweepMs(DAY)).toBe(0)
    for (const junk of ['nope', '-3', ' ']) {
      process.env[JANITOR_FIRST_SWEEP_MIN_VAR] = junk
      expect(janitorFirstSweepMs(DAY)).toBe(JANITOR_FIRST_SWEEP_DEFAULT_MIN * MIN)
    }
  })
})
