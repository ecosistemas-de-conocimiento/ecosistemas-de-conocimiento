/**
 * 🔴 ONE-OFF: CLEAR THE NEAR-RAW `heldText` OF HOLDS FROM BEFORE P-01.
 *
 * A `content` hold whose model never ran (`gate.ts`: "La revisión automática
 * no pudo terminar (…)") has had no text since P-01 (audit 2026-11-10): stages
 * 1-2 are all that touched it, so every third-party name is still in it. Rows
 * held BEFORE P-01 still store that text in `documents.held_text`. It is never
 * shown (`holdReview.ts` `modelNeverRan`), but it sits in the database. This
 * sets `held_text` and `held_text_hash` to NULL on those rows. Nothing else
 * changes: the hold stays a hold, its reason, report and status stay, and a
 * reviewer can still only reject it.
 *
 * Selection (the same criterion as `modelNeverRan`, on the stored row):
 *   · `anonymisation_status = 'held'`
 *   · `anonymisation_error` starts `content: La revisión automática no pudo terminar`
 *   · `held_text IS NOT NULL` (a post-P-01 hold has none: nothing to clear)
 *   · 🔴 NEVER an ecosistema in {@link EXCLUDED_ORGANIZATIONS} (org 8, Semiosis:
 *     the workshop is held for its authors' consent and left exactly as it is)
 *   · 🔴 NEVER a row held for consent (`notConsentHeldSql`)
 *
 * 🔴 DRY RUN UNLESS `apply`: reads ids only, never the text. With `apply`, ONE
 * guarded `UPDATE … RETURNING id` (the same predicate, so a row that changed
 * since the read is not touched). No Payload hooks, no model, no ai-service.
 * Each changed id is logged, never any text. ⚠ `updated_at` is left as it was:
 * the review queue sorts on it, and this is not a review event.
 *
 * CLI: `scripts/clear-legacy-held-text.ts`.
 */

import type { ConsentDb } from './consentHold'
import { notConsentHeldSql } from './consentHold'
import { MODEL_NEVER_RAN } from './holdReview'

/** 🔴 Ecosistemas this script never touches. */
export const EXCLUDED_ORGANIZATIONS: readonly number[] = [8]

/** The stored `anonymisation_error` prefix of a hold whose model never ran. */
export const LEGACY_HOLD_ERROR_PREFIX = `content: ${MODEL_NEVER_RAN}`

export interface LegacyHeldTextReport {
  apply: boolean
  /** Rows matching the selection (dry run) or found before the write (apply). */
  ids: number[]
  /** Rows written (0 on a dry run). */
  cleared: number
  clearedIds: number[]
}

const rowsOf = (result: unknown): Record<string, unknown>[] =>
  ((result as { rows?: Record<string, unknown>[] })?.rows ?? []) as Record<string, unknown>[]

export async function clearLegacyHeldText(
  db: ConsentDb,
  opts: { apply: boolean; organizationId?: number; log?: (line: string) => void },
): Promise<LegacyHeldTextReport> {
  const { sql } = await import('@payloadcms/db-postgres')
  const log = opts.log ?? (() => undefined)
  if (opts.organizationId !== undefined && !Number.isInteger(opts.organizationId)) {
    throw new Error('clear-legacy-held-text: the ecosistema id must be a number')
  }
  // ⚠ `%`/`_` do not occur in the prefix; LIKE is a plain prefix match here.
  const where = sql.join(
    [
      sql`anonymisation_status = 'held'`,
      sql`anonymisation_error LIKE ${`${LEGACY_HOLD_ERROR_PREFIX}%`}`,
      sql`held_text IS NOT NULL`,
      sql`(organization_id IS NULL OR organization_id NOT IN (${sql.join(
        EXCLUDED_ORGANIZATIONS.map((o) => sql`${o}`),
        sql`, `,
      )}))`,
      sql.raw(notConsentHeldSql()),
      ...(opts.organizationId !== undefined ? [sql`organization_id = ${opts.organizationId}`] : []),
    ],
    sql` AND `,
  )

  const ids = rowsOf(await db.execute(sql`SELECT id FROM documents WHERE ${where} ORDER BY id`)).map((r) => Number(r.id))
  for (const id of ids) log(`doc ${id}: ${opts.apply ? 'clearing' : 'would clear'} held_text`)
  const report: LegacyHeldTextReport = { apply: opts.apply, ids, cleared: 0, clearedIds: [] }
  if (!opts.apply || ids.length === 0) return report

  const cleared = rowsOf(
    await db.execute(
      sql`UPDATE documents SET held_text = NULL, held_text_hash = NULL
          WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}) AND ${where}
          RETURNING id`,
    ),
  )
    .map((r) => Number(r.id))
    .sort((a, b) => a - b)
  for (const id of cleared) log(`doc ${id}: held_text cleared`)
  report.cleared = cleared.length
  report.clearedIds = cleared
  return report
}
