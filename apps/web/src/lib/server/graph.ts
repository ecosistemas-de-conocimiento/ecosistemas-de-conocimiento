/**
 * Server half of the corpus graph: the three backend reads, and the GraphRAG
 * provider the chat turn injects into `@edc/chat-engine`.
 *
 * Companion to `$lib/graph.ts`, which holds the vocabulary, the Spanish copy
 * and every pure rule. This file is the I/O half — same split, and the same
 * reason, as `$lib/biblioteca.ts` ↔ `$lib/server/biblioteca.ts`.
 *
 * ── THE BACKEND CONTRACT WE CONSUME ─────────────────────────────────────────
 *
 *   GET  /api/graph/view?organization=<id>&type=<…>&q=<text>
 *        → { entities: [{ id, type, label, support }], hidden, minSupport,
 *            publishedDocuments }
 *   GET  /api/graph/entity/<id>?organization=<id>
 *        → { entity, neighbours: [{ entity, relationType, support }],
 *            documents: [{ id, title, contentKind }] }
 *   POST /api/graph/retrieve  { organization, query, limit? }
 *        → { entities, edges: [{ from, to, relationType, support }],
 *            documents, terms: string[] }
 *
 * All three are org-scoped, published-only and minimum-support-filtered ON THE
 * BACKEND (ADR §7.3.3). This module never relaxes any of that, and never asks
 * for an organization the caller did not resolve server-side.
 *
 * ⚠ TWO FIELDS THAT ARE EASY TO SKIP AND BOTH MATTER. `publishedDocuments` is
 * what lets the empty-graph screen tell "nobody has published anything" from
 * "everything is below the threshold" — two states that look identical and are
 * fixed by different actions. And `edges` reaches ONE HOP OUT of the matched
 * seeds, so an edge's far endpoint is usually NOT in `entities`: an index built
 * from `entities` alone resolves almost no neighbours and the context block
 * silently loses the clause it exists for. See `GraphRetrieval.nodes`.
 *
 * ── 🔴 THE THREE RETRIEVAL INVARIANTS, AND HOW THE GRAPH LEG KEEPS THEM ─────
 *
 * The expansion retrieve (`G1`, ADR §8.1) is an ORDINARY ai-service retrieve
 * with a different query. Three ways to break it silently, all avoided here by
 * REUSING what already exists rather than writing a second copy:
 *
 *  1. **`asOf` is mandatory.** `buildRetrieveBody()` returns `null` without it
 *     and the caller yields zero chunks (`$lib/server/retrieval.ts`). This
 *     module never builds a retrieve body: it calls the SAME engine `AIClient`
 *     the vector leg calls (`$lib/server/engine/aiClient.ts`), which already
 *     carries the turn's `asOf` in its closure and routes every call through
 *     `buildRetrieveBody`. One body builder, one `asOf` guard, no second path
 *     to forget about.
 *
 *  2. **Corpus names are NEVER composed here.** They come from backend
 *     `GET /api/sessions/:id/corpora` and are handed in. `graphExpansionCorpus`
 *     PICKS one out of that list; it cannot invent one. This matters more than
 *     it looks: `makeEngineAIClient` refuses any corpus outside `allowedCorpora`
 *     and returns empty WITHOUT A NETWORK CALL, so a hand-composed name would
 *     fail with no error anywhere and the next person would debug the graph
 *     instead of the gate.
 *
 *  3. **Everything except the published corpus is narrowed to the current
 *     conversation's documents.** The graph leg reads ecosistema-wide PUBLISHED
 *     material, so it says so explicitly: it retrieves from the published
 *     corpus and from nothing else. Say nothing and the leg is treated as a
 *     draft leg, gets narrowed to this conversation's own files, and the graph
 *     hits vanish with no error at all.
 *
 *     ⚠ When the corpora response did not identify a published corpus, the
 *     expansion retrieve is SKIPPED rather than aimed at some other corpus.
 *     Same failure direction as everywhere else in this app: lose context
 *     loudly, never widen quietly. The deterministic graph block still rides
 *     into the turn — it comes from the backend, not from ai-service, so the
 *     global-question win survives even when the expansion cannot run.
 *
 * ── BEST-EFFORT, ALWAYS ─────────────────────────────────────────────────────
 *
 * Every function here degrades to "nothing" on any failure. `prepareTurn`
 * already wraps the provider in `.catch(() => null)` (ADR §8.2), so a graph
 * that errors, times out or matches nothing produces a normal answer with no
 * message to the user. The timeout is OURS to enforce — the engine deliberately
 * does not impose one.
 */

