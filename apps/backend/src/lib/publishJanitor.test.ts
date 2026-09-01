/**
 * 🔴 THE SWEEP FOR THE STATE NOTHING WAS WATCHING.
 *
 * 145 documents sat in `publicationStatus: 'publishing'` for 25+ minutes after a
 * 285-document seed hit ai-service's 100/min rate limit. 99 of them carried no
 * error and no ingest id: a non-terminal state, no explanation, nothing to
 * retry from.
 *
 * These tests pin down BOTH halves of what the janitor is for — what it writes,
 * and just as importantly what it refuses to do:
 *   · it makes an invisible stall visible, and leaves the row retryable;
 *   · it NEVER changes `publicationStatus`, so `draft` never lies about a
 *     document with a half-finished copy in the shared corpus;
 *   · it NEVER re-enqueues. Re-driving 145 publishes on a timer would recreate
 *     the rate-limit burst that caused the mess;
 *   · it never overwrites an error ai-service already gave us, because that
 *     specific diagnosis is worth more than this file's generic one.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Payload } from 'payload'

import {
  DEFAULT_STUCK_MIN,
  PUBLISH_JANITOR_ENABLED_VAR,
  PUBLISH_JANITOR_INTERVAL_MIN_VAR,
  PUBLISH_JANITOR_STUCK_MIN_VAR,
  STALLED_PUBLISH_CODE,
  isStalledPublish,
  publishJanitorEnabled,
  publishJanitorIntervalMs,
  stalledPublishReason,
  startPublishJanitor,
  stopPublishJanitor,
  stuckAfterMs,
  sweepStalledPublishes,
} from './publishJanitor'

const NOW = new Date('2026-08-28T12:00:00Z')
const DEADLINE_MS = 30 * 60_000

/** Minutes before NOW, as the ISO string Payload stores. */
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString()

function fakePayload(docs: Array<Record<string, unknown>>) {
  const update = vi.fn(async (_args: { id: unknown; data: Record<string, unknown> }) => ({}))
  const find = vi.fn(async (_args: Record<string, unknown>) => ({ docs }))
  return {
    payload: { find, update } as unknown as Pick<Payload, 'find' | 'update'>,
    find,
    update,
  }
}

afterEach(() => {
  delete process.env[PUBLISH_JANITOR_ENABLED_VAR]
  delete process.env[PUBLISH_JANITOR_INTERVAL_MIN_VAR]
  delete process.env[PUBLISH_JANITOR_STUCK_MIN_VAR]
  stopPublishJanitor()
})

describe('isStalledPublish — what counts as stuck', () => {
  it('🔴 an old `publishing` row with no error is stuck — the 99-document case', () => {
    expect(
      isStalledPublish(
        { publicationStatus: 'publishing', updatedAt: minutesAgo(31) },
        NOW,
        DEADLINE_MS,
      ),
    ).toBe(true)
  })

  it('covers `unpublishing` too — the shared copy is already retired there', () => {
    expect(
      isStalledPublish(
        { publicationStatus: 'unpublishing', updatedAt: minutesAgo(45) },
        NOW,
        DEADLINE_MS,
      ),
    ).toBe(true)
  })

  it('leaves a row inside its deadline alone', () => {
    expect(
      isStalledPublish(
        { publicationStatus: 'publishing', updatedAt: minutesAgo(10) },
        NOW,
        DEADLINE_MS,
      ),
    ).toBe(false)
  })

  it('🔴 never touches a row that ALREADY has an error', () => {
    // Overwriting ai-service's own diagnosis with a generic timeout message is a
    // downgrade — and it would happen on every sweep, forever.
    expect(
      isStalledPublish(
        {
          publicationStatus: 'publishing',
          publicationError: 'Rate limit exceeded. Retry after ~52s.',
          updatedAt: minutesAgo(90),
        },
        NOW,
        DEADLINE_MS,
      ),
    ).toBe(false)
  })

  it('ignores terminal states entirely', () => {
    for (const status of ['draft', 'published', undefined, null, 'weird']) {
      expect(
        isStalledPublish({ publicationStatus: status, updatedAt: minutesAgo(999) }, NOW, DEADLINE_MS),
      ).toBe(false)
    }
  })

  it('an unreadable `updatedAt` reads as NOT stuck', () => {
    // Writing an error because we could not parse a timestamp is acting on a
    // data-shape bug, not on a real stall.
    for (const updatedAt of [null, undefined, 'not a date', '']) {
      expect(isStalledPublish({ publicationStatus: 'publishing', updatedAt }, NOW, DEADLINE_MS)).toBe(
        false,
      )
    }
  })
})

