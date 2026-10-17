import { describe, expect, it } from 'vitest';
import { ANSWER_NOT_SAVED_CODE, ANSWER_NOT_SAVED_MESSAGE, answerNotice } from './aiMessages';

describe('answerNotice (C-14)', () => {
  it('names the unsaved answer when the BFF sent ANSWER_NOT_SAVED', () => {
    expect(answerNotice([{ code: 'BUDGET_SOFT_CAP' }, { code: ANSWER_NOT_SAVED_CODE }])).toBe(
      ANSWER_NOT_SAVED_MESSAGE,
    );
  });

  it('shows nothing for other warnings or none', () => {
    expect(answerNotice([{ code: 'BUDGET_SOFT_CAP' }])).toBeUndefined();
    expect(answerNotice(undefined)).toBeUndefined();
    expect(answerNotice([])).toBeUndefined();
  });
});
