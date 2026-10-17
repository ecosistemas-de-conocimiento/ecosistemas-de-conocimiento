/**
 * User-turn assembly — THE LOAD-BEARING INVARIANT (spec §0).
 *
 * The system message is BEHAVIORAL ONLY. ALL factual context (Tier-1 summary,
 * retrieved chunks, @-cited entities) goes in the USER turn, under the labelled
 * "[CONTEXT for your reply …]" preamble. This is because the dev chat model
 * under-weights/ignores factual content placed in the system message. All of
 * the strings come from `EngineConfig` so a consumer can override them.
 *
 * Note the deliberate language split visible in the assembled turn: the
 * preamble is ENGLISH (machinery — the engine instructing the model) while
 * `blockHeaders` stay LOCALIZED (content — labels on product prose the model
 * can echo). See the `config.ts` docs before "unifying" them.
 *
 * The preamble carries the anti-fabrication contract — see the
 * `userContextPreamble` doc in `config.ts`. It must (a) stop the model denying
 * context that is present, (b) stop it inventing facts that are absent, and
 * (c) keep the reply in the user's language. A product that overrides the
 * string inherits all three obligations.
 */

import { DEFAULT_ENGINE_CONFIG, type EngineConfig } from './config.js';
import type { ChatHistoryRow, RetrievedChunk, SyncChatMessage, Provenance } from './types.js';

/**
 * System message = base prompt + (optional) team/thread custom instructions.
 * NO factual context here — see module header.
 */
export function buildSystemPrompt(
  config: EngineConfig,
  teamInstructions?: string,
  threadInstructions?: string,
): string {
  const parts: string[] = [config.systemPrompt];
  const instructions = [teamInstructions, threadInstructions]
    .map((s) => s?.trim())
    .filter((s): s is string => Boolean(s))
    .join('\n\n');
  if (instructions) {
    parts.push(`${config.teamInstructionsHeader}\n${instructions}`);
  }
  return parts.join('\n\n---\n\n');
}

export interface BuildTurnArgs {
  config: EngineConfig;
  history: ChatHistoryRow[];
  summaryText: string;
  retrievedMatches: RetrievedChunk[];
  /**
   * OPTIONAL pre-rendered structured-context block, produced by whatever
   * `graphProvider` the consumer injected. OPAQUE to the engine: it is a
   * string of already-formatted prose, and the engine never inspects, parses
   * or knows what it describes.
   *
   * Rendered as its own labelled block right after the summary and BEFORE the
   * retrieved block. It carries NO `[N]` markers: the citation ordinals are
   * assigned by array index over `retrievedMatches` only, and this block must
   * not disturb them. Absent/blank → the assembled turn is byte-identical to
   * one built without the field at all.
   */
  graphContext?: string;
  inlineRefsText?: string;
  userMessage: string;
  teamInstructions?: string;
  threadInstructions?: string;
  /**
   * Persist each retrieved chunk's grounding passage (`RetrievedChunk.text`)
   * into the provenance so the canonical citation card can render the quoted
   * `<blockquote>` without a re-fetch. ADDITIVE (engine ≥0.3.0); defaults to
   * `true`. Set `false` (or a max length) to keep the legacy lean shape.
   *   - `true`   → store the full chunk text
   *   - `false`  → omit `text` (legacy behaviour)
   *   - number   → store the chunk text truncated to that many characters
   */
  includePassageText?: boolean | number;
}

export interface BuiltTurn {
  messages: SyncChatMessage[];
  /** Provenance to persist on the assistant turn, or null when nothing cited. */
  provenance: Provenance | null;
}

