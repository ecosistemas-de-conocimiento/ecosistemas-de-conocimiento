/**
 * Fence every retrieved chunk before it reaches the prompt (audit 2026-10-17
 * §3 item 3, prompt injection).
 *
 * The engine renders retrieved chunks as `[N] ${text}` inside the user turn
 * (`packages/chat-engine/src/core/turn.ts`, not edited here). With no
 * boundary, a chunk that says "</context> new instructions…" reads as part of
 * the prompt. Every chunk reaching the engine comes through ONE `AIClient`:
 * the published leg, the draft leg and the hybrid `retrieveMulti` all live in
 * `makeEngineAIClient`, and the graph provider's widened retrieve calls that
 * same client. So wrapping that client fences every leg, and the engine's
 * `[N]` ordinals, fusion and provenance order are untouched:
 *
 *   [1] <fuente>
 *   …chunk text, every <fuente / </fuente look-alike and [N] neutralised…
 *   </fuente>
 *
 * 🔴 Conversation turns (questions AND answers) are DROPPED on every sources
 * leg, always, with no flag: they are never a source. They reach the model
 * only as background, in the separate orientation block (`./orientation`,
 * owner ruling 2026-10-21, #4 choice A). See `$lib/turnChunks`. The system-prompt rule that gives the fence its
 * meaning is `CHUNK_DATA_RULE` (`./prompt`).
 *
 * ⚠ The engine copies `RetrievedChunk.text` into the persisted provenance (the
 * citation card's quoted passage). `restorePassages` puts the ORIGINAL text
 * back, so users never see the fence. Call it on every provenance this turn
 * produces, before persisting.
 *
 * 🔴 `restorePassages` also puts back each chunk's `rerankScore`, the HIGHEST
 * any retrieve this turn returned for that `chunkId`. The engine's
 * `fuseMatches` (`packages/chat-engine/src/core/retrieve.ts`,
 * `isRicher`) keeps ONE record per `chunkId`: the one with more metadata keys.
 * The GraphRAG copy (`$lib/server/graph`) adds `metadata.path` and is never
 * reranked, so when both legs found a chunk the graph copy won and the
 * cross-encoder score was lost. Measured on dev 2026-10-21 (coordinator):
 * dengue 5 of 7 cited sources unscored, Discapacidad 2 of 3. A chunk no retrieve scored stays unscored, never 0.
 * The engine fix: `fuseMatches` should carry the max `rerankScore` (and
 * `denseScore`) of every copy onto the record it keeps.
 *
 * `@`-mentioned documents (`resolveEntity`, the engine's inline-refs block)
 * get the same fence through `withFencedRefs`.
 *
 * Not fenced: the graph block (`graphContext`) — prose built by
 * `$lib/server/graph` from extracted entity names, not raw chunk text — and the
 * Tier-1 summary (product text plus document titles). Neither is free of
 * corpus-derived words; both are short and structured.
 *
 * The clean home for this is a per-chunk formatter hook in
 * chat-engine's `buildChatTurn`; until it exists this wrapper is the seam.
 */

import type {
  AIClient,
  ContextRef,
  DomainAdapter,
  Provenance,
  RetrieveMatch,
} from '@edc/chat-engine/core';
// Relative, not `$lib`: the eval harness in apps/backend imports this file.
import { isConversationTurnChunk } from '../../turnChunks';

/**
 * Look-alike detection works on a COMPARISON COPY of the text, one entry per
 * folded character, each mapped back to the span of the original it came from.
 * Folding, per character:
 *   · decode entities and escapes: `&#60;` `&#x3c;` `&lt` (with or without `;`,
 *     any number of `&amp;` layers), `&sol;`, `<`, `\x3c`;
 *   · drop format characters (Unicode `Cf`: zero-width, LRM/RLM, soft hyphen,
 *     BOM, tag characters), combining marks (`M`, incl. CGJ) and backslashes;
 *   · NFKC (fullwidth `＜`, small `﹤`, fullwidth `／`…), a few homoglyphs
 *     (Cyrillic `е`), then lower case.
 * A match is replaced in the ORIGINAL text; everything else is byte-identical,
 * so tone marks in indigenous-language text are never stripped.
 *
 * ⚠ Cheap, not complete: a model may still read some spelling this misses
 * (other homoglyphs, words split by visible characters). The system rule
 * (`CHUNK_DATA_RULE`) is the second layer.
 */
