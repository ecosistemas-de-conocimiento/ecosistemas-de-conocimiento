/**
 * 🔴 THE STALLED-PUBLISH SWEEP — the safety net for the OTHER non-terminal state.
 *
 * `lib/transcriptionJanitor.ts` exists because `ingestStatus: 'transcribing'` is
 * a state nothing moves when the completion webhook is never delivered. This
 * file is the same argument for `publicationStatus`, and the gap was found the
 * expensive way.
 *
 * ── The incident, measured ───────────────────────────────────────────────────
 *
 * A seed published 285 documents at concurrency against an ai-service that caps
 * `/v1` at 100 requests per minute. Afterwards, in `edc_backend`:
 *
 *   · 145 documents in `publicationStatus: 'publishing'`,
 *   · 46 of them with a `publicationError` (visible, retryable — the system
 *     working as designed),
 *   · 99 with NO error and NO `publishIngestId`, which is not a state anyone
 *     designed. It reads to a user as "still working" and to an operator as
 *     nothing at all.
 *   · Frozen for 25+ minutes, because `payload.config.ts` armed the session and
 *     transcription janitors and nothing else.
 *
 * ⚠ THE ENQUEUE FIX ALONE IS NOT ENOUGH, which is why this file exists as well.
 * `publishDocument.ts` now backs off and stamps an error when it gives up — but
 * that only covers a failure this process SAW. The row is also stuck if the
 * process died between the status write and the enqueue, if ai-service accepted
 * the ingest and never called back, or if the callback arrived and its handler
 * threw. Those all produce the same invisible row and no code path is left
 * running to notice. A sweep is the only thing that covers a failure nobody was
 * around for.
 *
 * ── 🔴 WHAT THIS DELIBERATELY DOES NOT DO ────────────────────────────────────
 *
 * IT DOES NOT RE-DRIVE THE PUBLISH. It never calls `beginPublish`, never
 * enqueues, never touches a corpus. That restraint is the whole design, for two
 * independent reasons:
 *
 *   1. ⚠ THE OUTCOME IS UNKNOWABLE FROM HERE. A row at `publishing` with a
 *      `publishIngestId` may have an ingest that SUCCEEDED at ai-service and
 *      whose callback is merely late. Re-enqueueing would embed the document a
 *      second time into the shared corpus, and then the late callback would
 *      retire the draft copy for an ingest that had been superseded. Guessing
 *      turns one stuck row into two conflicting copies.
 *   2. ⚠ A SWEEP THAT RE-DRIVES IS A BURST GENERATOR. The state this cleans up
 *      was CAUSED by too many concurrent calls to a rate-limited service. A
 *      janitor that re-published 145 documents on a timer would recreate the
 *      exact overload it is cleaning up after, on a schedule, forever — and
 *      compete with every other consumer for the same per-key bucket.
 *
 * IT DOES NOT ROLL THE STATUS BACK TO `draft` either. That is this product's
 * existing rule (see `failPublish` in `publishDocument.ts`): `draft` means "this
 * was never attempted", and a half-finished copy may be sitting in the shared
 * corpus. `publishing` + a populated `publicationError` is the vocabulary for
 * "this tried and did not make it".
 *
 * ── So what DOES it do? ──────────────────────────────────────────────────────
 *
 * It writes down that the row is stuck. That is all, and it is the entire point:
 * it converts an invisible non-terminal state into a visible one that the user
 * can see and that `POST /api/documents/:id/{publish,unpublish}` can already act
 * on — that endpoint refuses only a row that has already REACHED its target
 * state, so a stamped `publishing` row stays retryable by the existing button.
 *
 * ⚠ IF THE INGEST WAS IN FACT STILL RUNNING, THE ROW SELF-HEALS. A late
 * `ingest.completed` callback still matches, `confirmPublish` still runs, and it
 * clears `publicationError` on its way to `published`. Stamping here is a
 * statement about what we can SEE, not a cancellation — exactly as in
 * `transcriptionJanitor.ts`.
 */

import type { Payload, Where } from 'payload'

import {
  janitorEnabledFromEnv,
  janitorIntervalMsFromEnv,
  startJanitor,
  stopJanitor,
} from './janitorScheduler'

/** Env var names, so log lines and tests never hand-type a string that can drift. */
export const PUBLISH_JANITOR_ENABLED_VAR = 'PUBLISH_JANITOR_ENABLED'
export const PUBLISH_JANITOR_INTERVAL_MIN_VAR = 'PUBLISH_JANITOR_INTERVAL_MIN'
export const PUBLISH_JANITOR_STUCK_MIN_VAR = 'PUBLISH_JANITOR_STUCK_MIN'

