/**
 * `@edc/chat-engine` / `@edc/chat-engine/core` — the backend-agnostic
 * engine. No svelte, no DOM, no backend SDK. Consumable by the Payload backend
 * (`apps/backend`) and by SvelteKit server/BFF code (`apps/web`).
 */

// Types
export type {
  ContextRef,
  ContextScope,
  ContextSearchResult,
  ChatHistoryRow,
  ResolvedCorpus,
  RetrievedChunk,
  Provenance,
  CitationLike,
  SyncChatMessage,
  SyncEffort,
  SyncGenerationRequest,
  SyncGenerationResult,
  IngestRequest,
  IngestResult,
  RetrieveRequest,
  RetrieveResult,
  RetrieveMode,
  RetrieveMatch,
  RetrieveMultiRequest,
  RetrieveMultiResult,
  RetrieveMultiCorpusDiagnostics,
  RetrievalPolicy,
  AIClient,
} from './types.js';

// Config + kind registry
export type {
  KindDescriptor,
  KindRegistry,
  EngineConfig,
} from './config.js';
export {
  DEFAULT_ENGINE_CONFIG,
  kindLabel,
  kindEmoji,
  buildAliasMap,
} from './config.js';

// Domain adapter seam
export type { DomainAdapter, ResolvedScope } from './adapter.js';

// Pure mention helpers
export type { MentionRefLike, MessageSegment, MentionQuery } from './mention.js';
export { escapeRegExp, splitContentByRefs, detectMention } from './mention.js';

// Text utilities
export { richTextToPlain, clamp } from './text.js';

// Citation normalization (provenance → domain-agnostic CitationLike[])
// + the browser allowlist every server→browser provenance path runs through
export type { ProvenanceToCitationsOptions, CitationSegment, BrowserProvenanceOptions } from './citation.js';
export { provenanceToCitations, splitContentByCitations, toBrowserProvenance } from './citation.js';

// Condense + title
export { condenseQuery } from './condense.js';
export {
  generateThreadTitle,
  isPlaceholderTitle,
  deriveTitleFromText,
} from './title.js';

// Retrieve orchestration + the pure two-list fusion (RRF)
export type {
  RetrieveContextArgs,
  RetrieveContextResult,
  FuseMatchesOptions,
} from './retrieve.js';
export {
  retrieveContext,
  threadCorpus,
  fuseMatches,
  DEFAULT_MERGED_CAP,
  DEFAULT_PER_CORPUS_TOPK,
  DEFAULT_RRF_K,
} from './retrieve.js';

// Relevance across retrieve modes (cosine vs RRF vs rerank) + cited-only provenance
export type { ScoredChunk, CitedChunk } from './relevance.js';
export {
  thresholdScore,
  maxDenseScore,
  relevanceScore,
  parseCitedOrdinals,
  citedProvenance,
} from './relevance.js';

// Empty-generation predicates (a 200 with no visible text)
export type { StreamOutcome } from './generation.js';
export {
  isEmptyGeneration,
  shouldRetryEmpty,
  EMPTY_ANSWER_CODE,
  EmptyAnswerError,
  isEmptyAnswerCode,
  assertAnswer,
  streamOutcome,
} from './generation.js';

// Turn assembly (the load-bearing invariant)
export type { BuildTurnArgs, BuiltTurn } from './turn.js';
export { buildChatTurn, buildSystemPrompt } from './turn.js';

// Top-level orchestrator (condense → scope → retrieve → turn → generate)
export type {
  RespondArgs,
  PreparedTurn,
  RespondResult,
  GraphProvider,
  GraphProviderResult,
} from './respond.js';
export { respond, prepareTurn, MAX_INLINE_REFS } from './respond.js';

// Generic corpus-sync scaffolding (the advanced-RAG ingest seam)
export type { CorpusDoc, CorpusBatch, EntitySource } from './corpus-sync.js';
export { syncEntity, backfillScope, CorpusSyncError } from './corpus-sync.js';

// Survived-failure warnings: the structured payload every console.warn carries
export type { EngineWarning, EngineWarningEvent } from './warn.js';