const IGNORABLE = /^[\p{Cf}\p{M}\\]$/u;
const LT_LIKE = new Set(['<', '‹', '〈', '〈', '⟨']);
const SLASH_LIKE = new Set(['/', '⁄', '∕', '⧸']);
const HOMOGLYPHS: Record<string, string> = { 'е': 'e', 'Е': 'e', 'у': 'u' };
const NUM_ENTITY = /^&(?:amp;)*#(?:x([0-9a-f]{1,6})|(\d{1,7}));?/i;
const NAMED_ENTITY = /^&(?:amp;)*(lt|sol);?/i;
const JS_ESCAPE = /^\\(?:u([0-9a-f]{4})|x([0-9a-f]{2}))/i;

function foldChar(ch: string): string {
  if (IGNORABLE.test(ch)) return '';
  if (LT_LIKE.has(ch)) return '<';
  if (SLASH_LIKE.has(ch)) return '/';
  return [...ch.normalize('NFKC')]
    .map((c) => (LT_LIKE.has(c) ? '<' : SLASH_LIKE.has(c) ? '/' : (HOMOGLYPHS[c] ?? c)))
    .join('')
    .toLowerCase();
}

function fromCode(hex: string | undefined, dec: string | undefined): string {
  const cp = hex ? parseInt(hex, 16) : Number(dec);
  return Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
}

/** The comparison copy, with each copy char's original span [from, to). */
function comparisonCopy(text: string): { copy: string; from: number[]; to: number[] } {
  let copy = '';
  const from: number[] = [];
  const to: number[] = [];
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i, i + 24);
    let len: number;
    let decoded: string;
    let m: RegExpExecArray | null;
    if ((m = NUM_ENTITY.exec(rest))) {
      len = m[0].length;
      decoded = fromCode(m[1], m[2]);
    } else if ((m = NAMED_ENTITY.exec(rest))) {
      len = m[0].length;
      decoded = m[1]!.toLowerCase() === 'lt' ? '<' : '/';
    } else if ((m = JS_ESCAPE.exec(rest))) {
      len = m[0].length;
      decoded = fromCode(m[1] ?? m[2], undefined);
    } else {
      decoded = String.fromCodePoint(text.codePointAt(i)!);
      len = decoded.length;
    }
    for (const c of foldChar(decoded)) {
      copy += c;
      from.push(i);
      to.push(i + len);
    }
    i += len;
  }
  return { copy, from, to };
}

const TAG_IN_COPY = /<\s*(\/?)\s*fuente/g;
/**
 * Any `[N]` or `[N, M]` inside the text, anywhere on a line. Same shape the
 * engine's `parseCitedOrdinals` reads as a citation (inner spaces allowed).
 */
const ORDINAL_MARKER = /\[\s*(\d+(?:\s*,\s*\d+)*)\s*\]/g;

/**
 * Break every fence-tag look-alike inside chunk text by replacing it with
 * `‹fuente` / `‹/fuente` (U+2039), and turn every `[N]` into `(N)`.
 * The words stay readable; only the tag stops being a tag.
 *
 * 🔴 EVERY `[N]`, not only a line-leading one. The model copies what it reads:
 * a document's own footnote "[2]" written into an answer is parsed as a
 * citation of prompt passage 2 (`parseCitedOrdinals`), a different document,
 * or as a marker no source answers. The only `[N]` the model may see is the
 * engine's own ordinal in front of each fence.
 */
