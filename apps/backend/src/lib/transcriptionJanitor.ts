/**
 * 🔴 THE STALLED-TRANSCRIPTION SWEEP — the backend's own safety net.
 *
 * ── The failure this exists for, stated precisely ────────────────────────────
 *
 * audio-service runs as THREE containers from one image: the API, the
 * transcription worker, and `audio-service-callbacks` (`arq
 * app.worker.CallbackWorkerSettings`). Leave the third one out, or let it die,
 * and this is what happens:
 *
 *   · uploads are accepted (the API is up),
 *   · transcriptions succeed (the worker is up),
 *   · and NOT ONE completion webhook is ever delivered.
 *
 * ⚠ NOTHING NOTICES. `/health` and `/health/ready` both pass — they check Redis
 * and the model, not the delivery queue. audio-service believes it did its job.
 * This backend is waiting for a callback that will never arrive. The document
 * sits in `ingestStatus: "transcribing"` forever, and "forever" is genuinely
 * indistinguishable from "still working" to a user, because a real
 * transcription legitimately takes as long as the recording does.
 *
 * audio-service's own reconciler does NOT cover this. It watches for jobs whose
 * row stops being touched and turns them into `transcribe.failed` — which it
 * then delivers over the very queue that is broken.
 *
 * So the only thing that can protect the user's document is a timeout on THIS
 * side. That is this file.
 *
 * ── Why the deadline is per-document and not a constant ──────────────────────
 *
 * Transcription runs at roughly 1× realtime on CPU with the default weights: a
 * ten-minute recording is a ten-minute job. A fixed timeout is therefore either
 * too short (it kills real three-hour jobs) or useless (a value safe for three
 * hours tells you nothing for three minutes). We know the duration from the
 * moment the job is accepted — audio-service runs ffprobe inline and returns it
 * on the 202 — so the deadline is derived from it.
 *
 * ⚠ THE MULTIPLIER IS DELIBERATELY GENEROUS. A false positive here fails a
 * document that was about to succeed, and the user's only recovery is to pay
 * the CPU-hours again. A false negative just means the row stays honest-looking
 * for longer. The two errors are not symmetric, so this errs late.
 */

import type { Payload } from 'payload'

import { updateDocumentColumns, type DocumentColumnsPayload } from './documentColumns'

import {
  janitorEnabledFromEnv,
  janitorIntervalMsFromEnv,
  startJanitor,
  stopJanitor,
} from './janitorScheduler'

/** Env var names, so log lines and tests never hand-type a string that can drift. */
export const TRANSCRIPTION_JANITOR_ENABLED_VAR = 'TRANSCRIPTION_JANITOR_ENABLED'
export const TRANSCRIPTION_JANITOR_INTERVAL_MIN_VAR = 'TRANSCRIPTION_JANITOR_INTERVAL_MIN'

/**
 * How much longer than the recording we are willing to wait.
 *
 * 4× covers the default weights at 1× realtime with a large margin for a queue,
 * a slow host, or a retry. It does NOT cover a machine an order of magnitude
 * slower than expected — that is a deployment problem, and a document failed
 * with a reason is a better outcome than one that waits silently forever.
 */
export const TRANSCRIPTION_SLACK_MULTIPLIER = 4

/**
 * Floor on the deadline, in ms.
 *
 * ⚠ Two jobs need it. A 30-second voice note whose deadline would otherwise be
 * two minutes — long enough for a queue to make it a false positive. And a
 * document with NO known duration, where we have nothing to multiply: that
 * happens when the submit succeeded but the follow-up write of
 * `audioMeta.durationSeconds` did not, and guessing short there would fail a
 * job that is running normally.
 */
export const TRANSCRIPTION_MIN_DEADLINE_MS = 90 * 60_000

/** Ceiling. audio-service refuses anything over 6h, so nothing can legitimately exceed this. */
export const TRANSCRIPTION_MAX_DEADLINE_MS = 8 * 60 * 60_000

/** Default sweep interval: every 15 minutes. */
const DEFAULT_INTERVAL_MIN = 15

/** The slice of a row this module reasons about. */
export interface StalledCandidate {
  id?: number | string
  /** When the row was last written. The transcription started at or before this. */
  updatedAt?: string | number | Date | null
  audioMeta?: { durationSeconds?: number | null } | null
}

/**
 * How long this particular transcription is allowed to take, in ms.
 *
 * Clamped at both ends: see the two constants above for why each bound exists.
 */
export function transcriptionDeadlineMs(candidate: StalledCandidate): number {
  const seconds = candidate.audioMeta?.durationSeconds
  const known = typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
  const derived = known ? seconds * 1000 * TRANSCRIPTION_SLACK_MULTIPLIER : 0
  return Math.min(
    TRANSCRIPTION_MAX_DEADLINE_MS,
    Math.max(TRANSCRIPTION_MIN_DEADLINE_MS, derived),
  )
}

/**
 * Has this transcription been "in progress" past any plausible duration?
 *
 * ⚠ An unreadable or missing `updatedAt` reads as NOT stalled. Failing a
 * document because we could not parse a timestamp would be destroying a user's
 * work over a data-shape bug — exactly the asymmetry the header describes.
 */