/**
 * How long a publish move may sit in flight before we call it stuck, in minutes.
 *
 * ⚠ THIS IS A CONSTANT, UNLIKE THE TRANSCRIPTION DEADLINE, and the difference is
 * real rather than an oversight. Transcription time is proportional to the
 * recording, which we know, so that janitor derives a per-document deadline. An
 * embed is proportional to nothing we hold: one document's chunks take seconds,
 * and the only thing that stretches it is a queue at ai-service, which is a
 * property of the deployment and not of the row.
 *
 * 30 minutes is therefore sized for "the worker queue is badly backed up", not
 * for "this document is large". It is roughly two orders of magnitude above the
 * happy path.
 *
 * ⚠ ERRING LATE IS CHEAP HERE, unlike in the transcription sweep. That one sets
 * `ingestStatus: 'failed'` and a false positive costs the user CPU-hours of
 * re-transcription. This one only writes a message, changes no status, and is
 * cleared automatically if the callback later arrives. So the bound can be
 * comfortable without much at stake either way.
 */
export const DEFAULT_STUCK_MIN = 30

/** Default sweep interval: every 15 minutes, like the transcription janitor. */
const DEFAULT_INTERVAL_MIN = 15

/**
 * The two non-terminal publication states.
 *
 * ⚠ Kept as a literal list rather than derived from `PUBLICATION_STATES` minus
 * the terminal ones: a new state added there must be a deliberate decision here,
 * not something this sweep silently starts writing errors onto.
 */
export const IN_FLIGHT_PUBLICATION_STATES = ['publishing', 'unpublishing'] as const

/** The reason stamped on a row this sweep gives up on. Stable; used by tests and support. */
export const STALLED_PUBLISH_CODE = 'publish_stalled'

/** The slice of a row this module reasons about. */
export interface StalledPublishCandidate {
  id?: number | string
  publicationStatus?: unknown
  /** Non-empty means the failure is ALREADY visible — see {@link isStalledPublish}. */
  publicationError?: string | null
  /** Set once the ingest was accepted. Its absence says the enqueue never landed. */
  publishIngestId?: string | null
  /**
   * When the row was last written. The publish move started at or before this.
   *
   * ⚠ ANY OTHER WRITE TO THE ROW RESETS THIS CLOCK — an admin edit, a metadata
   * backfill, a re-save. The effect is always to delay the sweep, never to
   * trigger it early, which is the harmless direction.
   */
  updatedAt?: string | number | Date | null
}

export function stuckAfterMs(): number {
  const raw = Number(process.env[PUBLISH_JANITOR_STUCK_MIN_VAR])
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STUCK_MIN
  return minutes * 60_000
}

/**
 * Is this row stuck in flight with nothing written down?
 *
 * Three conditions, each of which the sweep would be wrong without:
 *
 *   · the status is one of the in-flight states;
 *   · `publicationError` is EMPTY. ⚠ A row that already carries an error is
 *     already visible and already retryable, and overwriting it would replace
 *     ai-service's specific diagnosis ("Rate limit exceeded", "embedding model
 *     unavailable") with this file's generic one. Losing the real reason to a
 *     timeout message is a downgrade, and it would happen on every sweep;
 *   · `updatedAt` is older than the deadline.
 *
 * ⚠ AN UNREADABLE OR MISSING `updatedAt` READS AS NOT STUCK. Same asymmetry as
 * the transcription sweep: writing an error onto a row because we could not
 * parse its timestamp is acting on a data-shape bug.
 */
export function isStalledPublish(
  candidate: StalledPublishCandidate,
  now: Date,
  deadlineMs: number = stuckAfterMs(),
): boolean {
  const status = String(candidate.publicationStatus ?? '')
  if (!(IN_FLIGHT_PUBLICATION_STATES as readonly string[]).includes(status)) return false
  if (typeof candidate.publicationError === 'string' && candidate.publicationError.trim() !== '') {
    return false
  }
  const updated =
    candidate.updatedAt == null ? NaN : new Date(candidate.updatedAt as string).getTime()
  if (!Number.isFinite(updated)) return false
  return now.getTime() - updated > deadlineMs
}

/**
 * The Spanish message written onto a stuck row.
 *
 * ⚠ IT SPLITS ON `publishIngestId`, because the two cases are genuinely
 * different things to have happened and the user's next move differs:
 *
 *   · no ingest id → the request never reached ai-service. Nothing was sent,
 *     nothing is half-done, retrying is unambiguously safe. This is the 99-row
 *     case from the incident.
 *   · an ingest id → ai-service accepted the job and never reported back. It may
 *     have finished. Retrying is still allowed, but we must not tell the user
 *     that nothing happened, because something may well have.
 */
