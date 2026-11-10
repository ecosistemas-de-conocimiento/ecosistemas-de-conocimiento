/**
 * RE-EXTRACT THE GRAPH OF EVERY PUBLISHED DOCUMENT, whatever its prompt stamp.
 * Logic: `src/lib/graph/backfill.ts` (`runGraphBackfill` with `allPublished`).
 *
 * 🔴 DRY RUN BY DEFAULT: lists every document it would send, with its
 * ecosistema and corpus-text length, and an estimated cost. Calls no model,
 * writes nothing, deletes nothing.
 *
 * 🔴 WHAT IT NEVER TOUCHES (2026-11-10, audit `taller-2026-11-10/rutas.md` #6):
 *   · a draft, in any ecosistema — the query asks `publicationStatus =
 *     'published'` and each row is checked again; so org 8's Semiosis
 *     workshop drafts (held until their authors consent) are out;
 *   · a row held for consent (`lib/graph/consentHold.ts`, `isConsentHeld`;
 *     today no row is: edc-1 defines the mark);
 *   · a gated row without a cleared text (`corpusTextFor`): skipped, as the
 *     live path does.
 *
 * ── Who it calls (APPLY only) ───────────────────────────────────────────────
 *
 * Per document, up to `GRAPH_EXTRACT_MAX_WINDOWS` (8) `generate.sync` calls to
 * ai-service at the `deep` tier, with `X-AI-Org: eco-<id>` (booked to that
 * ecosistema's budget). ai-service sends them to OpenRouter, DeepSeek V3.1
 * (quoted, `docs/03-arquitectura/pila-de-ia.md` table "Extracción del grafo").
 * Zero data retention: ai-service asks `provider.zdr: true` on every
 * OpenRouter call and fails rather than send without it (quoted, same doc
 * §"OpenRouter", "en el código desde el 2026-11-07; sin desplegar a esa
 * fecha"). ⚠ Before APPLY on dev, confirm the deployed ai-service has it:
 * `docker exec <ai-service> grep -c zdr dist/services/ai/router/adapters/openrouter.js`
 * (path inferred from the source layout) must be > 0. What is sent:
 * `corpusTextFor(row)` (the anonymised text of a gated row, the text of a
 * plain documento) and `titleFor` (a neutral title for a gated kind). No
 * embeddings, no detector, no gate.
 *
 * ── How to run it on dev ────────────────────────────────────────────────────
 *
 * Inside the backend container, with the Payload binary, never `pnpm` in the
 * image (`docs/05-infraestructura/despliegue-y-runbook.md` §6.6). `<backend>`
 * is the dev backend container's name (`docker ps`).
 *
 *     # 1. dry run (default): the list and the estimate
 *     docker exec -w /repo/apps/backend <backend> \
 *       node_modules/.bin/payload run scripts/reextract-published-graph.ts
 *     # one ecosistema, the first N
 *     docker exec -w /repo/apps/backend -e GRAPH_REEXTRACT_ORG=6 -e GRAPH_REEXTRACT_LIMIT=5 <backend> \
 *       node_modules/.bin/payload run scripts/reextract-published-graph.ts
 *     # 2. apply, detached (a long run must outlive the SSH session, §6.6)
 *     docker exec -d -w /repo/apps/backend -e GRAPH_REEXTRACT_APPLY=1 <backend> sh -c \
 *       'node_modules/.bin/payload run scripts/reextract-published-graph.ts > /tmp/reextract-graph.log 2>&1'
 *
 * Env (not flags: `payload run` does not reliably forward argv):
 *   GRAPH_REEXTRACT_APPLY=1           extract for real (default: dry run)
 *   GRAPH_REEXTRACT_ORG=<id>          only this ecosistema (default: all)
 *   GRAPH_REEXTRACT_LIMIT=<n>         stop after n documents (default: all)
 *   GRAPH_REEXTRACT_NO_SWEEP=1        skip the orphan-entity sweep at the end
 *   GRAPH_REEXTRACT_USD_PER_WINDOW    price for the estimate (default 0.0029,
 *                                     quoted from ADR §5.2 — an estimate)
 *
 * ── How to verify ──────────────────────────────────────────────────────────
 *
 *   · The dry run's ids are all `published`: `SELECT id, publication_status
 *     FROM documents WHERE id IN (…)` — none is a draft, none is org 8's
 *     workshop.
 *   · After APPLY: the log ends `listo: N extraídos, F fallidos, S omitidos`;
 *     exit 1 when F > 0. `SELECT graph_status, graph_prompt_version, count(*)
 *     FROM documents WHERE publication_status = 'published' GROUP BY 1, 2` —
 *     every published row `ready`/`skipped` at the current prompt version.
 *   · The org 8 drafts' `graph_extracted_at` did not move.
 *   · ai-service `usage_logs` for the run's window: the calls and `costUsd`,
 *     to replace the estimate above with a measurement.
 *
 * Exit 0 = ran (dry run, or every extraction ok). Exit 1 = could not run, or
 * some extraction failed.
 */