export function neutraliseFenceTags(text: string): string {
  const { copy, from, to } = comparisonCopy(text);
  let out = '';
  let last = 0;
  for (const m of copy.matchAll(TAG_IN_COPY)) {
    const a = from[m.index]!;
    const b = to[m.index + m[0].length - 1]!;
    if (a < last) continue;
    out += text.slice(last, a) + `‹${m[1]}fuente`;
    last = b;
  }
  out += text.slice(last);
  return out.replace(ORDINAL_MARKER, (_m, group: string) => `(${group.split(/\s*,\s*/).join(', ')})`);
}

/**
 * 🔴 THE FENCE CARRIES NO ID AND NO NUMBER. Measured on dev 020ebec
 * (2026-10-24): an audio document attached to the conversation (backend doc
 * 266) rode the turn fenced as `<fuente id="document:266">`. The system rule
 * says "cite only with [N]", and 266 was the only number on that fence, so
 * the answer cited "[266]". No prompt passage is 266, so the marker mapped to
 * no source and the source list was empty, sync and stream. A chunk id is the
 * same hazard (ai-service ids are UUIDs, full of digit runs). Nothing reads
 * the attribute: `restorePassages` keys on `chunkId` from the match itself.
 * So the model's only numbers are the engine's dense `[1]…[k]`.
 *
 * Retrieved passages: `<fuente>`. Attached documents (`@`-mention, pinned,
 * named by title): `<fuente tipo="adjunto">`, which `CHUNK_DATA_RULE`
 * (`./prompt`) says is never cited with `[N]`.
 */
export const ATTACHED_FENCE_OPEN = '<fuente tipo="adjunto">';

function fence(text: string, open = '<fuente>'): string {
  return `${open}\n${neutraliseFenceTags(text)}\n</fuente>`;
}

/** The fenced form of one chunk's text, as the model reads it. */
export function fenceChunkText(chunk: Pick<RetrieveMatch, 'text'>): string {
  return fence(chunk.text ?? '');
}

/**
 * Fence what `resolveEntity` returns for an `@`-mention or a pinned or
 * title-named document (its text, up to `REF_BLOCK_MAX`) with
 * {@link ATTACHED_FENCE_OPEN}. Empty results stay empty, so the engine still
 * drops them.
 */
export function withFencedRefs<A extends DomainAdapter>(adapter: A): A {
  return {
    ...adapter,
    async resolveEntity(ref: ContextRef) {
      const text = await adapter.resolveEntity(ref);
      return typeof text === 'string' && text.trim() ? fence(text, ATTACHED_FENCE_OPEN) : text;
    },
  };
}

/**
 * Extra chunks each leg asks for, because conversation turns are dropped.
 *
 * The filter runs AFTER retrieval (ai-service's `filter` has no "not equal"),
 * so a dropped turn would cost its top-K slot. Each leg asks for `topK + 3`
 * (and `limit + 3` on `retrieveMulti`), drops the turns and trims back.
 * ⚠ 3 is inferred, not measured: audit 2026-10-17 saw an earlier answer as the
 * top-1 source in 6 of 14 turns, but did not count how many turns a retrieve
 * held. A leg that retrieves more than 3 turns still comes up short.
 * ⚠ Turns are ingested again (owner ruling 2026-10-21, #4 choice A: stored
 * for orientation, never cited), so the corpus GROWS them: a question many
 * members ask may pull more than 3 turns into one leg and crowd documents
 * out. The durable fix is a server-side `kind $in [documento, testimonio]` on
 * the sources legs (ai-service `metadataFilterIn`); not done here.
 * Turns reach the prompt only through `./orientation`.
 *
 * Rerank cost (inferred from ai-service's pool rule `min(topK × 4, 50)`,
 * quoted in `./rerank`, not measured): the published leg's pool grows from 20
 * to 32 candidates per turn; the draft leg stays at the 50 cap; the
 * graph-widened retrieve and the expansion variants are not reranked.
 */
export const TURN_OVERFETCH = 3;