import { safeErrMessage } from '$lib/errorSummary';
import type { AIClient, GraphProvider, RetrievedChunk } from '@edc/chat-engine/core';
import { backendFetch } from '$lib/server/auth';
import type { LenguaIndex } from '$lib/lengua';
import {
  expandGraphQuery,
  graphContextParagraph,
  GRAPH_RELATION_TYPES,
  parseGraphEntityDetail,
  parseGraphRetrieval,
  parseGraphView,
  type GraphEntityDetail,
  type GraphRetrieval,
  type GraphView,
} from '$lib/graph';

/**
 * How many seed entities `POST /api/graph/retrieve` is asked for.
 *
 * ⚠ The same number as the backend's own `MAX_RETRIEVE_SEEDS`, and the same as
 * `CONTEXT_MAX_ENTITIES` in `$lib/graph.ts`. Asking for more would be clamped
 * upstream; asking for fewer would starve the block. Three constants that have
 * to agree, named here so the next person can find the other two.
 */
export const GRAPH_RETRIEVE_LIMIT = 8;

/**
 * Chunks the ONE expansion retrieve asks for.
 *
 * ⚠ Deliberately the engine's own per-corpus `topK` (5), not more. RRF fuses
 * the two legs by RANK, so a longer graph leg does not out-vote the vector leg
 * — it just adds tail chunks that will never survive the merged cap of 8.
 */
export const GRAPH_EXPANSION_TOPK = 5;

/**
 * The whole graph path's budget, in ms.
 *
 * ⚠ It runs CONCURRENTLY with the vector retrieve (`prepareTurn`), so this is a
 * ceiling on how much latency the graph can add to a turn, not on the turn. Two
 * sequential calls live inside it — the backend read, then the expansion
 * retrieve — because the second needs the first one's `terms`.
 */
export const GRAPH_TIMEOUT_MS = 4000;

/** `metadata.path` stamped on every chunk the graph leg contributes (ADR §8.2). */
export const GRAPH_PATH_TAG = 'graph';

// ── Reads for the /grafo view ──────────────────────────────────────────────

export interface GraphViewInput {
  organizationId: string;
  /**
   * Optional server-side narrowing the backend supports. ⚠ `/grafo` does NOT
   * use them: it loads the ecosistema's ranked lists once and filters in the
   * browser, so the search is accent-insensitive and instant. They are kept
   * because they are part of the contract and the day an ecosistema has
   * thousands of entities the page will need them.
   */
  type?: string;
  q?: string;
}

export function graphViewQuery(input: GraphViewInput): string {
  const qs = new URLSearchParams({ organization: input.organizationId });
  if (input.type) qs.set('type', input.type);
  if (input.q) qs.set('q', input.q);
  return qs.toString();
}

export interface GraphViewResult {
  view: GraphView;
  /**
   * `false` ⇒ the read FAILED. ⚠ Load-bearing, exactly like
   * `LibraryPage.ok`: an empty graph because the backend blinked must never be
   * rendered as "aún no hay suficientes documentos publicados". One is a
   * temporary outage; the other is a sentence about this ecosistema's corpus.
   */
  ok: boolean;
}

const EMPTY_VIEW: GraphView = { entities: [], hidden: 0, minSupport: null, publishedDocuments: null };

export async function fetchGraphView(
  token: string | undefined,
  input: GraphViewInput,
): Promise<GraphViewResult> {
  try {
    const res = await backendFetch(token, `/api/graph/view?${graphViewQuery(input)}`, {
      method: 'GET',
    });
    if (!res.ok) {
      console.warn(`[grafo] backend answered ${res.status} reading the graph view`);
      return { view: EMPTY_VIEW, ok: false };
    }
    return { view: parseGraphView(await res.json()), ok: true };
  } catch (err) {
    console.warn('[grafo] graph view read failed', safeErrMessage(err));
    return { view: EMPTY_VIEW, ok: false };
  }
}

export type GraphEntityResult =
  | { state: 'ok'; detail: GraphEntityDetail }
  /** Below the threshold, another ecosistema's, or gone. All the same to a reader. */
  | { state: 'not-found' }
  | { state: 'unavailable' };

/**
 * One entity's ego network.
 *
 * ⚠ 400, 403 and 404 are all reported as `not-found`, for two different
 * reasons. A 403 would confirm the id exists somewhere else on the
 * installation, which is exactly the inference an org-scoped surface must not
 * hand out. A 400 means the id in the URL was not even a valid id — someone
 * hand-edited the address bar — and "eso ya no aparece en el grafo" is the
 * right thing to say about it; "no pudimos leer el grafo" would blame our
 * backend for a typo.
 */
