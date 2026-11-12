// `log.error({ err })` must not copy a database error's row text into the log.
// See `log-safe.ts`. The DB-backed case is `log-safe.integration.test.ts`.

import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';

import pino, { type Logger } from 'pino';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';

import {
  LOG_SAFE_OPTIONS,
  ROW_TEXT_SOURCE,
  clientErrText,
  errSummary,
  isDatabaseError,
  safeErrMessage,
  safeErrSerializer,
} from './log-safe.js';

const ROW_TEXT = 'Juana Pérez declaró en la audiencia';

/** A pino logger with the shared options, writing JSON lines into an array. */
function captured(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, done) {
      lines.push(String(chunk));
      done();
    },
  });
  return { log: pino({ ...LOG_SAFE_OPTIONS, level: 'info' }, sink), lines };
}

/**
 * The driver's own class, with the fields a Postgres `ErrorResponse` fills on
 * a unique violation; `query` / `parameters` attached as postgres.js does
 * (non-enumerable unless `debug`).
 */
function postgresError(): Error {
  const err = new postgres.PostgresError({
    severity_local: 'ERROR',
    severity: 'ERROR',
    code: '23505',
    message: `duplicate key value violates unique constraint "documents_title_key": ${ROW_TEXT}`,
    detail: `Key (title)=(${ROW_TEXT}) already exists.`,
    schema_name: 'public',
    table_name: 'documents',
    constraint_name: 'documents_title_key',
  } as unknown as string);
  Object.defineProperties(err, {
    query: { value: 'insert into documents (title) values ($1)', enumerable: false },
    parameters: { value: [ROW_TEXT], enumerable: false },
  });
  return err;
}

/**
 * What postgres.js rejects with when the server refuses the connection: Node's
 * `net` error (`errno` -111 on Linux), with the `query` it was running
 * attached, which makes it a database error.
 */
function refused(): Error {
  const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
    code: 'ECONNREFUSED',
    errno: -111,
    syscall: 'connect',
    address: '127.0.0.1',
    port: 5432,
  });
  Object.defineProperty(err, 'query', { value: 'select $1', enumerable: false });
  return err;
}

describe('a Node system error keeps its code (2026-11-10)', () => {
  it('🔴 migrate\'s fatal on an unreachable database says ECONNREFUSED, errno and syscall', () => {
    const { log, lines } = captured();
    log.fatal({ err: refused() }, 'Migration failed');
    const line = JSON.parse(lines[0]!) as { err: Record<string, unknown> };
    expect(line.err).toMatchObject({ type: 'Error', code: 'ECONNREFUSED', errno: -111, syscall: 'connect' });
  });

  it('🔴 a database error still drops its message, and keeps its SQLSTATE', () => {
    const out = safeErrSerializer(postgresError()) as Record<string, unknown>;
    expect(out.code).toBe('23505');
    expect(out.message).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('Juana');
  });

  it('🔴 errSummary and safeErrMessage say the code; neither quotes a row', () => {
    expect(errSummary(refused())).toBe('Error(ECONNREFUSED)');
    expect(errSummary(new Error('x', { cause: refused() }))).toBe('Error(ECONNREFUSED)');
    expect(errSummary(postgresError())).toBe('PostgresError(23505)');
    expect(safeErrMessage(postgresError())).toBe('PostgresError(23505)');
    expect(safeErrMessage(new TypeError('boom'))).toBe('TypeError: boom');
    expect(safeErrMessage(`Failed query: select\nparams: ${ROW_TEXT}`)).not.toContain('Juana');
  });
});

