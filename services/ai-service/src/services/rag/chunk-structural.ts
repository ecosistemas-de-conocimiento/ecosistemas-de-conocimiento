// Structural chunker — split a document at its own headings instead of at an
// arbitrary token window.
//
// WHY THIS EXISTS
// ---------------
// `chunkRecursive` packs ~800 tokens per chunk and slices wherever the budget
// runs out. For prose that is fine. For any document whose *addressable unit*
// is a numbered section, it is actively harmful: a citation the consumer shows
// the user ("section 12, clause III") has to correspond to something, and a
// 512-token window that starts halfway through section 11 and ends halfway
// through section 13 corresponds to nothing citable. Worse, retrieval scores
// get diluted — the passage that actually answers the query is averaged in
// with two unrelated neighbours.
//
// PROJECT-AGNOSTIC BY CONSTRUCTION (ADR-0001)
// -------------------------------------------
// Shared packages hold MACHINERY; products hold CONTENT. The test is not
// "does this look abstract?" — it is "does this name, encode, or assume one
// product's domain?".
//
// So this module ships NO presets and NO document-format vocabulary. It takes
// a list of heading patterns from the caller and splits on them, and that is
// the whole of it. Whoever owns the documents owns the patterns: a consumer
// puts them in its corpus's `chunk_config` (see `parseStructuralConfig` in
// `chunk-strategy.ts` for the accepted shape). A named preset here would mean
// this repo asserting what some other product's documents look like, which is
// exactly the coupling ADR-0001 exists to prevent — and it would be a one-way
// door, because consumers would start depending on the name.
//
// See also `plan/m3-m4-decisions.md` §11 for the recursive-char strategy this
// sits beside; the two are selected per-corpus via `corpora.chunk_strategy`.

import type { Chunk } from './chunk.js';

/**
 * One level of document structure to split on.
 *
 * `pattern` must match at a chunk boundary and capture the section's
 * identifier in group 1. It is applied with the `gm` flags forced on (plus
 * whatever `flags` adds), so `^` anchors to a line start.
 */
export interface SectionPattern {
  /** Metadata key the captured identifier is stored under (e.g. `section`). */
  key: string;
  /** Regex source. Group 1 = the identifier. */
  pattern: string;
  /** Extra regex flags. `g` and `m` are always added; `i` is the usual addition. */
  flags?: string;
}

export interface StructuralChunkOptions {
  /** Primary split level — one chunk per match (subject to `maxChars`). Required. */
  sections?: SectionPattern[];
  /**
   * Secondary split level, used ONLY to break up a primary section that
   * exceeds `maxChars`. Keeps oversize sections splitting at a meaningful
   * boundary instead of mid-sentence.
   */
  subSections?: SectionPattern[];
  /** Hard ceiling per chunk, in characters. Oversize sections are split. */
  maxChars?: number;
  /**
   * Below this many characters an UNIDENTIFIED span (preamble text, a bare
   * heading line like "CAPÍTULO II") is merged into the previous chunk rather
   * than standing alone. 0 disables merging.
   *
   * A span that carries its own section identifier is NEVER merged, however
   * short. "Section 5. Repealed." is three words and is exactly the kind of
   * provision someone needs to cite; folding it into section 4 because it fell
   * under a length threshold would attach it to the wrong identifier — the one
   * error this whole module exists to prevent.
   */
  minChars?: number;
}

const CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_CHARS = 4000;
const DEFAULT_MIN_CHARS = 80;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Metadata keys the chunker adds for bookkeeping rather than identity. A chunk
 * carrying only these was never matched to a section.
 */
const BOOKKEEPING_KEYS = new Set(['part', 'parts']);

/** Did this chunk come from an actual section boundary (not just a split of unstructured text)? */
export function hasSectionMetadata(chunk: { metadata?: Record<string, unknown> }): boolean {
  const meta = chunk.metadata;
  if (!meta) return false;
  return Object.keys(meta).some((k) => !BOOKKEEPING_KEYS.has(k));
}

// ---------------------------------------------------------------------------
// Splitting
// ---------------------------------------------------------------------------

interface Boundary {
  /** Character offset in the source text where this section starts. */
  start: number;
  key: string;
  id: string;
}

function compile(p: SectionPattern): RegExp {
  const flags = new Set(['g', 'm', ...(p.flags ?? '')]);
  return new RegExp(p.pattern, [...flags].join(''));
}

/** Find every boundary produced by `patterns`, sorted by position, deduped. */
function findBoundaries(text: string, patterns: SectionPattern[]): Boundary[] {
  const found: Boundary[] = [];
  for (const p of patterns) {
    const re = compile(p);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      // Zero-length match would loop forever.
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      found.push({
        start: m.index,
        key: p.key,
        id: normalizeId(m[1] ?? ''),
      });
    }
  }
  found.sort((a, b) => a.start - b.start);
  // Two patterns matching at the same offset: keep the first declared.
  return found.filter((b, i) => i === 0 || b.start !== found[i - 1]!.start);
}

/** Collapse internal whitespace and lowercase so `16  Bis` and `16 bis` agree. */
function normalizeId(raw: string): string {
  return raw.trim().replace(/[ \t]+/g, ' ').replace(/[ \t]*-[ \t]*/g, '-').toLowerCase();
}

