/**
 * The `@edc/chat-engine` configuration — the per-product knobs the engine's
 * `core` reads. Server-only (lives under `$lib/server/`). The kind registry
 * itself lives in the client-safe `$lib/engine/registry`; this module imports
 * and re-exports it so server code has one import surface.
 *
 * Domain: an Organization + the Documents its users upload to a session.
 * Spanish UI copy; English identifiers (house convention).
 */

import type { EngineConfig } from '@edc/chat-engine/core';
import { DEFAULT_ENGINE_CONFIG } from '@edc/chat-engine/core';
import { env } from '$env/dynamic/private';
import { CHAT_KIND_REGISTRY } from '$lib/engine/registry';
import { parseExpansionFlag } from './expand';
import { parseAssistantChunksFlag } from './chunkFence';
import { chatRetrievalPolicy, parseRerankFlag } from './rerank';
import { hybridRetrievalForTurn } from './hybrid';
import { CHAT_SYSTEM_PROMPT } from './prompt';
import type { RetrievalPolicy } from '@edc/chat-engine/core';

/** Re-export the client-safe registry so server code has one import surface. */
export { CHAT_KIND_REGISTRY };

/**
 * The tenant key the engine and ai-service scope a turn to (budget, retrieval
 * namespace). ONE deployment-wide constant, not a per-user claim — nothing in
 * the session proves which ai-service tenant a user belongs to, so this must
 * never be read off `locals.user`. Read per call so an operator can change it
 * without a rebuild.
 */
export function engineOrgId(): string {
  return env.ORG_KEY?.trim() || 'edc';
}

/**
 * The engine config. Inherits the default user-turn preamble + headers (the
 * load-bearing invariant strings), overriding only the system prompt with this
 * product's assistant persona.
 */
export const CHAT_ENGINE_CONFIG: EngineConfig = {
  ...DEFAULT_ENGINE_CONFIG,
  surface: 'chat',
  // `./prompt`: pure, so the eval harness imports the same string.
  systemPrompt: CHAT_SYSTEM_PROMPT,
};

/**
 * Query expansion on chat turns (`./expand`): `QUERY_EXPANSION=off` turns it
 * off. Default ON. Read per call, so an operator can flip it without a rebuild.
 */
export function queryExpansionEnabled(): boolean {
  return parseExpansionFlag(env.QUERY_EXPANSION);
}

/**
 * Earlier assistant answers in chat retrieval (`./chunkFence`):
 * `CHAT_RETRIEVE_ASSISTANT_CHUNKS=on` brings them back, labelled. Default OFF
 * (owner ruling 2026-10-20). Read per call, so an operator can flip it without
 * a rebuild.
 */
export function retrieveAssistantChunks(): boolean {
  return parseAssistantChunksFlag(env.CHAT_RETRIEVE_ASSISTANT_CHUNKS);
}

/**
 * Cross-encoder rerank on chat turns (`./rerank`): `CHAT_RERANK=off` turns it
 * off. Default ON. Read per call, so an operator can flip it without a rebuild.
 * `undefined` (dense, rerank off) is the engine's pre-policy retrieval, byte
 * for byte.
 *
 * `hybrid` is the answer of `chatTurnHybrid()`: the `CHAT_RETRIEVAL_MODE`
 * switch AND the ai-service capability. Pass the same value to
 * `makeEngineAIClient({ hybrid })`.
 */
export function chatTurnRetrievalPolicy(hybrid = false): RetrievalPolicy | undefined {
  return chatRetrievalPolicy(parseRerankFlag(env.CHAT_RERANK), hybrid ? 'hybrid' : 'dense');
}

/**
 * Whether this turn retrieves in hybrid mode (`./hybrid`). Default dense.
 * Read per call. Never throws; any doubt answers `false`.
 */
export function chatTurnHybrid(): Promise<boolean> {
  return hybridRetrievalForTurn({
    CHAT_RETRIEVAL_MODE: env.CHAT_RETRIEVAL_MODE,
    AI_SERVICE_URL: env.AI_SERVICE_URL,
    AI_SERVICE_API_KEY: env.AI_SERVICE_API_KEY,
  });
}
