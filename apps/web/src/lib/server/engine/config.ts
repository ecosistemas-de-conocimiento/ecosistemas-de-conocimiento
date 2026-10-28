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
import { hybridRetrievalForTurn, metadataFilterInAvailable } from './hybrid';
import {
  chatSystemPrompt,
  INTERVIEW_CONTEXT_PREAMBLE,
  interviewSystemPrompt,
  parseCiteVariant,
  RESONANCIAS_CONTEXT_PREAMBLE,
  resonanciasSystemPrompt,
  withEcosystemStyle,
  type CiteVariant,
} from './prompt';
import type { AnswerStyles } from '$lib/answerStyle';
import type { SessionKind } from '$lib/sessionKind';
import type { ChatTurnMode } from './turnMode';
import { parseOrientScope, type OrientScope } from './orientation';
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
  // `./prompt`: pure, so the eval harness can import a fixed string (variant A).
  // A getter, so `CHAT_CITE_VARIANT` is read per request: the engine reads
  // `systemPrompt` once per turn (`buildSystemPrompt` in chat-engine core).
  get systemPrompt() {
    return chatSystemPrompt(chatCiteVariant());
  },
};

/**
 * Prompt cite rule: `CHAT_CITE_VARIANT` = `A`|`B`|`C`|`D`|`E` picks it
 * (`CITE_RULE_VARIANTS` in `./prompt`). Unset or blank is `E`
 * (`DEFAULT_CITE_VARIANT`); an unknown value is `E` too, with a warning
 * (`parseCiteVariant`). Case and surrounding spaces are ignored. Read per call
 * from `$env/dynamic/private` (the container's runtime env, not the build), so
 * an operator flips it with a container recreate, no rebuild.
 *
 * Logs `[prompt] cite variant X` at debug level on every call, so a
 * measurement can attribute runs, and at info level on the first call and
 * whenever the variant changes, so the active variant shows in the container
 * logs even where debug output is filtered.
 */
export function chatCiteVariant(): CiteVariant {
  const variant = parseCiteVariant(env.CHAT_CITE_VARIANT);
  const line = `[prompt] cite variant ${variant}`;
  if (variant !== lastAnnouncedVariant) {
    lastAnnouncedVariant = variant;
    console.info(line);
  }
  console.debug(line);
  return variant;
}

let lastAnnouncedVariant: CiteVariant | null = null;

/**
 * The engine config for one turn, from the conversation's kind (`sessions.kind`,
 * `$lib/sessionKind`; owner ruling 2026-10-26) and, on Generales only, the
 * heuristic turn mode (`chatTurnMode` in `./turnMode`; owner ruling 2026-10-27).
 *
 * - `resonancias`: ALWAYS the corpus-informed interviewer
 *   ({@link resonanciasSystemPrompt}); `mode` is ignored.
 * - `generales` + `answer` (the default): {@link CHAT_ENGINE_CONFIG} itself
 *   (variant E unchanged).
 * - `generales` + `interview`: the heuristic interviewer
 *   ({@link interviewSystemPrompt}). The caller passes `interview` only when the
 *   ecosistema's `interviewerMode` switch is on and `chatTurnMode` says so.
 *
 * Each non-answer config swaps only the system prompt and the user-turn
 * preamble (`./prompt`).
 *
 * `styles`: the ecosistema's answer style (owner ruling 2026-10-28), appended
 * LAST by {@link withAnswerStyle}. No style for this prompt → the very same
 * object as without it, so the pinned prompt hashes hold.
 */
export function chatEngineConfigFor(
  kind: SessionKind,
  mode: ChatTurnMode = 'answer',
  styles?: AnswerStyles | null,
): EngineConfig {
  return withAnswerStyle(baseConfigFor(kind, mode), kind, mode, styles);
}

/** Which of the three styles a turn uses: Resonancias, the interviewer, or Generales. */
export function answerStyleFor(
  kind: SessionKind,
  mode: ChatTurnMode,
  styles: AnswerStyles | null | undefined,
): string | null {
  if (!styles) return null;
  if (kind === 'resonancias') return styles.resonancias;
  return mode === 'interview' ? styles.interviewer : styles.generales;
}

/**
 * `config` with the turn's answer style appended to its system prompt. Rules
 * added later (`withTurnRules`) go before it, so it stays last. No style:
 * `config` itself, untouched.
 */
export function withAnswerStyle(
  config: EngineConfig,
  kind: SessionKind,
  mode: ChatTurnMode,
  styles: AnswerStyles | null | undefined,
): EngineConfig {
  const style = answerStyleFor(kind, mode, styles);
  if (!style?.trim()) return config;
  return { ...config, systemPrompt: withEcosystemStyle(config.systemPrompt, style) };
}

function baseConfigFor(kind: SessionKind, mode: ChatTurnMode): EngineConfig {
  if (kind === 'resonancias') {
    return {
      ...CHAT_ENGINE_CONFIG,
      systemPrompt: resonanciasSystemPrompt(),
      userContextPreamble: RESONANCIAS_CONTEXT_PREAMBLE,
    };
  }
  if (mode === 'answer') return CHAT_ENGINE_CONFIG;
  return {
    ...CHAT_ENGINE_CONFIG,
    systemPrompt: interviewSystemPrompt(),
    userContextPreamble: INTERVIEW_CONTEXT_PREAMBLE,
  };
}

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

/**
 * Earlier conversations as orientation (`./orientation`): `CHAT_ORIENT_SCOPE`
 * = `ecosistema` (default, every member's turns in this ecosistema) | `own`
 * (this user's other conversations) | `off`. Unknown is `off`. Read per call.
 */
export function chatOrientScope(): OrientScope {
  return parseOrientScope(env.CHAT_ORIENT_SCOPE);
}

/**
 * Whether the sources legs may send `kind $in [documento, testimonio]`
 * (`SOURCE_KINDS_FILTER`, `./chunkFence`): ai-service has `metadataFilterIn`.
 * Asked once per process (cached in `./hybrid`). Never throws; doubt is `false`.
 */
export function chatKindFilterAvailable(): Promise<boolean> {
  const baseUrl = env.AI_SERVICE_URL?.replace(/\/+$/, '');
  const apiKey = env.AI_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) return Promise.resolve(false);
  return metadataFilterInAvailable(baseUrl, apiKey);
}
