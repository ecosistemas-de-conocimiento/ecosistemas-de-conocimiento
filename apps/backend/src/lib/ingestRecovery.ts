/**
 * 🔴 THE STATES NOTHING ELSE MOVES — and the one place the audio pipeline is
 * driven forward from.
 *
 * `embeddingJanitor.ts` covers `embedding`, and a narrow `pending` (a plain
 * `documento` whose background extract was lost). An audit (2026-10-17) found
 * four more shapes with nothing to move them. Measured on the local DB that
 * day: 8 `testimonio` rows at `ingestStatus: 'pending'` +
 * `anonymisationStatus: 'pending'` since 2026-09-08, and 3 `messages` at
 * `corpusStatus: 'embedding'` since 2026-08-28.
 *
 *   1. `transcribed` — the transcript is on the row and the ingest is not.
 *      🔴 THIS SWEEP DRIVES IT, it does not just stamp it. The audio callback
 *      (`app/api/ai-service/callback/route.ts`) used to run the anonymisation
 *      gate (two model calls) and the enqueue inside the webhook request;
 *      audio-service gives up after 20 s (`services/audio-service/app/config.py`)
 *      and the receiver answered 200 even when the handler threw. Now the
 *      callback only persists the text and writes `transcribed`, then starts
 *      `driveTranscribedDocument` detached (`lib/driveTranscribedSoon.ts`); this
 *      sweep is the safety net for a run that was dropped. Both run
 *      `enqueueIngestForDoc` — the same function every other path uses — behind
 *      one atomic claim, so only one of them ever drives a row.
 *      Re-driving is safe HERE (unlike `embedding`) because `enqueueIngestForDoc`
 *      writes `embedding` before it calls ai-service: a row still at
 *      `transcribed` has provably not been sent.
 *   2. `extracting` past its deadline — the extract or the gate that runs
 *      inside it was lost to a restart. Stamped `failed`, retryable.
 *   3. A lost GATE run — `anonymisationStatus: 'pending'` on a row that never
 *      reached `embedding` (`pending` or `transcribed`). The gate writes
 *      `pending` before its model calls; a restart in between leaves it there.
 *      Stamped `failed`, retryable (`planIngestRetry` clears the gate state).
 *   4. `messages.corpusStatus: 'embedding'` past its deadline. Read the
 *      ai-service job status first, like the document sweep does; otherwise
 *      stamp `failed`, which puts the turn back in the runnable set so the next
 *      message in the thread retries it.
 *
 *   5. A gate that could not RUN — the model never answered (429, 5xx, 402,
 *      timeout), so `enqueueIngestForDoc` wrote `ingestStatus: 'failed'` with
 *      `anonymisation_unavailable` and left the gate at `n/a`. 🔴 THIS SWEEP
 *      RE-DRIVES IT after a cooldown, a few rows per pass, through the same
 *      reset `POST /:id/retry` uses. Nothing was sent to the corpus, so a
 *      repeat cannot duplicate anything; it costs at most two model calls.
 *
 *   6. An audio drive's claim (`extracting`) with no live run behind it.
 *      🔴 HANDED BACK to `transcribed`, capped (`recoverAbandonedClaims`);
 *      nothing is sent before `embedding`. A hold whose `failed` write was
 *      lost is stamped `failed` and left for review (`sweepStalledHolds`).
 *
 * ⚠ 2–4 NEVER RE-DRIVE. Same reasons as `embeddingJanitor.ts`: an outcome we
 * cannot see, and a shared 100 req/min ai-service bucket.
 *
 * ⚠ EVERY CONDITION IS IN THE QUERY AND EVERY WRITE RE-ASSERTS IT — the
 * starvation rule and the race rule from `embeddingJanitor.ts`. A row a sweep
 * has handled leaves the predicate for good.
 *
 * ⚠ PUBLISHED ROWS ARE LEFT ALONE, as in the `pending` sweep: a retry re-runs
 * the DRAFT ingest, so failing a published row out would invite a second copy
 * in the uploader's private corpus.
 */

import type { Payload, Where } from 'payload'

import {
  DEFAULT_MAX_STATUS_READS,
  JOB_FAILED_REASON,
  PENDING_SWEEP_KINDS,
  type IngestJobStatus,
} from './embeddingJanitor'
import {
  janitorEnabledFromEnv,
  janitorIntervalMsFromEnv,
  startJanitor,
  stopJanitor,
} from './janitorScheduler'
import { GATE_UNAVAILABLE_CODE, GATE_UNAVAILABLE_INGEST_CODE } from './anonymiseDocument'
import { updateDocumentColumns, type DocumentColumnsPayload } from './documentColumns'
import { relationId } from './permissions'

export const INGEST_RECOVERY_ENABLED_VAR = 'INGEST_RECOVERY_JANITOR_ENABLED'
export const INGEST_RECOVERY_INTERVAL_MIN_VAR = 'INGEST_RECOVERY_JANITOR_INTERVAL_MIN'
export const TRANSCRIBED_DRIVE_MIN_VAR = 'INGEST_RECOVERY_TRANSCRIBED_MIN'
export const STAGE_STUCK_MIN_VAR = 'INGEST_RECOVERY_STAGE_STUCK_MIN'
export const MESSAGE_STUCK_MIN_VAR = 'INGEST_RECOVERY_MESSAGE_STUCK_MIN'
export const GATE_RETRY_MIN_VAR = 'INGEST_RECOVERY_GATE_RETRY_MIN'
export const EXTRACTING_RECOVER_MIN_VAR = 'INGEST_RECOVERY_EXTRACTING_MIN'

