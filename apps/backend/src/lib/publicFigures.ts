/**
 * WHAT A GATED DOCUMENT RUNS WITH: public figures, the roster, the document's
 * author and cited authors.
 *
 *   · KEEP PUBLIC FIGURES and the roster (owner rulings 2026-10-27,
 *     "Semiosis práctica" far-right case files): `documento` only. A testimonio
 *     or a conversation never gets them here (`conversationIngest.ts` builds
 *     its own roster). `documents.keepPublicFigures` (nullable) wins; null
 *     means the ecosistema's `keepPublicFigures` feature (`lib/features.ts`).
 *     The roster (owner Q13 A): every member's name parts are redacted, unless
 *     the option is on and the model called that mention public.
 *   · 🔴 THE DEFAULT ANONYMISES EVERYTHING (owner decision 2026-11-07). Two
 *     switches, each a nullable per-document override of an ecosistema
 *     feature, read for a `documento` or a `testimonio`, never a conversation:
 *       keepDocumentAuthor  the uploader's whole `personName` (`authorRestore.ts`);
 *       keepCitedAuthors    surnames in bibliographic citations (`citedAuthorRestore.ts`).
 *
 * 🔴 FAILS CLOSED: a failed read of a switch is off, and a failed roster read
 * gives option off and no roster, which is what every documento ran with
 * before the roster existed.
 */

import type { Payload } from 'payload'

import type { KeptPublicFigure } from './anonymise/types'
import { featureEnabled } from './features'

export interface DocumentoGateOptions {
  keepPublicFigures: boolean
  roster: string[]
  /**
   * 🔴 The document's ACTUAL author, kept visible (`anonymise/authorRestore.ts`):
   * the uploader's membership `personName` in this ecosistema, and only when the
   * effective `keepDocumentAuthor` is on. `documents` has no staff-recorded
   * authors field, so this is the only source. A read that fails gives none.
   */
  authors: string[]
  /** The effective `keepDocumentAuthor` (true even when no `personName` gave a name). */
  keepDocumentAuthor: boolean
  /** The effective `keepCitedAuthors`. */
  keepCitedAuthors: boolean
}

/**
 * The anonymisation switches: each a nullable per-document override of an
 * ecosistema feature, audited on every change (`anonymisation-setting-changes`)
 * and re-gated when turned off (`lib/anonymisationControls.ts`).
 * 🔴 `keepPublicFigures` joined on 2026-11-10 (audit P-04/I-13): it is the
 * third way a name stays in the text, and changed with no audit row and no
 * re-gate before. It applies to a `documento` only, and only a platform admin
 * may change it (`PLATFORM_ADMIN_ONLY_FEATURES`).
 */
export const ANONYMISE_SWITCHES = ['keepDocumentAuthor', 'keepCitedAuthors', 'keepPublicFigures'] as const
export type AnonymiseSwitch = (typeof ANONYMISE_SWITCHES)[number]

/** The log of the names each switch left in the text (`documents.*Kept`). */
export const KEEP_LOG: Record<AnonymiseSwitch, 'authorsKept' | 'citedAuthorsKept' | 'publicFiguresKept'> = {
  keepDocumentAuthor: 'authorsKept',
  keepCitedAuthors: 'citedAuthorsKept',
  keepPublicFigures: 'publicFiguresKept',
}

/** One switch as a document runs with it, and where the value came from. */
export interface EffectiveSwitch {
  value: boolean
  origin: 'ecosistema' | 'documento'
}

const logged = (v: unknown) => Array.isArray(v) && v.length > 0

/** Did this row's verdict leave any name in under `key` (its keep log is non-empty)? */
export function keptUnder(row: Record<string, unknown>, key: AnonymiseSwitch): boolean {
  return logged(row[KEEP_LOG[key]])
}

type ReportSettings = Partial<Record<AnonymiseSwitch, unknown>>
const settingsOf = (row: { anonymisationReport?: unknown }): ReportSettings | null => {
  const s = (row.anonymisationReport as { settings?: unknown } | null | undefined)?.settings
  return s && typeof s === 'object' && !Array.isArray(s) ? (s as ReportSettings) : null
}

/** Did the verdict RECORD this switch (a boolean in its report's `settings`)? */
export function verdictRecorded(row: { anonymisationReport?: unknown }, key: AnonymiseSwitch): boolean {
  return typeof settingsOf(row)?.[key] === 'boolean'
}

/**
 * The switches a row's CURRENT verdict was made under: its report's `settings`
 * (`lib/anonymiseDocument.ts`). 🔴 A report without them (gated before they
 * existed) counts a switch ON when its keep log is non-empty: such a row kept
 * the uploader's name by the old default (audit 2026-11-07, X8), so turning
 * the switch off must re-gate it.
 * ⚠ `keepPublicFigures` is not in `settings` yet (the gate's caller records
 * only the first two, `collections/Documents.ts`), so it reads its log,
 * `publicFiguresKept`, unless a boolean is recorded. Off with an empty log is
 * then a guess for a row gated with it on that kept nobody: see
 * {@link verdictMismatch}.
 */
export function verdictSettings(row: {
  anonymisationReport?: unknown
  authorsKept?: unknown
  citedAuthorsKept?: unknown
  publicFiguresKept?: unknown
}): Record<AnonymiseSwitch, boolean> {
  const s = settingsOf(row)
  const keepPublicFigures =
    typeof s?.keepPublicFigures === 'boolean' ? s.keepPublicFigures : logged(row.publicFiguresKept)
  if (s) {
    return { keepDocumentAuthor: s.keepDocumentAuthor === true, keepCitedAuthors: s.keepCitedAuthors === true, keepPublicFigures }
  }
  return { keepDocumentAuthor: logged(row.authorsKept), keepCitedAuthors: logged(row.citedAuthorsKept), keepPublicFigures }
}

