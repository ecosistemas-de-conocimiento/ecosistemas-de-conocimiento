// System-prompt resolution — the ONE place that decides what (if anything)
// ai-service sends to the model as a `{ role: 'system' }` message.
//
// ── Why this module exists ────────────────────────────────────────────────
// Until now the generation path hardcoded `messages: [{ role: 'user', … }]`.
// There was no system role anywhere: every consumer that needed standing
// instructions (a persona, an output contract, an embedded response schema,
// anti-hallucination rules) had to hand-fold them into the *user* prompt.
// Worse, `registry_entries.meta_prompt_template` was resolved into the spec and
// then consumed by nothing — a socket that was designed and never wired.
//
// This module wires both, behind one rule set used identically by
// `/v1/generate` (worker), `/v1/generate/sync` and `/v1/generate/stream`.
//
// ── Precedence (highest first) ────────────────────────────────────────────
//   1. `unit.systemPrompt`                     — per-request, per-unit. LITERAL.
//   2. `unit.specOverride.metaPromptTemplate`  — per-request, per-unit inline
//                                                spec. RENDERED.
//   3. `systemPromptOverride` (request body)   — per-request, batch-wide. LITERAL.
//   4. `registry_entries.meta_prompt_template` — standing registry default.
//                                                RENDERED.
//   5. nothing → NO system message is sent at all.
//
// The shape of that ladder is deliberately the same "most specific wins" order
// the prompt template already uses in `resolveSpec` (inline specOverride →
// request-level override → registry row), with the new explicit `systemPrompt`
// field sitting on top as the documented consumer surface.
//
// Request-level beats registry-level because the registry row is a default
// authored ahead of time by an admin, while the request carries what the
// consumer knows *now*. A chat turn's system prompt, for instance, is composed
// at runtime from the session's organization and the documents in scope — a
// registry row that could silently override it would be exactly the
// duplicate-and-desync failure the registry column was never able to serve.
//
// ── Rendered vs literal ───────────────────────────────────────────────────
// Anything named `…Template` (levels 2 and 4) is a template: it is authored in
// the registry / inline spec and rendered with the SAME variable bag as the
// user prompt, so `{{orgName}}`-style interpolation works.
//
// Anything named `systemPrompt` (levels 1 and 3) is passed through
// byte-for-byte. That is not laziness: `renderPrompt` compiles in Handlebars
// `strict` mode, so a caller-composed prompt that happens to contain `{{` (an
// embedded schema, a literal example, a mustache-looking placeholder) would
// throw at generation time. Consumers compose these strings at runtime; they
// must be inert.
//
// ── Backward compatibility ────────────────────────────────────────────────
// No system input at any level ⇒ `resolveSystemPrompt` returns `undefined` and
// `withSystemMessage` returns the caller's message array UNCHANGED (same array
// identity is not guaranteed, but the contents are byte-identical). Today no
// registry row sets `meta_prompt_template` and no consumer sends the new
// fields, so the wire behaviour — including the router cache key, which hashes
// the message list — is unchanged for every existing caller.

import { renderPrompt } from '../render/handlebars.js';
import type { ChatMessage } from '../ai/router/types.js';
import type { ResolvedSpec } from '../registry/resolve.js';

/** The precedence level that actually supplied the system prompt. */
export type SystemPromptSource =
  | 'unit'
  | 'spec-inline'
  | 'request'
  | 'registry';

export interface SystemPromptInputs {
  /** `unit.systemPrompt` from the request body (level 1). Literal. */
  unitSystemPrompt?: string | null | undefined;
  /** `systemPromptOverride` from the request body (level 3). Literal. */
  requestSystemPrompt?: string | null | undefined;
  /** Resolved spec — carries levels 2 and 4 plus their provenance. */
  spec?: Pick<ResolvedSpec, 'metaPromptTemplate' | 'metaPromptSource'> | undefined;
  /** Variable bag for rendering the template-valued levels (2 and 4). */
  vars?: object | undefined;
}

export interface SystemPromptResolution {
  /** The final system prompt, or `undefined` when there is none. */
  systemPrompt?: string;
  /** Which level won. `undefined` when nothing was supplied. */
  source?: SystemPromptSource;
}

/** Blank / whitespace-only inputs count as "not supplied". */
function firm(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? value : undefined;
}

/**
 * Apply the precedence ladder above.
 *
 * Throws `RenderError` (from `renderPrompt`) when a template-valued level fails
 * to render — the same failure mode, and the same error class, the user prompt
 * already has, so callers map it to their existing 400 / job-failed handling.
 */
export function resolveSystemPrompt(
  inputs: SystemPromptInputs,
): SystemPromptResolution {
  const unit = firm(inputs.unitSystemPrompt);
  if (unit) return { systemPrompt: unit, source: 'unit' };

  const template = firm(inputs.spec?.metaPromptTemplate);
  const source = inputs.spec?.metaPromptSource;

  if (template && source === 'inline') {
    const rendered = firm(renderPrompt(template, inputs.vars ?? {}));
    if (rendered) return { systemPrompt: rendered, source: 'spec-inline' };
  }

  const request = firm(inputs.requestSystemPrompt);
  if (request) return { systemPrompt: request, source: 'request' };

  // `metaPromptSource` is only absent on specs built before this field existed
  // (or by hand in a test); treat an unlabelled template as registry-level,
  // which is the lowest-privilege interpretation.
  if (template && source !== 'inline') {
    const rendered = firm(renderPrompt(template, inputs.vars ?? {}));
    if (rendered) return { systemPrompt: rendered, source: 'registry' };
  }

  return {};
}

/**
 * Prefix a `system` message onto `messages` when `systemPrompt` is present.
 *
 * When it is absent the array is returned with identical contents — the
 * byte-identical-to-before guarantee for every consumer that has not migrated.
 */
export function withSystemMessage(
  systemPrompt: string | undefined,
  messages: ChatMessage[],
): ChatMessage[] {
  if (!systemPrompt) return messages;
  return [{ role: 'system', content: systemPrompt }, ...messages];
}
