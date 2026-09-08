/**
 * 🔴 THE STALLED-EMBEDDING SWEEP — the third non-terminal state, and the one
 * the collection's own comment claims is covered when it is not.
 *
 * `collections/Documents.ts` says, next to the `ingestStatus` field:
 *
 *     ⚠ EVERY NON-TERMINAL STATE HAS SOMETHING THAT WILL MOVE IT. `embedding`
 *       is moved by the ai-service callback […]
 *
 * The first half is the rule this product holds itself to. The second half is
 * the assumption that fails, and `lib/callbackConfig.ts` already says so in as
 * many words: *"Nothing polls `ingest.status`, so `embedding` is a terminal
 * state in practice."* Two files, opposite claims, and the row loses.
 *
 * ── How a row actually gets stranded at `embedding` ──────────────────────────
 *
 * `enqueueIngestForDoc` writes `ingestStatus: 'embedding'` BEFORE it calls
 * ai-service, so every one of these leaves a row that nothing will ever move:
 *
 *   1. `getAppAIClient()` throws (AI client unconfigured). The function logs and
 *      RETURNS — no status write, no error. The row is already at `embedding`.
 *   2. `PUBLIC_BACKEND_URL` is missing, so no `callbackUrl` is sent. ai-service
 *      accepts the ingest, does the work, and has nowhere to report it. The
 *      enqueue path warns about exactly this and then proceeds anyway.
 *   3. `CALLBACK_SECRET` is missing or wrong. ai-service DOES call back and
 *      every POST 401s at the receiver.
 *   4. The process dies between the status write and the enqueue, or between
 *      the enqueue and the `ingestId` write.
 *   5. The callback arrives and its handler throws.
 *
 * ⚠ NONE of those write an `ingestError`, and `ingestStatus: 'embedding'` with
 * an empty `ingestError` is what "still working" looks like in the UI. To the
 * person who uploaded the file, forever and in progress are the same screen.
 *
 * ⚠ AND IT IS WORSE THAN A COSMETIC LIE, for one specific reason spelled out in
 * `callbackConfig.ts`: `ingest.failed` travels over the SAME callback that is
 * broken. So an ingest that genuinely failed and one that genuinely succeeded
 * both come to rest here, wearing the same face.
 *
 * ── 🔴 WHAT THIS DELIBERATELY DOES NOT DO ────────────────────────────────────
 *
 * IT DOES NOT RE-ENQUEUE THE INGEST. Same two reasons as `publishJanitor.ts`,
 * and they are the whole design:
 *
 *   1. ⚠ THE OUTCOME IS UNKNOWABLE FROM HERE. Cases 2 and 3 above are ingests
 *      that very probably SUCCEEDED at ai-service. Re-sending would embed the
 *      document into the corpus a second time, and ai-service has no
 *      per-document delete to undo it with.
 *   2. ⚠ A SWEEP THAT RE-DRIVES IS A BURST GENERATOR. `/v1` is capped at 100
 *      requests per minute and the cap is enforced per IP, not per key, so
 *      every consumer shares one bucket. A janitor that re-ingested a backlog
 *      on a timer would manufacture that burst on a schedule, forever.
 *
 * What it does instead is write down that the row is stuck. That is all, and it
 * is the entire point.
 *
 * ── 🔴 WHY THIS ONE CHANGES THE STATUS AND THE PUBLISH SWEEP DOES NOT ────────
 *
 * `publishJanitor.ts` writes ONE text field and leaves `publicationStatus`
 * alone, because `POST /:id/publish` refuses only a row that has already
 * REACHED its target state — a stamped `publishing` row is still retryable.
 *
 * `POST /api/documents/:id/retry` is not like that. `planIngestRetry` opens with
 * `if (doc.ingestStatus !== 'failed') return null`, so a row stamped with an
 * error and LEFT at `embedding` would be visible and permanently un-retryable —
 * the user reads a message telling them to try again next to a button the API
 * answers 409 to. Making the row terminal is what keeps the message honest.
 *
 * ⚠ THE FALSE POSITIVE IS CHEAP, WHICH IS WHY THE STATUS WRITE IS SAFE HERE and
 * is not in `transcriptionJanitor.ts`. If the ingest was in fact still running,
 * a late `ingest.completed` writes `{ ingestStatus: 'ready', ingestError: null }`
 * unconditionally — the row heals itself completely. Stamping is a statement
 * about what we can SEE, not a cancellation.
 *
 * ⚠ ONE ROW SHAPE STAYS UN-RETRYABLE AND IT IS NOT THIS FILE'S DOING. A row
 * whose `anonymisationStatus` is `approved` (a reviewer released a held
 * testimony, which re-enters the pipeline at `pending`) is refused by
 * `planIngestRetry` on purpose — retry clears the gate, and clearing a
 * reviewer's decision by pressing a button is the bug that rule exists for. Such
 * a row still becomes VISIBLE here, which is strictly better than silent, and
 * releasing it again is a reviewer action rather than an uploader one.
 */

