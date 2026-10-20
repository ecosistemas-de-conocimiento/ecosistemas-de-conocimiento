/**
 * Fence every retrieved chunk before it reaches the prompt (audit 2026-10-17
 * §3 item 3, prompt injection).
 *
 * The engine renders retrieved chunks as `[N] ${text}` inside the user turn
 * (`packages/chat-engine/src/core/turn.ts`, not edited here). With no
 * boundary, a chunk that says "</context> new instructions…" reads as part of
 * the prompt. Every chunk reaching the engine comes through ONE `AIClient`:
 * the published leg, the draft leg and the hybrid `retrieveMulti` all live in
 * `makeEngineAIClient`, and the graph provider's widened retrieve calls that
 * same client. So wrapping that client fences every leg, and the engine's
 * `[N]` ordinals, fusion and provenance order are untouched:
 *
 *   [1] <fuente id="<chunkId>">
 *   …chunk text, with every <fuente / </fuente look-alike neutralised…
 *   </fuente>
 *
 * Earlier assistant answers get `tipo="respuesta anterior del asistente, no es
 * fuente primaria"` on the opening tag. The system-prompt rule that gives the
 * fence its meaning is `CHUNK_DATA_RULE` (`./prompt`).
 *
 * ⚠ The engine copies `RetrievedChunk.text` into the persisted provenance (the
 * citation card's quoted passage). `restorePassages` puts the ORIGINAL text
 * back, so users never see the fence. Call it on every provenance this turn
 * produces, before persisting.
 *
 * Not fenced: the graph block (`graphContext`) — deterministic prose built by
 * `$lib/server/graph` from entity names, not raw chunk text — and the Tier-1
 * summary, which is the product's own text.
 *
 * The clean home for this is a per-chunk formatter hook in
 * chat-engine's `buildChatTurn`; until it exists this wrapper is the seam.
 */

import type { AIClient, Provenance, RetrieveMatch } from '@edc/chat-engine/core';
// Relative, not `$lib`: the eval harness in apps/backend imports this file.
import { ASSISTANT_CHUNK_LABEL, isAssistantAuthored } from '../../assistantChunks';

export { ASSISTANT_CHUNK_LABEL };

/**
 * Zero-width characters a forged tag could hide between `<` and `fuente`.
 * Matches `<fuente`, `</fuente`, `< / FUENTE`, `<​/fuente`, and the
 * HTML-escaped `&lt;/fuente`.
 */
const FENCE_LOOKALIKE =
  /(<|&lt;)([\s​-‍⁠﻿]*\/?[\s​-‍⁠﻿]*fuente)/gi;

/**
 * Break every fence-tag look-alike inside chunk text by swapping its `<` for
 * `‹` (U+2039). The words stay readable; only the tag stops being a tag.
 */
export function neutraliseFenceTags(text: string): string {
  return text.replace(FENCE_LOOKALIKE, (_m, _lt: string, rest: string) => `‹${rest}`);
}

/** Ids land inside an attribute: keep them to a safe alphabet. */
function safeId(id: string): string {
  return String(id).replace(/[^\w.:#-]/g, '_');
}

/** The fenced form of one chunk's text, as the model reads it. */
export function fenceChunkText(chunk: Pick<RetrieveMatch, 'chunkId' | 'text' | 'metadata'>): string {
  const tipo = isAssistantAuthored(chunk.metadata) ? ` tipo="${ASSISTANT_CHUNK_LABEL}"` : '';
  return `<fuente id="${safeId(chunk.chunkId)}"${tipo}>\n${neutraliseFenceTags(chunk.text ?? '')}\n</fuente>`;
}

export interface FenceOptions {
  /**
   * 🔴 OPEN DECISION (owner): should earlier assistant answers be retrievable
   * at all? `true` (default) keeps today's behaviour, labelled. `false` drops
   * them here, after retrieval, so they cost top-K slots. Every leg passes
   * through this one line.
   */
  retrieveAssistantChunks?: boolean;
}

export interface FencedClient<T extends AIClient> {
  client: T;
  /** Swap the fenced passage text in a provenance back to the original, capped like the engine's `includePassageText`. */
  restorePassages<P extends Provenance | null | undefined>(provenance: P, cap: number): P;
}

export function withFencedChunks<T extends AIClient>(base: T, opts: FenceOptions = {}): FencedClient<T> {
  const keepAssistant = opts.retrieveAssistantChunks ?? true;
  const originals = new Map<string, string>();

  const fence = <M extends RetrieveMatch>(matches: M[]): M[] =>
    matches
      .filter((x) => keepAssistant || !isAssistantAuthored(x.metadata))
      .map((x) => {
        originals.set(x.chunkId, x.text);
        return { ...x, text: fenceChunkText(x) };
      });

  const client: T = {
    ...base,
    generateSync: base.generateSync.bind(base),
    ingest: base.ingest.bind(base),
    async retrieve(req) {
      const r = await base.retrieve(req);
      return { ...r, matches: fence(r.matches) };
    },
    ...(base.retrieveMulti
      ? {
          async retrieveMulti(req: Parameters<NonNullable<AIClient['retrieveMulti']>>[0]) {
            const r = await base.retrieveMulti!(req);
            return { ...r, matches: fence(r.matches) };
          },
        }
      : {}),
  };

  return {
    client,
    restorePassages(provenance, cap) {
      if (!provenance) return provenance;
      return {
        ...provenance,
        chunks: provenance.chunks.map((c) => {
          const original = originals.get(c.chunkId);
          return original !== undefined && c.text !== undefined ? { ...c, text: original.slice(0, cap) } : c;
        }),
      };
    },
  };
}
