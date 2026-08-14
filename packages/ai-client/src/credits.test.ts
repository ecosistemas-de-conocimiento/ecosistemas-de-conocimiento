import { describe, expect, it } from 'vitest';

import { toCredits } from './credits.js';

describe('toCredits', () => {
  it('multiplies and rounds up', () => {
    expect(toCredits(0.001, 1000)).toBe(1);
    expect(toCredits(0.0001, 1000)).toBe(1); // 0.1 → ceil → 1
    expect(toCredits(1, 100)).toBe(100);
    expect(toCredits(1.234, 100)).toBe(124); // 123.4 → ceil → 124
  });

  it('zero usd yields zero credits', () => {
    expect(toCredits(0, 100)).toBe(0);
  });

  it('throws on non-finite or non-positive rate', () => {
    expect(() => toCredits(1, 0)).toThrow(TypeError);
    expect(() => toCredits(1, -1)).toThrow(TypeError);
    expect(() => toCredits(1, Number.NaN)).toThrow(TypeError);
    expect(() => toCredits(Number.POSITIVE_INFINITY, 1)).toThrow(TypeError);
  });
});
