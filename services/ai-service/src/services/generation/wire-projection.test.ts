// Unit tests for the router-usage → wire-usage projection.
//
// The behaviour under test is mostly about ABSENCE. The adapter defaults a
// provider's missing token counts to `0`, so by the time usage reaches this
// layer "not reported" and "reported as zero" look identical. Emitting
// `{ outputTokens: 0 }` would hand a billing consumer an authoritative-looking
// zero; omitting the field makes it fall back to its own estimate instead.

import { describe, expect, it } from 'vitest';

import type { TokenUsage } from '../ai/router/types.js';
import { projectWireUsage } from './wire-projection.js';

/** A full, realistic router usage record. Tests override one field at a time. */
function usage(over: Partial<TokenUsage> = {}): TokenUsage {
  return {
    inputTokens: 120,
    outputTokens: 45,
    totalTokens: 165,
    estimatedCostUsd: 0.0012,
    ...over,
  };
}

describe('projectWireUsage', () => {
  it('projects the three token fields when the provider reported counts', () => {
    expect(projectWireUsage(usage())).toEqual({
      outputTokens: 45,
      inputTokens: 120,
      totalTokens: 165,
    });
  });

  it('never leaks cost onto the usage object', () => {
    // Cost stays on the sibling top-level `costUsd` field. Duplicating it here
    // would give consumers two places to read one number, free to disagree.
    const projected = projectWireUsage(usage());
    expect(projected).not.toHaveProperty('estimatedCostUsd');
    expect(projected).not.toHaveProperty('costUsd');
  });

  describe('omission — the provider reported nothing', () => {
    it('returns undefined when every count is zero', () => {
      expect(
        projectWireUsage(usage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })),
      ).toBeUndefined();
    });

    it('returns undefined even when a cost is known but tokens are not', () => {
      // OpenRouter can report `usage.cost` while the underlying provider omits
      // token counts. Cost is still emitted (as `costUsd`); usage is not.
      expect(
        projectWireUsage(
          usage({ inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0.004 }),
        ),
      ).toBeUndefined();
    });

    it('drops inputTokens alone when only the output count is known', () => {
      expect(projectWireUsage(usage({ inputTokens: 0, totalTokens: 0 }))).toEqual({
        outputTokens: 45,
      });
    });

    it('keeps a zero outputTokens when the input count is real', () => {
      // A content-filtered response genuinely produces 0 output tokens off a
      // real prompt. That zero IS a measurement, so it must survive — the
      // whole-object omission only applies when nothing at all was reported.
      expect(projectWireUsage(usage({ outputTokens: 0, totalTokens: 120 }))).toEqual({
        outputTokens: 0,
        inputTokens: 120,
        totalTokens: 120,
      });
    });
  });

  describe('hostile / malformed provider numbers', () => {
    // None of these should reach a consumer that multiplies tokens by a rate.
    it('treats NaN as absent', () => {
      expect(
        projectWireUsage(usage({ inputTokens: Number.NaN, outputTokens: Number.NaN, totalTokens: Number.NaN })),
      ).toBeUndefined();
    });

    it('treats Infinity as absent', () => {
      expect(
        projectWireUsage(
          usage({
            inputTokens: Number.POSITIVE_INFINITY,
            outputTokens: Number.POSITIVE_INFINITY,
            totalTokens: Number.POSITIVE_INFINITY,
          }),
        ),
      ).toBeUndefined();
    });

    it('treats negatives as absent rather than emitting a negative bill', () => {
      expect(
        projectWireUsage(usage({ inputTokens: -5, outputTokens: -1, totalTokens: -6 })),
      ).toBeUndefined();
    });

    it('rounds fractional counts to integers', () => {
      expect(projectWireUsage(usage({ inputTokens: 10.4, outputTokens: 3.6, totalTokens: 14 }))).toEqual({
        outputTokens: 4,
        inputTokens: 10,
        totalTokens: 14,
      });
    });
  });

  it('emits only the documented keys', () => {
    const projected = projectWireUsage(usage());
    expect(Object.keys(projected ?? {}).sort()).toEqual([
      'inputTokens',
      'outputTokens',
      'totalTokens',
    ]);
  });
});
