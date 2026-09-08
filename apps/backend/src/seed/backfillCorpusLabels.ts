/**
 * BACKFILL `documents.tema` AND `documents.lengua` FOR AN ALREADY-SEEDED
 * ECOSISTEMA.
 *
 * `seed/corpus.ts` writes both columns from now on, but it refuses to run
 * against an ecosistema that already holds the corpus — deleting 250 rows to
 * re-seed would retire their chunks from ai-service on the way out. So the 250
 * documents already in `edc_backend` need a separate, one-off pass. This is it.
 *
 *     pnpm exec payload run src/seed/backfillCorpusLabels.cli.ts -- --organization=1
 *     pnpm exec payload run src/seed/backfillCorpusLabels.cli.ts -- --organization=1 --apply
 *
 * 🔴 IT IS A DRY RUN UNTIL `--apply`. It reports exactly what it would change
 * and writes nothing. The default direction matters: this is run by hand,
 * against the SHARED dev database, on a collection whose writes fan out to
 * ai-service. "Show me first" has to be the thing you get by forgetting a flag.
 *
 * 🔴 `--organization` IS REQUIRED AND IS NEVER INFERRED. `plan/adr-corpus-graph.md`
 * §6 gate 1: name the tenant explicitly, always, in every statement that touches
 * documents. A script that defaulted to "organization 1" or to "every
 * organization" would be the one place that rule is not written down.
 *
 * ── HOW A ROW IS MATCHED, AND WHY 59 OF THEM MATCH ONLY HALFWAY ──────────────
 *
 *   · A seeded `documento` carries `SIM_xxxx` in `documents.name`. That joins
 *     straight to `MANIFEST.csv` and yields BOTH labels.
 *   · A seeded `testimonio` carries no `SIM_` id — `seed/corpus.ts`'s `titleFor`
 *     keeps it off deliberately, because it is a key into a table with a
 *     `nombre` column. Its theme is still legible from the title, so it gets
 *     `tema` and never `lengua`.
 *
 * 🔴 THAT ASYMMETRY IS THE FEATURE, NOT A GAP. `lengua` is an attribute of the
 * person a document is about, and on an anonymous Voz it is a re-identification
 * key: of the 34 `(tema, lengua)` cells the 59 seeded testimonios fall into, 18
 * hold exactly one. `collections/Documents.ts` refuses to store it there anyway
 * (`enforceLenguaDocumentoOnly`); the manifest simply cannot be reached from
 * those rows either. Two independent reasons, same answer.
 *
 * ⚠ ANYTHING THAT MATCHES NEITHER IS LEFT ALONE. e2e residue and hand-uploaded
 * documents live in the same ecosistema by the dozen. They are counted and
 * reported, never guessed at.
 *
 * ── WHY `payload.update` AND NOT ONE `UPDATE … FROM (VALUES …)` ──────────────
 *
 * Raw SQL would be one statement and would bypass every hook — including
 * `enforceLenguaDocumentoOnly`, which is the rule this file most needs to be
 * held to. Going through Payload means the backfill obeys the same gate an
 * ordinary write does, so the two cannot disagree. 250 round trips against
 * localhost is not a cost worth trading that for.
 *
 * ⚠ `__skipDocsExtract` IS NOT OPTIONAL. Without it `extractAndIngestHook` fires
 * on every one of these updates and starts 250 background ingests — which is
 * exactly what `ingestSeededDocuments` uses a bare `payload.update` to do ON
 * PURPOSE. Same call, opposite intent, one context key between them.
 *
 * ⚠ EXTENSIONLESS IMPORTS, matching the rest of `src/seed/`.
 */

import type { Payload } from 'payload'

import { themeFromSeededTitle } from './corpus'
import { readCorpusManifest, resolveCorpusDir } from './corpusSource'

/** `Carta de presentación — traducción en salud (SIM_0001)` → `SIM_0001`. */
const SIM_ID = /(SIM_\d+)/

export interface BackfillPlanRow {
  id: number | string
  contentKind: string
  /** Reported, never branched on: the dry run's join-health number. */
  via: 'manifest' | 'title'
  tema: string | null
  lengua: string | null
}

