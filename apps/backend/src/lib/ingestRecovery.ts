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
 *      callback only persists the text and writes `transcribed`, and this sweep
 *      runs `enqueueIngestForDoc` — the same function every other path uses.
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
import { relationId } from './permissions'

export const INGEST_RECOVERY_ENABLED_VAR = 'INGEST_RECOVERY_JANITOR_ENABLED'
export const INGEST_RECOVERY_INTERVAL_MIN_VAR = 'INGEST_RECOVERY_JANITOR_INTERVAL_MIN'
export const TRANSCRIBED_DRIVE_MIN_VAR = 'INGEST_RECOVERY_TRANSCRIBED_MIN'
export const STAGE_STUCK_MIN_VAR = 'INGEST_RECOVERY_STAGE_STUCK_MIN'
export const MESSAGE_STUCK_MIN_VAR = 'INGEST_RECOVERY_MESSAGE_STUCK_MIN'

/**
 * Every minute (the scheduler's floor). This sweep is now the step that moves
 * a finished transcript into the ingest, so its interval IS added latency on
 * every audio upload. inferred: one transcript adds ≤ interval + the
 * `transcribed` age below, about 2 minutes; not measured.
 */
export const DEFAULT_INTERVAL_MIN = 1

/**
 * A `transcribed` row is driven once it is this old. The callback is the only
 * writer of `transcribed`, so this is a margin, not a wait for anything.
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
  return [
    { ingestStatus: { equals: 'transcribed' } },
    { ingestId: { exists: false } },
    { anonymisationStatus: { in: ['n/a', 'ready'] } },
    { publicationStatus: { equals: 'draft' } },
    { updatedAt: { less_than: cutoff } },
  ]
}

/** `extracting` that outlived its deadline. Gate state not settled by a human. */
export function stalledExtractingWhere(cutoff: string): Where[] {
  return [
    { ingestStatus: { equals: 'extracting' } },
    { ingestId: { exists: false } },
    { anonymisationStatus: { in: ['n/a', 'pending', 'ready'] } },
    { publicationStatus: { equals: 'draft' } },
    { kind: { in: [...PENDING_SWEEP_KINDS] } },
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
  opts: { limit: number; log?: Log; label: string },
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
      const res = await payload.update({
        collection: 'documents',
        where: { and: [{ id: { equals: doc.id } }, ...where] },
        data: { ingestStatus: 'failed', ingestError: reason.slice(0, 500) },
        overrideAccess: true,
        context: { __skipDocsExtract: true },
      })
      if (changed(res)) stalled += 1
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
    { limit: opts.limit ?? 500, log: opts.log, label: 'lost gate run' },
  )
}

/** The slice of a `transcribed` row the drive reads. */
interface TranscribedRow {
  id?: number | string
  organization?: unknown
  uploadedBy?: unknown
  name?: unknown
  kind?: unknown
  contentKind?: unknown
  lengua?: unknown
  anonymisationStatus?: unknown
  redactedText?: unknown
  extractedText?: unknown
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
    if (doc?.id == null) continue
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
        const res = await payload.update({
          collection: 'documents',
          where: { and: [{ id: { equals: docId } }, ...where] },
          data: { ingestStatus: 'failed', ingestError: refusal },
          overrideAccess: true,
          context: { __skipDocsExtract: true },
        })
        if (changed(res)) failed += 1
      } catch (err) {
        opts.log?.warn(
          { documentId: String(docId), err: err instanceof Error ? err.message : String(err) },
          '[ingest-recovery] could not fail out a transcript with no corpus',
        )
      }
      continue
    }

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
          lengua: str(doc.lengua),
          anonymisationStatus: str(doc.anonymisationStatus),
          redactedText: str(doc.redactedText),
        },
        extractedText: text,
      })
    } catch (err) {
      // The row stays where `enqueueIngestForDoc` left it; the next pass, or
      // the lost-gate / embedding sweeps, pick it up from there.
      opts.log?.warn(
        { documentId: String(docId), err: err instanceof Error ? err.message : String(err) },
        '[ingest-recovery] driving a transcript into the ingest threw',
      )
      continue
    }
    driven += 1

    // The audio path's corpus-graph trigger. Never throws, and passes NO text:
    // the graph re-reads the row and takes what the corpus got.
    await scheduleGraphExtractionForDoc({
      payload: payload as never,
      docId,
      organizationId: organizationId as number | string,
      fresh: { name: str(doc.name), contentKind: str(doc.contentKind) as never },
    })
  }

  return { examined: docs.length, driven, failed }
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
    await step('transcribed', () => driveTranscribedDocuments(payload, { log }))
    await step('extracting', () => sweepStalledExtracting(payload, { log }))
    await step('gate', () => sweepLostGateRuns(payload, { log }))
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
