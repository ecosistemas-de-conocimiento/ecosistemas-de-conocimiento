import { describe, expect, it } from 'vitest';

import { MODEL_PRICING, getTaskProfile, priceForUsage } from './task-profiles.js';

// Assertions read MODEL_PRICING dynamically so the test stays correct across
// price refreshes. Only model *identifiers* are
// hard-coded — those track `EFFORT_PROFILES` in registry/resolve.ts.
describe('priceForUsage', () => {
  it('matches the per-million formula for a known model', () => {
    const model = 'deepseek/deepseek-chat-v3.1';
    const row = MODEL_PRICING[model]!;
    const inputTokens = 12_345;
    const outputTokens = 6_789;
    const expected =
      (inputTokens / 1_000_000) * row.inputPerMillion +
      (outputTokens / 1_000_000) * row.outputPerMillion;
    expect(priceForUsage(model, inputTokens, outputTokens)).toBeCloseTo(expected, 12);
  });

  it('matches the formula for a legacy-priced model', () => {
    // kimi-k2 was the former `deep` model (dropped — degenerate structured
    // output); its price row is retained for old-trace cost-fallback.
    const model = 'moonshotai/kimi-k2-0905';
    const row = MODEL_PRICING[model]!;
    const inputTokens = 1_000_000;
    const outputTokens = 500_000;
    const expected = row.inputPerMillion + 0.5 * row.outputPerMillion;
    expect(priceForUsage(model, inputTokens, outputTokens)).toBeCloseTo(expected, 12);
  });

  // Without a row, a call whose OpenRouter usage carries no cost is ledgered at $0. The
  // expected value is a MEASURED call (4348 in / 496 out → $0.0025328,
  // OpenRouter-reported cost), so the row must reproduce OpenRouter's price.
  it('prices openai/gpt-4.1-mini at OpenRouter rates', () => {
    expect(MODEL_PRICING['openai/gpt-4.1-mini']).toEqual({ inputPerMillion: 0.4, outputPerMillion: 1.6 });
    expect(priceForUsage('openai/gpt-4.1-mini', 4348, 496)).toBeCloseTo(0.0025328, 10);
  });

  it('returns 0 for an unknown model', () => {
    expect(priceForUsage('does/not-exist', 1_000_000, 1_000_000)).toBe(0);
  });
});

describe('getTaskProfile', () => {
  it('returns the standard profile with a positive maxOutputTokens', () => {
    const p = getTaskProfile('standard');
    expect(p.maxOutputTokens).toBeGreaterThan(0);
  });

  it('returns distinct copies (mutation does not leak)', () => {
    const a = getTaskProfile('quick');
    a.maxOutputTokens = -1;
    const b = getTaskProfile('quick');
    expect(b.maxOutputTokens).toBeGreaterThan(0);
  });
});