describe('safeErrSerializer', () => {
  it('a postgres.js PostgresError logged as { err } leaves no row text, keeps type, SQLSTATE and frames', () => {
    const { log, lines } = captured();
    log.error({ err: postgresError() }, 'insert failed');

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('Juana');
    const line = JSON.parse(lines[0]!) as { err: Record<string, unknown> };
    expect(line.err.type).toBe('PostgresError');
    expect(line.err.code).toBe('23505');
    expect(line.err.message).toBeUndefined();
    expect(line.err.detail).toBeUndefined();
    expect(String(line.err.stack)).toMatch(/^\s+at /);
  });

  it('the same holds when the database error is the cause of a wrapper', () => {
    const { log, lines } = captured();
    const wrapped = new Error(`could not save chunk: ${ROW_TEXT}`, { cause: postgresError() });
    log.error({ err: wrapped }, 'save failed');
    expect(lines[0]).not.toContain('Juana');
    expect((JSON.parse(lines[0]!) as { err: { code: string } }).err.code).toBe('23505');
  });

  it("drizzle's query text, as a message or a bare string, is withheld", () => {
    const text = `Failed query: insert into documents (title) values ($1)\nparams: ${ROW_TEXT}`;
    expect(isDatabaseError(new Error(text))).toBe(true);
    expect(JSON.stringify(safeErrSerializer(new Error(text)))).not.toContain('Juana');
    expect(safeErrSerializer(text)).toBe('[database error text withheld]');
  });

  it('🔴 an AggregateError holding a PostgresError is a database error (2026-11-11)', () => {
    const agg = new AggregateError([new Error('timeout'), postgresError()], `all failed: ${ROW_TEXT}`);
    expect(isDatabaseError(agg)).toBe(true);
    expect(JSON.stringify(safeErrSerializer(agg))).not.toContain('Juana');
    expect(safeErrMessage(agg)).toBe('AggregateError');
  });

  it('a PostgresError whose debug-mode fields are enumerable still leaves no row text', () => {
    // postgres.js with `debug` on: `query` and `parameters` are plain fields.
    const err = Object.assign(
      new postgres.PostgresError({
        severity: 'ERROR',
        code: '22P02',
        message: `invalid input syntax for type uuid: "${ROW_TEXT}"`,
        where: `unnamed portal parameter $1 = '${ROW_TEXT}'`,
      } as unknown as string),
      { query: 'select $1::uuid', parameters: [ROW_TEXT] },
    );
    const { log, lines } = captured();
    log.error({ err }, 'insert failed');
    expect(lines[0]).not.toContain('Juana');
    expect(safeErrMessage(err)).toBe('PostgresError(22P02)');
    expect(errSummary(err)).toBe('PostgresError(22P02)');
  });

  it('any other error keeps its message, truncated to 500 characters', () => {
    const out = safeErrSerializer(new TypeError('x'.repeat(600))) as Record<string, string>;
    expect(out.type).toBe('TypeError');
    expect(out.message).toHaveLength(500);
  });
});

/** The `err` serializer a pino logger (or child) ended up with. */
function errSerializerOf(log: Logger): unknown {
  const table = (log as unknown as Record<symbol, { err?: unknown }>)[pino.symbols.serializersSym];
  return table?.err;
}

describe('every ai-service logger uses it', () => {
  it('the background rootLogger', async () => {
    const { rootLogger } = await import('../logger.js');
    expect(errSerializerOf(rootLogger)).toBe(safeErrSerializer);
  });

  it('the Fastify instance logger', async () => {
    const { buildServer } = await import('../server.js');
    const { createTestRuntime } = await import('../testing/runtime.js');
    const runtime = createTestRuntime();
    const app = await buildServer(runtime);
    try {
      const log = app.log as unknown as Logger;
      expect(errSerializerOf(log)).toBe(safeErrSerializer);
      // A request-scoped child inherits it.
      const child = log.child({ reqId: 'r' });
      expect(errSerializerOf(child)).toBe(safeErrSerializer);
    } finally {
      await app.close();
      await runtime.close();
    }
  });
});

describe('clientErrText', () => {
  it('a database error is its code; any other reads exactly as its message did', () => {
    expect(clientErrText(postgresError())).toBe('PostgresError(23505)');
    expect(clientErrText(new Error('upstream 500'))).toBe('upstream 500');
    expect(clientErrText(42)).toBe('42');
    expect(clientErrText(`Failed query: select\nparams: ${ROW_TEXT}`)).not.toContain('Juana');
  });
});

/** Postgres messages that quote their input (shapes from a real Postgres 16, 2026-11-12). */
const QUOTING = [
  'invalid input value for enum st: "Juana Pérez"',
  'malformed array literal: "Juana Pérez"',
  'malformed record literal: "Juana Pérez"',
  'invalid input syntax for type uuid: "Juana Pérez"',
  'invalid input syntax for type json Token "Juana" is invalid.',
  'value "98765432109" is out of range for type integer',
  'no operand in tsquery: "Juana &"',
  'Key (email)=(Juana Pérez) already exists.',
];

describe('a string quoting a value is withheld (audit 2026-11-12)', () => {
  it.each(QUOTING)('%s', (msg) => {
    expect(safeErrMessage(msg)).toBe('[database error text withheld]');
    expect(clientErrText(msg)).toBe('[database error text withheld]');
    expect(isDatabaseError(new Error(msg))).toBe(true);
  });

  it('an ordinary message passes', () => {
    expect(safeErrMessage('ai-service reported a failure')).toBe('ai-service reported a failure');
    expect(clientErrText('timeout')).toBe('timeout');
  });

  it("is the backend's pattern, character for character", () => {
    const backend = readFileSync(new URL('../../../../apps/backend/src/lib/errorSummary.ts', import.meta.url), 'utf8');
    const list = /export const ROW_TEXT_SOURCE = \[([\s\S]*?)\]\.join/.exec(backend)?.[1];
    expect(list).toBeTruthy();
    const items = [...list!.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]!.replace(/\\\\/g, '\\'));
    expect(items.join('|')).toBe(ROW_TEXT_SOURCE);
  });
});
