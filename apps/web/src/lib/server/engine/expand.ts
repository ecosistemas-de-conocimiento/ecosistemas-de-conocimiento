/**
 * Query expansion ("query rewriting"): before searching, ask the cheap model
 * for a few rewordings of the question plus one short hypothetical answer,
 * search all of them, and fuse the results. Goal: find the document when the
 * user asks vaguely, or in words the document does not use.
 *
 * ── WHERE IT SITS ────────────────────────────────────────────────────────────
 *
 * A DECORATOR on the engine's `AIClient`, and only on `retrieve`. Nothing in
 * `@edc/chat-engine` changes (it does not do
 * multi-query as of 0.6). The engine calls `retrieve` once per corpus with the
 * CONDENSED query, so this wrapper sees the standalone question — after the
 * engine's own anaphora rewrite (`condenseQuery`), never the raw follow-up.
 *
 *   · `generateSync` passes through untouched: condense and the answer itself
 *     are not expanded.
 *   · The expansion is memoised per query text, so ONE model call serves every
 *     corpus of the turn (published + draft + the engine's thread leg).
 *   · Every rewording is retrieved with the request's own corpus, `topK` and
 *     `filter` — the `lengua` restriction applies to every variant.
 *   · The GraphRAG provider is handed the UNWRAPPED client by the caller: its
 *     one widened retrieve is its own expansion and must not trigger a second
 *     model call.
 *
 * ── HOW THE LISTS ARE FUSED ──────────────────────────────────────────────────
 *
 * Two legs into the engine's own `fuseMatches` (RRF, k = 60): the original
 * query's ranking, and the rewordings' union ranked by cosine. Within one
 * corpus and one embedding model those cosines share a scale, which is why the
 * union may be ranked by score (inferred, not measured — a hypothetical-answer
 * passage likely scores higher than a short question, so it may lead that
 * leg). A chunk both legs found wins. The result is capped at the request's
 * `topK`, so the engine's cross-corpus merge sees exactly as many chunks as
 * before.
 *
 * ⚠ `score` is RE-ASSIGNED BY RANK after fusion (audit C-5). Fused position
 * `i` takes the `i`-th highest score of the ORIGINAL query's list; positions
 * past its end take its lowest score. So within a corpus `score` follows the
 * RRF order, and across corpora it stays on the scale the original search
 * produced (cosine without rerank, cross-encoder with it). Before, a chunk only
 * a variant found kept its cosine while the original's carried the
 * cross-encoder value, and the engine's cross-corpus sort compared the two.
 * When the original found nothing in this corpus there is no scale to borrow:
 * under rerank those chunks get 0 (they sort after every reranked hit);
 * without rerank they keep their cosine, which is the same scale anyway.
 *
 * Relevance gates are unaffected: they read `denseScore`. A chunk whose
 * `score` WAS its cosine (no `denseScore`, `rerankScore` or `lexicalScore`)
 * gets that cosine copied to `denseScore` before `score` is replaced, so
 * `thresholdScore` reads the same number it read before.
 *
 * ── RERANK (`./rerank`, CHAT_RERANK) ─────────────────────────────────────────
 *
 * Only the ORIGINAL query's search carries `rerank`; the variant searches go
 * out without it. ai-service has no stand-alone rerank endpoint, so the fused
 * list cannot be reranked once as a whole, and reranking every variant would
 * be four cross-encoder calls per corpus instead of one — against a
 * hypothetical-answer "query" the cross-encoder was not built to score. The
 * rank-derived `score` above is what keeps that choice from mixing scales.
 *
 * Best-effort like every engine context step: a failing, slow or junk
 * expansion degrades to the plain retrieve and logs one `[expand]` line.
 */

import type {
  AIClient,
  RetrieveMatch,
  RetrieveRequest,
  RetrieveResult,
  RetrievedChunk,
} from '@edc/chat-engine/core';
import { fuseMatches } from '@edc/chat-engine/core';

/** At most this many variants are searched besides the original. */
export const MAX_EXPANSIONS = 3;
/**
 * Give up on the expansion after this long and search the original only.
 * Inferred, not measured: a `quick` call usually returns in 1–2 s.
 */
export const EXPANSION_TIMEOUT_MS = 5000;
/** The engine always sends `topK`; this only covers a request without one. */
const DEFAULT_TOPK = 5;
/** Longest variant kept, in characters. */
const MAX_VARIANT_CHARS = 300;
/** Above this many characters the query is already specific — not expanded. */
const MAX_EXPANDABLE_CHARS = 400;

export const EXPANSION_SYSTEM_PROMPT =
  'Ayudas a buscar en una biblioteca de documentos y testimonios de un ecosistema ' +
  'de conocimiento. Recibes la pregunta de una persona. Escribe exactamente tres ' +
  'líneas, sin numerarlas ni explicar nada:\n' +
  '1. La pregunta dicha con otras palabras (sinónimos, términos más formales).\n' +
  '2. La pregunta dicha con palabras más cotidianas o nombrando el tema general.\n' +
  '3. Una respuesta hipotética breve, de una o dos oraciones, como la diría un ' +
  'documento que la responde. Puede inventar detalles: solo sirve para buscar.\n' +
  'Escribe en español. Conserva nombres propios, lugares y lenguas tal como aparecen.';

export interface ExpansionTrace {
  query: string;
  variants: string[];
  ms: number;
  costUsd: number;
}