export interface BackfillPlan {
  /** Rows that need a write. */
  changes: BackfillPlanRow[]
  /** Already carrying exactly these values. */
  unchanged: number
  /** Neither a `SIM_` id nor a recognisable seeded title — left alone. */
  unmatched: number
  /** A `SIM_` id that is not in this manifest — a corpus regeneration, or residue. */
  orphaned: number
  scanned: number
}

interface DocRow {
  id: number | string
  name?: unknown
  contentKind?: unknown
  tema?: unknown
  lengua?: unknown
}

/**
 * What the backfill WOULD write, computed with no side effects.
 *
 * ⚠ Pure and separately exported so the decision logic is testable without a
 * database. The write half below is a loop over this.
 */
export function planCorpusLabelBackfill(
  rows: readonly DocRow[],
  manifest: ReadonlyMap<string, { tema: string; lengua: string }>,
): BackfillPlan {
  const plan: BackfillPlan = {
    changes: [],
    unchanged: 0,
    unmatched: 0,
    orphaned: 0,
    scanned: rows.length,
  }

  for (const row of rows) {
    const name = typeof row.name === 'string' ? row.name : ''
    // 🔴 THE RAW COLUMN, not `contentKindOf()`. An unreadable value must not be
    // read as `documento` here — that is the direction that opens `lengua` on a
    // row whose kind we cannot establish. Same comparison as `personaAllowed`.
    const contentKind = typeof row.contentKind === 'string' ? row.contentKind : ''

    let tema: string | null = null
    let lengua: string | null = null
    let via: 'manifest' | 'title'

    const simId = SIM_ID.exec(name)?.[1]
    if (simId) {
      const labels = manifest.get(simId)
      if (!labels) {
        // The row names a document this manifest does not contain. Do not guess:
        // a regenerated corpus renumbers, and writing the wrong theme is worse
        // than writing none.
        plan.orphaned += 1
        continue
      }
      via = 'manifest'
      tema = labels.tema || null
      lengua = contentKind === 'documento' ? labels.lengua || null : null
    } else {
      const fromTitle = themeFromSeededTitle(name)
      if (fromTitle === null) {
        plan.unmatched += 1
        continue
      }
      via = 'title'
      tema = fromTitle
      // ⚠ NEVER FROM A TITLE. The title carries a theme and nothing else; there
      // is no path from a seeded Voz back to the manifest, by design.
      lengua = null
    }

    const storedTema = typeof row.tema === 'string' && row.tema !== '' ? row.tema : null
    const storedLengua = typeof row.lengua === 'string' && row.lengua !== '' ? row.lengua : null
    if (storedTema === tema && storedLengua === lengua) {
      plan.unchanged += 1
      continue
    }

    plan.changes.push({ id: row.id, contentKind, via, tema, lengua })
  }

  return plan
}

export interface BackfillOptions {
  organizationId: number
  /** Writes only when true. Everything else is a report. */
  apply: boolean
}

export interface BackfillResult extends BackfillPlan {
  applied: number
  failed: number
  corpusDir: string
}

