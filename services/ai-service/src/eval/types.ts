// Retrieval-eval interchange format.
//
// WHAT THIS IS FOR
// ----------------
// Every rung of the retrieval ladder (hybrid fusion, reranking, query
// rewriting, contextual retrieval) can improve the average case while
// regressing a specific corpus or query shape. Rerankers punish
// correct-but-awkwardly-worded passages; HyDE can hallucinate a hypothetical
// document and retrieve noise. Without a before/after number, "this is better"
// is an unfalsifiable claim, and shipping it is a coin flip.
//
// So: a golden set, a fixed metric, a number before, a number after.
//
// THE SEAM (deliberate, see the module README in ../../plan/)
// ----------------------------------------------------------
// ai-service owns the MACHINERY — this format, the metrics, the runner.
// Consumers own the CONTENT — their golden items, which encode their domain.
// A consumer that already stores a golden set maps its rows onto `GoldenItem`
// field-for-field and keeps them where they are. Copying that content here
// would put a product's domain into the shared service, which ADR-0001
// forbids, and would immediately drift from the copy the consumer renders.
//
// ai-service ships only its own small, project-agnostic fixture set, used as a
// regression gate on this repo's own retrieval behaviour.

/**
 * Which assertion style an item uses. Expressed in terms a RETRIEVER can be
 * judged on, since that is all this runner sees. A consumer's generation-side
 * assertion kinds are not retrieval assertions and are not modelled here; the
 * three below are the ones that can be decided from a ranked chunk list alone.
 */
export type GoldenKind =
  /** Ranking quality: are the labelled-relevant chunks near the top? */
  | 'retrieval_relevance'
  /**
   * Can the top result actually support the citation? Asserts on the text of
   * rank 1 specifically — a citation points at ONE passage, so a fact that
   * only appears at rank 7 does not ground it.
   */
  | 'citation_groundedness'
  /**
   * Could an answer be written faithfully from what was retrieved? Asserts on
   * the UNION of the top-k texts: the generator sees all of them.
   */
  | 'qa_faithfulness';

/** One golden test case. */
export interface GoldenItem {
  id: string;
  kind: GoldenKind;
  /** Corpus name to retrieve against. */
  corpus: string;
  /** The user query, verbatim. */
  query: string;
  /**
   * `documents.external_id` values that SHOULD be retrieved. Document-level
   * rather than chunk-level on purpose: chunk ids are assigned at ingest and
   * change whenever the chunking strategy changes — which is one of the very
   * things being evaluated. Labelling by document keeps a golden set valid
   * across a re-chunk.
   */
  relevantDocs?: string[];
  /**
   * Section identifiers (as stamped into chunk metadata by a structural
   * chunker, e.g. `{ section: '12' }` — the key is whatever the corpus's
   * `chunk_config` named it) that should be retrieved. Lets an item assert the
   * chunker put the citation boundary in the right place, not just that the
   * right document came back.
   */
  relevantSections?: Array<Record<string, string>>;
  /** Substrings that must appear in the retrieved text (case/accent-insensitive). */
  mustContain?: string[];
  /**
   * Substrings that must NOT appear. This is the repealed-law assertion: the
   * highest-severity failure for a compliance product is confidently citing a
   * superseded provision, and it is a failure that average-relevance metrics
   * are completely blind to.
   */
  mustNotContain?: string[];
  /** Point-in-time to retrieve at. Passed through to `/v1/retrieve` as `asOf`. */
  asOf?: string;
  /** Free-form labels for slicing results (e.g. `exact-identifier`, `validity`). */
  tags?: string[];
  /** Why this item exists — shown in failure output. */
  note?: string;
}

/**
 * One document a harness ingests before a run. Lives here, not in a fixture
 * file, so `harness.ts` can be handed ANY fixture set without importing a
 * particular one — the harness is machinery, the documents are content.
 */
export interface FixtureDoc {
  externalId: string;
  title: string;
  text: string;
  metadata: Record<string, unknown>;
  validFrom?: string;
  validTo?: string;
}

/** A named retrieval configuration to evaluate. */
export interface EvalConfig {
  name: string;
  topK: number;
  mode?: 'dense' | 'hybrid';
  mmr?: number;
  rrfK?: number;
  /** Opt into cross-encoder reranking. Requires the service to have a reranker injected. */
  rerank?: boolean;
  /** Override the rerank model for this config. */
  rerankModel?: string;
}

/** Per-item outcome under one config. */
export interface ItemResult {
  itemId: string;
  kind: GoldenKind;
  tags: string[];
  /** Did every assertion this item makes hold? */
  pass: boolean;
  /** Which assertions failed, human-readable. */
  failures: string[];
  recallAtK: number;
  precisionAtK: number;
  /** Reciprocal rank of the first relevant result; 0 when none retrieved. */
  reciprocalRank: number;
  ndcgAtK: number;
  /** Results that violated `mustNotContain` — the stale-citation counter. */
  forbiddenHits: number;
  retrievedDocs: string[];
}

/** Aggregate over a whole golden set under one config. */
export interface ConfigReport {
  config: EvalConfig;
  nItems: number;
  nPass: number;
  /** Share of items where every assertion held. The headline number. */
  passRate: number;
  meanRecallAtK: number;
  meanPrecisionAtK: number;
  mrr: number;
  meanNdcgAtK: number;
  /**
   * Total results across the whole set that matched a `mustNotContain`
   * pattern. This must be ZERO. It is reported separately from `passRate`
   * because it is not a quality metric to be traded off — it is a correctness
   * floor, and a config that improves ranking while surfacing one superseded
   * provision is worse, not better.
   */
  totalForbiddenHits: number;
  /** Pass rate broken down by tag, for spotting a config that helps overall but regresses a slice. */
  byTag: Record<string, { n: number; nPass: number; passRate: number }>;
  items: ItemResult[];
}