/**
 * Fill the `{context}` / `{message}` slots of the preamble.
 *
 * ONE pass with a replacer function, deliberately. The obvious
 * `.replace('{context}', context).replace('{message}', message)` has two real
 * bugs, both of which silently corrupt what the model reads:
 *   1. a STRING replacement still interprets `$&`, `` $` ``, `$'`, `$$` and
 *      `$1` in the replacement, so a user message or retrieved chunk holding
 *      `$&` (shell, regex, a code paste) comes out mangled;
 *   2. substituting `{context}` first means a retrieved chunk containing the
 *      literal text `{message}` swallows the user's actual question.
 * A replacer function is exempt from `$`-expansion and each slot is visited
 * exactly once, so neither can happen.
 */
function applyPreamble(template: string, context: string, message: string): string {
  return template.replace(/\{(context|message)\}/g, (_m, slot: string) =>
    slot === 'context' ? context : message,
  );
}

/**
 * Assemble the full `messages[]` for a chat turn. ALL factual context lands in
 * the final user turn; system = behavioral only; history is replayed verbatim.
 */
export function buildChatTurn(args: BuildTurnArgs): BuiltTurn {
  const { config } = args;
  const systemPrompt = buildSystemPrompt(
    config,
    args.teamInstructions,
    args.threadInstructions,
  );

  const contextBlocks: string[] = [];
  if (args.summaryText && args.summaryText.trim()) {
    contextBlocks.push(`${config.blockHeaders.summary}\n${args.summaryText}`);
  }
  // Optional structured/graph block — after the summary, BEFORE the retrieved
  // chunks. Its position is deliberate (it frames the corpus before the
  // individual passages) and it is header-only text: the `[N]` ordinals below
  // are still assigned purely by index over `retrievedMatches`, so wiring a
  // graph provider in cannot renumber a citation.
  if (args.graphContext && args.graphContext.trim()) {
    const graphHeader =
      config.blockHeaders.graph ?? DEFAULT_ENGINE_CONFIG.blockHeaders.graph ?? '';
    contextBlocks.push(
      graphHeader ? `${graphHeader}\n${args.graphContext}` : args.graphContext,
    );
  }
  if (args.retrievedMatches.length > 0) {
    contextBlocks.push(
      `${config.blockHeaders.retrieved}\n${args.retrievedMatches
        .map((m, i) => `[${i + 1}] ${m.text}`)
        .join('\n\n')}`,
    );
  }
  if (args.inlineRefsText && args.inlineRefsText.trim()) {
    contextBlocks.push(`${config.blockHeaders.inlineRefs}\n${args.inlineRefsText}`);
  }

  const userContent =
    contextBlocks.length > 0
      ? applyPreamble(
          config.userContextPreamble,
          contextBlocks.join('\n\n---\n\n'),
          args.userMessage,
        )
      : args.userMessage;

  const messages: SyncChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...args.history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userContent },
  ];

  // Default-on: persist the grounding passage so the citation card can quote
  // it. `includePassageText === false` keeps the legacy lean shape; a number
  // truncates (defensive against very large chunks bloating the JSON column).
  const passageMode = args.includePassageText ?? true;
  const passageOf = (text: string): string | undefined => {
    if (passageMode === false) return undefined;
    if (typeof passageMode === 'number') return text.slice(0, passageMode);
    return text;
  };

  const provenance: Provenance | null =
    args.retrievedMatches.length > 0
      ? {
          chunks: args.retrievedMatches.map((m) => {
            const passage = passageOf(m.text);
            return {
              chunkId: m.chunkId,
              documentId: m.documentId,
              score: m.score,
              corpus: m.corpus,
              metadata: m.metadata ?? null,
              // Optional per-leg scores (0.6.0): copied only when present, so a
              // dense turn's provenance keeps its pre-0.6.0 shape.
              ...(typeof m.denseScore === 'number' ? { denseScore: m.denseScore } : {}),
              ...(typeof m.lexicalScore === 'number' ? { lexicalScore: m.lexicalScore } : {}),
              ...(typeof m.rerankScore === 'number' ? { rerankScore: m.rerankScore } : {}),
              ...(passage !== undefined ? { text: passage } : {}),
            };
          }),
        }
      : null;

  return { messages, provenance };
}
