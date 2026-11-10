import { describe, it, expect } from 'vitest';
import {
  assertAnswer,
  EMPTY_ANSWER_CODE,
  EmptyAnswerError,
  isEmptyAnswerCode,
  isEmptyGeneration,
  shouldRetryEmpty,
  streamOutcome,
} from './generation.js';

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

describe('isEmptyAnswerCode', () => {
  it('reads every spelling of an empty completion', () => {
    for (const code of ['EmptyCompletion', 'EMPTY_COMPLETION', 'ERR_EMPTY_COMPLETION', 'empty_answer']) {
      expect(isEmptyAnswerCode(code)).toBe(true);
    }
  });
  it('any other code, or none, is not one', () => {
    for (const code of ['ProviderUnavailable', 'ERR_PROVIDER_UNAVAILABLE', 'INTERNAL', 'Teapot', '', undefined, 42]) {
      expect(isEmptyAnswerCode(code)).toBe(false);
    }
  });
});

describe('assertAnswer', () => {
  it('an empty or whitespace-only sync answer throws EmptyAnswerError', () => {
    for (const text of ['', ' \n\t ', null, undefined]) {
      expect(() => assertAnswer({ text, finishReason: 'length' })).toThrow(EmptyAnswerError);
    }
    try {
      assertAnswer({ text: '', finishReason: 'length' });
    } catch (err) {
      expect((err as EmptyAnswerError).code).toBe(EMPTY_ANSWER_CODE);
      expect((err as EmptyAnswerError).finishReason).toBe('length');
    }
  });
  it('an answer with text passes through as the same object', () => {
    const gen = { text: 'Hola.' };
    expect(assertAnswer(gen)).toBe(gen);
  });
});

describe('streamOutcome', () => {
  it('done with text: that text', () => {
    expect(streamOutcome({ type: 'done', text: 'Final.' }, 'Fin')).toEqual({ ok: true, text: 'Final.' });
  });
  it('done with no content and nothing streamed: empty_answer', () => {
    for (const frame of [{ type: 'done', text: '' }, { type: 'done', text: '  \n' }, { type: 'done' }]) {
      expect(streamOutcome(frame, '')).toMatchObject({ ok: false, code: EMPTY_ANSWER_CODE });
      expect(streamOutcome(frame, ' ')).toMatchObject({ ok: false, code: EMPTY_ANSWER_CODE });
    }
  });
  it('done with no text after streamed content: the streamed text', () => {
    expect(streamOutcome({ type: 'done', text: '' }, 'Parcial.')).toEqual({ ok: true, text: 'Parcial.' });
  });
  it('an empty-completion error frame, before or after partial content: empty_answer', () => {
    for (const code of ['EmptyCompletion', 'EMPTY_COMPLETION', 'ERR_EMPTY_COMPLETION']) {
      expect(streamOutcome({ type: 'error', code, message: 'x' }, '')).toMatchObject({ ok: false, code: EMPTY_ANSWER_CODE });
      expect(streamOutcome({ type: 'error', code, message: 'x' }, 'Medio')).toMatchObject({ ok: false, code: EMPTY_ANSWER_CODE });
    }
  });
  it('any other error frame keeps its code, before or after partial content', () => {
    expect(streamOutcome({ type: 'error', code: 'ProviderUnavailable', message: 'down' }, '')).toEqual({
      ok: false,
      code: 'ProviderUnavailable',
      message: 'down',
    });
    expect(streamOutcome({ type: 'error', code: 'ProviderTimeout', message: 't' }, 'Medio')).toMatchObject({
      ok: false,
      code: 'ProviderTimeout',
    });
  });
  it('an unknown code is kept as is; a missing one becomes stream_failed', () => {
    expect(streamOutcome({ type: 'error', code: 'SOMETHING_NEW' })).toMatchObject({ ok: false, code: 'SOMETHING_NEW' });
    expect(streamOutcome({ type: 'error' })).toEqual({
      ok: false,
      code: 'stream_failed',
      message: 'Streaming generation failed.',
    });
  });
});
