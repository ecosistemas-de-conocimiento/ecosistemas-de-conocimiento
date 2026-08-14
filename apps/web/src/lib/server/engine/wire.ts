/**
 * ai-service wire-request builder for chat turns — the ONE place that decides
 * what the model actually sees.
 *
 * ## What this replaced (the system-role fold)
 *
 * ai-service used to have no `system` slot at all: `/v1/generate/{sync,stream}`
 * rendered a single `{role:'user'}` message from a Handlebars `promptTemplate`
 * over `unit.input`. chat coped by sending the engine's whole `messages[]` as
 * `input.messages` plus a PASSTHROUGH template that flattened every turn —
 * INCLUDING the system message — into that one user message, each prefixed with
 * a literal role marker (`system:\n…`, `user:\n…`). The persona and the standing
 * rules therefore reached the model as ordinary conversational text.
 *
 * ai-service now accepts a real system prompt (`unit.systemPrompt`, literal,
 * never Handlebars-rendered) and sends it as a genuine `system` message. This
 * module does the partition.
 *
 * ## The partition
 *
 * `@edc/chat-engine` has already done the hard part for us. Its
 * `buildChatTurn` (see the engine's `core/turn.ts` header) enforces a
 * load-bearing invariant:
 *
 *   - the **system message is BEHAVIORAL ONLY** — persona, standing rules,
 *     output/format contract, plus optional team/thread custom instructions;
 *   - **ALL factual context** (Tier-1 summary, retrieved chunks, `@`-cited
 *     entities) lives in the final USER turn under the labelled
 *     `[CONTEXTO …]` preamble, because the chat model under-weights facts
 *     placed in the system message.
 *
 * So the split is already drawn where it belongs, and we honour it exactly:
 *
 *   - leading `system` messages  → `unit.systemPrompt` (real system message)
 *   - history + final user turn  → `unit.input.userPrompt`
 *
 * Nothing was moved ACROSS that line by this migration. The behavioural delta
 * is only that the behavioural block is now weighted as rules rather than as
 * chat text, and that the literal `system:` marker no longer appears in the
 * user message.
 *
 * ## Why history is still flattened
 *
 * ai-service still renders exactly ONE user message; it has no multi-turn
 * message passthrough. Conversation history therefore still has to be
 * flattened into that message as a role-marked transcript. When there is no
 * history (the common single-turn case, and every `condense` / `title`
 * utility call) we send the user content VERBATIM — no role markers, no
 * trailing directive — which is what a normal chat API would send.
 *
 * ## Rendering
 *
 * We build the user text in TypeScript and hand ai-service a trivial
 * `{{{userPrompt}}}` passthrough template, rather than shipping conversation
 * assembly into a Handlebars template on the far side. That keeps the exact
 * bytes the model sees assertable in a unit test with no network (see
 * `wire.test.ts`), and sidesteps ai-service's strict-mode Handlebars choking on
 * user content that happens to contain `{{`. Triple-stache keeps the content
 * unescaped — it is LLM input, not HTML.
 *
 * ## Where that template LIVES (inline vs registry)
 *
 * Assembling in TypeScript and staying UNREGISTERED are two different
 * decisions, and only the first was ever made deliberately. chat's first commit
 * shipped a README line — "when the chat path graduates to a registered
 * unitType, drop `specOverride`" — that was deleted in a mechanical
 * SolidStart→SvelteKit port without anyone deciding. Every other product on
 * ai-service registers its prompts.
 *
 * So the passthrough stays; the SLOT it travels in moves. the backend seeds a
 * `chat` unit-type whose `promptTemplate` is these same bytes, and
 * `useRegistryPrompt` (see `./promptSource`) makes this builder omit
 * `specOverride` so the registry supplies the spec instead. The rendered prompt
 * is byte-identical either way — that is the whole point, and it is why the
 * registered row must use TRIPLE stache like this one.
 *
 * What chat gains: the model / validators / effort tier become editable config
 * instead of a deploy, and generations finally carry a prompt version, because
 * ai-service refuses to stamp provenance on any request that carries an inline
 * override.
 */

import type { GenerateSyncRequest } from '$lib/server/aiService';

/** Minimal message shape shared by the engine and chat's BFF. */
export interface WireMessage {
  role: string;
  content: string;
}

