import { describe, expect, it } from 'vitest';

import { chunkRecursive } from './chunk.js';

describe('chunkRecursive', () => {
  it('empty input → []', () => {
    expect(chunkRecursive('')).toEqual([]);
  });

  it('short input → single chunk with ordinal 0', () => {
    const out = chunkRecursive('hello world');
    expect(out).toHaveLength(1);
    expect(out[0]!.ordinal).toBe(0);
    expect(out[0]!.text).toBe('hello world');
    expect(out[0]!.tokens).toBeGreaterThan(0);
  });

  it('deterministic — same input + opts produces identical output', () => {
    const text = 'paragraph one.\n\nparagraph two.\n\nparagraph three.';
    const a = chunkRecursive(text, { chunkSize: 5, chunkOverlap: 1 });
    const b = chunkRecursive(text, { chunkSize: 5, chunkOverlap: 1 });
    expect(a).toEqual(b);
  });

  it('long input → multiple chunks with monotonically increasing ordinal', () => {
    // 4000 chars ≈ 1000 tokens; at chunkSize 200 we expect ~5 chunks.
    const text = ('Lorem ipsum dolor sit amet. ').repeat(150);
    const out = chunkRecursive(text, { chunkSize: 200, chunkOverlap: 20 });
    expect(out.length).toBeGreaterThan(1);
    for (let i = 0; i < out.length; i++) {
      expect(out[i]!.ordinal).toBe(i);
    }
  });

  it('chunks respect rough size limits (chars <= chunkSize * 4)', () => {
    const text = ('alpha bravo charlie delta echo. ').repeat(200);
    const chunkSize = 100;
    const out = chunkRecursive(text, { chunkSize, chunkOverlap: 10 });
    const maxChars = chunkSize * 4;
    for (const c of out) {
      // Allow tiny overshoot from the recursive splitter's separator-keeping.
      expect(c.text.length).toBeLessThanOrEqual(maxChars * 1.05);
    }
  });

  it('overlap is present — chunk N ends with content that opens chunk N+1', () => {
    // Build text long enough to span multiple chunks reliably.
    const text = ('Sentence number ' + Array.from({ length: 60 }, (_, i) => `S${i}.`).join(' '))
      .repeat(5);
    const chunkSize = 50;
    const chunkOverlap = 10;
    const out = chunkRecursive(text, { chunkSize, chunkOverlap });
    expect(out.length).toBeGreaterThanOrEqual(2);
    // Each chunk after the first should start with a prefix taken from the
    // tail of the previous one (length up to chunkOverlap*4 chars).
    for (let i = 1; i < out.length; i++) {
      const prev = out[i - 1]!.text;
      const curr = out[i]!.text;
      const overlapChars = chunkOverlap * 4;
      const tail = prev.slice(Math.max(0, prev.length - overlapChars));
      // Curr should begin with some non-empty prefix of `tail` when overlap > 0
      // and the previous chunk was full enough to leave a tail.
      if (tail.length > 0 && prev.length > overlapChars) {
        expect(curr.startsWith(tail)).toBe(true);
      }
    }
  });

  it('chunkSize = 0 throws RangeError', () => {
    expect(() => chunkRecursive('abc', { chunkSize: 0 })).toThrow(RangeError);
  });

  it('chunkSize negative throws RangeError', () => {
    expect(() => chunkRecursive('abc', { chunkSize: -1 })).toThrow(RangeError);
  });

  it('chunkOverlap >= chunkSize throws RangeError', () => {
    expect(() => chunkRecursive('abc', { chunkSize: 5, chunkOverlap: 5 })).toThrow(RangeError);
  });

  it('handles a single very long paragraph with no separators (hard char-split fallback)', () => {
    const text = 'x'.repeat(10_000);
    const out = chunkRecursive(text, { chunkSize: 100, chunkOverlap: 10 });
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) {
      expect(c.text.length).toBeLessThanOrEqual(100 * 4 + 1);
    }
  });

  it('tokens is chars/4 rounded up', () => {
    const out = chunkRecursive('1234567'); // 7 chars => 2 tokens
    expect(out[0]!.tokens).toBe(Math.ceil(7 / 4));
  });
});
