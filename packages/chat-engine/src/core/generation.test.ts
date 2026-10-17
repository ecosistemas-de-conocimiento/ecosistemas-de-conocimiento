import { describe, it, expect } from 'vitest';
import { isEmptyGeneration, shouldRetryEmpty } from './generation.js';

describe('isEmptyGeneration', () => {
  it('empty, missing and whitespace-only text count as empty', () => {
    expect(isEmptyGeneration('')).toBe(true);
    expect(isEmptyGeneration('   \n\t ')).toBe(true);
    expect(isEmptyGeneration(undefined)).toBe(true);
    expect(isEmptyGeneration(null)).toBe(true);
  });
  it('any visible character is an answer', () => {
    expect(isEmptyGeneration('ok')).toBe(false);
    expect(isEmptyGeneration('  [1]  ')).toBe(false);
  });
});

describe('shouldRetryEmpty', () => {
  it("'length' is deterministic (cap spent on hidden reasoning): no retry", () => {
    expect(shouldRetryEmpty('length')).toBe(false);
  });
  it('any other finishReason is transient: retry once', () => {
    expect(shouldRetryEmpty('stop')).toBe(true);
    expect(shouldRetryEmpty('content_filter')).toBe(true);
  });
  it('no finishReason (cache hit / older ai-service): retry once', () => {
    expect(shouldRetryEmpty(undefined)).toBe(true);
    expect(shouldRetryEmpty(null)).toBe(true);
  });
});