export async function backfillCorpusLabels(
  payload: Payload,
  opts: BackfillOptions,
): Promise<BackfillResult | null> {
  const located = resolveCorpusDir()
  if (located.dir === null) {
    // 🔴 REFUSE, do not degrade. Unlike the seed — which must still produce a
    // working stack for a developer who never cloned the corpus — this script
    // has exactly one job and no corpus means it cannot do any of it. Silently
    // reporting "0 rows updated" would read as "already done".
    payload.logger.error(`[backfill-labels] no corpus to read ground truth from. ${located.reason}`)
    return null
  }

  const entries = readCorpusManifest(located.dir)
  const manifest = new Map<string, { tema: string; lengua: string }>(
    entries.map((e) => [e.id, { tema: e.ecosistema, lengua: e.lengua }]),
  )
  if (manifest.size === 0) {
    payload.logger.error(`[backfill-labels] ${located.dir} has a manifest but no readable files.`)
    return null
  }

  const found = await payload.find({
    collection: 'documents',
    where: { organization: { equals: opts.organizationId } },
    // ⚠ EVERY ROW, not a page. A silently truncated backfill looks exactly like
    // a partially-labelled corpus, and the ecosistema holds e2e residue and
    // hand-uploads on top of the corpus's 250.
    pagination: false,
    depth: 0,
    overrideAccess: true,
    select: { name: true, contentKind: true, tema: true, lengua: true },
  })

  const rows = found.docs as unknown as DocRow[]

  const plan = planCorpusLabelBackfill(rows, manifest)
  const result: BackfillResult = { ...plan, applied: 0, failed: 0, corpusDir: located.dir }

  const summary =
    `${plan.scanned} scanned, ${plan.changes.length} to update, ${plan.unchanged} already correct, ` +
    `${plan.unmatched} not seeded by the corpus, ${plan.orphaned} carrying a SIM id this manifest ` +
    `does not have`

  if (!opts.apply) {
    // ⚠ THE SPLIT IS THE NUMBER TO READ. ~191 by SIM id and ~59 by title is a
    // working join; the same total arriving entirely by title means the manifest
    // join broke and every row is about to be labelled from a string match.
    const viaManifest = plan.changes.filter((c) => c.via === 'manifest').length
    const withLengua = plan.changes.filter((c) => c.lengua !== null).length
    payload.logger.info(
      `[backfill-labels] DRY RUN over ecosistema ${opts.organizationId} from ${located.dir}: ` +
        `${summary}. Of the updates: ${viaManifest} joined on a SIM id, ` +
        `${plan.changes.length - viaManifest} matched only their seeded title (theme only), ` +
        `${withLengua} will carry a \`lengua\`. NOTHING WAS WRITTEN — re-run with --apply.`,
    )
    return result
  }

  const startedAt = Date.now()
  for (const change of plan.changes) {
    try {
      await payload.update({
        collection: 'documents',
        id: change.id as never,
        data: { tema: change.tema, lengua: change.lengua } as never,
        overrideAccess: true,
        // 🔴 See the header. Without this every update re-enqueues an ingest.
        context: { __skipDocsExtract: true },
      })
      result.applied += 1
    } catch (err) {
      result.failed += 1
      // ⚠ One failure does not stop the rest: a label is independent per row,
      // and 249 labelled documents with one loud line beats an aborted pass.
      payload.logger.warn(
        `[backfill-labels] document ${change.id}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  payload.logger.info(
    `[backfill-labels] ecosistema ${opts.organizationId}: ${summary}. ` +
      `Applied ${result.applied}, failed ${result.failed}, in ${Date.now() - startedAt}ms. ` +
      'Nothing was re-ingested and nothing was re-extracted.',
  )

  return result
}

/**
 * `--organization=1 --apply` → `{ organizationId: 1, apply: true }`, or an
 * explanation.
 *
 * ⚠ Returns the error rather than throwing, so the CLI can print it and exit 1
 * without a stack trace over a typo.
 *
 * ⚠ NOT `node:util`'s `parseArgs`, and that was measured, not assumed: swapping
 * it in grew this function from 18 lines to 32, because the error message stays
 * either way and `parseArgs` throws on a typo'd flag, so it needs a try/catch to
 * keep the no-stack-trace promise above. One required string and one boolean do
 * not earn that. What it would buy — `--organization 1` with a space, and a loud
 * rejection of an unknown flag — both already fail safe here: the first hits the
 * refusal below, and a misspelt `--apply` yields a dry run.
 */
export function parseBackfillArgs(argv: readonly string[]): BackfillOptions | { error: string } {
  const raw = argv.find((a) => a.startsWith('--organization='))?.slice('--organization='.length)
  if (!raw) {
    return {
      error:
        'Pass --organization=<id>. It is never inferred: every statement that touches documents ' +
        'names its ecosistema explicitly (plan/adr-corpus-graph.md §6). ' +
        '⚠ If you did pass it, you are probably missing the `--` separator — `payload run` eats ' +
        'every argument that is not behind one: ' +
        '`payload run src/seed/backfillCorpusLabels.cli.ts -- --organization=1`.',
    }
  }
  const organizationId = Number(raw)
  if (!Number.isInteger(organizationId) || organizationId <= 0) {
    return { error: `--organization=${raw} is not a positive integer.` }
  }
  return { organizationId, apply: argv.includes('--apply') }
}