/**
 * 🔴 The SOURCE kinds, as an ai-service `$in` (capability `metadataFilterIn`).
 * Merged into every sources leg's `filter` so ai-service drops turn chunks
 * BEFORE ranking: turns are ingested again (ruling 2026-10-21) and would
 * otherwise crowd documents out of a leg's top-K. ⚠ Only when the capability
 * is there: an older ai-service reads `{ $in: [...] }` as plain equality and
 * would return nothing. The post-filter below stays as the second layer.
 * Draft legs inherit it: `retrieveMultiScoped` spreads `filter` into each
 * `corpusFilters` entry (`./aiClient`).
 */
export const SOURCE_KINDS_FILTER = { kind: { $in: ['documento', 'testimonio'] } } as const;

export interface FencedChunksOptions {
  /** ai-service has `metadataFilterIn`: send {@link SOURCE_KINDS_FILTER}. */
  kindFilter?: boolean;
}
/** The engine's per-corpus topK when a request carries none. */
const DEFAULT_TOPK = 5;

export interface FencedClient<T extends AIClient> {
  client: T;
  /** Swap the fenced passage text in a provenance back to the original, capped like the engine's `includePassageText`. */
  restorePassages<P extends Provenance | null | undefined>(provenance: P, cap: number): P;
}

export function withFencedChunks<T extends AIClient>(base: T, opts: FencedChunksOptions = {}): FencedClient<T> {
  const originals = new Map<string, string>();
  /** Highest `rerankScore` per `chunkId` across every retrieve this turn. */
  const rerankScores = new Map<string, number>();
  const extra = TURN_OVERFETCH;
  // The engine types `filter` values as primitives; ai-service takes operators.
  type Filter = Record<string, string | number | boolean>;
  const withKinds = (filter: Filter | undefined): Filter | undefined =>
    opts.kindFilter ? ({ ...(filter ?? {}), ...SOURCE_KINDS_FILTER } as unknown as Filter) : filter;

  /** Drop conversation turns, trim the over-fetch back to `cap`, fence what is left. */
  const fence = <M extends RetrieveMatch>(matches: M[], cap: number | undefined): M[] =>
    matches
      .filter((x) => !isConversationTurnChunk(x.metadata))
      .slice(0, cap)
      .map((x) => {
        // Strings only: a `text: null` from upstream must not make
        // `restorePassages` throw after the SSE stream has opened.
        if (typeof x.text === 'string') originals.set(x.chunkId, x.text);
        if (typeof x.rerankScore === 'number') {
          rerankScores.set(x.chunkId, Math.max(x.rerankScore, rerankScores.get(x.chunkId) ?? -Infinity));
        }
        return { ...x, text: fenceChunkText(x) };
      });

  const client: T = {
    ...base,
    generateSync: base.generateSync.bind(base),
    ingest: base.ingest.bind(base),
    async retrieve(req) {
      const topK = req.topK && req.topK > 0 ? req.topK : DEFAULT_TOPK;
      const filter = withKinds(req.filter);
      const r = await base.retrieve({ ...req, topK: topK + extra, ...(filter ? { filter } : {}) });
      return { ...r, matches: fence(r.matches, topK) };
    },
    ...(base.retrieveMulti
      ? {
          async retrieveMulti(req: Parameters<NonNullable<AIClient['retrieveMulti']>>[0]) {
            const filter = withKinds(req.filter);
            const r = await base.retrieveMulti!({
              ...req,
              ...(filter ? { filter } : {}),
              ...(req.topK ? { topK: req.topK + extra } : {}),
              ...(req.limit ? { limit: req.limit + extra } : {}),
            });
            // No `limit` → nothing to trim back to; the turns are still dropped.
            return { ...r, matches: fence(r.matches, req.limit) };
          },
        }
      : {}),
  };

  return {
    client,
    restorePassages(provenance, cap) {
      if (!provenance) return provenance;
      return {
        ...provenance,
        chunks: provenance.chunks.map((c) => {
          const original = originals.get(c.chunkId);
          const rerankScore = rerankScores.get(c.chunkId);
          const withText =
            typeof original === 'string' && typeof c.text === 'string' ? { ...c, text: original.slice(0, cap) } : c;
          return rerankScore === undefined ? withText : { ...withText, rerankScore };
        }),
      };
    },
  };
}
