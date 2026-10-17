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
import { chatRetrievalPolicy, parseRerankFlag } from './rerank';
import { hybridRetrievalForTurn } from './hybrid';
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
  systemPrompt:
    'Eres un asistente que ayuda a una persona a consultar los documentos de su ' +
    'ecosistema de conocimiento. Tienes acceso a un resumen del contexto (el ' +
    'ecosistema y los documentos de la conversación) y a fragmentos recuperados ' +
    'de esos documentos.\n\n' +
    'Puedes razonar, proponer ideas y aportar conocimiento general. Pero cuando ' +
    'afirmes hechos sobre el ecosistema o sus documentos, básate en el resumen ' +
    'y en el contenido recuperado; no inventes detalles. Distingue con claridad ' +
    'entre lo que consta en el contexto y tus propias sugerencias. Si el contexto ' +
    'no alcanza para responder algo, dilo explícitamente.\n\n' +
    'Responde en español, de forma clara y concisa. Usa Markdown (encabezados, ' +
    'listas, código) cuando ayude a la lectura.',
};

/**
 * Query expansion on chat turns (`./expand`): `QUERY_EXPANSION=off` turns it
 * off. Default ON. Read per call, so an operator can flip it without a rebuild.
 */
export function queryExpansionEnabled(): boolean {
  return parseExpansionFlag(env.QUERY_EXPANSION);
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
