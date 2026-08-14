// Retrieval-eval runner — run a golden set through `RetrieveService` under one
// or more named configurations and report per-config aggregates.
//
// Project-agnostic machinery (ADR-0001). It knows about queries, relevance
// labels and metrics; it knows nothing about any consumer's subject matter —
// that lives in the golden ITEMS, which the consumer owns.
//
// The runner calls the service directly rather than going over HTTP. That is
// deliberate: it removes auth, rate limits and serialisation from the
// measurement, and lets a caller inject a deterministic embedder so a run
// costs nothing and is byte-reproducible.

import type { RetrieveService } from '../services/rag/retrieve.js';
import type { RetrievedChunk } from '../services/rag/types.js';
import { mean, ndcg, normalizeForMatch, precision, recall, reciprocalRank, round4 } from './metrics.js';
import type { ConfigReport, EvalConfig, GoldenItem, ItemResult } from './types.js';

export interface RunnerCtx {
  org: string;
  project: string;
}

/**
 * Map a retrieved chunk back to the consumer-facing document id. The runner
 * needs `documents.external_id`, but `/v1/retrieve` returns the internal
 * `documentId` UUID — so the caller supplies the mapping it built at ingest.
 */
export type DocIdResolver = (documentId: string) => string | undefined;

export interface RunOptions {
  service: RetrieveService;
  items: GoldenItem[];
  config: EvalConfig;
  ctx: RunnerCtx;
  resolveDocId: DocIdResolver;
}

/** Does this chunk's metadata match every key/value in `section`? */
function matchesSection(chunk: RetrievedChunk, section: Record<string, string>): boolean {
  const meta = chunk.metadata ?? {};
  return Object.entries(section).every(
    (entry) => normalizeForMatch(String(meta[entry[0]] ?? '')) === normalizeForMatch(entry[1]),
  );
}

/**
 * Is this result relevant to the item?
 *
 * An item may label relevance by document, by section, or both. When both are
 * present a result must satisfy BOTH — that is the strict reading, and the one
 * that catches "right document, wrong section", which is precisely the error a
 * citation surface must not make.
 */
function isRelevant(
  chunk: RetrievedChunk,
  item: GoldenItem,
  resolveDocId: DocIdResolver,
): boolean {
  const hasDocLabels = (item.relevantDocs?.length ?? 0) > 0;
  const hasSectionLabels = (item.relevantSections?.length ?? 0) > 0;
  if (!hasDocLabels && !hasSectionLabels) return false;

  if (hasDocLabels) {
    const ext = resolveDocId(chunk.documentId);
    if (ext === undefined || !item.relevantDocs!.includes(ext)) return false;
  }
  if (hasSectionLabels) {
    if (!item.relevantSections!.some((s) => matchesSection(chunk, s))) return false;
  }
  return true;
}

/**
 * The distinct relevant UNITS an item declares. A unit is a section label when
 * the item has any, otherwise a document label.
 *
 * Relevance has to be counted per unit, not per chunk. One labelled document
 * can produce a dozen chunks, and counting each of them as a separate "hit"
 * makes recall and nDCG exceed 1 — and, worse, systematically flatters
 * whichever config returns the most chunks from one document, which is the
 * opposite of what a retrieval metric should reward.
 */
function relevantUnits(item: GoldenItem): string[] {
  if ((item.relevantSections?.length ?? 0) > 0) {
    return item.relevantSections!.map((s) =>
      Object.entries(s)
        .sort()
        .map(([k, v]) => `${k}=${normalizeForMatch(v)}`)
        .join(','),
    );
  }
  return item.relevantDocs ?? [];
}

/** Which declared unit (if any) this chunk covers. */
function unitFor(
  chunk: RetrievedChunk,
  item: GoldenItem,
  resolveDocId: DocIdResolver,
): string | undefined {
  if ((item.relevantSections?.length ?? 0) > 0) {
    const hit = item.relevantSections!.find((s) => matchesSection(chunk, s));
    if (!hit) return undefined;
    return Object.entries(hit)
      .sort()
      .map(([k, v]) => `${k}=${normalizeForMatch(v)}`)
      .join(',');
  }
  const ext = resolveDocId(chunk.documentId);
  return ext !== undefined && (item.relevantDocs ?? []).includes(ext) ? ext : undefined;
}

