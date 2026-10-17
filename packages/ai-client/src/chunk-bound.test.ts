// `maxChunkChars` — the passage-length contract, in characters.

import { describe, expect, it } from 'vitest';

import { CHARS_PER_TOKEN, DEFAULT_CHUNK_SIZE, maxChunkChars } from './index.js';

describe('maxChunkChars', () => {
  it('pins the server defaults: 800 tokens × 4 chars = 3200', () => {
    expect(DEFAULT_CHUNK_SIZE).toBe(800);
    expect(CHARS_PER_TOKEN).toBe(4);
    expect(maxChunkChars()).toBe(3200);
  });

  it('follows a corpus`s own chunk_size', () => {
    expect(maxChunkChars(1200)).toBe(4800);
    expect(maxChunkChars(256)).toBe(1024);
  });

  it('falls back to the default for a nullish chunk_size', () => {
    expect(maxChunkChars(null)).toBe(3200);
    expect(maxChunkChars(undefined)).toBe(3200);
  });
});
