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
export type { ProvenanceToCitationsOptions, CitationSegment } from './citation.js';
export { provenanceToCitations, splitContentByCitations } from './citation.js';

// Condense + title
export { condenseQuery } from './condense.js';
export {
  generateThreadTitle,
  isPlaceholderTitle,
  deriveTitleFromText,
} from './title.js';

// Retrieve orchestration
export type { RetrieveContextArgs } from './retrieve.js';
export { retrieveContext, threadCorpus } from './retrieve.js';

// Turn assembly (the load-bearing invariant)
export type { BuildTurnArgs, BuiltTurn } from './turn.js';
export { buildChatTurn, buildSystemPrompt } from './turn.js';

// Top-level orchestrator (condense → scope → retrieve → turn → generate)
export type { RespondArgs, PreparedTurn, RespondResult } from './respond.js';
export { respond, prepareTurn } from './respond.js';

// Generic corpus-sync scaffolding (the advanced-RAG ingest seam)
export type { CorpusDoc, CorpusBatch, EntitySource } from './corpus-sync.js';
export { syncEntity, backfillScope } from './corpus-sync.js';
