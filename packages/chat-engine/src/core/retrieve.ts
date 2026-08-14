/**
 * Retrieve orchestration — fan out over the resolved corpora PLUS an
 * always-appended per-thread/session corpus, swallow per-corpus failures, tag
 * each match by corpus, sort by score, cap.
 *
 * The optional ai-service metadata `filter` is forwarded to every corpus.
 */

import type { AIClient, ResolvedCorpus, RetrievedChunk } from './types.js';

/**
 * Canonical per-thread/session chat-docs corpus name — the ONE shared helper.
 * Every consumer that ingests, retrieves, or deletes a thread's uploaded-docs
 * corpus MUST derive the name from here (never hand-copy the literal): the
 * ingest hook, the retrieval path, and corpus teardown have to agree or the
 * corpus leaks / retrieval silently misses.
 *
 * Format follows the `<prefix>:<id>` corpus-namespace convention:
 * `chat:thread:<id>`.
 */
export function threadCorpus(threadId: number | string): string {
  return `chat:thread:${threadId}`;
}

/** How many merged chunks survive the cap. */
const MERGED_CAP = 8;
/** Per-corpus topK. */
const PER_CORPUS_TOPK = 5;

export interface RetrieveContextArgs {
  aiClient: AIClient;
  orgId: string;
  /** Fallback scope for corpora that have no single scope (per-thread). */
  fallbackScopeId: string;
  corpora: ResolvedCorpus[];
  threadId: number | string;
  query: string;
  /** Optional ai-service metadata filter, forwarded to every corpus retrieve. */
  filter?: Record<string, string | number | boolean>;
}

/**
 * Best-effort retrieval. The resolver-supplied corpora PLUS the per-thread
 * chat-docs corpus, each fetched independently; any side may fail/empty without
 * killing the turn. Merged by score, capped.
 */
export async function retrieveContext(
  args: RetrieveContextArgs,
): Promise<RetrievedChunk[]> {
  const trimmed = args.query.trim();
  if (!trimmed) return [];
  const queryText = trimmed.slice(0, 2000);

  const targets: ResolvedCorpus[] = [
    ...args.corpora,
    { corpus: threadCorpus(args.threadId), scopeId: args.fallbackScopeId },
  ];

  const fetchOne = ({ corpus, scopeId }: ResolvedCorpus) =>
    args.aiClient
      .retrieve({
        orgId: args.orgId,
        scopeId: scopeId || args.fallbackScopeId,
        corpus,
        query: queryText,
        topK: PER_CORPUS_TOPK,
        ...(args.filter ? { filter: args.filter } : {}),
      })
      .then((r) =>
        (r.matches ?? []).map((m) => ({ ...m, corpus }) as RetrievedChunk),
      )
      .catch(() => [] as RetrievedChunk[]);

  const results = await Promise.all(targets.map(fetchOne));
  const tagged: RetrievedChunk[] = results.flat();
  tagged.sort((a, b) => b.score - a.score);
  return tagged.slice(0, MERGED_CAP);
}