export async function fetchGraphEntity(
  token: string | undefined,
  organizationId: string,
  entityId: string,
): Promise<GraphEntityResult> {
  const qs = new URLSearchParams({ organization: organizationId });
  try {
    const res = await backendFetch(
      token,
      `/api/graph/entity/${encodeURIComponent(entityId)}?${qs.toString()}`,
      { method: 'GET' },
    );
    if (res.status === 400 || res.status === 403 || res.status === 404) {
      return { state: 'not-found' };
    }
    if (!res.ok) {
      console.warn(`[grafo] backend answered ${res.status} reading entity ${entityId}`);
      return { state: 'unavailable' };
    }
    const detail = parseGraphEntityDetail(await res.json());
    // An unreadable body, or an entity of a type this view does not show
    // (`isViewableEntityType`), is absent as far as the page is concerned.
    if (!detail) return { state: 'not-found' };
    return { state: 'ok', detail };
  } catch (err) {
    console.warn('[grafo] entity read failed', safeErrMessage(err));
    return { state: 'unavailable' };
  }
}

// ── The GraphRAG leg ───────────────────────────────────────────────────────

export interface GraphRetrieveInput {
  organizationId: string;
  query: string;
  limit?: number;
}

/**
 * `POST /api/graph/retrieve` — the ONE backend call per turn (ADR §8.1).
 *
 * `null` on anything that is not a readable answer. The caller then contributes
 * nothing and the turn is byte-identical to one with no graph provider at all.
 */
export async function fetchGraphRetrieval(
  token: string | undefined,
  input: GraphRetrieveInput,
): Promise<GraphRetrieval | null> {
  try {
    const res = await backendFetch(token, '/api/graph/retrieve', {
      method: 'POST',
      body: JSON.stringify({
        organization: input.organizationId,
        query: input.query,
        limit: input.limit ?? GRAPH_RETRIEVE_LIMIT,
      }),
    });
    if (!res.ok) {
      // Still fail-open, but LOUD. A silent `return null` here hid an HTTP 500
      // on every graph-matching turn (fixed 2026-10-17, backend
      // `lib/graph/queries.ts:intArray`): the chat worked, the graph never did.
      console.warn(`[grafo] backend answered ${res.status} to /api/graph/retrieve`);
      return null;
    }
    return parseGraphRetrieval(await res.json());
  } catch {
    // Best-effort by design. A network failure or unreadable body is not
    // logged: this runs on every chat turn and the turn works without it.
    return null;
  }
}

/**
 * 🔴 WHICH CORPUS THE EXPANSION RETRIEVE MAY TOUCH — invariants 2 and 3, in one
 * function, on purpose.
 *
 * It PICKS from the list the backend authorised (`GET /api/sessions/:id/corpora`)
 * and never composes a name. And it picks the ecosistema's SHARED PUBLISHED
 * corpus specifically, because that is what the graph leg is: an
 * ecosistema-wide read over published material. Every other corpus is
 * per-conversation and gets narrowed to this conversation's documents by
 * `makeEngineAIClient`, which would quietly gut the graph hits.
 *
 * `null` — skip the retrieve — when the corpora response did not identify a
 * published corpus, or when it identified one the backend did not authorise.
 * Losing the expansion is a smaller answer; guessing is a wrong one.
 */
export function graphExpansionCorpus(
  corpora: readonly string[],
  publishedCorpus: string | null | undefined,
): string | null {
  if (!publishedCorpus) return null;
  return corpora.includes(publishedCorpus) ? publishedCorpus : null;
}

/** Resolve to `fallback` if `promise` has not settled within `ms`. */
async function withDeadline<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface GraphProviderOptions {
  token: string | undefined;
  /**
   * The ecosistema this conversation belongs to, read off the SESSION row
   * (`sessionEcosystemId`) — never the selection cookie. `null` → no provider.
   */
  organizationId: string | null;
  /** The engine's `AIClient` for this turn. Carries `asOf` and the corpus gate. */
  aiClient: AIClient;
  /** ai-service attribution keys, same values the vector leg uses. */
  orgId: string;
  scopeId: string;
  /** The corpus names the BACKEND authorised for this turn. Never composed here. */
  corpora: readonly string[];
  /** Which of them is the ecosistema's shared published corpus. */
  publishedCorpus: string | null;
  timeoutMs?: number;
}

/**
 * Build the `graphProvider` the chat turn injects into `respond()`/`prepareTurn()`.
 *
 * Returns `null` when there is nothing to scope a graph read to, and the caller
 * then omits `graphProvider` entirely — so a turn without an ecosistema is
 * byte-identical to one built before this file existed.
 *
 * What one call does, in order:
 *   1. `POST /api/graph/retrieve` with the CONDENSED query the engine hands us.
 *   2. Build the deterministic Spanish block from the answer. NO MODEL CALL —
 *      this is where the global-question win comes from (ADR §8.1, G2).
 *   3. If, and only if, the graph's `terms` widen the query, run ONE extra
 *      ai-service retrieve over the published corpus and tag its chunks
 *      `metadata.path = 'graph'`.
 */