export interface QueryExpansionOptions {
  /** Attribution for the expansion call (same tags as the turn's generate). */
  surface: string;
  orgId: string;
  scopeId?: string;
  userId: string;
  /** Called once per expanded query — the eval harness records it. */
  onExpansion?: (trace: ExpansionTrace) => void;
}

/** `QUERY_EXPANSION` env value → on/off. Default ON; off on off/0/false/no. */
export function parseExpansionFlag(raw: string | undefined): boolean {
  const v = (raw ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(v);
}

/**
 * Worth a model call? Not for one word ("hola", "gracias" — and a single
 * keyword is what the original search already matches best), and not for a
 * pasted wall of text, which is already specific.
 */
export function shouldExpand(query: string): boolean {
  const q = query.trim();
  if (q.length > MAX_EXPANDABLE_CHARS) return false;
  return q.split(/\s+/).filter(Boolean).length >= 2;
}

/** Case- and accent-folded, punctuation-free key for duplicate detection. */
function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * The model's text → up to `MAX_EXPANSIONS` clean variants. Strips list
 * numbering, a leading "Label:" and quotes; drops lines under 3 chars, repeats,
 * and the original question itself.
 */
export function parseExpansions(text: string, original: string): string[] {
  const seen = new Set([fold(original)]);
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw
      .trim()
      .replace(/^(?:\d+[.)]|[-*•])\s*/, '')
      .replace(/^[\p{L} ]{3,30}:\s+/u, '')
      .replace(/^["'«“”]+|["'»“”]+$/g, '')
      .trim()
      .slice(0, MAX_VARIANT_CHARS);
    const key = fold(line);
    if (line.length < 3 || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length === MAX_EXPANSIONS) break;
  }
  return out;
}

function withDeadline<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Wrap `client` so each `retrieve` also searches the query's rewordings and
 * fuses them in. See the module header. Build one per turn — the memo lives
 * as long as the wrapper.
 */
export function withQueryExpansion<T extends AIClient>(client: T, opts: QueryExpansionOptions): T {
  const memo = new Map<string, Promise<string[]>>();

  const expand = async (query: string): Promise<string[]> => {
    const started = Date.now();
    try {
      const result = await client.generateSync({
        surface: opts.surface,
        orgId: opts.orgId,
        ...(opts.scopeId ? { scopeId: opts.scopeId } : {}),
        userId: opts.userId,
        effort: 'quick',
        messages: [
          { role: 'system', content: EXPANSION_SYSTEM_PROMPT },
          { role: 'user', content: `Pregunta: ${query}` },
        ],
      });
      const variants = parseExpansions(result.text, query);
      if (variants.length === 0) console.warn('[expand] the model returned no usable rewording');
      opts.onExpansion?.({ query, variants, ms: Date.now() - started, costUsd: result.costUsd });
      return variants;
    } catch (err) {
      // Name only: the message can carry upstream detail (budget figures).
      console.warn(`[expand] expansion failed (${(err as Error)?.name ?? 'Error'}); plain search`);
      return [];
    }
  };

  const variantsFor = (query: string): Promise<string[]> => {
    let p = memo.get(query);
    if (!p) {
      p = withDeadline(expand(query), EXPANSION_TIMEOUT_MS, []);
      memo.set(query, p);
    }
    return p;
  };

  return {
    ...client,
    async retrieve(req: RetrieveRequest): Promise<RetrieveResult> {
      if (!shouldExpand(req.query)) return client.retrieve(req);
      // The original search starts now, alongside the model call.
      const originalP = client.retrieve(req);
      const variants = await variantsFor(req.query);
      if (variants.length === 0) return originalP;
      // Variants are never reranked — see "RERANK" in the module header.
      const { rerank: _rerank, ...variantReq } = req;

      const [original, ...rewritten] = await Promise.all([
        originalP,
        ...variants.map((query) =>
          client.retrieve({ ...variantReq, query }).catch(() => ({ matches: [] }) as RetrieveResult),
        ),
      ]);
      // `fuseMatches` wants `RetrievedChunk`; the engine tags `corpus` after us.
      const tag = (r: RetrieveResult) =>
        (r.matches ?? []).map((x) => ({ ...x, corpus: req.corpus }) as RetrievedChunk);
      const fused = fuseMatches(tag(original), rewritten.flatMap(tag), {
        mergedCap: req.topK && req.topK > 0 ? req.topK : DEFAULT_TOPK,
      });
      // Every record came in as a `RetrieveMatch`, so `metadata` is never null.
      const matches = fused.map(({ corpus: _corpus, ...rest }) => rest as RetrieveMatch);
      return { matches: scoreByRank(matches, original.matches ?? [], req.rerank === true) };
    },
  };
}

/**
 * Re-score a fused list by RANK on the original list's scale. See "`score` is
 * RE-ASSIGNED BY RANK" in the module header. Pure; inputs are not mutated.
 */
export function scoreByRank(
  fused: readonly RetrieveMatch[],
  original: readonly RetrieveMatch[],
  reranked: boolean,
): RetrieveMatch[] {
  const scale = original.map((x) => x.score).sort((a, b) => b - a);
  const floor = scale.length > 0 ? scale[scale.length - 1]! : null;
  return fused.map((c, i) => {
    const wasCosine =
      typeof c.denseScore !== 'number' &&
      typeof c.rerankScore !== 'number' &&
      typeof c.lexicalScore !== 'number';
    const score = scale[i] ?? floor ?? (reranked ? 0 : c.score);
    return { ...c, ...(wasCosine ? { denseScore: c.score } : {}), score };
  });
}
