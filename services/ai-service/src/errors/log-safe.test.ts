// `log.error({ err })` must not copy a database error's row text into the log.
// See `log-safe.ts`. The DB-backed case is `log-safe.integration.test.ts`.

import { Writable } from 'node:stream';

import pino, { type Logger } from 'pino';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';

import { LOG_SAFE_OPTIONS, isDatabaseError, safeErrSerializer } from './log-safe.js';

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