import { runGraphBackfill, type GraphBackfillPayload } from '../src/lib/graph/backfill'
import { DEFAULT_USD_PER_WINDOW, estimateWindows } from '../src/lib/graph/reextractWikilinkNotes'
import { safeErrMessage } from '../src/lib/errorSummary'

const positiveInt = (raw: string | undefined): number | undefined => {
  if (!raw || !/^\d+$/.test(raw.trim())) return undefined
  const n = Number(raw)
  return n > 0 ? n : undefined
}

async function main(): Promise<number> {
  const apply = process.env.GRAPH_REEXTRACT_APPLY === '1'
  const orgRaw = process.env.GRAPH_REEXTRACT_ORG?.trim()
  const organizationId = orgRaw ? positiveInt(orgRaw) : undefined
  // 🔴 A typo must never widen the run to every ecosistema.
  if (orgRaw && organizationId === undefined) throw new Error(`GRAPH_REEXTRACT_ORG is not an id: "${orgRaw}"`)
  const limit = positiveInt(process.env.GRAPH_REEXTRACT_LIMIT)
  const usdRaw = Number(process.env.GRAPH_REEXTRACT_USD_PER_WINDOW ?? '')
  const usdPerWindow = Number.isFinite(usdRaw) && usdRaw > 0 ? usdRaw : DEFAULT_USD_PER_WINDOW

  const { getPayload } = await import('payload')
  const config = (await import('@payload-config')).default
  const payload = await getPayload({ config })

  console.log(
    `[reextract-published-graph] mode=${apply ? 'APPLY' : 'dry-run'} org=${organizationId ?? 'todas'} limit=${limit ?? 'sin límite'}`,
  )
  const result = await runGraphBackfill(payload as unknown as GraphBackfillPayload, {
    allPublished: true,
    dryRun: !apply,
    ...(organizationId !== undefined ? { organizationId } : {}),
    ...(limit !== undefined ? { limit } : {}),
    skipOrphanSweep: process.env.GRAPH_REEXTRACT_NO_SWEEP === '1',
  })

  const windows = result.planned.reduce((n, p) => n + estimateWindows(p.chars), 0)
  const usd = Math.round(windows * usdPerWindow * 10_000) / 10_000
  const byOrg = new Map<string, number>()
  for (const p of result.planned) byOrg.set(String(p.organizationId), (byOrg.get(String(p.organizationId)) ?? 0) + 1)
  console.log(
    `[reextract-published-graph] ${result.planned.length} documento(s) al extractor, por ecosistema: ` +
      [...byOrg].map(([o, n]) => `${o}=${n}`).join(' '),
  )
  console.log(`[reextract-published-graph] ids=${result.planned.map((p) => p.id).join(',')}`)
  console.log(
    `[reextract-published-graph] ≈ ${windows} ventanas ≈ $${usd} a $${usdPerWindow}/ventana ` +
      '(inferred: estimateWindows × precio citado del ADR §5.2, antes de reintentos)',
  )
  if (!apply) {
    console.log('[reextract-published-graph] simulación: nada se envió. GRAPH_REEXTRACT_APPLY=1 para correrlo.')
    return 0
  }
  if (result.failed > 0) {
    console.error(`[reextract-published-graph] ${result.failed} documento(s) fallaron`)
    return 1
  }
  return 0
}

// `payload run` awaits only the import; top-level await keeps it alive.
try {
  process.exit(await main())
} catch (err) {
  console.error('[reextract-published-graph] failed:', safeErrMessage(err))
  process.exit(1)
}
