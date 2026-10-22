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

// ── the browser allowlist ────────────────────────────────────────────────────

/**
 * Identifier fields of a chunk that may reach the browser. With `score`,
 * `text` and `ordinal` (typed separately below) this is exactly what
 * `provenanceToCitations` reads, plus the `[N]` a cited-only provenance
 * carries. Other scores (`denseScore`, `lexicalScore`, `rerankScore`,
 * `relevance`) are server-side ranking data and stay there.
 */
const BROWSER_CHUNK_IDS = ['chunkId', 'documentId', 'corpus'] as const;

export interface BrowserProvenanceOptions {
  /**
   * Metadata keys probed for the card's title. Defaults to the keys
   * `provenanceToCitations` probes. Pass the same override you pass there.
   */
  titleKeys?: readonly string[];
  /**
   * Extra metadata keys your own client code reads (for example a document id
   * your link resolver uses). Primitive values only.
   */
  metadataKeys?: readonly string[];
  /**
   * Extra top-level provenance keys to keep beside `chunks` (for example a
   * diagnostic flag your client reads). Primitive values only.
   */
  topLevelKeys?: readonly string[];
}

function isPrimitive(v: unknown): v is string | number | boolean {
  return typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
}

function pickPrimitives(src: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = src[k];
    if (isPrimitive(v)) out[k] = v;
  }
  return out;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

type ProvenanceChunk = Provenance['chunks'][number];

function browserChunk(raw: unknown, metadataKeys: readonly string[]): ProvenanceChunk | null {
  const src = asRecord(raw);
  if (!src) return null;
  const out: Record<string, unknown> = {};
  for (const k of BROWSER_CHUNK_IDS) {
    const v = src[k];
    if (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
  }
  if (typeof src.score === 'number' && Number.isFinite(src.score)) out.score = src.score;
  if (typeof src.text === 'string') out.text = src.text;
  if (typeof src.ordinal === 'number' && Number.isInteger(src.ordinal) && src.ordinal > 0) {
    out.ordinal = src.ordinal;
  }
  const meta = asRecord(src.metadata);
  out.metadata = meta ? pickPrimitives(meta, metadataKeys) : null;
  return out as unknown as ProvenanceChunk;
}

/**
 * The browser-safe copy of a provenance: an ALLOWLIST, never a denylist.
 *
 * Retrieved chunks carry free-form ai-service metadata, whatever the ingest
 * pipeline stamped (`sessionId`, `authoredBy`, internal ids). Only what the
 * citation card renders leaves the server:
 *   · per chunk: `chunkId`, `documentId`, `score`, `corpus`, `text`, `ordinal`;
 *   · in `metadata`: the title keys (`titleKeys`) plus `metadataKeys`;
 *   · at the top level: `chunks` plus `topLevelKeys`.
 * Listed keys must hold primitives (string, finite number, boolean); a nested
 * object is dropped whole. A key added to ingest metadata tomorrow stays on
 * the server until someone lists it.
 *
 * Accepts anything, because persisted rows predate it: a `{ chunks }` object
 * or a bare chunk array (an older shape). Unreadable input → `null`, which
 * the card renders as "no sources"; unreadable chunks are dropped. Never
 * mutates its input.
 *
 * Run it on EVERY server→browser path that carries provenance: the sync JSON
 * reply, the stream's terminal frame, persisted turns read back, and any echo
 * of a stored message (a create reply, a populated relation).
 */
export function toBrowserProvenance(
  provenance: unknown,
  options: BrowserProvenanceOptions = {},
): Provenance | null {
  const top = Array.isArray(provenance) ? { chunks: provenance } : asRecord(provenance);
  if (!top || !Array.isArray(top.chunks)) return null;
  const metadataKeys = [...(options.titleKeys ?? DEFAULT_TITLE_KEYS), ...(options.metadataKeys ?? [])];
  const chunks = top.chunks
    .map((c) => browserChunk(c, metadataKeys))
    .filter((c): c is ProvenanceChunk => c !== null);
  const extra = pickPrimitives(top, (options.topLevelKeys ?? []).filter((k) => k !== 'chunks'));
  return { ...extra, chunks };
}