export function isTranscriptionStalled(candidate: StalledCandidate, now: Date): boolean {
  const updated =
    candidate.updatedAt == null ? NaN : new Date(candidate.updatedAt as string).getTime()
  if (!Number.isFinite(updated)) return false
  return now.getTime() - updated > transcriptionDeadlineMs(candidate)
}

/** The reason stamped on a row this sweep gives up on. Stable; the UI maps it. */
export const STALLED_ERROR_CODE = 'transcription_timed_out'

export interface SweepResult {
  /** Rows in `transcribing` that were examined. */
  examined: number
  /** Rows failed out because they were past their deadline. */
  failed: number
}

/**
 * One sweep: find every document stuck in `transcribing`, and fail out the ones
 * past their own deadline.
 *
 * ⚠ It fails them with a REASON and leaves them RETRYABLE
 * (`POST /api/documents/:id/retry`). It never deletes, never reverts to
 * `pending`, and never touches `extractedText` — a silent revert would look
 * exactly like "still queued" and is the behaviour this whole feature is
 * written to avoid.
 *
 * ⚠ It does NOT tell audio-service to stop. If the job is in fact still running
 * and the callback later arrives, the receiver's `transcribeId` guard still
 * matches and the transcript is applied — the row recovers on its own. Failing
 * here is a statement about what we can SEE, not a cancellation.
 */
export async function sweepStalledTranscriptions(
  payload: Pick<Payload, 'find' | 'update'>,
  opts: { now?: Date; limit?: number } = {},
): Promise<SweepResult> {
  const now = opts.now ?? new Date()
  const limit = opts.limit ?? 200

  const page = (await payload.find({
    collection: 'documents',
    where: { ingestStatus: { equals: 'transcribing' } },
    limit,
    depth: 0,
    overrideAccess: true,
  })) as unknown as { docs?: StalledCandidate[] }

  const docs = page?.docs ?? []
  let failed = 0

  for (const doc of docs) {
    if (doc?.id == null) continue
    if (!isTranscriptionStalled(doc, now)) continue

    const waitedMinutes = Math.round(transcriptionDeadlineMs(doc) / 60_000)
    // 🔴 Only the ingest columns, and only while the row is STILL
    // `transcribing`: a late `transcribe.completed` between the `find` and
    // this write wins instead of being overwritten. `lib/documentColumns.ts`.
    const changed = await updateDocumentColumns(payload as unknown as DocumentColumnsPayload, {
      id: doc.id,
      where: [{ ingestStatus: { equals: 'transcribing' } }],
      data: {
        ingestStatus: 'failed',
        ingestError:
          `${STALLED_ERROR_CODE}: no completion callback arrived within ${waitedMinutes} minutes. ` +
          'The transcription service may have finished without being able to deliver the result — ' +
          'check that the audio-service callback worker is running.',
      },
    })
    if (changed > 0) failed += 1
  }

  return { examined: docs.length, failed }
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/** Log tag, and the key the shared scheduler holds this janitor's timer under. */
const JANITOR_PREFIX = 'transcription-janitor'

/**
 * ON BY DEFAULT, unlike the session janitor.
 *
 * That janitor DELETES data, so it is opt-in. This one only converts an
 * already-broken invisible state into a visible, retryable one — the risk of
 * running it is small and the cost of not running it is a document that waits
 * forever with nobody able to tell. Set the var to `0` / `false` to disable.
 */
export function transcriptionJanitorEnabled(): boolean {
  return janitorEnabledFromEnv(TRANSCRIPTION_JANITOR_ENABLED_VAR)
}

export function transcriptionJanitorIntervalMs(): number {
  return janitorIntervalMsFromEnv(TRANSCRIPTION_JANITOR_INTERVAL_MIN_VAR, DEFAULT_INTERVAL_MIN)
}

/**
 * Arm the sweep. Idempotent. The timer, the one-interval delay before the first
 * pass and the catch around a throwing sweep all live in `janitorScheduler.ts`,
 * shared with the publish and embedding sweeps. `sweepStalledTranscriptions` is
 * exported so a cron can drive it instead.
 */
export function startTranscriptionJanitor(payload: Payload): boolean {
  return startJanitor(payload, {
    prefix: JANITOR_PREFIX,
    enabledVar: TRANSCRIPTION_JANITOR_ENABLED_VAR,
    enabled: transcriptionJanitorEnabled,
    intervalMs: transcriptionJanitorIntervalMs,
    disabledDetail:
      'A transcription whose completion callback is never delivered will stay in ' +
      'ingestStatus="transcribing" indefinitely with nothing to move it.',
    sweep: async (p) => {
      const result = await sweepStalledTranscriptions(p)
      if (result.failed > 0) {
        // ERROR, not warn: reaching here means completion callbacks are not
        // being delivered, which is an operational fault, not a user's file.
        p.logger.error(
          result,
          '[transcription-janitor] failed out transcriptions that never got a callback — ' +
            'check that the audio-service callback worker container is running',
        )
      }
    },
  })
}

/** Stop the interval (used by tests / graceful shutdown). */
export function stopTranscriptionJanitor(): void {
  stopJanitor(JANITOR_PREFIX)
}