export function evaluateItem(
  item: GoldenItem,
  chunks: RetrievedChunk[],
  resolveDocId: DocIdResolver,
): ItemResult {
  const flags = chunks.map((c) => isRelevant(c, item, resolveDocId));
  const units = relevantUnits(item);
  const totalRelevant = units.length;

  // Label-deduplicated flags: true only at the rank where a unit is FIRST
  // covered. These are what recall and nDCG are computed from, so both stay
  // in [0, 1] and reward covering DISTINCT relevant units early rather than
  // returning eight chunks of the same section.
  const seen = new Set<string>();
  const novelFlags = chunks.map((c, i) => {
    if (!flags[i]) return false;
    const u = unitFor(c, item, resolveDocId);
    if (u === undefined || seen.has(u)) return false;
    seen.add(u);
    return true;
  });
  const nUnitsCovered = seen.size;
  const nRelevantChunks = flags.filter(Boolean).length;
  const failures: string[] = [];

  // ── forbidden content: the correctness floor ────────────────────────────
  let forbiddenHits = 0;
  for (const pattern of item.mustNotContain ?? []) {
    const needle = normalizeForMatch(pattern);
    for (const c of chunks) {
      if (normalizeForMatch(c.text).includes(needle)) {
        forbiddenHits++;
        failures.push(`FORBIDDEN: retrieved text contains "${pattern}" (chunk ${c.chunkId})`);
      }
    }
  }

  // ── mustContain, scoped by kind ─────────────────────────────────────────
  // `citation_groundedness` asserts on rank 1 alone: a citation points at one
  // passage, so a fact that only shows up at rank 7 does not ground it.
  // `qa_faithfulness` asserts on the union: the generator sees every chunk.
  const scope =
    item.kind === 'citation_groundedness'
      ? chunks.slice(0, 1)
      : chunks;
  const haystack = normalizeForMatch(scope.map((c) => c.text).join('\n'));
  for (const pattern of item.mustContain ?? []) {
    if (!haystack.includes(normalizeForMatch(pattern))) {
      failures.push(
        item.kind === 'citation_groundedness'
          ? `MISSING at rank 1: "${pattern}"`
          : `MISSING in top-${chunks.length}: "${pattern}"`,
      );
    }
  }

  // ── ranking assertions ──────────────────────────────────────────────────
  if (totalRelevant > 0 && nUnitsCovered === 0) {
    failures.push('NO RELEVANT RESULT retrieved');
  }
  if (item.kind === 'citation_groundedness' && totalRelevant > 0 && !flags[0]) {
    failures.push('rank 1 is not a labelled-relevant result');
  }

  return {
    itemId: item.id,
    kind: item.kind,
    tags: item.tags ?? [],
    pass: failures.length === 0,
    failures,
    recallAtK: round4(recall(nUnitsCovered, totalRelevant)),
    // Precision uses the RAW per-chunk flags: "how much of what I returned was
    // on target" is a per-result question, and returning three chunks of the
    // right section genuinely is more precise than returning one right and two
    // wrong.
    precisionAtK: round4(precision(nRelevantChunks, chunks.length)),
    reciprocalRank: round4(reciprocalRank(flags)),
    ndcgAtK: round4(ndcg(novelFlags, totalRelevant)),
    forbiddenHits,
    retrievedDocs: [...new Set(chunks.map((c) => resolveDocId(c.documentId) ?? c.documentId))],
  };
}

/** Run every item under one config and aggregate. */
export async function runConfig(opts: RunOptions): Promise<ConfigReport> {
  const { service, items, config, ctx, resolveDocId } = opts;
  const results: ItemResult[] = [];

  for (const item of items) {
    const { chunks } = await service.retrieve(
      {
        corpus: item.corpus,
        query: item.query,
        topK: config.topK,
        ...(config.mode !== undefined ? { mode: config.mode } : {}),
        ...(config.mmr !== undefined ? { mmr: config.mmr } : {}),
        ...(config.rrfK !== undefined ? { rrfK: config.rrfK } : {}),
        ...(config.rerank !== undefined ? { rerank: config.rerank } : {}),
        ...(config.rerankModel !== undefined ? { rerankModel: config.rerankModel } : {}),
        ...(item.asOf !== undefined ? { asOf: item.asOf } : {}),
      },
      ctx,
    );
    results.push(evaluateItem(item, chunks, resolveDocId));
  }

  const byTag: ConfigReport['byTag'] = {};
  for (const r of results) {
    for (const tag of r.tags) {
      const slot = (byTag[tag] ??= { n: 0, nPass: 0, passRate: 0 });
      slot.n++;
      if (r.pass) slot.nPass++;
    }
  }
  for (const slot of Object.values(byTag)) {
    slot.passRate = round4(slot.n === 0 ? 0 : slot.nPass / slot.n);
  }

  const nPass = results.filter((r) => r.pass).length;
  return {
    config,
    nItems: results.length,
    nPass,
    passRate: round4(results.length === 0 ? 0 : nPass / results.length),
    meanRecallAtK: round4(mean(results.map((r) => r.recallAtK))),
    meanPrecisionAtK: round4(mean(results.map((r) => r.precisionAtK))),
    mrr: round4(mean(results.map((r) => r.reciprocalRank))),
    meanNdcgAtK: round4(mean(results.map((r) => r.ndcgAtK))),
    totalForbiddenHits: results.reduce((n, r) => n + r.forbiddenHits, 0),
    byTag,
    items: results,
  };
}

/** Render a compact comparison table. Fixed-width so successive runs diff cleanly. */
export function formatComparison(reports: ConfigReport[]): string {
  const lines: string[] = [];
  const pad = (s: string, n: number) => s.padEnd(n);
  const num = (x: number) => x.toFixed(3).padStart(7);

  lines.push('');
  lines.push(`${pad('config', 22)} ${pad('pass', 9)} ${'recall'.padStart(7)} ${'MRR'.padStart(7)} ${'nDCG'.padStart(7)} ${'prec'.padStart(7)}  stale`);
  lines.push('-'.repeat(80));
  for (const r of reports) {
    lines.push(
      `${pad(r.config.name, 22)} ${pad(`${r.nPass}/${r.nItems}`, 9)} ${num(r.meanRecallAtK)} ${num(r.mrr)} ${num(r.meanNdcgAtK)} ${num(r.meanPrecisionAtK)}  ${String(r.totalForbiddenHits).padStart(5)}`,
    );
  }

  const tags = [...new Set(reports.flatMap((r) => Object.keys(r.byTag)))].sort();
  if (tags.length > 0) {
    lines.push('');
    lines.push('pass rate by tag');
    lines.push('-'.repeat(80));
    lines.push(`${pad('tag', 22)} ${reports.map((r) => pad(r.config.name, 16)).join(' ')}`);
    for (const tag of tags) {
      const cells = reports.map((r) => {
        const s = r.byTag[tag];
        return pad(s ? `${s.nPass}/${s.n}  ${(s.passRate * 100).toFixed(0)}%` : '—', 16);
      });
      lines.push(`${pad(tag, 22)} ${cells.join(' ')}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}
