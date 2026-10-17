/**
 * The seed's throttle: a concurrency limit, a minimum gap between starts, and
 * a wait for a draft's in-process work. All on a fake clock — nothing sleeps.
 */
import { describe, expect, it, vi } from 'vitest'

import { draftSettled, throttledEach, waitForDraftSettled, waitUntilIdle } from './throttle'

/** A fake clock whose `sleep` advances time and yields. */
function fakeClock() {
  let t = 0
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms
      await Promise.resolve()
    },
  }
}

describe('throttledEach', () => {
  it('never runs more than `concurrency` at once', async () => {
    const clock = fakeClock()
    let inFlight = 0
    let peak = 0
    await throttledEach(
      Array.from({ length: 10 }, (_, i) => i),
      async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await clock.sleep(5)
        inFlight -= 1
      },
      { concurrency: 3, spacingMs: 0, ...clock },
    )
    expect(peak).toBe(3)
  })

  it('🔴 spaces every start at least `spacingMs` apart, across workers', async () => {
    // Real timers' API on vitest's fake clock: concurrent sleeps overlap in time.
    vi.useFakeTimers({ now: 0 })
    const starts: number[] = []
    const run = throttledEach(
      [1, 2, 3, 4, 5],
      async () => {
        starts.push(Date.now())
        await new Promise((r) => setTimeout(r, 50))
      },
      { concurrency: 4, spacingMs: 1000 },
    )
    await vi.runAllTimersAsync()
    await run
    vi.useRealTimers()
    expect(starts[0]).toBe(0)
    expect(starts).toHaveLength(5)
    const sorted = [...starts].sort((a, b) => a - b)
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(1000)
    }
  })

  it('visits every item once, even when one throws', async () => {
    const seen: number[] = []
    const errors: unknown[] = []
    await throttledEach(
      [1, 2, 3],
      async (n) => {
        seen.push(n)
        if (n === 2) throw new Error('boom')
      },
      { concurrency: 2, spacingMs: 0, ...fakeClock(), onError: (_n, err) => errors.push(err) },
    )
    expect(seen.sort()).toEqual([1, 2, 3])
    expect(errors).toHaveLength(1)
  })
})

describe('draftSettled', () => {
  it.each([
    [{ ingestStatus: 'pending', anonymisationStatus: 'n/a' }, false],
    [{ ingestStatus: 'extracting', anonymisationStatus: 'n/a' }, false],
    [{ ingestStatus: 'embedding', anonymisationStatus: 'n/a' }, true],
    [{ ingestStatus: 'ready', anonymisationStatus: 'ready' }, true],
    [{ ingestStatus: 'failed', anonymisationStatus: 'n/a' }, true],
    // The gate is still running: two model calls in flight.
    [{ ingestStatus: 'embedding', anonymisationStatus: 'pending' }, false],
    // The gate refused it: no ingest will follow, and the row is done.
    [{ ingestStatus: 'pending', anonymisationStatus: 'held' }, true],
    [{ ingestStatus: 'pending', anonymisationStatus: 'rejected' }, true],
  ])('%o → %s', (row, expected) => {
    expect(draftSettled(row)).toBe(expected)
  })
})

describe('waitForDraftSettled', () => {
  it('polls until the row settles', async () => {
    const clock = fakeClock()
    const states = [
      { ingestStatus: 'pending', anonymisationStatus: null },
      { ingestStatus: 'pending', anonymisationStatus: 'pending' },
      { ingestStatus: 'embedding', anonymisationStatus: 'ready' },
    ]
    let reads = 0
    const settled = await waitForDraftSettled(async () => states[Math.min(reads++, 2)]!, {
      pollMs: 2000,
      timeoutMs: 60_000,
      ...clock,
    })
    expect(settled).toBe(true)
    expect(reads).toBe(3)
  })

  it('gives up at the timeout and says so, rather than hanging the seed', async () => {
    const clock = fakeClock()
    const settled = await waitForDraftSettled(async () => ({ ingestStatus: 'pending' }), {
      pollMs: 1000,
      timeoutMs: 5000,
      ...clock,
    })
    expect(settled).toBe(false)
    expect(clock.now()).toBeGreaterThanOrEqual(5000)
  })
})

describe('waitUntilIdle', () => {
  it('returns once the work has been idle for `quietPolls` polls in a row', async () => {
    const clock = fakeClock()
    const busy = [true, false, true, false, false, false, true]
    let i = 0
    const idle = await waitUntilIdle(async () => !busy[i++], {
      pollMs: 1000,
      timeoutMs: 60_000,
      quietPolls: 3,
      ...clock,
    })
    expect(idle).toBe(true)
    // The blip at poll 3 reset the count; polls 4 to 6 were the quiet three.
    expect(i).toBe(6)
  })

  it('gives up at the timeout', async () => {
    const clock = fakeClock()
    const idle = await waitUntilIdle(async () => false, {
      pollMs: 1000,
      timeoutMs: 3000,
      quietPolls: 2,
      ...clock,
    })
    expect(idle).toBe(false)
  })
})
