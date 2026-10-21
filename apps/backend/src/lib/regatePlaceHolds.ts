/**
 * ONE-OFF: send the holds that only flagged PLACES back through the gate, now
 * that a town no longer holds (`anonymise/townPlaces.ts`).
 *
 * Measured on dev, 2026-10-21 (runbook `infra/fleet/edc-1.md` §4p): of 38
 * verify holds, 31 had place findings only. Those were held under the old rule;
 * under the new one most would pass. 🔴 THEY ARE RE-GATED, NOT RELEASED: the
 * gate runs again (two model calls per chunk), and whatever it says now stands.
 *
 * Selection, all of it, on the stored row:
 *
 *   · gated content, `anonymisation_status = held`, a DRAFT
 *   · held at `verify` (the reason starts `verify: `)
 *   · `anonymisation_survivors` non-empty and EVERY one of type `lugar`
 *
 * A hold with a `persona`, `contacto`, `identificador` or `otro` survivor is
 * never selected; nor is a `structural`/`content` hold or a decided row.
 *
 * Apply resets the gate columns to the retryable `n/a` state (the same
 * fields `planIngestRetry` clears), guarded on the row still being a held
 * draft. The caller then gates exactly these ids.
 */

import type { Payload } from 'payload'

import { mustPassAnonymisationGate } from './anonymiseDocument'
import { updateDocumentColumns, type DocumentColumnsPayload } from './documentColumns'
import { relationId } from './permissions'

interface Row {
  id?: number | string
  organization?: unknown
  contentKind?: unknown
  publicationStatus?: unknown
  anonymisationStatus?: unknown
  anonymisationError?: unknown
  anonymisationSurvivors?: unknown
}

export function isPlaceOnlyHold(row: Row): boolean {
  if (!mustPassAnonymisationGate(row.contentKind)) return false
  if (row.anonymisationStatus !== 'held') return false
  if (row.publicationStatus !== 'draft') return false
  if (typeof row.anonymisationError !== 'string' || !row.anonymisationError.startsWith('verify: ')) return false
  const survivors = row.anonymisationSurvivors
  if (!Array.isArray(survivors) || survivors.length === 0) return false
  return survivors.every((s) => Boolean(s) && typeof s === 'object' && (s as { type?: unknown }).type === 'lugar')
}

export interface PlaceHoldsReport {
  examined: number
  matched: number
  reset: number
  /** Reset ids grouped by ecosistema, for the per-ecosistema gate run. */
  byOrganization: Record<string, string[]>
}

export async function resetPlaceOnlyHolds(
  payload: Pick<Payload, 'find'> & DocumentColumnsPayload,
  opts: { apply: boolean; limit?: number; log?: (line: string) => void },
): Promise<PlaceHoldsReport> {
  const log = opts.log ?? (() => undefined)
  const found = (await payload.find({
    collection: 'documents',
    where: { and: [{ anonymisationStatus: { equals: 'held' } }, { publicationStatus: { equals: 'draft' } }] },
    limit: opts.limit ?? 1000,
    depth: 0,
    overrideAccess: true,
  })) as unknown as { docs?: Row[] }
  const rows = found.docs ?? []
  const report: PlaceHoldsReport = { examined: rows.length, matched: 0, reset: 0, byOrganization: {} }

  for (const row of rows) {
    if (row.id == null || !isPlaceOnlyHold(row)) continue
    report.matched += 1
    const org = String(relationId(row.organization) ?? '')
    log(`doc ${row.id}: ${(row.anonymisationSurvivors as unknown[]).length} place finding(s) in eco-${org}`)
    if (!opts.apply) {
      ;(report.byOrganization[org] ??= []).push(String(row.id))
      continue
    }
    const changed = await updateDocumentColumns(payload, {
      id: row.id,
      where: [{ anonymisationStatus: { equals: 'held' } }, { publicationStatus: { equals: 'draft' } }],
      data: {
        anonymisationStatus: 'n/a',
        anonymisationError: null,
        redactedText: null,
        heldText: null,
        anonymisationSurvivors: null,
        ingestStatus: 'pending',
        ingestError: null,
      },
    })
    if (changed > 0) {
      report.reset += 1
      ;(report.byOrganization[org] ??= []).push(String(row.id))
    }
  }
  return report
}
