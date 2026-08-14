// Retrieval metrics. Pure functions, no I/O — unit-testable on their own.
//
// All of these take a ranked list of "was this result relevant?" booleans.
// Keeping them boolean (binary relevance) rather than graded is a deliberate
// simplification: graded relevance needs a judge, and a judge is either a
// human (expensive) or an LLM (expensive and itself uncalibrated). Binary
// labels are cheap to author, cheap to audit, and sufficient to detect the
// regressions this harness exists to catch.

/** Fold accents, case and whitespace so document text and query text compare predictably. */
export function normalizeForMatch(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Share of the known-relevant set that appears anywhere in the ranked list. */
export function recall(relevantRetrieved: number, totalRelevant: number): number {
  if (totalRelevant === 0) return 1;
  return relevantRetrieved / totalRelevant;
}

/** Share of returned results that were relevant. */
export function precision(relevantRetrieved: number, nRetrieved: number): number {
  if (nRetrieved === 0) return 0;
  return relevantRetrieved / nRetrieved;
}

/**
 * Reciprocal rank of the FIRST relevant result (1-based). 0 when none.
 * Averaged across items this is MRR — the metric that best tracks "did the
 * user get their answer without scrolling", which is what matters when the
 * retrieved passages are about to be pasted into a prompt with a token budget.
 */
export function reciprocalRank(flags: boolean[]): number {
  const i = flags.indexOf(true);
  return i === -1 ? 0 : 1 / (i + 1);
}

/**
 * Normalised discounted cumulative gain at k, binary gain.
 *
 * DCG discounts by log2(rank+1); the ideal ranking puts every relevant item
 * first. Unlike MRR this rewards getting the SECOND and THIRD relevant results
 * high too, which matters here because the consumer feeds several chunks to
 * the generator, not just one.
 */
/**
 * `flags` MUST be label-deduplicated (at most one `true` per known-relevant
 * unit) or the result can exceed 1. `evaluateItem` guarantees this by flagging
 * only the position at which each label is FIRST covered — see the note there
 * on why a raw per-chunk flag array is the wrong input.
 */
export function ndcg(flags: boolean[], totalRelevant: number): number {
  if (totalRelevant === 0) return 1;
  let dcg = 0;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i]) dcg += 1 / Math.log2(i + 2);
  }
  const ideal = Math.min(totalRelevant, flags.length);
  let idcg = 0;
  for (let i = 0; i < ideal; i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Round to 4 dp so report output is stable and diffable. */
export function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}
