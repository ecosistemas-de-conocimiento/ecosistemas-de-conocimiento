/**
 * The sweep that stops a transcription waiting forever.
 *
 * 🔴 THE FAILURE IT COVERS IS INVISIBLE TO EVERY HEALTH CHECK. audio-service
 * runs as three containers; if the callback-worker one is missing or dead, every
 * transcription succeeds and not one webhook is delivered. `/health` and
 * `/health/ready` both pass — they check Redis and the model, not the delivery
 * queue. So the document sits in `transcribing`, which is genuinely
 * indistinguishable from "still working" because a real job takes as long as
 * the recording does.
 *
 * The asymmetry that shapes every threshold below: a FALSE POSITIVE fails a
 * document that was about to succeed, and the user's only recovery is to pay the
 * CPU-hours again. A FALSE NEGATIVE just means the row stays honest-looking a
 * while longer. So the deadline errs late, everywhere.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  STALLED_ERROR_CODE,
  TRANSCRIPTION_JANITOR_ENABLED_VAR,
  TRANSCRIPTION_JANITOR_INTERVAL_MIN_VAR,
  TRANSCRIPTION_MAX_DEADLINE_MS,
  TRANSCRIPTION_MIN_DEADLINE_MS,
  isTranscriptionStalled,
  sweepStalledTranscriptions,
  transcriptionDeadlineMs,
  transcriptionJanitorEnabled,
  transcriptionJanitorIntervalMs,
} from './transcriptionJanitor'

const NOW = new Date('2026-08-14T12:00:00.000Z')
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString()

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

// ── The deadline ───────────────────────────────────────────────────────────

describe('transcriptionDeadlineMs', () => {
  it('scales with the recording, because transcription runs at ~1x realtime', () => {
    // A fixed timeout is either too short (it kills real three-hour jobs) or
    // useless (a value safe for three hours says nothing about three minutes).
    const oneHour = transcriptionDeadlineMs({ audioMeta: { durationSeconds: 3600 } })
    const threeHours = transcriptionDeadlineMs({ audioMeta: { durationSeconds: 10_800 } })
    expect(threeHours).toBeGreaterThan(oneHour)
  })

  it('never drops below the floor, even for a 30-second voice note', () => {
    // 4x of 30 seconds is two minutes — short enough that a queue alone would
    // make it a false positive.
    expect(transcriptionDeadlineMs({ audioMeta: { durationSeconds: 30 } })).toBe(
      TRANSCRIPTION_MIN_DEADLINE_MS,
    )
  })

  it.each([
    ['missing audioMeta', undefined],
    ['a null duration', { durationSeconds: null }],
    ['a zero duration', { durationSeconds: 0 }],
    ['a NaN duration', { durationSeconds: Number.NaN }],
  ])('falls back to the floor with %s', (_label, audioMeta) => {
    // This happens when the submit succeeded but the follow-up write of
    // `durationSeconds` did not. Guessing short there would fail a job that is
    // running normally.
    expect(transcriptionDeadlineMs({ audioMeta })).toBe(TRANSCRIPTION_MIN_DEADLINE_MS)
  })

  it('is capped — audio-service refuses anything over 6 h', () => {
    expect(transcriptionDeadlineMs({ audioMeta: { durationSeconds: 999_999 } })).toBe(
      TRANSCRIPTION_MAX_DEADLINE_MS,
    )
  })
})

describe('isTranscriptionStalled', () => {
  it('leaves a job inside its own deadline alone', () => {
    // A 30-minute recording, 40 minutes in. That is a perfectly normal job.
    expect(
      isTranscriptionStalled(
        { updatedAt: minutesAgo(40), audioMeta: { durationSeconds: 1800 } },
        NOW,
      ),
    ).toBe(false)
  })

  it('flags a job far past any plausible duration', () => {
    // A 30-minute recording, five hours in. Nothing is coming.
    expect(
      isTranscriptionStalled(
        { updatedAt: minutesAgo(300), audioMeta: { durationSeconds: 1800 } },
        NOW,
      ),
    ).toBe(true)
  })

  it.each([['missing', null], ['unparseable', 'not-a-date']])(
    'treats a %s updatedAt as NOT stalled',
    (_label, updatedAt) => {
      // Destroying a user's work over a data-shape bug is the wrong side of the
      // asymmetry in the header.
      expect(isTranscriptionStalled({ updatedAt }, NOW)).toBe(false)
    },
  )
})

// ── The sweep ──────────────────────────────────────────────────────────────

describe('sweepStalledTranscriptions', () => {
  const updated: Array<Record<string, unknown>> = []
  let rows: Array<Record<string, unknown>> = []

  const payload = {
    find: async (args: Record<string, unknown>) => {
      // Only ever looks at rows the pipeline says are mid-transcription.
      expect(args.where).toEqual({ ingestStatus: { equals: 'transcribing' } })
      return { docs: rows }
    },
    update: async (args: Record<string, unknown>) => {
      updated.push(args)
      return {}
    },
  }

  beforeEach(() => {
    updated.length = 0
    rows = []
  })

  it('fails out the stalled ones and leaves the rest running', async () => {
    rows = [
      { id: 1, updatedAt: minutesAgo(400), audioMeta: { durationSeconds: 600 } },
      { id: 2, updatedAt: minutesAgo(5), audioMeta: { durationSeconds: 600 } },
    ]
    const result = await sweepStalledTranscriptions(payload as never, { now: NOW })
    expect(result).toEqual({ examined: 2, failed: 1 })
    expect(updated).toHaveLength(1)
    expect(updated[0]).toMatchObject({ id: 1, data: { ingestStatus: 'failed' } })
  })

  it('stamps a stable code the UI can translate, and names the likely cause', async () => {
    rows = [{ id: 1, updatedAt: minutesAgo(400), audioMeta: { durationSeconds: 600 } }]
    await sweepStalledTranscriptions(payload as never, { now: NOW })
    const reason = String((updated[0]!.data as Record<string, unknown>).ingestError)
    expect(reason).toMatch(new RegExp(`^${STALLED_ERROR_CODE}: `))
    // The operator reading this log line needs the one hypothesis that is almost
    // always right: the callback worker is not running.
    expect(reason).toContain('callback worker')
  })

  it('never reverts to `pending` and never touches the text', async () => {
    // A revert would look exactly like "still queued" — the state this whole
    // sweep exists to make impossible. And `extractedText` is the only copy of a
    // transcript that cost CPU-hours to produce.
    rows = [{ id: 1, updatedAt: minutesAgo(400) }]
    await sweepStalledTranscriptions(payload as never, { now: NOW })
    const body = JSON.stringify(updated)
    expect(body).not.toContain('pending')
    expect(body).not.toContain('extractedText')
  })

  it('skips the hook so failing a row cannot restart the pipeline', async () => {
    rows = [{ id: 1, updatedAt: minutesAgo(400) }]
    await sweepStalledTranscriptions(payload as never, { now: NOW })
    expect(updated[0]).toMatchObject({ context: { __skipDocsExtract: true } })
  })

  it('does nothing when there is nothing in flight', async () => {
    expect(await sweepStalledTranscriptions(payload as never, { now: NOW })).toEqual({
      examined: 0,
      failed: 0,
    })
  })
})

// ── Scheduling ─────────────────────────────────────────────────────────────

describe('scheduling', () => {
  it('is ON by default, unlike the session janitor', () => {
    // That janitor DELETES data, so it is opt-in. This one only converts an
    // already-broken invisible state into a visible, retryable one. The cost of
    // NOT running it is a document nobody can tell is stuck.
    vi.stubEnv(TRANSCRIPTION_JANITOR_ENABLED_VAR, '')
    expect(transcriptionJanitorEnabled()).toBe(true)
  })

  it.each(['0', 'false', 'off', 'no', 'FALSE'])('can be turned off with %s', (value) => {
    vi.stubEnv(TRANSCRIPTION_JANITOR_ENABLED_VAR, value)
    expect(transcriptionJanitorEnabled()).toBe(false)
  })

  it('defaults to a 15-minute interval', () => {
    vi.stubEnv(TRANSCRIPTION_JANITOR_INTERVAL_MIN_VAR, '')
    expect(transcriptionJanitorIntervalMs()).toBe(15 * 60_000)
  })

  it.each([['0'], ['-5'], ['nonsense']])(
    'refuses a nonsense interval of %s rather than becoming a query loop',
    (value) => {
      vi.stubEnv(TRANSCRIPTION_JANITOR_INTERVAL_MIN_VAR, value)
      expect(transcriptionJanitorIntervalMs()).toBeGreaterThanOrEqual(60_000)
    },
  )
})