import type { Payload, Where } from 'payload'

import { missingCallbackConfig } from './callbackConfig'
import {
  janitorEnabledFromEnv,
  janitorIntervalMsFromEnv,
  startJanitor,
  stopJanitor,
} from './janitorScheduler'

/** Env var names, so log lines and tests never hand-type a string that can drift. */
export const EMBEDDING_JANITOR_ENABLED_VAR = 'EMBEDDING_JANITOR_ENABLED'
export const EMBEDDING_JANITOR_INTERVAL_MIN_VAR = 'EMBEDDING_JANITOR_INTERVAL_MIN'
export const EMBEDDING_JANITOR_STUCK_MIN_VAR = 'EMBEDDING_JANITOR_STUCK_MIN'

/**
 * How long a document may sit in `embedding` before we call it stuck, in minutes.
 *
 * ⚠ A CONSTANT, like the publish deadline and unlike the transcription one. The
 * transcription janitor derives a per-document deadline because transcription
 * time is proportional to the recording, which we know. An embed is
 * proportional to nothing on the row: one document's chunks take seconds, and
 * the only thing that stretches it is a queue at ai-service, which is a property
 * of the deployment.
 *
 * 30 minutes is sized for "the ai-service worker queue is badly backed up", not
 * for "this document is large" — roughly two orders of magnitude above the happy
 * path, and the same number the publish sweep uses for the same reason.
 */
export const DEFAULT_STUCK_MIN = 30

/** Default sweep interval: every 15 minutes, like the other two janitors. */
const DEFAULT_INTERVAL_MIN = 15

/**
 * The one non-terminal ingest state this sweep owns.
 *
 * ⚠ `pending` AND `transcribed` ARE ALSO NON-TERMINAL AND ARE DELIBERATELY NOT
 * HERE. Both can strand a row the same way — `transcribed` is where a row stops
 * if the process dies between persisting the transcript and enqueuing the
 * ingest — but each needs a different message and a different deadline, and a
 * sweep that quietly grew to cover states nobody argued about is how a janitor
 * starts writing errors onto rows that are fine. Adding one is a decision, not
 * an edit to a list.
 */
export const STALLED_INGEST_STATE = 'embedding'

/** The reason stamped on a row this sweep gives up on. Stable; used by tests and support. */
export const STALLED_EMBED_CODE = 'embedding_stalled'

/** The slice of a row this module reasons about. */
export interface StalledEmbeddingCandidate {
  id?: number | string
  ingestStatus?: unknown
  /**
   * ai-service's join-back key, written only AFTER the enqueue returned 200.
   * Its absence is the closest thing we have to "nothing was sent" — see
   * {@link stalledEmbeddingReason} for how far that evidence actually goes.
   */
  ingestId?: string | null
  /**
   * When the row was last written. The embed started at or before this.
   *
   * ⚠ ANY OTHER WRITE TO THE ROW RESETS THIS CLOCK — an admin edit, a metadata
   * backfill, a re-save. The effect is always to delay the sweep, never to
   * trigger it early, which is the harmless direction.
   */
  updatedAt?: string | number | Date | null
}

