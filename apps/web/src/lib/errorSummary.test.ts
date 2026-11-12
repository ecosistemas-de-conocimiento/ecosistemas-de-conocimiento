/**
 * P-07 (re-audit 2026-11-10): what a log line may keep of an error.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { errSummary, ROW_TEXT_SOURCE, safeErrMessage, safeReason } from './errorSummary';

const TESTIMONY = 'Me llamo Ana Pérez y en 2019 mi hermano';

/** drizzle's shape: the failed query's params in the message, kept as properties too. */
function drizzleError(): Error {
  const err = new Error(`Failed query: update "documents" set "extracted_text" = $1\nparams: ${TESTIMONY}`);
  Object.assign(err, { query: 'update …', params: [TESTIMONY] });
  return err;
}

describe('a Node system error keeps its code (2026-11-10)', () => {
  it('an ECONNREFUSED is summarised with its code; a database error still drops its message', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3000'), {
      code: 'ECONNREFUSED',
      errno: -111,
      syscall: 'connect',
    });
    expect(errSummary(refused)).toBe('Error(ECONNREFUSED)');
    expect(safeErrMessage(refused)).toBe('Error(ECONNREFUSED): connect ECONNREFUSED 127.0.0.1:3000');
    expect(safeErrMessage(drizzleError())).not.toContain('Ana');
  });
});

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

/** Postgres 16 messages that quote their input (shapes from a real server, 2026-11-12). */
const QUOTING = [
  'invalid input value for enum enum_documents_publication_status: "Ana Pérez"',
  'malformed array literal: "Ana Pérez"',
  'malformed record literal: "Ana Pérez"',
  'malformed range literal: "Ana Pérez"',
  'invalid input syntax for type integer: "Ana Pérez"',
  'invalid input syntax for type json Token "Ana" is invalid.',
  'value "99999999999999" is out of range for type integer',
  'date/time field value out of range: "2019-13-45"',
  'duplicate key value violates unique constraint "users_email_idx" Key (email)=(Ana Pérez) already exists.',
  'new row for relation "t" violates check constraint "t_v_check" Failing row contains (Ana Pérez).',
  'syntax error in tsquery: "Ana Pérez &"',
  'DETAIL: Ana Pérez'
];

describe('safeReason: any Postgres text that quotes a value (audit 2026-11-12)', () => {
  it.each(QUOTING)('withholds %s, keeping the code', (msg) => {
    expect(safeReason(`ingest_failed: ${msg}`)).toBe('ingest_failed: [database error text withheld]');
    expect(safeReason(msg)).toBe('[database error text withheld]');
    expect(safeErrMessage(msg)).not.toContain('Ana');
  });

  it('a clean reason passes unchanged', () => {
    for (const v of ['no_audio_stream: the file has no audio', 'verify: 2 nombres', 'publish_failed: timeout', 'gate: 1 nombre']) {
      expect(safeReason(v)).toBe(v);
    }
  });

  it("is the backend's pattern, character for character", () => {
    const backend = readFileSync(new URL('../../../backend/src/lib/errorSummary.ts', import.meta.url), 'utf8');
    const list = /export const ROW_TEXT_SOURCE = \[([\s\S]*?)\]\.join/.exec(backend)?.[1];
    expect(list).toBeTruthy();
    const items = [...list!.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]!.replace(/\\\\/g, '\\'));
    expect(items.join('|')).toBe(ROW_TEXT_SOURCE);
  });
});