/**
 * The switches whose current value differs from the verdict's. ⚠ An
 * UNRECORDED `keepPublicFigures` that is on now and "off" by its empty log is
 * not counted: the verdict may well have run with it on and found nobody
 * public, and counting it would call every such row stale. Off now and on by
 * its log always counts (a name is still in the text).
 */
export function verdictMismatch(
  row: Record<string, unknown>,
  now: Record<AnonymiseSwitch, EffectiveSwitch>,
): AnonymiseSwitch[] {
  const made = verdictSettings(row)
  return ANONYMISE_SWITCHES.filter((k) => {
    if (now[k].value === made[k]) return false
    if (k === 'keepPublicFigures' && now[k].value && !verdictRecorded(row, k)) return false
    return true
  })
}

/** May this content kind keep its author or cited names at all? */
export function switchesApply(contentKind: unknown): boolean {
  return contentKind === 'documento' || contentKind === 'testimonio'
}

/** May this switch keep a name in this content kind? `keepPublicFigures` is a `documento`'s only. */
export function switchApplies(key: AnonymiseSwitch, contentKind: unknown): boolean {
  return key === 'keepPublicFigures' ? contentKind === 'documento' : switchesApply(contentKind)
}

/**
 * The effective value of each switch for one row: the row's boolean override,
 * else the ecosistema's feature. 🔴 Fails closed: a read that throws is off,
 * and `keepPublicFigures` is off for anything but a `documento` (a row with
 * no `contentKind` included), as `documentoGateOptions` runs it.
 */
export async function effectiveSwitches(
  payload: Pick<Payload, 'findByID'>,
  organizationId: number | string,
  row: Partial<Record<AnonymiseSwitch, unknown>> & { contentKind?: unknown },
): Promise<Record<AnonymiseSwitch, EffectiveSwitch>> {
  const one = async (key: AnonymiseSwitch): Promise<EffectiveSwitch> => {
    const own = row[key]
    const applies = key !== 'keepPublicFigures' || row.contentKind === 'documento'
    if (typeof own === 'boolean') return { value: applies && own, origin: 'documento' }
    if (!applies) return { value: false, origin: 'ecosistema' }
    try {
      return { value: (await featureEnabled(payload, organizationId, key)) === true, origin: 'ecosistema' }
    } catch {
      return { value: false, origin: 'ecosistema' }
    }
  }
  return {
    keepDocumentAuthor: await one('keepDocumentAuthor'),
    keepCitedAuthors: await one('keepCitedAuthors'),
    keepPublicFigures: await one('keepPublicFigures'),
  }
}

/**
 * The uploader's active membership's `personName` in this ecosistema.
 *
 * 🔴 NEVER `users.displayName`: every account edits its own, so an account
 * named "Carla Méndez" could publish "Autora: Carla Méndez". `personName` only
 * changes through whoever manages members (`manageAccess` in `Memberships.ts`).
 * 🔴 FAILS CLOSED: no active membership, no `personName`, or a failed read all
 * keep no name.
 */
async function uploaderNames(
  payload: Pick<Payload, 'find'>,
  organizationId: number | string,
  uploadedBy: unknown,
): Promise<string[]> {
  const id = uploadedBy && typeof uploadedBy === 'object' ? (uploadedBy as { id?: unknown }).id : uploadedBy
  if (typeof id !== 'number' && typeof id !== 'string') return []
  try {
    const memberships = await payload.find({
      collection: 'memberships',
      where: {
        and: [{ user: { equals: id } }, { organization: { equals: organizationId } }, { isActive: { equals: true } }],
      },
      depth: 0,
      pagination: false,
      overrideAccess: true,
    })
    const names = new Set<string>()
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
  row: {
    contentKind?: unknown
    keepPublicFigures?: unknown
    uploadedBy?: unknown
    keepDocumentAuthor?: unknown
    keepCitedAuthors?: unknown
  },
): Promise<DocumentoGateOptions> {
  const off: DocumentoGateOptions = {
    keepPublicFigures: false,
    roster: [],
    authors: [],
    keepDocumentAuthor: false,
    keepCitedAuthors: false,
  }
  if (!switchesApply(row.contentKind)) return off
  const switches = await effectiveSwitches(payload, organizationId, row)
  const authors = switches.keepDocumentAuthor.value ? await uploaderNames(payload, organizationId, row.uploadedBy) : []
  const keepCitedAuthors = switches.keepCitedAuthors.value
  const keepDocumentAuthor = switches.keepDocumentAuthor.value
  if (row.contentKind !== 'documento') return { ...off, authors, keepDocumentAuthor, keepCitedAuthors }
  try {
    const { rosterForOrganization } = await import('./conversationIngest')
    const roster = await rosterForOrganization(payload as Payload, organizationId)
    const keepPublicFigures =
      typeof row.keepPublicFigures === 'boolean'
        ? row.keepPublicFigures
        : await featureEnabled(payload, organizationId, 'keepPublicFigures')
    return { keepPublicFigures, roster, authors, keepDocumentAuthor, keepCitedAuthors }
  } catch (err) {
    console.warn(
      `[public-figures] roster or setting unreadable for ecosistema ${organizationId}; gating as before (option off, no roster): ${err instanceof Error ? err.name : 'error'}`,
    )
    return { ...off, authors, keepDocumentAuthor, keepCitedAuthors }
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
