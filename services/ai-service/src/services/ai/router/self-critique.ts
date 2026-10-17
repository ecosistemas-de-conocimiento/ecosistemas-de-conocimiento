// Self-critique loop for `deep` and `maximum` effort. The ai-service `Flag`
// union is `'blocker' | 'warning'` only.
//
// Two passes per call:
//   1. generate — produce the initial draft.
//   2. refine   — feed the draft + validator feedback back into the model.
// Bypassed for `quick` and `standard` effort — EXCEPT for the structured-output
// self-heal: a `json-schema-mismatch` OR `json-parse-error` blocker earns a
// single (hard-capped) refine pass at any effort so structured extraction can
// recover from a bad draft. See `decideRefine`.

import type { ChatMessage } from './types.js';
import type { Flag } from '../validators/types.js';
import type { EffortLevel } from '../../../types/generation.js';

/**
 * Blocker codes that describe an unusable STRUCTURED-OUTPUT draft:
 *   - `json-schema-mismatch` — parsed cleanly but violates the `responseSchema`
 *     (router's authoritative Ajv gate, or the `json-schema` validator).
 *   - `json-parse-error` — the model's output was not valid JSON at all.
 * Both are the same class of failure (output a structured consumer can't use),
 * and both earn a cross-effort self-heal refine pass — see the `quick`/
 * `standard` branch in `decideRefine`.
 */
const STRUCTURED_SELF_HEAL_CODES = new Set(['json-schema-mismatch', 'json-parse-error']);

export interface CritiqueDecision {
  shouldRefine: boolean;
  feedback: string;
}

/**
 * Decide whether a refine pass is warranted given the draft + validator flags.
 *   - if the draft carries a structured-output failure blocker
 *     (`json-schema-mismatch` or `json-parse-error`) → refine (at ANY effort,
 *     including `quick`/`standard`) — the targeted structured-output self-heal
 *     (see below).
 *   - else if any flag is `blocker` (and effort is deep/maximum) → refine
 *   - else if effort === 'deep' || effort === 'maximum' → always refine
 *   - else → skip
 *
 * STRUCTURED-OUTPUT CROSS-EFFORT SELF-HEAL. Structured extraction (the
 * brainstorm-extraction surface) runs at `quick` effort, where refine is
 * otherwise bypassed. An occasional unusable draft — JSON that violates the
 * schema, or output that isn't valid JSON at all — would then return
 * `parsed:false` with no chance to recover. So a `json-schema-mismatch` or
 * `json-parse-error` blocker (and ONLY those codes) triggers a single refine
 * pass regardless of effort.
 *
 * HARD CAP = 1 EXTRA PASS. This function is a pure per-call decision; it is
 * invoked exactly ONCE per `route()` and drives exactly one refine pass. It is
 * never re-evaluated on the refined draft, so a persistently-invalid model
 * stops after one retry — the self-heal never loops. No other flag/effort
 * combination changes behaviour here.
 */
export function decideRefine(opts: {
  effort: EffortLevel;
  flags: Flag[];
}): CritiqueDecision {
  const blockers = opts.flags.filter((f) => f.severity === 'blocker');
  const warnings = opts.flags.filter((f) => f.severity === 'warning');
  const hasStructuredFailure = blockers.some((f) => STRUCTURED_SELF_HEAL_CODES.has(f.code));

  if (opts.effort === 'quick' || opts.effort === 'standard') {
    // Targeted self-heal: an unusable structured draft (schema mismatch or
    // unparseable JSON) earns exactly one refine pass even below deep effort.
    // Bounded by the single-invocation contract documented above.
    if (hasStructuredFailure) {
      return { shouldRefine: true, feedback: formatFeedback(blockers, warnings, 'blocker') };
    }
    return { shouldRefine: false, feedback: '' };
  }

  if (blockers.length > 0) {
    const feedback = formatFeedback(blockers, warnings, 'blocker');
    return { shouldRefine: true, feedback };
  }

  if (opts.effort === 'deep' || opts.effort === 'maximum') {
    const feedback = formatFeedback(blockers, warnings, 'depth-policy');
    return { shouldRefine: true, feedback };
  }

  return { shouldRefine: false, feedback: '' };
}

function formatFeedback(
  blockers: Flag[],
  warnings: Flag[],
  reason: 'blocker' | 'depth-policy',
): string {
  const lines: string[] = [];
  if (reason === 'blocker') {
    lines.push('Validators reported BLOCKER issues with your draft. Address each one:');
  } else {
    lines.push(
      'Refine this draft so it is denser, more concrete, and free of vague filler. Make it production-ready.',
    );
  }
  if (blockers.length > 0) {
    lines.push('');
    lines.push('Blockers:');
    for (const b of blockers) lines.push(`  - [${b.code}] ${b.message}`);
  }
  if (warnings.length > 0) {
    lines.push('');
    lines.push('Warnings (consider addressing):');
    for (const w of warnings) lines.push(`  - [${w.code}] ${w.message}`);
  }
  lines.push('');
  lines.push(
    'Return the refined response in the same shape as the original. Respond in Spanish if the original prompt was in Spanish.',
  );
  return lines.join('\n');
}

/**
 * Build the messages for the second (refine) pass: original conversation,
 * then the assistant's draft, then a user turn carrying validator feedback.
 */
export function buildRefineMessages(opts: {
  originalMessages: ChatMessage[];
  draftContent: string;
  feedback: string;
}): ChatMessage[] {
  return [
    ...opts.originalMessages,
    { role: 'assistant', content: opts.draftContent },
    { role: 'user', content: opts.feedback },
  ];
}