/**
 * A row whose gate could not run is re-driven once it is this old. inferred:
 * longer than one ai-service rate-limit window (60 s) many times over, so a
 * burst has drained; short enough that a demo row recovers within the hour.
 */
export const DEFAULT_GATE_RETRY_MIN = 15

/** At most this many unavailable-gate rows are re-driven per pass. */
export const DEFAULT_GATE_RETRY_LIMIT = 5

/**
 * An audio row the drive claimed (`extracting`) with no gate run on it is
 * handed back to `transcribed` once it is this old. inferred: a live drive
 * leaves this shape within milliseconds (the gate writes `pending` or `n/a`,
 * then `embedding` follows), so ten minutes means the run is gone.
 */
export const DEFAULT_EXTRACTING_RECOVER_MIN = 10

/**
 * Drive tries per row (abandoned or thrown, one shared count) before the row
 * is failed out, retryable by a person. inferred: a row lost three times is
 * failing for a reason a re-drive will not fix.
 */
export const DEFAULT_EXTRACTING_RECOVER_ATTEMPTS = 3

/**
 * Every minute (the scheduler's floor). This sweep is now the step that moves
 * a finished transcript into the ingest, so its interval IS added latency on
 * every audio upload. inferred: one transcript adds ≤ interval + the
 * `transcribed` age below, about 2 minutes; not measured.
 */
export const DEFAULT_INTERVAL_MIN = 1

/**
 * A `transcribed` row is driven once it is this old. The callback is the only
 * writer of `transcribed` and it starts the drive itself, so this is a head
 * start for that run, not a wait for a commit. Safety rests on the claim in
 * {@link driveTranscribedDocument}, not on this age.
 */
export const DEFAULT_TRANSCRIBED_DRIVE_MIN = 1

/**
 * `extracting` and a lost gate run. inferred from the code path: extraction is
 * synchronous (seconds) and the gate is two model calls (seconds to a minute);
 * an hour is far past both. Same number as the `pending` sweep.
 */
export const DEFAULT_STAGE_STUCK_MIN = 60

/** A chat turn at `embedding`. Same deadline as a document, for the same reason. */
export const DEFAULT_MESSAGE_STUCK_MIN = 30

/**
 * ai-service job-status reads per pass for chat turns. This sweep runs every
 * minute against a `/v1` bucket of 100 req/min shared by every consumer
 * (quoted from `embeddingJanitor.ts`), so it reads far fewer than the
 * 15-minute document sweep's {@link DEFAULT_MAX_STATUS_READS}.
 */
export const DEFAULT_MESSAGE_STATUS_READS = 5

/** At most this many transcripts go through the gate + enqueue per pass. */
export const DEFAULT_DRIVE_LIMIT = 20

export const EXTRACTION_STALLED_CODE = 'extraction_stalled'
export const GATE_STALLED_CODE = 'anonymisation_stalled'
export const NO_TENANT_CODE = 'no_tenant'
export const EMPTY_TRANSCRIPT_CODE = 'empty_transcript'
export const MESSAGE_STALLED_CODE = 'embedding_stalled'
/** Written by {@link recoverAbandonedClaims}: `extracting_recovered: <n>/<cap>`. */
export const EXTRACTING_RECOVERED_CODE = 'extracting_recovered'
export const HELD_CODE = 'anonymisation_held'

