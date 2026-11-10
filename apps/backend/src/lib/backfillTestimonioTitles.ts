/**
 * ONE-OFF BACKFILL: give every cleared testimonio a system-proposed title
 * (owner ruling 2026-10-24). Driven by `scripts/backfill-testimonio-titles.ts`;
 * the logic lives here so it is tested.
 *
 * Candidates: `contentKind = testimonio` that {@link needsTitle} (no title,
 * `approved`, or a title the current rules refuse; `force` re-titles all), and either
 *   · `ready`/`approved` with a `redactedText` — titled from it, or
 *   · `held` with a `heldText` (owner ruling 2026-10-24: Revisión gets titles)
 *     — titled from the gate's redacted held output, its survivors forbidden.
 * A held row with no `heldText` (structural hold) is skipped: fallback label.
 *
 * 🔴 DRY RUN BY DEFAULT: reads, counts, calls no model. With `apply`, one or two
 * `generate.sync` calls per row through the gate detector's backend
 * (`titleClientFromEnv`: Spark first; hosted only when allowed, never for a
 * held row), paced
 * by `ANONYMISE_DETECT_MIN_GAP_MS` (shared with the gate detector) plus
 * `delayMs` between rows. Each write is guarded exactly like the live path.
 *
 * 🔴 THE SAME SWITCHES AS THE LIVE PATH (re-audit 2026-10-26): a row whose
 * ecosistema turned `testimonioTitles` off (`lib/features.ts`), or any row while
 * `TESTIMONIO_TITLES=off`, is skipped — counted in `disabled`, never sent. The
 * script resolves the stored detector fallback (`lib/platformSettings.ts`, fail
 * closed) inside `clientFor`.
 */

import type { Payload, Where } from 'payload'

import { isConsentHeld, NOT_CONSENT_HELD } from './consentHold'
import { featureEnabled } from './features'
import { relationId } from './permissions'
import {
  TESTIMONIO_TITLE_INPUT_CHARS,
  cleanTitle,
  payloadTitleStore,
  refreshTestimonioTitle,
  testimonioTitlesEnabled,
  type TitleGenerator,
  type TitleSource,
  type TitleStore,
} from './testimonioTitle'

export const TITLE_BACKFILL_WHERE: Where[] = [
  { contentKind: { equals: 'testimonio' } },
  { anonymisationStatus: { in: ['ready', 'approved', 'held'] } },
]

/** The gate output a row is titled from, or null when it has none. */
export function titleSourceOf(row: Record<string, unknown>): {
  text: string
  source: 'redacted' | 'held'
  forbidden: string[]
} | null {
  if (row.contentKind !== 'testimonio') return null
  const status = row.anonymisationStatus
  if (status === 'ready' || status === 'approved') {
    const text = typeof row.redactedText === 'string' ? row.redactedText : ''
    return text.trim() ? { text, source: 'redacted', forbidden: [] } : null
  }
  if (status === 'held') {
    const text = typeof row.heldText === 'string' ? row.heldText : ''
    if (!text.trim()) return null
    const spans = Array.isArray(row.anonymisationSurvivors) ? row.anonymisationSurvivors : []
    const forbidden = spans
      .filter((sp): sp is { start: number; end: number } =>
        Boolean(sp) && typeof sp.start === 'number' && typeof sp.end === 'number')
      .map((sp) => text.slice(sp.start, sp.end))
      .filter((f) => f.trim() !== '')
    return { text, source: 'held', forbidden }
  }
  return null
}

export interface TitleBackfillReport {
  apply: boolean
  candidates: number
  /** Redacted characters that would be (dry run) or were sent, capped per row. */
  inputChars: number
  /** Of `candidates`, how many are held rows titled from `heldText`. */
  held: number
  /** Rows skipped because titles are switched off for their ecosistema (or the process). */
  disabled: number
  written: number
  failed: number
  stale: number
  lastId: string | null
}

/**
 * 🔴 DOES THIS ROW NEED A (NEW) TITLE? No title yet; or `approved` (a title
 * from before 2026-10-24's clear-on-approve fix can be the held text's); or a
 * title today's {@link cleanTitle} refuses against the row's CURRENT gate
 * output. No source hash is stored: these three catch every stale case the
 * write paths can leave, without a migration.
 */