/**
 * Split `text` at `sections`. Each primary section becomes one chunk carrying
 * `{ [key]: id }` metadata. A section longer than `maxChars` is split further
 * at `subSections` boundaries (and, failing that, hard-split), with each piece
 * tagged `part: n` and — when a sub-level boundary was used — the sub-level id.
 *
 * Text preceding the first boundary (preamble, title page, "considerandos") is
 * emitted as leading chunk(s) with no section metadata, so nothing is silently
 * dropped.
 */
export function chunkStructural(
  text: string,
  opts: StructuralChunkOptions = {},
): Chunk[] {
  if (text.length === 0) return [];

  const sections = opts.sections ?? [];
  const subSections = opts.subSections ?? [];
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const minChars = opts.minChars ?? DEFAULT_MIN_CHARS;

  if (maxChars <= 0) throw new RangeError(`maxChars must be positive, got ${maxChars}`);
  if (sections.length === 0) {
    throw new RangeError('chunkStructural requires a non-empty `sections` list');
  }

  const boundaries = findBoundaries(text, sections);

  // Build [start, end) spans: preamble (if any), then one per boundary.
  interface Span {
    text: string;
    meta: Record<string, unknown>;
  }
  const spans: Span[] = [];

  const firstStart = boundaries[0]?.start ?? text.length;
  if (firstStart > 0) {
    const preamble = text.slice(0, firstStart);
    if (preamble.trim().length > 0) spans.push({ text: preamble, meta: {} });
  }
  for (let i = 0; i < boundaries.length; i++) {
    const b = boundaries[i]!;
    const end = boundaries[i + 1]?.start ?? text.length;
    spans.push({ text: text.slice(b.start, end), meta: { [b.key]: b.id } });
  }

  // Merge runt spans forward into their predecessor so a bare heading line
  // never becomes a standalone chunk. ONLY spans with no identifier of their
  // own are eligible — see `minChars` for why an identified article is never
  // merged no matter how short.
  const merged: Span[] = [];
  for (const s of spans) {
    const prev = merged[merged.length - 1];
    const isUnidentified = Object.keys(s.meta).length === 0;
    if (
      prev &&
      isUnidentified &&
      s.text.trim().length < minChars &&
      prev.text.length + s.text.length <= maxChars
    ) {
      prev.text += s.text;
      continue;
    }
    merged.push({ text: s.text, meta: { ...s.meta } });
  }

  // Emit, splitting anything still over `maxChars`.
  const out: Chunk[] = [];
  let ordinal = 0;
  const push = (chunkText: string, meta: Record<string, unknown>): void => {
    if (chunkText.trim().length === 0) return;
    out.push({
      ordinal: ordinal++,
      text: chunkText,
      tokens: estimateTokens(chunkText),
      ...(Object.keys(meta).length > 0 ? { metadata: meta } : {}),
    });
  };

  for (const span of merged) {
    if (span.text.length <= maxChars) {
      push(span.text, span.meta);
      continue;
    }
    const pieces = splitOversize(span.text, subSections, maxChars);
    pieces.forEach((piece, i) => {
      push(piece.text, {
        ...span.meta,
        ...piece.meta,
        part: i,
        parts: pieces.length,
      });
    });
  }
  return out;
}

/**
 * Break one oversize span at sub-section boundaries; hard-split whatever is
 * still too long. Each returned piece carries the sub-section id it *starts*
 * at (when there is one) so a citation can still be narrowed below the
 * primary level.
 */
function splitOversize(
  text: string,
  subSections: SectionPattern[],
  maxChars: number,
): Array<{ text: string; meta: Record<string, unknown> }> {
  const pieces: Array<{ text: string; meta: Record<string, unknown> }> = [];
  const subs = subSections.length > 0 ? findBoundaries(text, subSections) : [];

  // Candidate segments: the head (before the first sub-boundary) plus one per
  // sub-boundary. With no sub-boundaries at all this is just the whole text.
  interface Seg {
    text: string;
    meta: Record<string, unknown>;
  }
  const segs: Seg[] = [];
  const head = text.slice(0, subs[0]?.start ?? text.length);
  if (head.length > 0) segs.push({ text: head, meta: {} });
  for (let i = 0; i < subs.length; i++) {
    const b = subs[i]!;
    const end = subs[i + 1]?.start ?? text.length;
    segs.push({ text: text.slice(b.start, end), meta: { [b.key]: b.id } });
  }

  // Greedily pack segments up to `maxChars`, then hard-split any single
  // segment that is still oversize on its own.
  let buf = '';
  let bufMeta: Record<string, unknown> = {};
  const flush = (): void => {
    if (buf.length === 0) return;
    pieces.push({ text: buf, meta: bufMeta });
    buf = '';
    bufMeta = {};
  };
  for (const seg of segs) {
    if (seg.text.length > maxChars) {
      flush();
      for (let i = 0; i < seg.text.length; i += maxChars) {
        pieces.push({
          text: seg.text.slice(i, i + maxChars),
          meta: i === 0 ? seg.meta : {},
        });
      }
      continue;
    }
    if (buf.length + seg.text.length > maxChars) flush();
    if (buf.length === 0) bufMeta = { ...seg.meta };
    buf += seg.text;
  }
  flush();
  return pieces;
}
