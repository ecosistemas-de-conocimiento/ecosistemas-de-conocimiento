// Unit tests for the outbound passage-text bound.
//
// The load-bearing assertion in this file is the CHANGE-DETECTOR (last
// describe): the outbound bound must be computed from the ingester's own
// constants, not from a second literal. If someone bumps `DEFAULT_CHUNK_SIZE`
// or `CHARS_PER_TOKEN` and the retrieve clamp keeps its old number, the two
// halves of the contract have drifted and consumers get truncated text with no
// warning. That test fails the moment they disagree.

import { describe, expect, it, vi } from 'vitest';

import { CHARS_PER_TOKEN, DEFAULT_CHUNK_SIZE, maxChunkChars } from './chunk.js';
import { clampPassageText, corpusPassageBound } from './passage-bound.js';

const IDENTITY = {
  corpusId: '11111111-1111-1111-1111-111111111111',
  corpus: 'laws',
  documentId: '22222222-2222-2222-2222-222222222222',
  chunkId: '33333333-3333-3333-3333-333333333333',
  ordinal: 7,
};

describe('clampPassageText — normal chunks pass through untouched', () => {
  it('returns the SAME string reference when within bounds', () => {
    const text = 'a'.repeat(100);
    const out = clampPassageText(text, 3200, IDENTITY);
    // Reference equality, not just value equality: a chunk inside the contract
    // must not be copied, re-encoded, trimmed or normalised on the way out.
    expect(out).toBe(text);
  });

  it('passes a chunk sitting EXACTLY on the bound through byte-identical', () => {
    const text = 'x'.repeat(3200);
    const out = clampPassageText(text, 3200, IDENTITY);
    expect(out).toBe(text);
    expect(out).toHaveLength(3200);
  });

  it('does not warn when nothing is clamped', () => {
    const logger = { warn: vi.fn() };
    clampPassageText('short', 3200, IDENTITY, logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('leaves an empty string alone', () => {
    expect(clampPassageText('', 3200, IDENTITY)).toBe('');
  });
});

describe('clampPassageText — over-bound chunks are truncated to EXACTLY the bound', () => {
  it('truncates to the bound and keeps the prefix', () => {
    const text = 'y'.repeat(5000);
    const out = clampPassageText(text, 3200, IDENTITY);
    expect(out).toHaveLength(3200);
    expect(out).toBe(text.slice(0, 3200));
  });

  it('is one char over: still clamps, off-by-one guard', () => {
    const text = 'z'.repeat(3201);
    const out = clampPassageText(text, 3200, IDENTITY);
    expect(out).toHaveLength(3200);
  });

  it('warns with the doc/chunk identifiers so the anomalous row can be found', () => {
    const logger = { warn: vi.fn() };
    clampPassageText('q'.repeat(4000), 3200, IDENTITY, logger);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [payload, msg] = logger.warn.mock.calls[0]!;
    // Identifiers are the point of the warn — without them it is unactionable.
    expect(payload).toMatchObject({
      corpusId: IDENTITY.corpusId,
      corpus: 'laws',
      documentId: IDENTITY.documentId,
      chunkId: IDENTITY.chunkId,
      ordinal: 7,
      storedChars: 4000,
      maxChars: 3200,
      overBy: 800,
    });
    expect(String(msg)).toContain('exceeds the ingestion chunk-size bound');
  });

  it('clamping is idempotent — a clamped passage re-clamps to itself', () => {
    const once = clampPassageText('w'.repeat(9000), 3200, IDENTITY);
    const logger = { warn: vi.fn() };
    const twice = clampPassageText(once, 3200, IDENTITY, logger);
    expect(twice).toBe(once);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('works without a logger at all (logger is optional)', () => {
    expect(() => clampPassageText('v'.repeat(5000), 10, IDENTITY)).not.toThrow();
    expect(clampPassageText('v'.repeat(5000), 10, IDENTITY)).toHaveLength(10);
  });
});

describe('corpusPassageBound — per-corpus, never a global constant', () => {
  it('uses the corpus chunk_size when set', () => {
    // 2000 tokens is a legal `corpora.chunk_size`; a global 3200-char bound
    // would silently truncate every result this corpus ever returns.
    expect(corpusPassageBound({ chunkSize: 2000 })).toBe(2000 * CHARS_PER_TOKEN);
  });

  it('falls back to the ingester default when chunk_size is absent or null', () => {
    expect(corpusPassageBound({})).toBe(maxChunkChars());
    expect(corpusPassageBound({ chunkSize: null })).toBe(maxChunkChars());
  });

  it('a smaller corpus gets a smaller bound', () => {
    expect(corpusPassageBound({ chunkSize: 100 })).toBe(400);
  });
});

describe('CHANGE DETECTOR: the outbound bound tracks the ingester constants', () => {
  it('the default bound IS DEFAULT_CHUNK_SIZE x CHARS_PER_TOKEN', () => {
    // Computed from the same constants the chunker uses — deliberately NOT the
    // literal 3200. If this file had hardcoded 3200, bumping DEFAULT_CHUNK_SIZE
    // would leave the clamp silently truncating in-contract chunks.
    const expected = DEFAULT_CHUNK_SIZE * CHARS_PER_TOKEN;
    expect(maxChunkChars()).toBe(expected);
    expect(corpusPassageBound({})).toBe(expected);
  });

  it('today that number is 3200 — a canary on the current configuration', () => {
    // Not the source of truth (the line above is). This one exists so a change
    // to DEFAULT_CHUNK_SIZE shows up as a deliberate, reviewed test edit rather
    // than passing unnoticed, and so consumers reading this file see the value.
    expect(maxChunkChars()).toBe(3200);
  });

  it('the bound scales with chunk_size for every corpus, not just the default', () => {
    for (const size of [1, 50, 800, 2000, 100_000]) {
      expect(corpusPassageBound({ chunkSize: size })).toBe(size * CHARS_PER_TOKEN);
    }
  });
});