export function embeddingStuckAfterMs(): number {
  const raw = Number(process.env[EMBEDDING_JANITOR_STUCK_MIN_VAR])
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STUCK_MIN
  return minutes * 60_000
}

/**
 * The Spanish message written onto a stuck row. It lands in `ingestError`, which
 * the UI shows verbatim under "Detalle".
 *
 * 🔴 IT SPLITS ON `ingestId`, because the two stalls are different events and
 * the user's next move differs:
 *
 *   · no ingest id → the request never reached ai-service. Nothing is half-done
 *     in the corpus, so retrying is unambiguously safe. This is the
 *     unconfigured-AI-client case, and the crashed-before-enqueue case.
 *   · an ingest id → ai-service ACCEPTED the job and never reported back. It may
 *     well have finished; a second send would embed the document twice into a
 *     corpus with no per-document delete. Retry is still allowed, but we must
 *     not tell the user nothing happened.
 *
 * ⚠ BE HONEST ABOUT HOW GOOD THAT DISCRIMINATOR IS: it is good, not perfect. The
 * `ingestId` write is a SECOND statement after the enqueue returns, so a process
 * that died in between leaves a row that was sent and carries no id — and it
 * would get the "nothing was sent" message. Nothing on the row distinguishes
 * that window, and inventing a third hedged message for it would make the other
 * 99% of cases vaguer to cover a case we cannot detect anyway. The narrower
 * failure is the one we accept.
 */
export function stalledEmbeddingReason(
  candidate: StalledEmbeddingCandidate,
  waitedMinutes: number,
): string {
  const accepted = typeof candidate.ingestId === 'string' && candidate.ingestId !== ''
  if (!accepted) {
    return (
      `${STALLED_EMBED_CODE}: el documento no llegó a enviarse al servicio de IA y lleva más de ` +
      `${waitedMinutes} minutos sin avanzar. No se envió nada, así que puedes volver a intentarlo. ` +
      'Si vuelve a pasar, avisa a quien administra la instalación.'
    )
  }
  return (
    `${STALLED_EMBED_CODE}: el documento se envió al servicio de IA pero no hubo respuesta en más ` +
    `de ${waitedMinutes} minutos. Puede haber terminado sin avisar. Vuelve a intentarlo o pide ` +
    'ayuda al equipo antes de repetir el envío.'
  )
}

export interface EmbeddingSweepResult {
  /** Rows in `embedding` past the deadline that were examined. */
  examined: number
  /** Rows failed out with a visible reason. */
  stalled: number
  /** Of those, how many never got as far as an ingest id. The "nothing was sent" ones. */
  neverSent: number
}

/**
 * One sweep: find every document stranded mid-embed and make the stall VISIBLE
 * and RETRYABLE.
 *
 * ⚠ It writes TWO fields and calls nothing. No ai-service client is reachable
 * from this signature — the restraint is structural, not a matter of discipline.
 *
 * ⚠ `__skipDocsExtract` is not optional. Without it the status write re-fires
 * the `afterChange` hook, and the sweep that must not re-drive the ingest would
 * re-drive it on every pass.
 *
 * ⚠ One row's write failing does not abandon the rest. A single bad row
 * (deleted mid-sweep, failing validation) must not hide the other 144.
 */
