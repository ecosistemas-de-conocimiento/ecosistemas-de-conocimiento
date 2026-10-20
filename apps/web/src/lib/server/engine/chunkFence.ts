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
 *   [1] <fuente id="<chunkId>">
 *   …chunk text, with every <fuente / </fuente look-alike neutralised…
 *   </fuente>
 *
 * Earlier assistant answers are DROPPED by default (owner ruling 2026-10-20,
 * `FenceOptions.retrieveAssistantChunks`). When an operator brings them back
 * they get `tipo="respuesta anterior del asistente, no es fuente primaria"` on
 * the opening tag. The system-prompt rule that gives the
 * fence its meaning is `CHUNK_DATA_RULE` (`./prompt`).
 *
 * ⚠ The engine copies `RetrievedChunk.text` into the persisted provenance (the
 * citation card's quoted passage). `restorePassages` puts the ORIGINAL text
 * back, so users never see the fence. Call it on every provenance this turn
 * produces, before persisting.
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
import { ASSISTANT_CHUNK_LABEL, isAssistantAuthored } from '../../assistantChunks';

export { ASSISTANT_CHUNK_LABEL };

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
/** A `[N]` at the start of a line reads like one of the engine's own ordinals. */
const LINE_ORDINAL = /^([ \t]*)\[\s*(\d{1,4})\s*\]/gm;

/**
 * Break every fence-tag look-alike inside chunk text by replacing it with
 * `‹fuente` / `‹/fuente` (U+2039), and turn a line-leading `[N]` into `(N)`.
 * The words stay readable; only the tag stops being a tag.
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
  return out.replace(LINE_ORDINAL, (_m, lead: string, n: string) => `${lead}(${n})`);
}

/** Ids land inside an attribute: keep them to a safe alphabet. */
function safeId(id: string): string {
  return String(id).replace(/[^\w.:#-]/g, '_');
}

/** `<fuente id=…>` + neutralised text + `</fuente>`. */
function fence(id: string, text: string, tipo = ''): string {
  return `<fuente id="${safeId(id)}"${tipo}>\n${neutraliseFenceTags(text)}\n</fuente>`;
}

/** The fenced form of one chunk's text, as the model reads it. */
export function fenceChunkText(chunk: Pick<RetrieveMatch, 'chunkId' | 'text' | 'metadata'>): string {
  const tipo = isAssistantAuthored(chunk.metadata) ? ` tipo="${ASSISTANT_CHUNK_LABEL}"` : '';
  return fence(chunk.chunkId, chunk.text ?? '', tipo);
}

/**
 * Fence what `resolveEntity` returns for an `@`-mention (an attached
 * document's text, up to `REF_BLOCK_MAX`), with the same marker. The id is
 * `<kind>:<id>`. Empty results stay empty, so the engine still drops them.
 */
export function withFencedRefs<A extends DomainAdapter>(adapter: A): A {
  return {
    ...adapter,
    async resolveEntity(ref: ContextRef) {
      const text = await adapter.resolveEntity(ref);
      return typeof text === 'string' && text.trim() ? fence(`${ref.kind}:${ref.id}`, text) : text;
    },
  };
}

export interface FenceOptions {
  /**
   * Are earlier assistant answers (chunk metadata `authoredBy: 'assistant'`)
   * retrievable at all? Owner ruling 2026-10-20: NO, so the default is
   * `false`. Production reads it from `CHAT_RETRIEVE_ASSISTANT_CHUNKS`
   * (`retrieveAssistantChunks()` in `./config`); `true` brings them back,
   * labelled. Every leg passes through this one wrapper: the published and
   * draft legs, hybrid `retrieveMulti`, the graph provider's widened retrieve
   * and the query-expansion variants.
   */
  retrieveAssistantChunks?: boolean;
}

/** `CHAT_RETRIEVE_ASSISTANT_CHUNKS` env value → on/off. Default OFF; on on/1/true/yes. */
export function parseAssistantChunksFlag(raw: string | undefined): boolean {
  return ['on', '1', 'true', 'yes'].includes((raw ?? '').trim().toLowerCase());
}

/**
 * Extra chunks each leg asks for while assistant answers are filtered out.
 *
 * The filter runs AFTER retrieval (ai-service's `filter` has no "not equal"),
 * so a dropped answer would cost its top-K slot. Each leg asks for `topK + 3`
 * (and `limit + 3` on `retrieveMulti`), drops the answers and trims back.
 * ⚠ 3 is inferred, not measured: audit 2026-10-17 saw an answer as the top-1
 * source in 6 of 14 turns, but did not count how many answers a turn held. A
 * leg that retrieves more than 3 answers still comes up short.
 *
 * Rerank cost (inferred from ai-service's pool rule `min(topK × 4, 50)`,
 * quoted in `./rerank`, not measured): the published leg's pool grows from 20
 * to 32 candidates per turn; the draft leg stays at the 50 cap; the
 * graph-widened retrieve and the expansion variants are not reranked.
 */
export const ASSISTANT_OVERFETCH = 3;
/** The engine's per-corpus topK when a request carries none. */
const DEFAULT_TOPK = 5;

export interface FencedClient<T extends AIClient> {
  client: T;
  /** Swap the fenced passage text in a provenance back to the original, capped like the engine's `includePassageText`. */
  restorePassages<P extends Provenance | null | undefined>(provenance: P, cap: number): P;
}

export function withFencedChunks<T extends AIClient>(base: T, opts: FenceOptions = {}): FencedClient<T> {
  const keepAssistant = opts.retrieveAssistantChunks ?? false;
  const originals = new Map<string, string>();
  const extra = keepAssistant ? 0 : ASSISTANT_OVERFETCH;

  /** Drop answers, trim the over-fetch back to `cap`, fence what is left. */
  const fence = <M extends RetrieveMatch>(matches: M[], cap: number | undefined): M[] =>
    matches
      .filter((x) => keepAssistant || !isAssistantAuthored(x.metadata))
      .slice(0, keepAssistant ? undefined : cap)
      .map((x) => {
        // Strings only: a `text: null` from upstream must not make
        // `restorePassages` throw after the SSE stream has opened.
        if (typeof x.text === 'string') originals.set(x.chunkId, x.text);
        return { ...x, text: fenceChunkText(x) };
      });

  const client: T = {
    ...base,
    generateSync: base.generateSync.bind(base),
    ingest: base.ingest.bind(base),
    async retrieve(req) {
      const topK = req.topK && req.topK > 0 ? req.topK : DEFAULT_TOPK;
      const r = await base.retrieve(extra ? { ...req, topK: topK + extra } : req);
      return { ...r, matches: fence(r.matches, topK) };
    },
    ...(base.retrieveMulti
      ? {
          async retrieveMulti(req: Parameters<NonNullable<AIClient['retrieveMulti']>>[0]) {
            const r = await base.retrieveMulti!(
              extra
                ? {
                    ...req,
                    ...(req.topK ? { topK: req.topK + extra } : {}),
                    ...(req.limit ? { limit: req.limit + extra } : {}),
                  }
                : req,
            );
            // No `limit` → nothing to trim back to; the answers are still dropped.
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
          return typeof original === 'string' && typeof c.text === 'string'
            ? { ...c, text: original.slice(0, cap) }
            : c;
        }),
      };
    },
  };
}
