/**
 * ONE-OFF REPAIR: move rows HELD only because the detector never answered back
 * to the retryable state. Runner: `scripts/reset-infra-holds.ts`.
 *
 * Before 2026-10-21 a 429, a 5xx, a 402 or a timeout in the detector ended as
 * `anonymisationStatus: 'held'` with the reason
 * "La revisión automática no pudo terminar (transporte)" — a Revisión item with
 * no finding in it, which nothing ever retried. The gate now leaves those rows
 * at `n/a` with a `gate_unavailable` error (`anonymiseDocument.ts`). This moves
 * the rows held the old way to that same state.
 *
 * 🔴 CONTENT HOLDS ARE NEVER TOUCHED. A row qualifies only when its
 * `anonymisationError` is EXACTLY the transport/timeout reason the gate writes
 * ({@link INFRA_HOLD_REASON}). A finding, a parse failure, a crash or a
 * human decision does not match. Every write re-asserts `held` and the exact
 * old error, so a row a reviewer touched in between is left alone.
 */

import type { Payload } from 'payload'

import { GATE_UNAVAILABLE_CODE, GATE_UNAVAILABLE_INGEST_CODE } from '../anonymiseDocument'
import { updateDocumentColumns, type DocumentColumnsPayload } from '../documentColumns'

/**
 * The reasons `gate.ts` writes when stage 3 or 4 could not run because the
 * detector call failed (`detector.ts`: `transporte` / `tiempo-agotado`).
 * Anchored: the stage prefix `anonymiseDocument.ts` adds, then the gate's text.
 */
export const INFRA_HOLD_REASON =
  /^(content|verify): La (segunda )?revisión automática no pudo terminar \((transporte|tiempo-agotado)\)\./

export function isInfraHold(row: { anonymisationStatus?: unknown; anonymisationError?: unknown }): boolean {
  return (
    row.anonymisationStatus === 'held' &&
    typeof row.anonymisationError === 'string' &&
    INFRA_HOLD_REASON.test(row.anonymisationError)
  )
}

interface Row {
  id?: number | string
  anonymisationStatus?: unknown
  anonymisationError?: unknown
  ingestStatus?: unknown
  ingestError?: unknown
}

export interface ResetReport {
  examined: number
  matched: number
  reset: number
  ids: Array<number | string>
}

export async function resetInfraHolds(
  payload: Pick<Payload, 'find'> & DocumentColumnsPayload,
  opts: { apply: boolean; limit?: number; log?: (line: string) => void },
): Promise<ResetReport> {
  const found = (await payload.find({
    collection: 'documents',
    // Narrowed in SQL, decided in JS: `like` is only a pre-filter.
    where: {
      and: [
        { anonymisationStatus: { equals: 'held' } },
        { anonymisationError: { like: 'no pudo terminar' } },
      ],
    },
    limit: opts.limit ?? 1000,
    depth: 0,
    overrideAccess: true,
  })) as unknown as { docs?: Row[] }
  const docs = found?.docs ?? []

  const report: ResetReport = { examined: docs.length, matched: 0, reset: 0, ids: [] }
  for (const row of docs) {
    if (row.id == null || !isInfraHold(row)) continue
    report.matched += 1
    report.ids.push(row.id)
    const oldError = row.anonymisationError as string
    opts.log?.(`${opts.apply ? 'reset' : 'would reset'} document ${row.id}: ${oldError.slice(0, 80)}`)
    if (!opts.apply) continue

    const data: Record<string, unknown> = {
      anonymisationStatus: 'n/a',
      anonymisationError: `${GATE_UNAVAILABLE_CODE}: ${oldError}`.slice(0, 500),
      redactedText: null,
      heldText: null,
      anonymisationSurvivors: null,
      // Made from the `heldText` cleared above.
      testimonioTitle: null,
    }
    // A draft-path row also carries `ingestStatus: 'failed'` + `anonymisation_held`.
    // Relabel it so the ingest-recovery sweep re-drives it.
    if (
      row.ingestStatus === 'failed' &&
      typeof row.ingestError === 'string' &&
      row.ingestError.startsWith('anonymisation_held:')
    ) {
      data.ingestError = `${GATE_UNAVAILABLE_INGEST_CODE}:${row.ingestError.slice('anonymisation_held:'.length)}`
    }
    const n = await updateDocumentColumns(payload, {
      id: row.id,
      where: [{ anonymisationStatus: { equals: 'held' } }, { anonymisationError: { equals: oldError } }],
      data,
    })
    if (n > 0) report.reset += 1
  }
  return report
}
