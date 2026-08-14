/**
 * Pure helpers that normalize a product's persisted provenance into the
 * domain-agnostic `CitationLike[]` the canonical `CitationCard` renders. No
 * DOM / svelte imports — unit-testable and shared by every consumer.
 *
 * The engine produces `Provenance` (retrieved chunks); `provenanceToCitations`
 * maps that to `CitationLike`. A consumer with a different citation source can
 * map to `CitationLike` itself — the card only ever sees `CitationLike`.
 */

import type { CitationLike, Provenance } from './types.js';

/**
 * A piece of assistant content split for inline citation rendering: either a
 * literal text run or a clickable `[N]` citation marker. Lets the card render
 * markers as real buttons WITHOUT `{@html}` (clean-text invariant), the way
 * `splitContentByRefs` does for `@`-mention pills.
 */
export type CitationSegment =
  | { type: 'text'; text: string }
  | { type: 'cite'; ordinal: number };

/**
 * Split assistant `content` into text + `[N]` citation-marker segments. Only
 * ordinals present in `validOrdinals` become markers — a stray `[7]` in prose
 * with no 7th citation stays literal text. Markers may be bare (`[1]`) or
 * grouped (`[1, 2]` / `[1][2]`); each recognised number becomes its own
 * segment, in source order.
 *
 * Pure: no DOM, regex-only.
 */
export function splitContentByCitations(
  content: string,
  validOrdinals: number[] | Set<number>,
): CitationSegment[] {
  const valid = validOrdinals instanceof Set ? validOrdinals : new Set(validOrdinals);
  if (valid.size === 0 || !content) return [{ type: 'text', text: content }];

  const segments: CitationSegment[] = [];
  // Match a bracketed run of comma/space-separated numbers: [1] or [1, 2].
  const re = /\[\s*\d+(?:\s*,\s*\d+)*\s*\]/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(content)) !== null) {
    const nums = (m[0].match(/\d+/g) ?? []).map(Number).filter((n) => valid.has(n));
    if (nums.length === 0) continue; // no recognised ordinal → leave literal
    if (m.index > last) segments.push({ type: 'text', text: content.slice(last, m.index) });
    for (const n of nums) segments.push({ type: 'cite', ordinal: n });
    last = m.index + m[0].length;
  }
  if (last < content.length) segments.push({ type: 'text', text: content.slice(last) });
  if (segments.length === 0) segments.push({ type: 'text', text: content });
  return segments;
}

/**
 * What `provenanceToCitations` can read out of a chunk's free-form `metadata`
 * to fill the card. All optional; a product whose ai-service stamps a different
 * key passes a `titleKeys` override.
 */
const DEFAULT_TITLE_KEYS = ['title', 'documentTitle', 'document_title', 'name', 'source'] as const;

export interface ProvenanceToCitationsOptions {
  /**
   * Ordered metadata keys to probe for a human title (first non-empty wins).
   * Defaults to common keys. The chunk's `corpus` is the final fallback.
   */
  titleKeys?: readonly string[];
  /**
   * Map a chunk to an href for "open the source". Most consumers inject the
   * resolver on the card instead (it has the live registry/routes), but this is
   * handy when the URL is known at normalize time.
   */
  hrefFor?: (chunk: Provenance['chunks'][number], ordinal: number) => string | null;
}

function pickTitle(
  metadata: Record<string, unknown> | null | undefined,
  keys: readonly string[],
): string | null {
  if (!metadata) return null;
  for (const k of keys) {
    const v = metadata[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Normalize engine `Provenance` (or anything with the same `chunks` shape) into
 * `CitationLike[]`, in chunk order, 1-based ordinals. `null`/empty provenance →
 * `[]`. The title falls back metadata → corpus; the passage comes from the
 * additive `chunk.text` (≥0.3.0) when present.
 */
export function provenanceToCitations(
  provenance: Provenance | null | undefined,
  options: ProvenanceToCitationsOptions = {},
): CitationLike[] {
  const chunks = provenance?.chunks;
  if (!chunks || chunks.length === 0) return [];
  const titleKeys = options.titleKeys ?? DEFAULT_TITLE_KEYS;

  return chunks.map((c, i): CitationLike => {
    const ordinal = i + 1;
    const title = pickTitle(c.metadata, titleKeys) ?? c.corpus ?? null;
    const href = options.hrefFor ? options.hrefFor(c, ordinal) : null;
    return {
      ordinal,
      title,
      passageText: c.text ?? null,
      score: typeof c.score === 'number' ? c.score : null,
      href,
      documentId: c.documentId ?? null,
      chunkId: c.chunkId ?? null,
      corpus: c.corpus ?? null,
      metadata: c.metadata ?? null,
    };
  });
}