function minutesFromEnv(varName: string, fallback: number): number {
  const raw = Number(process.env[varName])
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

const cutoffIso = (now: Date, ms: number): string => new Date(now.getTime() - ms).toISOString()

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/**
 * A transcript ready to go through the gate and into the ingest.
 *
 * ⚠ `anonymisationStatus` is `n/a` or `ready`, never `pending`: a `pending`
 * gate on a `transcribed` row is a gate run that was lost (or is running right
 * now), and re-driving it on every pass would bill the gate's model calls in a
 * loop. {@link lostGateRunWhere} owns that shape. `held` / `rejected` /
 * `approved` never sit at `transcribed`.
 */
export function transcribedWhere(cutoff: string): Where[] {
  return [...transcribedClaimWhere(), { updatedAt: { less_than: cutoff } }]
}

/**
 * {@link transcribedWhere} without the age clause: the guard on the CLAIM in
 * {@link driveTranscribedDocument}. The callback's immediate drive uses it
 * as-is; the sweep adds its cutoff.
 */
export function transcribedClaimWhere(): Where[] {
  return [
    { ingestStatus: { equals: 'transcribed' } },
    { ingestId: { exists: false } },
    { anonymisationStatus: { in: ['n/a', 'ready'] } },
    { publicationStatus: { equals: 'draft' } },
  ]
}

/**
 * `extracting` that outlived its deadline. Gate state not settled by a human.
 *
 * ⚠ NOT AUDIO. An audio row reaches `extracting` only through the claim in
 * {@link driveTranscribedDocument}, and {@link recoverAbandonedClaims} owns
 * it: it hands the row back, and fails it out itself once the cap is reached.
 */
export function stalledExtractingWhere(cutoff: string): Where[] {
  return [
    { ingestStatus: { equals: 'extracting' } },
    { ingestId: { exists: false } },
    { anonymisationStatus: { in: ['n/a', 'pending', 'ready'] } },
    { publicationStatus: { equals: 'draft' } },
    { kind: { in: PENDING_SWEEP_KINDS.filter((k) => k !== 'audio') } },
    { updatedAt: { less_than: cutoff } },
  ]
}

/**
 * A drive's claim with no live run behind it: an audio row at `extracting`,
 * never sent (no `ingestId`; the row would be `embedding` past the send).
 *
 *   `gate: 'none'`     the gate never ran (`n/a`) or finished `ready`.
 *   `gate: 'pending'`  a gate run started and did not finish.
 */
export function abandonedClaimWhere(cutoff: string, gate: 'none' | 'pending'): Where[] {
  return [
    { ingestStatus: { equals: 'extracting' } },
    { kind: { equals: 'audio' } },
    { ingestId: { exists: false } },
    gate === 'pending'
      ? { anonymisationStatus: { equals: 'pending' } }
      : { anonymisationStatus: { in: ['n/a', 'ready'] } },
    { publicationStatus: { equals: 'draft' } },
    { updatedAt: { less_than: cutoff } },
  ]
}

/**
 * The gate HELD the row, and the write that should have made it `failed` was
 * lost, so it shows a spinner forever. Any kind: every path writes the hold
 * from inside `extracting` the same way.
 */
export function stalledHeldWhere(cutoff: string): Where[] {
  return [
    { ingestStatus: { equals: 'extracting' } },
    { anonymisationStatus: { equals: 'held' } },
    { ingestId: { exists: false } },
    { updatedAt: { less_than: cutoff } },
  ]
}

/**
 * A gate run that started and never finished, on a row that never reached
 * `embedding`. `extracting` is excluded here because
 * {@link stalledExtractingWhere} already owns it.
 */
export function lostGateRunWhere(cutoff: string): Where[] {
  return [
    { ingestStatus: { in: ['pending', 'transcribed'] } },
    { anonymisationStatus: { equals: 'pending' } },
    { ingestId: { exists: false } },
    { publicationStatus: { equals: 'draft' } },
    { kind: { in: [...PENDING_SWEEP_KINDS] } },
    { updatedAt: { less_than: cutoff } },
  ]
}

/**
 * A draft whose gate could not run (see `GATE_UNAVAILABLE_INGEST_CODE`), waiting
 * for a retry. `n/a` re-asserts that no human decision sits on the row.
 */
export function unavailableGateWhere(cutoff: string): Where[] {
  return [
    { ingestStatus: { equals: 'failed' } },
    { ingestError: { like: `${GATE_UNAVAILABLE_INGEST_CODE}:` } },
    { anonymisationStatus: { equals: 'n/a' } },
    { ingestId: { exists: false } },
    { publicationStatus: { equals: 'draft' } },
    { updatedAt: { less_than: cutoff } },
  ]
}

/** A chat turn claimed for ingest and never confirmed. */
export function stalledMessageWhere(cutoff: string): Where[] {
  return [{ corpusStatus: { equals: 'embedding' } }, { updatedAt: { less_than: cutoff } }]
}

// ---------------------------------------------------------------------------
// Messages written onto rows (shown verbatim under "Detalle")
// ---------------------------------------------------------------------------

export function extractionStalledReason(minutes: number): string {
  return (
    `${EXTRACTION_STALLED_CODE}: la preparación del documento empezó pero lleva más de ` +
    `${minutes} minutos sin terminar. No se envió nada al servicio de IA, así que puedes ` +
    'volver a intentarlo. Si vuelve a pasar, avisa a quien administra la instalación.'
  )
}

export function gateStalledReason(minutes: number): string {
  return (
    `${GATE_STALLED_CODE}: la revisión de datos personales empezó pero no terminó en más de ` +
    `${minutes} minutos. No se envió nada al servicio de IA, así que puedes volver a ` +
    'intentarlo. Si vuelve a pasar, avisa a quien administra la instalación.'
  )
}

export function messageStalledReason(minutes: number): string {
  return (
    `${MESSAGE_STALLED_CODE}: el turno no se confirmó en el servicio de IA en más de ` +
    `${minutes} minutos; se reintentará con el siguiente mensaje.`
  )
}

// ---------------------------------------------------------------------------
// Sweeps
// ---------------------------------------------------------------------------

type Log = { warn(o: Record<string, unknown>, m: string): void }

interface SweepOpts {
  now?: Date
  deadlineMs?: number
  limit?: number
  log?: Log
}

export interface FailOutResult {
  examined: number
  stalled: number
}

/** Count what the database changed, not what we asked it to change. */
const changed = (res: unknown): boolean =>
  ((res as { docs?: unknown[] } | null)?.docs?.length ?? 0) > 0

/**
 * Find rows matching `where` and make each `failed` with `reason`, guarded on
 * the same `where` so a row that moved in between is left alone.
 */
async function failOutDocuments(
  payload: Pick<Payload, 'find' | 'update'>,
  where: Where[],
  reason: string,
  opts: { limit: number; log?: Log; label: string; extra?: Record<string, unknown> },
): Promise<FailOutResult> {
  const page = (await payload.find({
    collection: 'documents',
    where: { and: where },
    sort: 'updatedAt',
    limit: opts.limit,
    depth: 0,
    overrideAccess: true,
  })) as unknown as { docs?: Array<{ id?: number | string }> }
  const docs = page?.docs ?? []
  let stalled = 0
  for (const doc of docs) {
    if (doc?.id == null) continue
    try {
      const res = await updateDocumentColumns(payload as unknown as DocumentColumnsPayload, {
        id: doc.id,
        where,
        data: { ingestStatus: 'failed', ingestError: reason.slice(0, 500), ...(opts.extra ?? {}) },
      })
      if (res > 0) stalled += 1
    } catch (err) {
      opts.log?.warn(
        { documentId: String(doc.id), err: err instanceof Error ? err.message : String(err) },
        `[ingest-recovery] could not fail out a ${opts.label} row`,
      )
    }
  }
  return { examined: docs.length, stalled }
}

/** `extracting` past the deadline → `failed`, retryable. */
export function sweepStalledExtracting(
  payload: Pick<Payload, 'find' | 'update'>,
  opts: SweepOpts = {},
): Promise<FailOutResult> {
  const now = opts.now ?? new Date()
  const ms = opts.deadlineMs ?? minutesFromEnv(STAGE_STUCK_MIN_VAR, DEFAULT_STAGE_STUCK_MIN) * 60_000
  return failOutDocuments(
    payload,
    stalledExtractingWhere(cutoffIso(now, ms)),
    extractionStalledReason(Math.round(ms / 60_000)),
    { limit: opts.limit ?? 500, log: opts.log, label: 'stale extracting' },
  )
}

/** A gate run that never finished → `failed`, retryable. */
export function sweepLostGateRuns(
  payload: Pick<Payload, 'find' | 'update'>,
  opts: SweepOpts = {},
): Promise<FailOutResult> {
  const now = opts.now ?? new Date()
  const ms = opts.deadlineMs ?? minutesFromEnv(STAGE_STUCK_MIN_VAR, DEFAULT_STAGE_STUCK_MIN) * 60_000
  return failOutDocuments(
    payload,
    lostGateRunWhere(cutoffIso(now, ms)),
    gateStalledReason(Math.round(ms / 60_000)),
    {
      limit: opts.limit ?? 500,
      log: opts.log,
      label: 'lost gate run',
      /**
       * 🔴 THE GATE STATE TOO, not only the ingest. Left at `pending`, the row
       * was skipped forever: the seed's gate claim refuses `pending`
       * (`GATE_CLAIM_GUARD`), so a seed re-run never picked it up. `n/a` + the
       * unavailable code is the retryable "gate not run" state. It also voids
       * the lost run's token, so if that run is somehow still alive its final
       * write matches nothing.
       */
      extra: {
        anonymisationStatus: 'n/a',
        anonymisationError: `${GATE_UNAVAILABLE_CODE}: stalled: the gate run did not finish`,
      },
    },
  )
}

export interface RedriveResult {
  examined: number
  /** Reset to `pending`; the `afterChange` hook re-runs the gate. */
  redriven: number
}

/**
 * Re-run the gate for drafts it could not finish (case 5 in the header).
 *
 * ⚠ THE SAME RESET AS `POST /:id/retry` (`ingestStatus: 'pending'`, no
 * `__skipDocsExtract`), so the ordinary hook does the work. A row that fails
 * again comes back with a fresh `updatedAt` and waits another cooldown.
 */
export async function sweepUnavailableGateRuns(
  payload: Pick<Payload, 'find' | 'update'>,
  opts: SweepOpts = {},
): Promise<RedriveResult> {
  const now = opts.now ?? new Date()
  const ms = opts.deadlineMs ?? minutesFromEnv(GATE_RETRY_MIN_VAR, DEFAULT_GATE_RETRY_MIN) * 60_000
  const where = unavailableGateWhere(cutoffIso(now, ms))
  const page = (await payload.find({
    collection: 'documents',
    where: { and: where },
    sort: 'updatedAt',
    limit: opts.limit ?? DEFAULT_GATE_RETRY_LIMIT,
    depth: 0,
    overrideAccess: true,
  })) as unknown as { docs?: Array<{ id?: number | string }> }
  const docs = page?.docs ?? []
  let redriven = 0
  for (const doc of docs) {
    if (doc?.id == null) continue
    try {
      const res = await payload.update({
        collection: 'documents',
        where: { and: [{ id: { equals: doc.id } }, ...where] },
        data: { ingestStatus: 'pending', ingestError: null, ingestId: null },
        overrideAccess: true,
      })
      if (changed(res)) redriven += 1
    } catch (err) {
      opts.log?.warn(
        { documentId: String(doc.id), err: err instanceof Error ? err.message : String(err) },
        '[ingest-recovery] could not re-drive a row whose gate could not run',
      )
    }
  }
  return { examined: docs.length, redriven }
}

export interface RecoverResult {
  examined: number
  /** Handed back to `transcribed`; the next drive picks them up. */
  recovered: number
  /** At the cap: `failed`, retryable by a person. */
  failed: number
}

const RECOVERED_RE = new RegExp(`^${EXTRACTING_RECOVERED_CODE}: (\\d+)`)
const attemptsOf = (ingestError: unknown): number => {
  const m = RECOVERED_RE.exec(String(ingestError ?? ''))
  return m ? Number(m[1]) : 0
}

/** Why a row whose drive threw on every attempt was failed out. */
const EXTRACTION_THREW_REASON =
  `${EXTRACTION_STALLED_CODE}: la preparación del documento falló varias veces seguidas. ` +
  'No se envió nada al servicio de IA, así que puedes volver a intentarlo. Si vuelve a ' +
  'pasar, avisa a quien administra la instalación.'

/**
 * The write that ends a claim with no live run: back to `transcribed` with one
 * more attempt counted or, at the cap, the retryable failure. Shared by the
 * drive's own hand-back and {@link recoverAbandonedClaims}, so both spend one
 * budget.
 */
function handBack(attempts: number, cap: number, failReason: string): Record<string, unknown> {
  // `attempts` counts the tries already handed back; this one is the next.
  return attempts + 1 >= cap
    ? { ingestStatus: 'failed', ingestError: failReason.slice(0, 500) }
    : { ingestStatus: 'transcribed', ingestError: `${EXTRACTING_RECOVERED_CODE}: ${attempts + 1}/${cap}` }
}

/**
 * Hand an abandoned drive claim back to `transcribed` (owner's ruling,
 * 2026-10-22), so a run lost to a restart costs minutes, not a failed upload.
 *
 * 🔴 SAFE BECAUSE NOTHING IS SENT BEFORE `embedding`. Every row here is still
 * `extracting` with no `ingestId`, and `enqueueIngestForDoc` writes `embedding`
 * before it calls ai-service, so no copy exists in any corpus.
 *
 *   · No gate run (`n/a`/`ready`): after {@link DEFAULT_EXTRACTING_RECOVER_MIN}.
 *   · A gate run that never finished (`pending`): after the stage deadline
 *     ({@link DEFAULT_STAGE_STUCK_MIN}). 🔴 The SAME UPDATE voids the run's
 *     token (`n/a` + the unavailable code, as {@link sweepLostGateRuns} does),
 *     so a slow run that is still alive writes nothing when it finishes: its
 *     final write is guarded on `pending` + its token.
 *
 * ⚠ CAPPED. The attempt count rides in `ingestError` (no new column); the
 * claim leaves it alone and the `embedding` write clears it. At the cap the
 * row is failed out, retryable, instead: that is the end state, and it is why
 * {@link stalledExtractingWhere} leaves audio to this sweep. At most
 * {@link DEFAULT_GATE_RETRY_LIMIT} rows per shape per pass, like the gate
 * re-drive; the age threshold is the cooldown between attempts.
 *
 * ⚠ EVERY WRITE IS ONE CONDITIONAL UPDATE on the predicate it read with, and
 * every write moves the row off `extracting`, so a row that moved, or that a
 * second runner already recovered, changes 0 rows.
 */
export async function recoverAbandonedClaims(
  payload: Pick<Payload, 'find' | 'update'>,
  opts: SweepOpts & { gateDeadlineMs?: number; maxAttempts?: number } = {},
): Promise<RecoverResult> {
  const now = opts.now ?? new Date()
  const cap = opts.maxAttempts ?? DEFAULT_EXTRACTING_RECOVER_ATTEMPTS
  const shapes = [
    {
      gate: 'none' as const,
      ms:
        opts.deadlineMs ??
        minutesFromEnv(EXTRACTING_RECOVER_MIN_VAR, DEFAULT_EXTRACTING_RECOVER_MIN) * 60_000,
    },
    {
      gate: 'pending' as const,
      ms:
        opts.gateDeadlineMs ??
        minutesFromEnv(STAGE_STUCK_MIN_VAR, DEFAULT_STAGE_STUCK_MIN) * 60_000,
    },
  ]
  const result: RecoverResult = { examined: 0, recovered: 0, failed: 0 }
  for (const { gate, ms } of shapes) {
    const where = abandonedClaimWhere(cutoffIso(now, ms), gate)
    const page = (await payload.find({
      collection: 'documents',
      where: { and: where },
      sort: 'updatedAt',
      limit: opts.limit ?? DEFAULT_GATE_RETRY_LIMIT,
      depth: 0,
      overrideAccess: true,
    })) as unknown as { docs?: Array<{ id?: number | string; ingestError?: unknown }> }
    const docs = page?.docs ?? []
    result.examined += docs.length
    for (const doc of docs) {
      if (doc?.id == null) continue
      const attempts = attemptsOf(doc.ingestError)
      const exhausted = attempts + 1 >= cap
      const voidGateRun =
        gate === 'pending'
          ? {
              anonymisationStatus: 'n/a',
              anonymisationError: `${GATE_UNAVAILABLE_CODE}: stalled: the gate run did not finish`,
            }
          : {}
      try {
        const res = await updateDocumentColumns(payload as unknown as DocumentColumnsPayload, {
          id: doc.id,
          where,
          data: {
            ...handBack(attempts, cap, extractionStalledReason(Math.round(ms / 60_000))),
            ...voidGateRun,
          },
        })
        if (res > 0) {
          if (exhausted) result.failed += 1
          else result.recovered += 1
        }
      } catch (err) {
        opts.log?.warn(
          { documentId: String(doc.id), err: err instanceof Error ? err.message : String(err) },
          '[ingest-recovery] could not recover an abandoned drive claim',
        )
      }
    }
  }
  return result
}

/**
 * `extracting` + `held` → `failed` with the hold's code, what
 * `enqueueIngestForDoc` would have written. 🔴 NO AUTO-RETRY: a person
 * reviews holds. `anonymisationStatus` stays `held`, so the row stays in the
 * review queue (`lib/holdReview.ts` lists on it).
 */
export function sweepStalledHolds(
  payload: Pick<Payload, 'find' | 'update'>,
  opts: SweepOpts = {},
): Promise<FailOutResult> {
  const now = opts.now ?? new Date()
  const ms =
    opts.deadlineMs ??
    minutesFromEnv(EXTRACTING_RECOVER_MIN_VAR, DEFAULT_EXTRACTING_RECOVER_MIN) * 60_000
  return failOutDocuments(
    payload,
    stalledHeldWhere(cutoffIso(now, ms)),
    `${HELD_CODE}: the anonymisation gate held this document; it waits for review`,
    { limit: opts.limit ?? 500, log: opts.log, label: 'stalled hold' },
  )
}

/** The slice of a `transcribed` row the drive reads. */
export interface TranscribedRow {
  id?: number | string
  organization?: unknown
  uploadedBy?: unknown
  name?: unknown
  kind?: unknown
  contentKind?: unknown
  anonymise?: unknown
  /** The row's `keepPublicFigures` override (NULL = the ecosistema's). */
  keepPublicFigures?: unknown
  /** The row's `keepDocumentAuthor` / `keepCitedAuthors` overrides (NULL = the ecosistema's). */
  keepDocumentAuthor?: unknown
  keepCitedAuthors?: unknown
  lengua?: unknown
  anonymisationStatus?: unknown
  redactedText?: unknown
  extractedText?: unknown
  /** Carries the drive-try count (`extracting_recovered: n/cap`). */
  ingestError?: unknown
}

export interface DriveResult {
  examined: number
  /** Handed to `enqueueIngestForDoc` (which may still hold or fail it, visibly). */
  driven: number
  /** Failed out before the gate: no tenant, or no text. */
  failed: number
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/**
 * Run the gate and the enqueue for every `transcribed` row. The second half of
 * what `transcribe.completed` used to do inline.
 *
 * ⚠ Sequential on purpose: each row can cost two model calls and one ingest
 * request, and the ingest client already backs off on a 429.
 */
export async function driveTranscribedDocuments(
  payload: Pick<Payload, 'find' | 'update'>,
  opts: SweepOpts = {},
): Promise<DriveResult> {
  const now = opts.now ?? new Date()
  const ms =
    opts.deadlineMs ?? minutesFromEnv(TRANSCRIBED_DRIVE_MIN_VAR, DEFAULT_TRANSCRIBED_DRIVE_MIN) * 60_000
  const where = transcribedWhere(cutoffIso(now, ms))

  const page = (await payload.find({
    collection: 'documents',
    where: { and: where },
    sort: 'updatedAt',
    limit: opts.limit ?? DEFAULT_DRIVE_LIMIT,
    depth: 0,
    overrideAccess: true,
  })) as unknown as { docs?: TranscribedRow[] }
  const docs = page?.docs ?? []

  let driven = 0
  let failed = 0
  for (const doc of docs) {
    const outcome = await driveTranscribedDocument(payload, doc, { where, log: opts.log })
    if (outcome === 'driven') driven += 1
    if (outcome === 'failed') failed += 1
  }

  return { examined: docs.length, driven, failed }
}

/** What {@link driveTranscribedDocument} did with one row. */
export type DriveOutcome = 'driven' | 'failed' | 'skipped'

/**
 * Drive ONE `transcribed` row: the sweep's per-row step, also called straight
 * from the `transcribe.completed` callback (`lib/driveTranscribedSoon.ts`).
 *
 * 🔴 CLAIM, OR DO NOTHING. Before the gate, one conditional UPDATE moves the
 * row `transcribed` → `extracting` under `where` (default
 * {@link transcribedClaimWhere}) and counts the rows it changed. Two runners
 * holding the same row — the callback's and the sweep's — race on that one
 * statement; Postgres row-locks the UPDATE, the loser re-checks the WHERE
 * against the committed `extracting` and changes 0 rows, and returns
 * `skipped`. Without it the gate's own claim did not cover this: it accepts
 * `ready`, so a second runner arriving after the first gate finished would gate
 * (and enqueue) the transcript a second time.
 *
 * `extracting` is the state the pdf/docx path runs the gate in, so a run lost
 * to a restart is failed out, retryable, by {@link sweepStalledExtracting}.
 * A run that THROWS hands the row back to `transcribed` (guarded the same way),
 * so the next sweep re-drives it.
 */
export async function driveTranscribedDocument(
  payload: Pick<Payload, 'update'>,
  doc: TranscribedRow,
  opts: { where?: Where[]; log?: Log } = {},
): Promise<DriveOutcome> {
  if (doc?.id == null) return 'skipped'
  const where = opts.where ?? transcribedClaimWhere()
  const db = payload as unknown as DocumentColumnsPayload
  const docId = doc.id
  const organizationId = relationId(doc.organization)
  const uploadedById = relationId(doc.uploadedBy)
  const text = str(doc.extractedText) ?? ''

  // Refuse rather than guess: a guessed corpus is a cross-tenant write.
  const refusal =
    organizationId == null || uploadedById == null
      ? `${NO_TENANT_CODE}: the document has no ecosistema or uploader, so it has no corpus`
      : !text.trim()
        ? `${EMPTY_TRANSCRIPT_CODE}: no speech was detected in the recording`
        : null
  if (refusal) {
    try {
      // Guarded by the same `where`: a refusal is itself a claim.
      const res = await updateDocumentColumns(db, {
        id: docId,
        where,
        data: { ingestStatus: 'failed', ingestError: refusal },
      })
      if (res > 0) return 'failed'
    } catch (err) {
      opts.log?.warn(
        { documentId: String(docId), err: err instanceof Error ? err.message : String(err) },
        '[ingest-recovery] could not fail out a transcript with no corpus',
      )
    }
    return 'skipped'
  }

  // 🔴 THE CLAIM. See the doc comment. A throw here leaves the row untouched.
  const claimed = await updateDocumentColumns(db, {
    id: docId,
    where,
    data: { ingestStatus: 'extracting' },
  })
  if (claimed === 0) return 'skipped'

  const { enqueueIngestForDoc, scheduleGraphExtractionForDoc } = await import(
    '@/collections/Documents'
  )
  try {
    await enqueueIngestForDoc({
      payload,
      docId,
      organizationId: organizationId as number | string,
      uploadedById: uploadedById as number | string,
      fresh: {
        name: str(doc.name),
        kind: str(doc.kind) ?? 'audio',
        // 🔴 CARRIED, NOT DEFAULTED: the gate decides on this column, and a
        // Voz is normally a recording.
        contentKind: str(doc.contentKind) as never,
        // 🔴 Carried raw: a staff recording filed with "Anonimizar" is gated.
        anonymise: doc.anonymise,
        // 🔴 Carried raw (audit 2026-10-27): dropped, an override of `false`
        // would fall back to an ecosistema that says `true`.
        keepPublicFigures: doc.keepPublicFigures,
        // 🔴 Carried raw for the same reason (owner decision 2026-11-07).
        keepDocumentAuthor: doc.keepDocumentAuthor,
        keepCitedAuthors: doc.keepCitedAuthors,
        lengua: str(doc.lengua),
        anonymisationStatus: str(doc.anonymisationStatus),
        redactedText: str(doc.redactedText),
      },
      extractedText: text,
    })
  } catch (err) {
    opts.log?.warn(
      { documentId: String(docId), err: err instanceof Error ? err.message : String(err) },
      '[ingest-recovery] driving a transcript into the ingest threw',
    )
    // Hand the claim back so the next sweep re-drives the row. Only while it is
    // still OUR `extracting` with no gate run or verdict on it: past the
    // `embedding` write the row may have reached ai-service, and a `pending`
    // gate belongs to `recoverAbandonedClaims`. Otherwise it stays where
    // `enqueueIngestForDoc` left it, for the recovery / hold / embedding sweeps.
    //
    // 🔴 CAPPED, on the SAME counter as `recoverAbandonedClaims`: a run that
    // throws every time would otherwise re-gate every minute, paying for the
    // detector each time. The count is read off the row this run claimed (the
    // claim does not touch `ingestError`) and re-asserted in the UPDATE.
    try {
      await updateDocumentColumns(db, {
        id: docId,
        where: [
          { ingestStatus: { equals: 'extracting' } },
          { ingestId: { exists: false } },
          { anonymisationStatus: { in: ['n/a', 'ready'] } },
          { publicationStatus: { equals: 'draft' } },
          doc.ingestError == null
            ? { ingestError: { exists: false } }
            : { ingestError: { equals: doc.ingestError } },
        ],
        data: handBack(
          attemptsOf(doc.ingestError),
          DEFAULT_EXTRACTING_RECOVER_ATTEMPTS,
          EXTRACTION_THREW_REASON,
        ),
      })
    } catch {
      // Left at `extracting`: `recoverAbandonedClaims` takes it, on the same cap.
    }
    return 'skipped'
  }

  // The audio path's corpus-graph trigger. Never throws, and passes NO text:
  // the graph re-reads the row and takes what the corpus got.
  await scheduleGraphExtractionForDoc({
    payload: payload as never,
    docId,
    organizationId: organizationId as number | string,
    fresh: { name: str(doc.name), contentKind: str(doc.contentKind) as never },
  })
  return 'driven'
}

/** The slice of a `messages` row the message sweep reads. */
export interface StalledMessage {
  id?: number | string
  session?: unknown
  corpusIngestId?: string | null
}

export interface MessageSweepResult {
  examined: number
  /** Moved to `failed` with a stall reason. */
  stalled: number
  /** Moved to `ingested` / `failed` from the ai-service job status. */
  recovered: number
}

/**
 * The production reader: the turn's ecosistema (through its session), then a
 * GET on that org's app key. Read-only.
 */
export function messageJobStatusReader(
  payload: Pick<Payload, 'findByID'>,
): (message: StalledMessage) => Promise<IngestJobStatus> {
  return async (message) => {
    const sessionId = relationId(message.session)
    if (sessionId == null) throw new Error('message has no session')
    const session = (await payload.findByID({
      collection: 'sessions',
      id: sessionId as never,
      depth: 0,
      overrideAccess: true,
    })) as unknown as { organization?: unknown } | null
    const org = relationId(session?.organization)
    if (org == null) throw new Error('session has no ecosistema')
    const { getAppAIClient } = await import('./aiClient')
    return (await getAppAIClient(org).ingest.status(String(message.corpusIngestId))).status
  }
}

/**
 * Chat turns stuck at `embedding`. Same shape as `sweepStalledEmbeddings`:
 * ask ai-service first when there is a job id, stamp otherwise.
 *
 * ⚠ The stall stamp KEEPS `corpusIngestId`, so a late callback for that run is
 * still accepted (`dispatchConversationTurn` matches on it) and heals the turn.
 * A job ai-service reports `failed` clears it, exactly as the callback does.
 */
export async function sweepStalledMessages(
  payload: Pick<Payload, 'find' | 'update'>,
  opts: SweepOpts & {
    readIngestStatus?: (message: StalledMessage) => Promise<IngestJobStatus>
    maxStatusReads?: number
  } = {},
): Promise<MessageSweepResult> {
  const now = opts.now ?? new Date()
  const ms =
    opts.deadlineMs ?? minutesFromEnv(MESSAGE_STUCK_MIN_VAR, DEFAULT_MESSAGE_STUCK_MIN) * 60_000
  const where = stalledMessageWhere(cutoffIso(now, ms))
  const maxReads = opts.maxStatusReads ?? DEFAULT_MESSAGE_STATUS_READS

  const page = (await payload.find({
    collection: 'messages',
    where: { and: where },
    sort: 'updatedAt',
    limit: opts.limit ?? 500,
    depth: 0,
    overrideAccess: true,
  })) as unknown as { docs?: StalledMessage[] }
  const docs = page?.docs ?? []

  const write = (id: number | string, data: Record<string, unknown>) =>
    payload.update({
      collection: 'messages',
      where: { and: [{ id: { equals: id } }, ...where] },
      data,
      overrideAccess: true,
      // Without it the status write re-fires the hook that starts a run.
      context: { __skipConversationIngest: true },
    })

  let stalled = 0
  let recovered = 0
  let reads = 0
  for (const msg of docs) {
    if (msg?.id == null) continue
    try {
      if (opts.readIngestStatus && msg.corpusIngestId) {
        // Past the cap the row is SKIPPED, not stamped: the next pass reads it.
        if (reads >= maxReads) continue
        reads += 1
        let job: IngestJobStatus | null = null
        try {
          job = await opts.readIngestStatus(msg)
        } catch (err) {
          opts.log?.warn(
            { messageId: String(msg.id), err: err instanceof Error ? err.message : String(err) },
            '[ingest-recovery] could not read a chat turn’s ai-service job status — stamping the stall',
          )
        }
        if (job === 'processing') continue
        if (job) {
          const res = await write(
            msg.id,
            job === 'completed'
              ? { corpusStatus: 'ingested', corpusError: null }
              : { corpusStatus: 'failed', corpusIngestId: null, corpusError: JOB_FAILED_REASON },
          )
          if (changed(res)) recovered += 1
          continue
        }
      }
      const res = await write(msg.id, {
        corpusStatus: 'failed',
        corpusError: messageStalledReason(Math.round(ms / 60_000)),
      })
      if (changed(res)) stalled += 1
    } catch (err) {
      opts.log?.warn(
        { messageId: String(msg.id), err: err instanceof Error ? err.message : String(err) },
        '[ingest-recovery] could not move a stalled chat turn',
      )
    }
  }
  return { examined: docs.length, stalled, recovered }
}

// ---------------------------------------------------------------------------
// One pass + scheduling
// ---------------------------------------------------------------------------

let passRunning = false

/**
 * One pass of all four. Each is caught on its own so one throwing does not
 * skip the rest.
 *
 * ⚠ ONE PASS AT A TIME PER PROCESS. The drive can outlast the one-minute
 * interval (model calls), and two overlapping passes would gate and enqueue the
 * same transcript twice. A second tick while a pass runs is skipped.
 */
export async function runIngestRecoveryPass(
  payload: Pick<Payload, 'find' | 'update' | 'findByID'> & { logger: Payload['logger'] },
): Promise<Record<string, unknown> | null> {
  if (passRunning) return null
  passRunning = true
  const log = payload.logger
  const results: Record<string, unknown> = {}
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      results[name] = await fn()
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        `[ingest-recovery] the ${name} sweep threw`,
      )
    }
  }
  try {
    await step('recover', () => recoverAbandonedClaims(payload, { log }))
    await step('held', () => sweepStalledHolds(payload, { log }))
    await step('transcribed', () => driveTranscribedDocuments(payload, { log }))
    await step('extracting', () => sweepStalledExtracting(payload, { log }))
    await step('gate', () => sweepLostGateRuns(payload, { log }))
    await step('gate-unavailable', () => sweepUnavailableGateRuns(payload, { log }))
    await step('messages', () =>
      sweepStalledMessages(payload, { log, readIngestStatus: messageJobStatusReader(payload) }),
    )
  } finally {
    passRunning = false
  }
  return results
}

