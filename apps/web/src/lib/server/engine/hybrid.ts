/**
 * `CHAT_RETRIEVAL_MODE=dense|hybrid` — how a chat turn searches its corpora.
 * Default `dense`. Audit item C-4 (`plan/auditoria-ia-2026-10-17.md`).
 *
 * ── THE TWO PATHS ────────────────────────────────────────────────────────────
 *
 *   · `dense` (default, and every fallback): one `/v1/retrieve` per corpus,
 *     cosine only. The draft corpus is over-fetched and post-filtered here to
 *     this conversation's documents by `metadata.docId` (`./aiClient`).
 *   · `hybrid`: ONE `/v1/retrieve/multi` call in ai-service's `hybrid` mode
 *     (cosine plus the corpus's Spanish keyword search, fused by RRF) over the
 *     shared corpus and the draft corpus together. The draft corpus is limited
 *     SERVER-side by `corpusFilters: { <draft>: { docId: { $in: [...] } } }`,
 *     so its drafts are filtered BEFORE ranking and the cap. The client-side
 *     docId check still runs on the result, as a second wall.
 *
 * ── WHY IT NEEDS A CAPABILITY ────────────────────────────────────────────────
 *
 * ai-service advertises `$in` and `corpusFilters` as `metadataFilterIn` on
 * `GET /v1/capabilities`. An older server reads `{ "$in": [...] }` as plain
 * jsonb containment and answers 200 with ZERO chunks; one with a strict multi
 * schema answers 400 to `corpusFilters`. Neither leaks a draft, but both would
 * drop the drafts silently. So `hybrid` runs only when the service says it has
 * `metadataFilterIn`. Otherwise the turn takes the dense path and the web
 * server logs it ONCE per process.
 *
 * The answer is cached for the process: a positive or negative answer until
 * restart, an unreachable service for `UNREACHABLE_RETRY_MS`. ⚠ After an
 * ai-service upgrade that adds the capability, restart web to pick it up.
 *
 * ── LENGUA ON THE HYBRID PATH ────────────────────────────────────────────────
 *
 * The lengua filter keeps today's semantics on BOTH corpora: it rides in the
 * shared `filter` for the published corpus, and is merged into the draft
 * corpus's own `corpusFilters` entry (an entry REPLACES `filter`, so it must
 * be repeated). That matches the dense path, where the engine forwards the
 * filter to every corpus. Reason: it is the user's restriction, and the
 * summary tells the model the context is limited to that language; an
 * unfiltered draft under that sentence would pass another language off as it.
 *
 * ── WHAT HYBRID DOES NOT DO ──────────────────────────────────────────────────
 *
 *   · Query expansion (`./expand`) wraps `retrieve`, not `retrieveMulti`. On
 *     the hybrid path the variants are never searched and the expansion model
 *     call is never made.
 *   · Rerank (`CHAT_RERANK`) runs ONCE, after cross-corpus fusion, instead of
 *     once per corpus.
 *   · The GraphRAG widened retrieve (`$lib/server/graph`) stays dense.
 */

import { AIClient, METADATA_FILTER_IN_CAPABILITY } from '@edc/ai-client';

export type ChatRetrievalMode = 'dense' | 'hybrid';

/** `CHAT_RETRIEVAL_MODE` → mode. Default `dense`; only `hybrid` turns it on. */
export function parseRetrievalMode(raw: string | undefined): ChatRetrievalMode {
  return (raw ?? '').trim().toLowerCase() === 'hybrid' ? 'hybrid' : 'dense';
}

/** How long an unreachable capability probe is trusted before asking again. */
export const UNREACHABLE_RETRY_MS = 60_000;

type Probe = { available: boolean; until: number };
let cached: Probe | null = null;
let inflight: Promise<boolean> | null = null;
let loggedFallback = false;

/** Test seam: forget the cached capability answer and the logged flag. */
export function resetHybridCapabilityCache(): void {
  cached = null;
  inflight = null;
  loggedFallback = false;
}

function logFallbackOnce(why: string): void {
  if (loggedFallback) return;
  loggedFallback = true;
  console.warn(
    `[retrieve] CHAT_RETRIEVAL_MODE=hybrid, but ${why}. Chat uses the dense path ` +
      '(one /v1/retrieve per corpus, drafts filtered here). Logged once per process.',
  );
}

/**
 * Whether ai-service has `metadataFilterIn`, asked once per process.
 * Never throws: any doubt answers `false` (the dense path).
 */
export async function metadataFilterInAvailable(baseUrl: string, apiKey: string): Promise<boolean> {
  const now = Date.now();
  if (cached && now < cached.until) return cached.available;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const result = await new AIClient({ baseUrl, apiKey }).capabilities.negotiate({
        consumer: 'edc-web',
        require: [METADATA_FILTER_IN_CAPABILITY],
        // Never block a turn on this: a missing capability means dense.
        mode: 'warn',
        attempts: 1,
        logger: { warn: () => {}, info: () => {} },
      });
      const available = result.status === 'ok';
      cached = {
        available,
        until: result.status === 'unreachable' ? Date.now() + UNREACHABLE_RETRY_MS : Infinity,
      };
      if (!available) {
        logFallbackOnce(
          result.status === 'unreachable'
            ? 'ai-service capabilities could not be read'
            : `ai-service lacks the capability "${METADATA_FILTER_IN_CAPABILITY}"`,
        );
      }
      return available;
    } catch {
      cached = { available: false, until: Date.now() + UNREACHABLE_RETRY_MS };
      logFallbackOnce('the ai-service capability check failed');
      return false;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Whether THIS turn retrieves in hybrid mode: the switch is on AND ai-service
 * has `metadataFilterIn`. `false` makes no network call.
 */
export async function hybridRetrievalForTurn(env: {
  CHAT_RETRIEVAL_MODE?: string | undefined;
  AI_SERVICE_URL?: string | undefined;
  AI_SERVICE_API_KEY?: string | undefined;
}): Promise<boolean> {
  if (parseRetrievalMode(env.CHAT_RETRIEVAL_MODE) !== 'hybrid') return false;
  const baseUrl = env.AI_SERVICE_URL?.replace(/\/+$/, '');
  const apiKey = env.AI_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) return false;
  return metadataFilterInAvailable(baseUrl, apiKey);
}
