/**
 * P-07 (re-audit 2026-11-10): what a log line may keep of an error.
 */
import { describe, expect, it } from 'vitest';

import { errSummary, safeErrMessage } from './errorSummary';

const TESTIMONY = 'Me llamo Ana Pérez y en 2019 mi hermano';

/** drizzle's shape: the failed query's params in the message, kept as properties too. */
function drizzleError(): Error {
  const err = new Error(`Failed query: update "documents" set "extracted_text" = $1\nparams: ${TESTIMONY}`);
  Object.assign(err, { query: 'update …', params: [TESTIMONY] });
  return err;
}

describe('errSummary', () => {
  it('keeps the type and the code, from the cause chain too', () => {
    const fetchFailed = new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) });
    expect(errSummary(fetchFailed)).toBe('TypeError(ECONNREFUSED)');
    expect(errSummary(Object.assign(new Error('x'), { code: '57P01' }))).toBe('Error(57P01)');
  });

  it('🔴 never the message', () => {
    expect(errSummary(drizzleError())).toBe('Error');
    expect(errSummary(new Error(TESTIMONY))).not.toContain('Ana');
  });

  it('names a subclass that never set `name` by its constructor', () => {
    class BackendError extends Error {}
    expect(errSummary(new BackendError(TESTIMONY))).toBe('BackendError');
  });

  it('says what a non-error is, not what it holds', () => {
    expect(errSummary(TESTIMONY)).toBe('string');
    expect(errSummary(undefined)).toBe('undefined');
  });
});

describe('safeErrMessage', () => {
  it('keeps an ordinary message, with its type and code', () => {
    expect(safeErrMessage(new TypeError('Failed to fetch'))).toBe('TypeError: Failed to fetch');
    const fetchFailed = new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) });
    expect(safeErrMessage(fetchFailed)).toBe('TypeError(ECONNREFUSED): fetch failed');
  });

  it('🔴 withholds a database error, also one wrapped as the cause', () => {
    expect(safeErrMessage(drizzleError())).not.toContain('Ana');
    expect(safeErrMessage(new Error('save failed', { cause: drizzleError() }))).toBe('Error');
    expect(safeErrMessage(Object.assign(new Error(TESTIMONY), { code: '23505' }))).toBe('Error(23505)');
  });

  it('🔴 withholds a wrapper that copied drizzle text into its own message', () => {
    expect(safeErrMessage(new Error(`backend 500: Failed query: select … params: ${TESTIMONY}`))).toBe('Error');
    expect(safeErrMessage(`Failed query: …\nparams: ${TESTIMONY}`)).not.toContain('Ana');
  });

  it('🔴 withholds a JSON parse error, which quotes the body', () => {
    let parseErr: unknown;
    try {
      JSON.parse(`{"text": "${TESTIMONY}"`);
    } catch (err) {
      parseErr = err;
    }
    expect(safeErrMessage(parseErr)).toBe('SyntaxError');
  });

  it('truncates a long message', () => {
    expect(safeErrMessage(new Error('x'.repeat(1000)), 10)).toBe(`Error: ${'x'.repeat(10)}`);
  });
});
