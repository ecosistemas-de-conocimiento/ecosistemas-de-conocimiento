/**
 * Drive a fresh transcript into the gate and the ingest RIGHT AWAY, instead of
 * waiting for the `ingestRecovery` sweep.
 *
 * Measured on dev 2026-10-22: a 30 s clip took 107.7 s from upload to ready;
 * the transcript was on the row at +5 s and the rest was the sweep's minute
 * age threshold plus its minute interval.
 *
 * ⚠ DETACHED, AFTER THE `transcribed` WRITE HAS COMMITTED. The callback awaits
 * `payload.update` (its own transaction, committed before it returns) and only
 * then calls this. `setImmediate` + a caught promise, like the ingest hook in
 * `collections/Documents.ts` and `lib/graph/schedule.ts`: the webhook answers
 * at once, and audio-service's 20 s callback timeout never sees the gate.
 *
 * ⚠ ONE AT A TIME PER PROCESS. A burst of callbacks queues here instead of
 * gating N documents in parallel. Every detector call still goes through the
 * process-wide `ANONYMISE_DETECT_MIN_GAP_MS` pacing in
 * `lib/anonymise/detector.ts`, and the per-document concurrency cap stays the
 * real bound because only one document is gated from this path at a time.
 *
 * ⚠ A DROPPED OR FAILED RUN IS NOT LOST. The row stays (or is handed back to)
 * `transcribed`, and the sweep drives it on its next pass. A run racing the
 * sweep is a no-op: see the claim in `driveTranscribedDocument`.
 */

import type { Payload } from 'payload'

import { driveTranscribedDocument, type TranscribedRow } from './ingestRecovery'

type DrivePayload = Pick<Payload, 'findByID' | 'update'>

let chain: Promise<unknown> = Promise.resolve()

/** Test seam: resolves once every drive queued so far has finished. */
export function _drainTranscribedDrives(): Promise<unknown> {
  return chain
}

export function driveTranscribedSoon(payload: DrivePayload, docId: number | string): void {
  setImmediate(() => {
    chain = chain.then(() => driveOne(payload, docId))
  })
}

async function driveOne(payload: DrivePayload, docId: number | string): Promise<void> {
  try {
    // Re-read: the drive works from the stored row, never from the webhook body.
    const row = (await payload.findByID({
      collection: 'documents',
      id: docId as never,
      depth: 0,
      overrideAccess: true,
    })) as unknown as TranscribedRow
    const outcome = await driveTranscribedDocument(payload, row, {
      log: { warn: (o, m) => console.warn(m, o) },
    })
    if (outcome === 'skipped') {
      console.log('[callback] transcript for doc', docId, 'already claimed or not drivable — left to its owner')
    }
  } catch (err) {
    console.error('[callback] immediate drive failed for doc', docId, '— the ingest-recovery sweep will pick it up', err)
  }
}