describe('stalledPublishReason — the two stalls are not the same story', () => {
  it('🔴 says nothing was sent when the enqueue never landed', () => {
    const reason = stalledPublishReason({ publicationStatus: 'publishing' }, 30)
    expect(reason).toContain(STALLED_PUBLISH_CODE)
    expect(reason).toContain('No se envió nada')
    expect(reason).toContain('30')
  })

  it('🔴 does NOT claim nothing happened when ai-service accepted the job', () => {
    // It may have finished. Telling the user "nothing was sent" here would be a
    // false statement that invites a duplicate publish.
    const reason = stalledPublishReason(
      { publicationStatus: 'publishing', publishIngestId: 'ing-1' },
      30,
    )
    expect(reason).not.toContain('No se envió nada')
    expect(reason).toContain('Puede haber terminado sin avisar')
  })

  it('is in Spanish, because it lands in a user-visible field', () => {
    const reason = stalledPublishReason({ publicationStatus: 'unpublishing' }, 30)
    expect(reason).toMatch(/servicio de IA|volver a intentarlo/i)
  })
})

describe('sweepStalledPublishes', () => {
  it('🔴 stamps a visible error and changes NOTHING else', async () => {
    const { payload, update } = fakePayload([
      { id: 1, publicationStatus: 'publishing', updatedAt: minutesAgo(60) },
    ])

    const result = await sweepStalledPublishes(payload, { now: NOW, deadlineMs: DEADLINE_MS })

    expect(result).toEqual({ examined: 1, stalled: 1, neverEnqueued: 1 })
    const data = update.mock.calls[0]![0].data
    // 🔴 The whole restraint of this janitor, asserted: ONE field.
    expect(Object.keys(data)).toEqual(['publicationError'])
    expect(String(data.publicationError)).toContain(STALLED_PUBLISH_CODE)
    expect(data.publicationStatus).toBeUndefined()
    expect(data.publishIngestId).toBeUndefined()
  })

  it('🔴 never re-drives the publish — no client is even reachable from here', async () => {
    // `sweepStalledPublishes` takes only `find` and `update`. It has no ai-service
    // client and no way to enqueue, by construction rather than by discipline.
    // Re-publishing 145 documents on a timer would recreate the rate-limit burst
    // that produced these rows in the first place.
    const { payload, update } = fakePayload([
      { id: 1, publicationStatus: 'publishing', publishIngestId: 'ing-9', updatedAt: minutesAgo(60) },
    ])
    await sweepStalledPublishes(payload, { now: NOW, deadlineMs: DEADLINE_MS })
    expect(update).toHaveBeenCalledTimes(1)
    expect(update.mock.calls[0]![0].data).not.toHaveProperty('publicationStatus')
  })

  it('leaves fresh and already-visible rows untouched', async () => {
    const { payload, update } = fakePayload([
      { id: 1, publicationStatus: 'publishing', updatedAt: minutesAgo(5) },
      {
        id: 2,
        publicationStatus: 'publishing',
        publicationError: 'Rate limit exceeded.',
        updatedAt: minutesAgo(99),
      },
      { id: 3, publicationStatus: 'publishing', updatedAt: minutesAgo(99) },
    ])

    const result = await sweepStalledPublishes(payload, { now: NOW, deadlineMs: DEADLINE_MS })

    expect(result.examined).toBe(3)
    expect(result.stalled).toBe(1)
    expect(update).toHaveBeenCalledTimes(1)
    expect(update.mock.calls[0]![0].id).toBe(3)
  })

  it('counts the invisible ones separately — they are the ones that alarmed us', async () => {
    const { payload } = fakePayload([
      { id: 1, publicationStatus: 'publishing', updatedAt: minutesAgo(60) },
      { id: 2, publicationStatus: 'publishing', publishIngestId: 'ing-2', updatedAt: minutesAgo(60) },
    ])
    const result = await sweepStalledPublishes(payload, { now: NOW, deadlineMs: DEADLINE_MS })
    expect(result).toEqual({ examined: 2, stalled: 2, neverEnqueued: 1 })
  })

  it('🔴 asks for the OLDEST rows first, so a backlog cannot starve the sweep', async () => {
    const { payload, find } = fakePayload([])
    await sweepStalledPublishes(payload, { now: NOW })
    const args = find.mock.calls[0]![0]
    expect(args.sort).toBe('updatedAt')
    expect(args.where).toEqual({ publicationStatus: { in: ['publishing', 'unpublishing'] } })
  })

  it('one bad row does not abandon the rest', async () => {
    const warn = vi.fn()
    const { payload, update } = fakePayload([
      { id: 1, publicationStatus: 'publishing', updatedAt: minutesAgo(60) },
      { id: 2, publicationStatus: 'publishing', updatedAt: minutesAgo(60) },
    ])
    ;(update as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new Error('row vanished mid-sweep')
    })

    const result = await sweepStalledPublishes(payload, {
      now: NOW,
      deadlineMs: DEADLINE_MS,
      log: { warn },
    })

    expect(result.stalled).toBe(1)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('survives a find that returns nothing at all', async () => {
    const { payload } = fakePayload([])
    await expect(sweepStalledPublishes(payload, { now: NOW })).resolves.toEqual({
      examined: 0,
      stalled: 0,
      neverEnqueued: 0,
    })
  })
})

describe('scheduling', () => {
  it('is ON by default — it only makes an invisible state visible', () => {
    expect(publishJanitorEnabled()).toBe(true)
    expect(stuckAfterMs()).toBe(DEFAULT_STUCK_MIN * 60_000)
  })

  it('can be switched off, and says what that costs', () => {
    const logger = { info: vi.fn(), error: vi.fn() }
    process.env[PUBLISH_JANITOR_ENABLED_VAR] = 'false'
    expect(publishJanitorEnabled()).toBe(false)
    expect(startPublishJanitor({ logger } as unknown as Payload)).toBe(false)
    expect(String(logger.info.mock.calls[0]![0])).toContain('indefinitely')
  })

  it('honours the interval and deadline overrides, with a one-minute floor', () => {
    process.env[PUBLISH_JANITOR_INTERVAL_MIN_VAR] = '0'
    expect(publishJanitorIntervalMs()).toBe(15 * 60_000) // 0 is not > 0 → default
    process.env[PUBLISH_JANITOR_INTERVAL_MIN_VAR] = '3'
    expect(publishJanitorIntervalMs()).toBe(3 * 60_000)
    process.env[PUBLISH_JANITOR_STUCK_MIN_VAR] = '90'
    expect(stuckAfterMs()).toBe(90 * 60_000)
  })

  it('arming is idempotent and does not sweep on the spot', () => {
    const find = vi.fn(async () => ({ docs: [] }))
    const payload = { logger: { info: vi.fn(), error: vi.fn() }, find, update: vi.fn() }
    expect(startPublishJanitor(payload as unknown as Payload)).toBe(true)
    expect(startPublishJanitor(payload as unknown as Payload)).toBe(true)
    // The first sweep is one interval away, so a deploy never stamps anything
    // the instant it boots.
    expect(find).not.toHaveBeenCalled()
  })
})
