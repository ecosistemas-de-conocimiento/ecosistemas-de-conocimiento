/**
 * KEEP PUBLIC FIGURES — what a gated document runs with (owner rulings
 * 2026-10-27, "Semiosis práctica" far-right case files).
 *
 *   · `documento` only. A testimonio or a conversation never keeps a name and
 *     never gets the roster here (`conversationIngest.ts` builds its own).
 *   · `documents.keepPublicFigures` (nullable) wins; null means the
 *     ecosistema's `keepPublicFigures` feature (`lib/features.ts`).
 *   · The roster (owner Q13 A): every member's name parts are redacted, unless
 *     the option is on and the model called that mention public.
 *
 * 🔴 FAILS TO TODAY'S BEHAVIOUR: a roster read that fails gives option off and
 * no roster, which is exactly what every documento ran with before this file.
 */

import type { Payload } from 'payload'

import type { KeptPublicFigure } from './anonymise/types'
import { featureEnabled } from './features'

export interface DocumentoGateOptions {
  keepPublicFigures: boolean
  roster: string[]
}

export async function documentoGateOptions(
  payload: Pick<Payload, 'findByID'>,
  organizationId: number | string,
  row: { contentKind?: unknown; keepPublicFigures?: unknown },
): Promise<DocumentoGateOptions> {
  if (row.contentKind !== 'documento') return { keepPublicFigures: false, roster: [] }
  try {
    const { rosterForOrganization } = await import('./conversationIngest')
    const roster = await rosterForOrganization(payload as Payload, organizationId)
    const keepPublicFigures =
      typeof row.keepPublicFigures === 'boolean'
        ? row.keepPublicFigures
        : await featureEnabled(payload, organizationId, 'keepPublicFigures')
    return { keepPublicFigures, roster }
  } catch (err) {
    console.warn(
      `[public-figures] roster or setting unreadable for ecosistema ${organizationId}; gating as before (option off, no roster): ${err instanceof Error ? err.name : 'error'}`,
    )
    return { keepPublicFigures: false, roster: [] }
  }
}

/**
 * One entry of `documents.publicFiguresKept`: a name the gate LEFT IN, why,
 * which model said so, and when. For reviewers.
 *
 * ⚠ Not a re-identification map: nothing here was removed. Every name is in
 * the published text already; the log only records the reason.
 */
export interface PublicFigureLogEntry extends KeptPublicFigure {
  model: string | null
  at: string
}

export function publicFiguresLog(
  kept: readonly KeptPublicFigure[] | undefined,
  model: string | null | undefined,
  at: Date = new Date(),
): PublicFigureLogEntry[] | null {
  if (!kept || kept.length === 0) return null
  return kept.map((k) => ({ name: k.name, motivo: k.motivo, model: model ?? null, at: at.toISOString() }))
}
