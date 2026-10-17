import { describe, expect, it } from 'vitest';
import { chatRetrievalPolicy, parseRerankFlag } from './rerank';

describe('parseRerankFlag (CHAT_RERANK)', () => {
  it('defaults to on', () => {
    expect(parseRerankFlag(undefined)).toBe(true);
    expect(parseRerankFlag('')).toBe(true);
    expect(parseRerankFlag('on')).toBe(true);
  });
  it('turns off on the usual spellings', () => {
    for (const v of ['off', '0', 'false', 'no', ' OFF ']) expect(parseRerankFlag(v)).toBe(false);
  });
});

describe('chatRetrievalPolicy', () => {
  it('on: dense with the engine defaults, plus rerank', () => {
    expect(chatRetrievalPolicy(true)).toEqual({
      mode: 'dense',
      perCorpusTopK: 5,
      limit: 8,
      rerank: true,
    });
  });
  it('off: no policy at all, so the engine keeps its pre-policy wire calls', () => {
    expect(chatRetrievalPolicy(false)).toBeUndefined();
  });
});
