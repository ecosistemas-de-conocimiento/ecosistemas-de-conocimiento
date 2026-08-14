// Unit tests for the self-critique helpers. Matrix:
//   - decideRefine: shouldRefine === true iff effort ∈ {'deep','maximum'} AND
//     (a blocker is present OR depth-policy applies — which for deep/maximum
//     is always). For quick/standard, false EXCEPT when a `json-schema-mismatch`
//     or `json-parse-error` blocker is present (the structured-output
//     cross-effort self-heal).
//   - buildRefineMessages: appends [assistant: draft, user: feedback] to the
//     original messages, preserving order.

import { describe, expect, it } from 'vitest';

import type { Flag } from '../validators/types.js';
import type { EffortLevel } from '../../../types/generation.js';
import type { ChatMessage } from './types.js';
import { buildRefineMessages, decideRefine } from './self-critique.js';

const blocker: Flag = { severity: 'blocker', code: 'B1', message: 'broken' };
const warning: Flag = { severity: 'warning', code: 'W1', message: 'soft' };
const schemaMismatch: Flag = {
  severity: 'blocker',
  code: 'json-schema-mismatch',
  message: 'required field missing',
};
const parseError: Flag = {
  severity: 'blocker',
  code: 'json-parse-error',
  message: 'model output was not valid JSON',
};

describe('decideRefine', () => {
  it('returns shouldRefine=false for quick effort regardless of flags', () => {
    expect(decideRefine({ effort: 'quick', flags: [] }).shouldRefine).toBe(false);
    expect(decideRefine({ effort: 'quick', flags: [blocker] }).shouldRefine).toBe(false);
    expect(decideRefine({ effort: 'quick', flags: [warning] }).shouldRefine).toBe(false);
  });

  it('returns shouldRefine=false for standard effort regardless of flags', () => {
    expect(decideRefine({ effort: 'standard', flags: [] }).shouldRefine).toBe(false);
    expect(decideRefine({ effort: 'standard', flags: [blocker] }).shouldRefine).toBe(false);
    expect(decideRefine({ effort: 'standard', flags: [warning] }).shouldRefine).toBe(false);
  });

  it('returns shouldRefine=true for deep effort with a blocker (blocker reason)', () => {
    const d = decideRefine({ effort: 'deep', flags: [blocker] });
    expect(d.shouldRefine).toBe(true);
    expect(d.feedback).toContain('BLOCKER');
    expect(d.feedback).toContain('[B1]');
    expect(d.feedback).toContain('broken');
  });

  it('returns shouldRefine=true for maximum effort with a blocker (blocker reason)', () => {
    const d = decideRefine({ effort: 'maximum', flags: [blocker] });
    expect(d.shouldRefine).toBe(true);
    expect(d.feedback).toContain('BLOCKER');
    expect(d.feedback).toContain('[B1]');
  });

  it('returns shouldRefine=true for deep effort with no flags (depth-policy)', () => {
    const d = decideRefine({ effort: 'deep', flags: [] });
    expect(d.shouldRefine).toBe(true);
    expect(d.feedback).toContain('denser');
    expect(d.feedback).not.toContain('BLOCKER');
  });

  it('returns shouldRefine=true for maximum effort with no flags (depth-policy)', () => {
    const d = decideRefine({ effort: 'maximum', flags: [] });
    expect(d.shouldRefine).toBe(true);
    expect(d.feedback).toContain('denser');
  });

  it('includes warnings in feedback when present', () => {
    const d = decideRefine({ effort: 'deep', flags: [blocker, warning] });
    expect(d.feedback).toContain('Warnings');
    expect(d.feedback).toContain('[W1]');
    expect(d.feedback).toContain('soft');
  });

  it('produces empty feedback when shouldRefine is false', () => {
    const d = decideRefine({ effort: 'quick', flags: [blocker] });
    expect(d.feedback).toBe('');
  });

  // Cross-effort structured-output self-heal: a `json-schema-mismatch` blocker
  // (and ONLY that code) earns exactly one refine pass even below deep effort,
  // so structured extraction (which runs at `quick`) can recover a bad draft.
  it('returns shouldRefine=true for quick effort when a json-schema-mismatch blocker is present', () => {
    const d = decideRefine({ effort: 'quick', flags: [schemaMismatch] });
    expect(d.shouldRefine).toBe(true);
    expect(d.feedback).toContain('BLOCKER');
    expect(d.feedback).toContain('[json-schema-mismatch]');
  });

  it('returns shouldRefine=true for standard effort when a json-schema-mismatch blocker is present', () => {
    const d = decideRefine({ effort: 'standard', flags: [schemaMismatch] });
    expect(d.shouldRefine).toBe(true);
    expect(d.feedback).toContain('[json-schema-mismatch]');
  });

  it('returns shouldRefine=true for quick/standard when a json-parse-error blocker is present', () => {
    const q = decideRefine({ effort: 'quick', flags: [parseError] });
    expect(q.shouldRefine).toBe(true);
    expect(q.feedback).toContain('[json-parse-error]');
    expect(decideRefine({ effort: 'standard', flags: [parseError] }).shouldRefine).toBe(true);
  });

  it('does NOT refine on quick/standard for a non-structured-failure blocker (scope guard)', () => {
    expect(decideRefine({ effort: 'quick', flags: [blocker] }).shouldRefine).toBe(false);
    expect(decideRefine({ effort: 'standard', flags: [blocker] }).shouldRefine).toBe(false);
    // Mixed: an unrelated blocker alongside a structured-failure blocker still
    // refines, driven by the structured failure.
    expect(
      decideRefine({ effort: 'quick', flags: [blocker, schemaMismatch] }).shouldRefine,
    ).toBe(true);
    expect(
      decideRefine({ effort: 'quick', flags: [blocker, parseError] }).shouldRefine,
    ).toBe(true);
  });
});

describe('buildRefineMessages', () => {
  it('appends assistant draft and user feedback to original messages', () => {
    const original: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ];
    const out = buildRefineMessages({
      originalMessages: original,
      draftContent: 'draft',
      feedback: 'critique...feedback',
    });
    expect(out).toHaveLength(4);
    expect(out[0]).toEqual({ role: 'system', content: 'sys' });
    expect(out[1]).toEqual({ role: 'user', content: 'hi' });
    expect(out[2]).toEqual({ role: 'assistant', content: 'draft' });
    expect(out[3]).toEqual({ role: 'user', content: 'critique...feedback' });
  });

  it('does not mutate the original messages array', () => {
    const original: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    const out = buildRefineMessages({
      originalMessages: original,
      draftContent: 'd',
      feedback: 'f',
    });
    expect(original).toHaveLength(1);
    expect(out).not.toBe(original);
  });

  it('handles an empty original message list', () => {
    const out = buildRefineMessages({
      originalMessages: [],
      draftContent: 'd',
      feedback: 'f',
    });
    expect(out).toEqual([
      { role: 'assistant', content: 'd' },
      { role: 'user', content: 'f' },
    ]);
  });
});

// Compile-time guard: ensure EffortLevel covers exactly the values the matrix
// above assumes. If a new level is added, this test file must be revisited.
const _effortMatrix: Record<EffortLevel, boolean> = {
  quick: false,
  standard: false,
  deep: true,
  maximum: true,
};
void _effortMatrix;
