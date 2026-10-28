/**
 * QUEUE A MODEL RE-EXTRACTION OF A SEEDING ECOSISTEMA'S `[[wikilink]]` NOTES.
 * Entry point: `scripts/reextract-wikilink-notes.ts`.
 *
 * Notes graphed before seeding existed carry the CURRENT `graphPromptVersion`,
 * so `lib/graph/backfill.ts` never selects them, and the version must not be
 * bumped (owner ruling 2026-10-28: it would re-run every ecosistema). This
 * clears the stamp on THOSE rows only — by id, org in every WHERE — which is
 * the backfill's own staleness predicate (`Documents.ts` does the same on a
 * `contentKind` change). The operator then runs
 * `GRAPH_BACKFILL_ORG=<id> payload run src/lib/graph/backfill.cli.ts`.
 *
 * 🔴 DRY RUN BY DEFAULT: lists ids and an estimated cost, writes nothing.
 * ⚠ No model call here. The cost is in the backfill run that follows.
 */
import { sql } from '@payloadcms/db-postgres'

import { DEFAULT_STALE_EXTRACTING_MS } from './backfill'
import { graphMaxWindows, graphWindowChars } from './extract'
import { GRAPH_PROMPT_VERSION } from './prompt'
import { wikiLinkSeedingEnabled } from './schedule'
import type { SeedExecutor } from './writer'

/**
 * quoted from `plan/adr-corpus-graph.md` §5.2 ("~3 windows × $0.0029" per
 * document), which marks it an ESTIMATE, not a measurement. Override with
 * `REEXTRACT_USD_PER_WINDOW` once a real run reports `costUsd`.
 */
export const DEFAULT_USD_PER_WINDOW = 0.0029

/** Windows one text costs, as `splitIntoWindows` would cut it (inferred: ignores paragraph packing). */
export function estimateWindows(chars: number, windowChars = graphWindowChars(), maxWindows = graphMaxWindows()): number {
  if (!(chars > 0)) return 0
  return Math.min(maxWindows, Math.ceil(chars / Math.max(1, windowChars)))
}

/**
 * `REEXTRACT_IDS` → ids, or `undefined` when UNSET (every note).
 *
 * 🔴 A SET value must be exactly `^\d+(,\d+)*$`: set-but-empty, `1e2`,
 * `0x10`, spaces or a stray comma throw. `Number()` alone accepts all of
 * those, and a typo must never drop or bend the id filter.
 */
export function parseReextractIds(raw: string | undefined): number[] | undefined {
  if (raw === undefined) return undefined
  if (!/^\d+(,\d+)*$/.test(raw)) {
    throw new Error(`REEXTRACT_IDS is set but is not a comma-separated list of ids: "${raw}"`)
  }
  const ids = raw.split(',').map(Number)
  if (ids.some((n) => !Number.isSafeInteger(n) || n <= 0)) throw new Error(`REEXTRACT_IDS has an id out of range: "${raw}"`)
  return ids
}

export interface CostLine {
  ids: number[]
  windows: number
  /** inferred: `windows × usdPerWindow`, before retries. */
  estimatedUsd: number
}

export interface ReextractPlan extends CostLine {
  organizationId: number
  apply: boolean
  usdPerWindow: number
  queued: number
  /**
   * ⚠ Rows `backfill.cli.ts` with `GRAPH_BACKFILL_ORG` would pick up ANYWAY
   * (stale prompt stamp, `failed`, stuck `extracting` — `staleDocumentsWhere`),
   * not among `ids`. The backfill run costs `ids` + these.
   */
  alreadyStale: CostLine
  /** What the backfill run will actually cost: `ids` ∪ `alreadyStale`. */
  backfillTotal: { documents: number; windows: number; estimatedUsd: number }
}

const rowsOf = (result: unknown): Record<string, unknown>[] =>
  Array.isArray(result) ? result : ((result as { rows?: Record<string, unknown>[] })?.rows ?? [])

export async function planWikilinkReextraction(
  db: SeedExecutor,
  opts: { organizationId: number; ids?: number[]; apply: boolean; usdPerWindow?: number },
): Promise<ReextractPlan> {
  const org = opts.organizationId
  if (!Number.isInteger(org) || !wikiLinkSeedingEnabled(org)) {
    throw new Error(`ecosistema ${String(org)} is not in WIKILINK_SEED_ORGS (lib/graph/schedule.ts)`)
  }
  // 🔴 An explicit id list that is empty is a typo, not "all notes".
  if (opts.ids !== undefined && opts.ids.length === 0) throw new Error('ids was given but is empty')
  const usdPerWindow = opts.usdPerWindow ?? DEFAULT_USD_PER_WINDOW
  const usd = (windows: number) => Math.round(windows * usdPerWindow * 10_000) / 10_000
  const idFilter =
    opts.ids && opts.ids.length > 0 ? sql` AND id IN (${sql.join(opts.ids.map((i) => sql`${i}`), sql`, `)})` : sql``
  // Markdown documento notes with a link in their source. Text length from the
  // column the corpus reads (redacted first), for the estimate only.
  const rows = rowsOf(
    await db.execute(sql`
      SELECT id, length(coalesce(nullif(redacted_text, ''), extracted_text, '')) AS chars
        FROM documents
       WHERE organization_id = ${org} AND kind = 'markdown' AND content_kind = 'documento'
         AND body_markdown LIKE '%[[%'${idFilter}
       ORDER BY id`),
  )
  const ids = rows.map((r) => Number(r.id))
  const windows = rows.reduce((n, r) => n + estimateWindows(Number(r.chars) || 0), 0)

  // ⚠ MIRRORS `staleDocumentsWhere(org)` in `backfill.ts` (same version, same
  // cutoff, same "has text" rule); `wikilinks.pg.test.ts` checks the two agree.
  const cutoff = new Date(Date.now() - DEFAULT_STALE_EXTRACTING_MS).toISOString()
  const staleRows = rowsOf(
    await db.execute(sql`
      SELECT id, length(coalesce(nullif(redacted_text, ''), extracted_text, '')) AS chars
        FROM documents
       WHERE organization_id = ${org} AND extracted_text IS NOT NULL
         AND (graph_prompt_version IS NULL OR graph_prompt_version <> ${GRAPH_PROMPT_VERSION}
              OR graph_status = 'failed'
              OR (graph_status = 'extracting' AND updated_at < ${cutoff}))
       ORDER BY id`),
  ).filter((r) => !ids.includes(Number(r.id)))
  const staleWindows = staleRows.reduce((n, r) => n + estimateWindows(Number(r.chars) || 0), 0)
  const queuedWithText = rows.filter((r) => Number(r.chars) > 0).length

  const plan: ReextractPlan = {
    organizationId: org,
    apply: opts.apply,
    ids,
    windows,
    estimatedUsd: usd(windows),
    usdPerWindow,
    queued: 0,
    alreadyStale: { ids: staleRows.map((r) => Number(r.id)), windows: staleWindows, estimatedUsd: usd(staleWindows) },
    backfillTotal: {
      documents: queuedWithText + staleRows.length,
      windows: windows + staleWindows,
      estimatedUsd: usd(windows + staleWindows),
    },
  }
  if (!opts.apply || ids.length === 0) return plan
  const queued = rowsOf(
    await db.execute(sql`
      UPDATE documents SET graph_prompt_version = NULL, updated_at = ${new Date().toISOString()}
       WHERE organization_id = ${org} AND id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
       RETURNING id`),
  )
  plan.queued = queued.length
  return plan
}