export async function sweepStalledEmbeddings(
  payload: Pick<Payload, 'find' | 'update'>,
  opts: {
    now?: Date
    limit?: number
    deadlineMs?: number
    log?: { warn(o: Record<string, unknown>, m: string): void }
  } = {},
): Promise<EmbeddingSweepResult> {
  const now = opts.now ?? new Date()
  const deadlineMs = opts.deadlineMs ?? embeddingStuckAfterMs()
  const limit = opts.limit ?? 500

  /**
   * 🔴 EVERY CONDITION IS IN THE QUERY. THIS IS THE STARVATION RULE, and the
   * publish sweep had to learn it the hard way: it filtered in JS and argued in
   * a comment that oldest-first sorting kept the already-handled rows out of
   * the way. That is backwards. A row this sweep has finished with keeps its OLD
   * `updatedAt`, so oldest-first sorts it FIRST. Once more than `limit` of them
   * exist — one seed produced 145 in a single run — they permanently fill the
   * page and a genuinely new stall is never examined at all.
   *
   * A post-filter cannot starve a query it is not part of. So the deadline lives
   * in SQL, not in the loop, and this sweep's own output (`ingestStatus:
   * 'failed'`) drops the row out of the first clause for good.
   *
   * ⚠ THESE TWO CLAUSES ARE THE WHOLE DEFINITION OF "STRANDED". There is no
   * second predicate in the loop below, and a sweep modelled on this one should
   * not grow one: the guarded update re-asserts this same array, so a row the
   * database returned has already passed every test there is, and a JS re-check
   * could only ever agree with it. An unreadable or missing `updatedAt` reads as
   * NOT stranded for free — `updated_at < cutoff` is NULL, not true, for a NULL
   * row — which is the right asymmetry: failing a document because we could not
   * parse its timestamp would be acting on a data-shape bug, not on a stall.
   *
   * ⚠ NO `ingestError: { exists: false }` CLAUSE HERE, unlike the publish sweep,
   * and that is deliberate rather than forgotten:
   *
   *   · it would filter nothing. `enqueueIngestForDoc` writes `ingestError: null`
   *     in the SAME statement as `ingestStatus: 'embedding'`, so a legitimate
   *     candidate never carries one;
   *   · the publish sweep NEEDS it because its rows stay `publishing` after
   *     stamping and would be re-stamped every 15 minutes forever. Here the
   *     status change retires the row instead;
   *   · and an anomalous `embedding` row that somehow DOES carry an error is
   *     precisely the thing this file exists to abolish — non-terminal, nothing
   *     to move it, and refused by `POST /:id/retry` because it is not `failed`.
   *     Skipping it would preserve the bug for the rows that show it worst.
   */
  const cutoff = new Date(now.getTime() - deadlineMs).toISOString()
  const stalledWhere: Where[] = [
    { ingestStatus: { equals: STALLED_INGEST_STATE } },
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
  })) as unknown as { docs?: StalledEmbeddingCandidate[] }

  const docs = page?.docs ?? []
  const waitedMinutes = Math.round(deadlineMs / 60_000)
  let stalled = 0
  let neverSent = 0

  for (const doc of docs) {
    if (doc?.id == null) continue

    try {
      /**
       * 🔴 CONDITIONAL ON THE ROW STILL BEING STUCK. Updating by `id` alone
       * races the very callback this sweep is waiting for.
       *
       * The gap between the `find` and this write is real — up to `limit`
       * sequential updates — and a 30-minute deadline is sized for exactly the
       * backed-up-queue case, which is precisely when a callback lands around
       * the deadline. Lose that race with an unguarded write and a document that
       * embedded perfectly is marked `failed` with a permanent false reason, and
       * the user's fix is to pay for the embed twice.
       *
       * ⚠ THE `updatedAt` CLAUSE IS HALF THE GUARD, not a leftover from the
       * read. Every write to this row bumps `updatedAt`, so re-asserting the
       * cutoff makes "nobody has touched this row since we read it" a condition
       * the DATABASE checks. That catches the late callback, a concurrent user
       * retry, and an admin edit with one clause.
       *
       * ⚠ IT IS A GUARD, NOT A LOCK. Payload's bulk update re-runs the query
       * inside its transaction and updates the matches; under READ COMMITTED a
       * callback can still interleave in the sliver between. It closes the
       * 30-minute window down to milliseconds, which is the difference between a
       * routine occurrence and a rounding error. Same shape as `holdReview.ts`'s
       * settle and the publish sweep's.
       */
      const res = (await payload.update({
        collection: 'documents',
        where: { and: [{ id: { equals: doc.id } }, ...stalledWhere] },
        data: {
          // Terminal, so `planIngestRetry` accepts the row — see the header.
          ingestStatus: 'failed',
          ingestError: stalledEmbeddingReason(doc, waitedMinutes).slice(0, 500),
        },
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
        '[embedding-janitor] could not fail out a stalled embed — the row stays invisible',
      )
      continue
    }
    stalled += 1
    if (!doc.ingestId) neverSent += 1
  }

  // ⚠ A FULL PAGE IS ITSELF A SIGNAL. `examined === limit` means there may be
  // more stalled rows than this sweep could see. The next pass picks them up —
  // the stamped ones leave `embedding` — but an operator staring at a count
  // should know it was truncated.
  if (docs.length >= limit) {
    opts.log?.warn(
      { examined: docs.length, limit },
      '[embedding-janitor] the sweep page was full — more documents may be stuck than this run examined',
    )
  }

  return { examined: docs.length, stalled, neverSent }
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/** Log tag, and the key the shared scheduler holds this janitor's timer under. */
const JANITOR_PREFIX = 'embedding-janitor'

/**
 * ON BY DEFAULT, for the same reason the other two sweeps are.
 *
 * The session janitor DELETES data, so it is opt-in. This one turns an
 * invisible non-terminal state into a visible, retryable failure and heals
 * itself if the callback was merely late. Set the var to `0` / `false` to
 * disable.
 */
export function embeddingJanitorEnabled(): boolean {
  return janitorEnabledFromEnv(EMBEDDING_JANITOR_ENABLED_VAR)
}

export function embeddingJanitorIntervalMs(): number {
  return janitorIntervalMsFromEnv(EMBEDDING_JANITOR_INTERVAL_MIN_VAR, DEFAULT_INTERVAL_MIN)
}

/**
 * Arm the sweep. Idempotent. The timer, the one-interval delay before the first
 * pass and the catch around a throwing sweep all live in `janitorScheduler.ts`,
 * shared with the transcription and publish sweeps. `sweepStalledEmbeddings` is
 * exported so a cron can drive it instead.
 */
export function startEmbeddingJanitor(payload: Payload): boolean {
  return startJanitor(payload, {
    prefix: JANITOR_PREFIX,
    enabledVar: EMBEDDING_JANITOR_ENABLED_VAR,
    enabled: embeddingJanitorEnabled,
    intervalMs: embeddingJanitorIntervalMs,
    disabledDetail:
      'A document whose ingest never reached ai-service, or whose completion callback is ' +
      'never delivered, will stay in ingestStatus="embedding" indefinitely with no error ' +
      'recorded, nothing to move it, and no retry available.',
    armedContext: () => ({ stuckAfterMinutes: embeddingStuckAfterMs() / 60_000 }),
    sweep: async (p) => {
      const result = await sweepStalledEmbeddings(p, { log: p.logger })
      if (result.stalled > 0) {
        /**
         * ERROR, not warn: reaching here means ingests are being accepted and
         * then going nowhere, which is an operational fault rather than a
         * user's file.
         *
         * ⚠ THE CONFIG READ IS THE POINT OF THIS LOG LINE. Three of the five
         * ways a row strands are a half-configured callback round-trip, and
         * that is invisible from the row itself — the user-facing message
         * cannot say it, because config today says nothing about config when
         * the row got stuck. An operator reading THIS line is looking at both
         * halves at once. Empty means the round-trip is configured and the
         * fault is somewhere else.
         */
        p.logger.error(
          { ...result, missingCallbackConfig: missingCallbackConfig() },
          '[embedding-janitor] documents were stranded mid-embed and have been failed out with ' +
            'a visible, retryable reason — check the ai-service callback config and that ' +
            'ingest callbacks are reaching this backend',
        )
      }
    },
  })
}

/** Stop the interval (used by tests / graceful shutdown). */
export function stopEmbeddingJanitor(): void {
  stopJanitor(JANITOR_PREFIX)
}