export function makeGraphProvider(opts: GraphProviderOptions): GraphProvider | null {
  const organizationId = opts.organizationId;
  if (!organizationId) return null;
  const corpus = graphExpansionCorpus(opts.corpora, opts.publishedCorpus);
  const timeoutMs = opts.timeoutMs ?? GRAPH_TIMEOUT_MS;

  return async (condensedQuery: string) => {
    const query = (condensedQuery ?? '').trim();
    if (!query) return null;
    const started = Date.now();

    const retrieval = await withDeadline(
      fetchGraphRetrieval(opts.token, { organizationId, query }),
      timeoutMs,
      null,
    );
    if (!retrieval || retrieval.entities.length === 0) return null;

    const context = graphContextParagraph(retrieval);

    // ── G1: at most ONE extra retrieve, and only when it can add something ──
    let chunks: RetrievedChunk[] = [];
    const expanded = expandGraphQuery(query, retrieval.terms);
    const remaining = timeoutMs - (Date.now() - started);
    if (corpus && expanded !== query && remaining > 0) {
      const result = await withDeadline(
        opts.aiClient
          .retrieve({
            orgId: opts.orgId,
            scopeId: opts.scopeId,
            // 🔴 From the backend's own list. See `graphExpansionCorpus`.
            corpus,
            query: expanded,
            topK: GRAPH_EXPANSION_TOPK,
            // No `rerank`, even when the turn's policy has it on: the query is
            // the question plus graph terms, and the engine fuses this list
            // by RANK (RRF), so a cross-encoder pass would buy nothing here.
          })
          .catch(() => null),
        remaining,
        null,
      );
      chunks = (result?.matches ?? []).map((m) => ({
        documentId: m.documentId,
        chunkId: m.chunkId,
        score: m.score,
        text: m.text,
        corpus,
        // ⚠ `path` is the only thing added. `fuseMatches` dedupes by `chunkId`
        // and keeps the record with MORE metadata keys, so a chunk both legs
        // found keeps this tag — which is the point: it is the raw material
        // ADR §8.4 leaves on the persisted message rows for a later look.
        metadata: { ...(m.metadata ?? {}), path: GRAPH_PATH_TAG },
      }));
    }

    if (!context && chunks.length === 0) return null;
    return { ...(chunks.length > 0 ? { chunks } : {}), ...(context ? { context } : {}) };
  };
}

/**
 * The corpus-overview graph path (`$lib/server/engine/overview`): the graph
 * VIEW's top entities over the whole published corpus, not a query-seeded
 * retrieval. A query-seeded read of "resumen del corpus" would seed on the
 * word "corpus" (an entity "Corpus Christi"), the same mistake as keyword
 * retrieval. No widened retrieve, no chunks: an overview turn has no passages.
 * Best-effort like {@link makeGraphProvider}: a failed or slow read is no block.
 */
export function makeOverviewGraphProvider(opts: {
  token: string | undefined;
  organizationId: string | null;
  timeoutMs?: number;
}): GraphProvider | null {
  const organizationId = opts.organizationId;
  if (!organizationId) return null;
  const timeoutMs = opts.timeoutMs ?? GRAPH_TIMEOUT_MS;
  return async () => {
    const { view } = await withDeadline(
      fetchGraphView(opts.token, { organizationId }),
      timeoutMs,
      { view: EMPTY_VIEW, ok: false },
    );
    // The view's edges are among its own entities; the paragraph reads only
    // their endpoints and support, never the relation type.
    const edges = (view.edges ?? []).map((e) => ({
      fromId: e.fromId,
      toId: e.toId,
      support: e.support,
      relationType: e.relationType ?? GRAPH_RELATION_TYPES[0],
    }));
    const context = graphContextParagraph({ entities: view.entities, edges, documents: [], terms: [] });
    return context ? { context } : null;
  };
}

/**
 * The combined view's lengua index: one per ecosistema, merged. Document ids
 * are global, so the map is a plain union; facet counts add up.
 */
export function mergeLenguaIndexes(indexes: readonly LenguaIndex[]): LenguaIndex {
  const counts = new Map<string, number>();
  const byDocument: Record<string, string> = {};
  for (const index of indexes) {
    for (const f of index.lenguas) counts.set(f.lengua, (counts.get(f.lengua) ?? 0) + f.documentos);
    Object.assign(byDocument, index.byDocument);
  }
  const lenguas = [...counts]
    .map(([lengua, documentos]) => ({ lengua, documentos }))
    .sort((a, b) => b.documentos - a.documentos || a.lengua.localeCompare(b.lengua, 'es'));
  return { lenguas, byDocument };
}
