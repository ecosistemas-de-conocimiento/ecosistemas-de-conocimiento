/**
 * ONE-OFF: send the holds that only flagged PLACES back through the gate, now
 * that a town no longer holds (`anonymise/townPlaces.ts`).
 *
 * Measured on dev, 2026-10-21 (runbook `infra/fleet/edc-1.md` §4p): of 38
 * verify holds, 31 had place findings only. 🔴 THEY ARE RE-GATED, NOT
 * RELEASED: the gate runs again (two model calls per chunk), and whatever it
 * says now stands.
 *
 * Selection, all of it on the stored row:
 *
 *   · gated content, `anonymisation_status = held`, a DRAFT
 *   · held at `verify` (the reason starts `verify: `)
 *   · `anonymisation_survivors` non-empty and EVERY one of type `lugar`
 *   · 🔴 checked OFFLINE first, no model call: every stored survivor passes the
 *     current town rule against `heldText` ({@link everySurvivorIsTown}). A
 *     place-only hold on a colonia or a hospital stays held and is not re-run.
 *
 * Apply, ONE ROW AT A TIME: reset the gate columns to the retryable `n/a`
 * state (the fields `planIngestRetry` clears), guarded on the row still being a
 * held draft, then gate that one id before the next row is touched. A crash
 * mid-run leaves at most one row reset and not yet gated, at the retryable
 * `n/a`, where a seed re-run or this script picks it up.
 */

import type { Payload } from 'payload'

import { isTownLevelPlace } from './anonymise/townPlaces'
import type { DetectorFinding } from './anonymise/types'
import { rowMustPassGate } from './anonymiseDocument'
import { isConsentHeld, NOT_CONSENT_HELD, readConsentHeld } from './consentHold'
import { updateDocumentColumns, type DocumentColumnsPayload } from './documentColumns'
import { relationId } from './permissions'

interface Row {
  id?: number | string
  organization?: unknown
  contentKind?: unknown
  anonymise?: unknown
  publicationStatus?: unknown
  anonymisationStatus?: unknown
  anonymisationError?: unknown
  anonymisationSurvivors?: unknown
  heldText?: unknown
  /** 🔴 `lib/consentHold.ts`: a held row is never reset or re-gated. */
  consentHeld?: unknown
}

export function isPlaceOnlyHold(row: Row): boolean {
  if (!rowMustPassGate(row)) return false
  if (row.anonymisationStatus !== 'held') return false
  if (row.publicationStatus !== 'draft') return false
  if (typeof row.anonymisationError !== 'string' || !row.anonymisationError.startsWith('verify: ')) return false
  const survivors = row.anonymisationSurvivors
  if (!Array.isArray(survivors) || survivors.length === 0) return false
  return survivors.every((s) => Boolean(s) && typeof s === 'object' && (s as { type?: unknown }).type === 'lugar')
}

/**
 * Would the CURRENT town rule ignore every finding verify left on this row?
 * Each survivor is an offset into `heldText` (verify's own input), so its text
 * and its context are exactly what `isTownLevelPlace` sees inside the gate.
 */
export function everySurvivorIsTown(row: Row): boolean {
  const heldText = typeof row.heldText === 'string' ? row.heldText : ''
  if (heldText === '' || !Array.isArray(row.anonymisationSurvivors)) return false
  const survivors = row.anonymisationSurvivors as Array<{ start?: unknown; end?: unknown; type?: unknown }>
  if (survivors.length === 0) return false
  return survivors.every((s) => {
    if (typeof s.start !== 'number' || typeof s.end !== 'number' || s.end <= s.start) return false
    const text = heldText.slice(s.start, s.end)
    return isTownLevelPlace({ text, type: s.type as DetectorFinding['type'] }, heldText)
  })
}

export interface PlaceHoldsReport {
  examined: number
  /** Held at verify with place findings only. */
  placeOnly: number
  /** …of which every finding passes the town rule offline: the ones re-run. */
  matched: number
  /** Reset and gated (apply only). */
  regated: number
  ids: string[]
  /** Place-only holds the offline check keeps held. */
  kept: string[]
}

export async function regatePlaceOnlyHolds(
  payload: Pick<Payload, 'find'> & DocumentColumnsPayload,
  opts: {
    apply: boolean
    /** Gate exactly one document. The script passes the seed's targeted ingest. */
    gate?: (organizationId: number, documentId: string) => Promise<unknown>
    limit?: number
    log?: (line: string) => void
  },
): Promise<PlaceHoldsReport> {
  const log = opts.log ?? (() => undefined)
  const found = (await payload.find({
    collection: 'documents',
    // 🔴 Never a row held for consent: the reset below ends in the gate's model calls.
    where: {
      and: [{ anonymisationStatus: { equals: 'held' } }, { publicationStatus: { equals: 'draft' } }, NOT_CONSENT_HELD],
    },
    limit: opts.limit ?? 1000,
    depth: 0,
    overrideAccess: true,
  })) as unknown as { docs?: Row[] }
  const rows = found.docs ?? []
  const report: PlaceHoldsReport = { examined: rows.length, placeOnly: 0, matched: 0, regated: 0, ids: [], kept: [] }

  for (const row of rows) {
    if (row.id == null || isConsentHeld(row) || !isPlaceOnlyHold(row)) continue
    report.placeOnly += 1
    const id = String(row.id)
    if (!everySurvivorIsTown(row)) {
      report.kept.push(id)
      log(`doc ${id}: a place finding is not a town under the current rule — stays held`)
      continue
    }
    report.matched += 1
    report.ids.push(id)
    const org = relationId(row.organization)
    log(`doc ${id}: every finding is a town — ${opts.apply ? 'gating again' : 'would gate again'} in eco-${String(org)}`)
    if (!opts.apply || !opts.gate) continue
    const orgNumber = Number(org)
    if (!Number.isInteger(orgNumber) || orgNumber <= 0) {
      log(`doc ${id}: no ecosistema on the row — left alone`)
      continue
    }

    // 🔴 Read again right before the reset: a hold placed while this ran wins.
    // (`updateDocumentColumns` cannot guard on `consentHeld`: not in its allowlist.)
    if (await readConsentHeld(payload, row.id)) {
      log(`doc ${id}: held for consent — left alone`)
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
        // Made from the `heldText` cleared above.
        testimonioTitle: null,
        ingestStatus: 'pending',
        ingestError: null,
      },
    })
    if (changed === 0) {
      log(`doc ${id}: changed since it was read — left alone`)
      continue
    }
    const result = await opts.gate(orgNumber, id)
    report.regated += 1
    log(`doc ${id}: ${JSON.stringify(result)}`)
  }
  return report
}