const JANITOR_PREFIX = 'ingest-recovery'

export function startIngestRecoveryJanitor(payload: Payload): boolean {
  return startJanitor(payload, {
    prefix: JANITOR_PREFIX,
    enabledVar: INGEST_RECOVERY_ENABLED_VAR,
    enabled: () => janitorEnabledFromEnv(INGEST_RECOVERY_ENABLED_VAR),
    intervalMs: () => janitorIntervalMsFromEnv(INGEST_RECOVERY_INTERVAL_MIN_VAR, DEFAULT_INTERVAL_MIN),
    disabledDetail:
      '🔴 A finished transcription will stay at ingestStatus="transcribed" and never be ' +
      'embedded, because this sweep is what runs the anonymisation gate and the ingest for it. ' +
      'Stuck extracting rows, lost gate runs and chat turns at embedding also stay invisible.',
    sweep: async (p) => {
      const results = await runIngestRecoveryPass(p)
      // Quiet when nothing moved: this runs every minute.
      const moved = Object.values(results ?? {}).some((r) =>
        Object.entries(r as Record<string, number>).some(([k, v]) => k !== 'examined' && v > 0),
      )
      if (moved) p.logger.info(results as object, '[ingest-recovery] moved rows')
    },
  })
}

export function stopIngestRecoveryJanitor(): void {
  stopJanitor(JANITOR_PREFIX)
}