/**
 * Passthrough template. ai-service still requires a prompt template to render
 * the user message from `unit.input`; we do the assembly here and let it
 * substitute one variable verbatim.
 *
 * 🔴 TRIPLE stache, and it must stay that way. ai-service renders prompts with
 * Handlebars in its default escaping mode, so `{{userPrompt}}` HTML-escapes its
 * value: `it's` → `it&#x27;s`, `<` → `&lt;`, and every markdown backtick →
 * `&#x60;`, which would destroy every code block chat emits. Since chat
 * assembles the WHOLE prompt in TypeScript and ships it as this one variable,
 * the escaping would hit all real user text.
 *
 * 🔴 These exact bytes are duplicated in the backend's registry seed
 * (`the backend/src/seed/registry.ts` → `CHAT_PROMPT_TEMPLATE`) because the
 * two services share no package. That equality IS the proof that moving to the
 * registry changes nothing the model sees: ai-service's `renderPrompt` is a
 * pure function, so an identical template over identical vars renders identical
 * bytes. Both sides pin the literal in a unit test. Change one, change both.
 */
export const PROMPT_TEMPLATE_USER_PROMPT = '{{{userPrompt}}}';

/**
 * Trailing directive appended ONLY when history forces us to flatten the
 * conversation into a transcript, to tell the model which turn to answer.
 * Unnecessary — and noise — when the user message stands alone.
 */
export const TRANSCRIPT_DIRECTIVE =
  'Responde como el asistente para el último turno del usuario.';

export interface PartitionedPrompt {
  /** Literal system-message text, or `undefined` when there is none. */
  systemPrompt: string | undefined;
  /** The single user message ai-service will send to the model. */
  userPrompt: string;
}

/**
 * Split an engine `messages[]` into a real system prompt + one user message.
 *
 * Only LEADING `system` messages are lifted out. A `system` entry appearing
 * mid-conversation (never emitted by the engine today) is left in the
 * transcript rather than silently reordered to the front — reordering would
 * change meaning without any signal.
 */
export function partitionMessages(messages: readonly WireMessage[]): PartitionedPrompt {
  let i = 0;
  const systemParts: string[] = [];
  for (; i < messages.length; i += 1) {
    const m = messages[i];
    if (!m || m.role !== 'system') break;
    systemParts.push(m.content);
  }
  const rest = messages.slice(i);

  const systemJoined = systemParts.join('\n\n').trim();
  // ai-service rejects an empty `systemPrompt` (`min(1)`); whitespace-only
  // means "no system prompt", so send `undefined`, never `''`.
  const systemPrompt = systemJoined.length > 0 ? systemJoined : undefined;

  const only = rest.length === 1 ? rest[0] : undefined;
  const userPrompt =
    only && only.role === 'user'
      ? only.content
      : `${rest.map((m) => `${m.role}:\n${m.content}`).join('\n\n')}\n\n${TRANSCRIPT_DIRECTIVE}`;

  return { systemPrompt, userPrompt };
}

export interface BuildChatUnitArgs {
  messages: readonly WireMessage[];
  unitKey: string;
  unitType?: string;
  effortLevel?: string;
  modelOverride?: string;
  /**
   * Omit `unit.specOverride` so ai-service's prompt registry supplies the spec.
   *
   * Defaults to `false` = today's behaviour. Callers pass
   * `useRegistryPrompt()` (`./promptSource`), which is off unless an operator
   * sets `PROMPT_SOURCE=registry` — and they must only do that AFTER
   * the backend has seeded the `chat` registry row, because ai-service returns
   * HTTP 400 when a unit has no override, no registry row and no
   * `project_configs` row.
   *
   * ⚠ Dropping the override is NOT prompt-only. `resolve.ts` resolves every
   * spec field independently and stops shadowing ALL of them at once, so the
   * registry row's `model`, `metaPromptTemplate`, `validators`,
   * `responseSchema`, `renderer` and `contentKind` all start applying too.
   * chat's seeded row deliberately sets none of them.
   */
  useRegistryPrompt?: boolean;
}

/**
 * Build the `/v1/generate/{sync,stream}` request body for a chat turn. Both
 * transports take the identical body, so sync and stream migrate in lockstep by
 * construction — including the registry flip.
 */
export function buildChatUnitRequest(args: BuildChatUnitArgs): GenerateSyncRequest {
  const { systemPrompt, userPrompt } = partitionMessages(args.messages);
  return {
    unit: {
      unitKey: args.unitKey,
      unitType: args.unitType ?? 'chat',
      input: { userPrompt },
      ...(systemPrompt ? { systemPrompt } : {}),
      // Registry mode omits the slot entirely rather than sending an empty
      // object: `specOverride: {}` is still truthy on the far side, and
      // `resolve.ts:407` refuses to stamp `registryEntryId` / `promptVersion`
      // whenever ANY override object is present. Omitting it is what finally
      // gives chat answers a prompt version to attribute them to.
      ...(args.useRegistryPrompt
        ? {}
        : { specOverride: { promptTemplate: PROMPT_TEMPLATE_USER_PROMPT } }),
    },
    ...(args.effortLevel ? { effortLevel: args.effortLevel } : {}),
    ...(args.modelOverride ? { modelOverride: args.modelOverride } : {}),
  };
}
