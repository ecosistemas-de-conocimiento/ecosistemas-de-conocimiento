// A REAL Postgres error, from the service's own db client, logged as `{ err }`
// through the shared logger options, leaves no row text. See `log-safe.ts`.

import { Writable } from 'node:stream';

import { sql } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, describe, expect, it } from 'vitest';

import { LOG_SAFE_OPTIONS } from './log-safe.js';

const ROW_TEXT = 'Juana Pérez declaró en la audiencia';

describe('log-safe err serializer against real Postgres (integration)', () => {
  afterAll(async () => {
    const { closeDb } = await import('../db/client.js');
    await closeDb().catch(() => undefined);
  });

  it('a value Postgres quotes back in its error never reaches the log line', async () => {
    const { db } = await import('../db/client.js');
    // `invalid input syntax for type uuid: "<value>"` — Postgres echoes the value.
    const err = await db.execute(sql`SELECT ${ROW_TEXT}::uuid`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).toContain('Juana');

    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, done) {
        lines.push(String(chunk));
        done();
      },
    });
    pino({ ...LOG_SAFE_OPTIONS, level: 'info' }, sink).error({ err }, 'query failed');

    expect(lines[0]).not.toContain('Juana');
    const line = JSON.parse(lines[0]!) as { err: Record<string, unknown> };
    expect(line.err.code).toBe('22P02');
    expect(line.err.message).toBeUndefined();
  });
});
