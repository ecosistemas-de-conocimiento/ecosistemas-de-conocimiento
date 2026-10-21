import { describe, expect, it, vi } from 'vitest';
import { AIServiceError, TURN_FAILED_MESSAGE, userFacingError } from './api';
import { AI_UNAVAILABLE_CODE, AI_UNAVAILABLE_MESSAGE } from './aiMessages';

describe('userFacingError', () => {
  it('keeps the canonical budget sentence', () => {
    expect(userFacingError(new AIServiceError('x', AI_UNAVAILABLE_CODE))).toBe(
      AI_UNAVAILABLE_MESSAGE,
    );
  });

  it('never shows developer text such as "Network error" or "HTTP 502"', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const err of [
      new AIServiceError('Network error: fetch failed'),
      new AIServiceError('HTTP 502'),
      new Error('boom'),
    ]) {
      expect(userFacingError(err)).toBe(TURN_FAILED_MESSAGE);
    }
  });
});