export function stalledPublishReason(candidate: StalledPublishCandidate, waitedMinutes: number): string {
  const accepted = typeof candidate.publishIngestId === 'string' && candidate.publishIngestId !== ''
  const action = candidate.publicationStatus === 'unpublishing' ? 'El cambio' : 'La publicación'
  if (!accepted) {
    return (
      `${STALLED_PUBLISH_CODE}: ${action.toLowerCase()} no llegó a enviarse al servicio de IA ` +
      `y lleva más de ${waitedMinutes} minutos sin avanzar. No se envió nada, así que puedes ` +
      'volver a intentarlo.'
    )
  }
  return (
    `${STALLED_PUBLISH_CODE}: ${action.toLowerCase()} se envió al servicio de IA pero no hubo ` +
    `respuesta en más de ${waitedMinutes} minutos. Puede haber terminado sin avisar. ` +
    'Vuelve a intentarlo o pide ayuda al equipo antes de repetir el envío.'
  )
}

export interface PublishSweepResult {
  /** Rows in an in-flight publication state that were examined. */
  examined: number
  /** Rows stamped with a visible error because they were past the deadline. */
  stalled: number
  /** Of those, how many never got as far as an ingest id. The invisible ones. */
  neverEnqueued: number
}

/**
 * One sweep: find every document stuck mid-publish and make the stall VISIBLE.
 *
 * ⚠ It writes ONLY `publicationError`. No status change, no corpus call, no
 * re-enqueue. See the file header for why re-driving would be worse than doing
 * nothing.
 *
 * ⚠ One row's write failing does not abandon the rest — the whole point is the
 * batch, and a single bad row (deleted mid-sweep, say) must not hide 144 others.
 */