export function needsTitle(row: Record<string, unknown>, picked: { text: string; forbidden: string[] }): boolean {
  const title = typeof row.testimonioTitle === 'string' ? row.testimonioTitle.trim() : ''
  if (title === '') return true
  if (row.anonymisationStatus === 'approved') return true
  return cleanTitle(title, picked.text, picked.forbidden) !== title
}

export async function backfillTestimonioTitles(
  payload: Pick<Payload, 'find' | 'findByID'>,
  /** `null` = no allowed backend for this row (`titleClientFromEnv`): no call. */
  clientFor: (
    organizationId: number | string,
    source: TitleSource,
  ) => TitleGenerator | null | Promise<TitleGenerator | null>,
  opts: {
    apply?: boolean
    force?: boolean
    organizationId?: number | string
    afterId?: number
    limit?: number
    delayMs?: number
    sleep?: (ms: number) => Promise<void>
    /** Test seam. Default: `payloadTitleStore(payload)`. */
    store?: TitleStore
    log?: (line: string) => void
  } = {},
): Promise<TitleBackfillReport> {
  const apply = opts.apply === true
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const where: Where[] = [
    ...TITLE_BACKFILL_WHERE,
    // 🔴 A row held for consent never goes to a model (`lib/consentHold.ts`).
    NOT_CONSENT_HELD,
    ...(opts.organizationId !== undefined ? [{ organization: { equals: opts.organizationId } } as Where] : []),
    ...(opts.afterId !== undefined ? [{ id: { greater_than: opts.afterId } } as Where] : []),
  ]
  const res = await payload.find({
    collection: 'documents',
    where: { and: where },
    sort: 'id',
    limit: opts.limit ?? 1000,
    depth: 0,
    overrideAccess: true,
    pagination: false,
    select: {
      organization: true,
      redactedText: true,
      heldText: true,
      anonymisationSurvivors: true,
      contentKind: true,
      anonymisationStatus: true,
      testimonioTitle: true,
      consentHeld: true,
    },
  } as never)
  const report: TitleBackfillReport = {
    apply,
    candidates: 0,
    inputChars: 0,
    held: 0,
    disabled: 0,
    written: 0,
    failed: 0,
    stale: 0,
    lastId: null,
  }
  const store = opts.store ?? payloadTitleStore(payload as never)
  for (const raw of res.docs as unknown as Array<Record<string, unknown>>) {
    // 🔴 Again per row: a payload that ignores the where still sends nothing.
    if (isConsentHeld(raw)) continue
    const picked = titleSourceOf(raw)
    const org = relationId(raw.organization as never)
    if (!picked || org === null) continue
    if (!opts.force && !needsTitle(raw, picked)) continue
    if (!testimonioTitlesEnabled() || !(await featureEnabled(payload, org, 'testimonioTitles'))) {
      report.disabled += 1
      continue
    }
    const { text } = picked
    report.candidates += 1
    if (picked.source === 'held') report.held += 1
    report.inputChars += Math.min(text.trim().length, TESTIMONIO_TITLE_INPUT_CHARS)
    report.lastId = String(raw.id)
    if (!apply) {
      opts.log?.(`would title document ${raw.id} (org ${org})`)
      continue
    }
    const client = await clientFor(org, picked.source)
    if (!client) {
      report.failed += 1
      opts.log?.(`document ${raw.id}: no allowed model (held rows are Spark-only; FALLBACK=none is no hosted)`)
      continue
    }
    try {
      const out = await refreshTestimonioTitle({
        docId: raw.id as number,
        organizationId: org,
        redactedText: text,
        source: picked.source,
        forbidden: picked.forbidden,
        client,
        store,
        sleep,
      })
      report[out.status] += 1
      // The title is derived from redacted text and is meant for display; the
      // document id and the outcome are enough for the operator's log.
      opts.log?.(`document ${raw.id}: ${out.status}`)
    } catch (err) {
      report.failed += 1
      opts.log?.(`document ${raw.id}: error ${err instanceof Error ? err.name : 'unknown'}`)
    }
    if (opts.delayMs) await sleep(opts.delayMs)
  }
  return report
}
