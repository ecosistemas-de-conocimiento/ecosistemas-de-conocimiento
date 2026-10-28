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
  /**
   * 🔴 R60: the document's ACTUAL author, kept visible (`anonymise/authorRestore.ts`):
   * the uploader's account display name and their roster entry in this
   * ecosistema. `documents` has no staff-recorded authors field, so this is
   * the only source. A read that fails gives none (today's behaviour).
   */
  authors: string[]
}

/** The uploader's names: their account display name and their membership's `personName` here. */
async function uploaderNames(
  payload: Pick<Payload, 'findByID' | 'find'>,
  organizationId: number | string,
  uploadedBy: unknown,
): Promise<string[]> {
  const id = uploadedBy && typeof uploadedBy === 'object' ? (uploadedBy as { id?: unknown }).id : uploadedBy
  if (typeof id !== 'number' && typeof id !== 'string') return []
  try {
    const names = new Set<string>()
    const user = (await payload.findByID({ collection: 'users', id, depth: 0, overrideAccess: true })) as {
      displayName?: unknown
    } | null
    if (typeof user?.displayName === 'string' && user.displayName.trim()) names.add(user.displayName.trim())
    const memberships = await payload.find({
      collection: 'memberships',
      where: { and: [{ user: { equals: id } }, { organization: { equals: organizationId } }] },
      depth: 0,
      pagination: false,
      overrideAccess: true,
    })
    for (const m of memberships.docs as unknown as Array<{ personName?: unknown }>) {
      if (typeof m.personName === 'string' && m.personName.trim()) names.add(m.personName.trim())
    }
    return [...names]
  } catch (err) {
    console.warn(
      `[authors] uploader unreadable for ecosistema ${organizationId}; no author kept: ${err instanceof Error ? err.name : 'error'}`,
    )
    return []
  }
}

export async function documentoGateOptions(
  payload: Pick<Payload, 'findByID' | 'find'>,
  organizationId: number | string,
  row: { contentKind?: unknown; keepPublicFigures?: unknown; uploadedBy?: unknown },
): Promise<DocumentoGateOptions> {
  if (row.contentKind !== 'documento') return { keepPublicFigures: false, roster: [], authors: [] }
  const authors = await uploaderNames(payload, organizationId, row.uploadedBy)
  try {
    const { rosterForOrganization } = await import('./conversationIngest')
    const roster = await rosterForOrganization(payload as Payload, organizationId)
    const keepPublicFigures =
      typeof row.keepPublicFigures === 'boolean'
        ? row.keepPublicFigures
        : await featureEnabled(payload, organizationId, 'keepPublicFigures')
    return { keepPublicFigures, roster, authors }
  } catch (err) {
    console.warn(
      `[public-figures] roster or setting unreadable for ecosistema ${organizationId}; gating as before (option off, no roster): ${err instanceof Error ? err.name : 'error'}`,
    )
    return { keepPublicFigures: false, roster: [], authors }
  }
}

/** One entry of `documents.authorsKept`: the document's author as left in the text, which model ran, when. */
export interface AuthorLogEntry {
  name: string
  model: string | null
  at: string
}

export function authorsLog(
  kept: readonly string[] | undefined,
  model: string | null | undefined,
  at: Date = new Date(),
): AuthorLogEntry[] | null {
  if (!kept || kept.length === 0) return null
  return kept.map((name) => ({ name, model: model ?? null, at: at.toISOString() }))
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