export async function sweepStalledPublishes(
  payload: Pick<Payload, 'find' | 'update'>,
  opts: { now?: Date; limit?: number; deadlineMs?: number; log?: { warn(o: Record<string, unknown>, m: string): void } } = {},
): Promise<PublishSweepResult> {
  const now = opts.now ?? new Date()
  const deadlineMs = opts.deadlineMs ?? stuckAfterMs()
  const limit = opts.limit ?? 500

  /**
   * 🔴 EVERY CONDITION IS IN THE QUERY, NOT JUST IN THE LOOP — and the middle
   * one is a starvation fix, not an optimisation.
   *
   * An earlier version filtered on status alone and relied on `sort: 'updatedAt'`
   * to keep already-errored rows out of the way. That reasoning was wrong. Rows
   * carrying a `publicationError` never leave `publishing` — only a user retry
   * clears one — and the ones stamped by `failPublish` (from the enqueue path
   * and from the ai-service callback) keep their OLD `updatedAt` forever. So
   * they sort FIRST, not last. Once more than `limit` of them exist — and one
   * seed produced 145 in a single run — they would permanently fill the page
   * and a genuinely new invisible stall would never be examined at all.
   */
  const cutoff = new Date(now.getTime() - deadlineMs).toISOString()
  const stalledWhere: Where[] = [
    { publicationStatus: { in: [...IN_FLIGHT_PUBLICATION_STATES] } },
    // Already visible, already retryable — and overwriting ai-service's specific
    // diagnosis with this file's generic one would be a downgrade.
    //
    // ⚠ PAYLOAD COMPILES `exists: false` TO `IS NULL` ALONE, so a row holding an
    // EMPTY STRING is not a candidate here and this sweep can never rescue it —
    // while the UI, which shows the error only when populated, does not show it
    // either. That row would be stuck at `publishing` forever with nobody able
    // to tell. The empty string is therefore forbidden at the only place that
    // writes the field (`failPublish` in `publishDocument.ts` substitutes
    // `UNEXPLAINED_PUBLISH_FAILURE`), rather than papered over with an `or` here
    // that would leave the bad value in the database.
    { publicationError: { exists: false } },
    { updatedAt: { less_than: cutoff } },
  ]

  const page = (await payload.find({
    collection: 'documents',
    where: { and: stalledWhere },
    // Oldest first: if the page is full, the rows most certainly stuck are the
    // ones that get looked at.
    sort: 'updatedAt',
    limit,
    depth: 0,
    overrideAccess: true,
  })) as unknown as { docs?: StalledPublishCandidate[] }

  const docs = page?.docs ?? []
  const waitedMinutes = Math.round(deadlineMs / 60_000)
  let stalled = 0
  let neverEnqueued = 0

  for (const doc of docs) {
    if (doc?.id == null) continue
    // Belt and braces. The query above already excluded everything this rejects;
    // keeping the predicate here is what makes the rule unit-testable and what
    // catches a future edit that loosens the `where`.
    if (!isStalledPublish(doc, now, deadlineMs)) continue

    try {
      /**
       * 🔴 CONDITIONAL ON THE ROW STILL BEING STUCK. Updating by `id` alone
       * raced the very callback this sweep is waiting for.
       *
       * The gap between the `find` and this write is real — up to `limit`
       * sequential updates — and the 30-minute deadline is sized for "the
       * ai-service queue is badly backed up", which is precisely when a
       * callback lands around the deadline. Lose that race and `confirmPublish`
       * has already set `published` + `publicationError: null`, and we would
       * stamp `publish_stalled` onto a document that published perfectly.
       * Nothing ever clears `publicationError` on a `published` row, so that
       * false alarm would be permanent.
       *
       * With the guard the late-callback case is simply a no-op, which is the
       * honest outcome: the row is fine and there was nothing to report.
       * Same `where` shape as `holdReview.ts`'s settle.
       */
      const res = (await payload.update({
        collection: 'documents',
        where: { and: [{ id: { equals: doc.id } }, ...stalledWhere] },
        data: { publicationError: stalledPublishReason(doc, waitedMinutes).slice(0, 500) },
        overrideAccess: true,
        context: { __skipDocsExtract: true },
      })) as unknown as { docs?: unknown[] }

      // ⚠ COUNT WHAT THE DATABASE ACTUALLY CHANGED. A guarded update that
      // matched nothing means the row recovered on its own between the read and
      // the write, and reporting it as "stalled" would put a phantom in the
      // ERROR log that operators are meant to act on.
      if ((res?.docs?.length ?? 0) === 0) continue
    } catch (err) {
      opts.log?.warn(
        { documentId: String(doc.id), err: err instanceof Error ? err.message : String(err) },
        '[publish-janitor] could not stamp a stalled publish — the row stays invisible',
      )
      continue
    }
    stalled += 1
    if (!doc.publishIngestId) neverEnqueued += 1
  }

  // ⚠ A FULL PAGE IS ITSELF A SIGNAL. `examined === limit` means there may be
  // more stalled rows than this sweep could see, and the next one will pick them
  // up — but an operator staring at a count should know it was truncated.
  if (docs.length >= limit) {
    opts.log?.warn(
      { examined: docs.length, limit },
      '[publish-janitor] the sweep page was full — more documents may be stuck than this run examined',
    )
  }

  return { examined: docs.length, stalled, neverEnqueued }
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/** Log tag, and the key the shared scheduler holds this janitor's timer under. */
const JANITOR_PREFIX = 'publish-janitor'

/**
 * ON BY DEFAULT, for the same reason the transcription janitor is.
 *
 * The session janitor DELETES data, so it is opt-in. This one writes one text
 * field and changes no state — it converts an already-broken invisible state
 * into a visible one. The risk of running it is small; the cost of not running
 * it is measured at 99 documents. Set the var to `0` / `false` to disable.
 */
export function publishJanitorEnabled(): boolean {
  return janitorEnabledFromEnv(PUBLISH_JANITOR_ENABLED_VAR)
}

export function publishJanitorIntervalMs(): number {
  return janitorIntervalMsFromEnv(PUBLISH_JANITOR_INTERVAL_MIN_VAR, DEFAULT_INTERVAL_MIN)
}

/**
 * Arm the sweep. Idempotent. The timer, the one-interval delay before the first
 * pass and the catch around a throwing sweep all live in `janitorScheduler.ts`,
 * shared with the transcription and embedding sweeps. `sweepStalledPublishes`
 * is exported so a cron can drive it instead.
 */
export function startPublishJanitor(payload: Payload): boolean {
  return startJanitor(payload, {
    prefix: JANITOR_PREFIX,
    enabledVar: PUBLISH_JANITOR_ENABLED_VAR,
    enabled: publishJanitorEnabled,
    intervalMs: publishJanitorIntervalMs,
    disabledDetail:
      'A document whose publish never reached ai-service, or whose callback is never ' +
      'delivered, will stay in publicationStatus="publishing" indefinitely with no error ' +
      'recorded and nothing to move it.',
    armedContext: () => ({ stuckAfterMinutes: stuckAfterMs() / 60_000 }),
    sweep: async (p) => {
      const result = await sweepStalledPublishes(p, { log: p.logger })
      if (result.stalled > 0) {
        // ERROR, not warn. Reaching here means publishes are being accepted
        // and then going nowhere — an operational fault (a rate limit being
        // hit hard, or callbacks not being delivered), not a user's file.
        p.logger.error(
          result,
          '[publish-janitor] documents were stuck mid-publish and have been marked with a ' +
            'visible error — check ai-service rate limits and that ingest callbacks are ' +
            'reaching this backend',
        )
      }
    },
  })
}

/** Stop the interval (used by tests / graceful shutdown). */
export function stopPublishJanitor(): void {
  stopJanitor(JANITOR_PREFIX)
}
