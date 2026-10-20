/**
 * `@edc/chat-engine` server wiring — adapter + AIClient shim + config.
 * Server-only (under `$lib/server/`). The composer and message components
 * import the kind registry separately via `$lib/engine/registry`, which is
 * client-safe.
 */

export {
  CHAT_ENGINE_CONFIG,
  CHAT_KIND_REGISTRY,
  chatTurnHybrid,
  chatTurnRetrievalPolicy,
  engineOrgId,
  queryExpansionEnabled,
  retrieveAssistantChunks,
} from './config';
export { chatRetrievalPolicy, parseRerankFlag } from './rerank';
export { parseRetrievalMode, type ChatRetrievalMode } from './hybrid';
export { withQueryExpansion, type ExpansionTrace, type QueryExpansionOptions } from './expand';
export { makeEngineAIClient, type EngineAIClientOptions } from './aiClient';
export {
  buildChatUnitRequest,
  partitionMessages,
  PROMPT_TEMPLATE_USER_PROMPT,
  TRANSCRIPT_DIRECTIVE,
  type PartitionedPrompt,
  type WireMessage,
} from './wire';
export { makeChatDomainAdapter, type ChatAdapterCtx } from './adapter';
export { useRegistryPrompt, PROMPT_SOURCE_REGISTRY } from './promptSource';
