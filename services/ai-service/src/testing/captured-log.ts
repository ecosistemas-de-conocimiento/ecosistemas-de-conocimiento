// A pino logger with the shared options (`errors/log-safe.ts`), writing its
// JSON lines into an array, for a test that reads what a log line carries.

import { Writable } from 'node:stream';

import pino, { type Logger } from 'pino';

import { LOG_SAFE_OPTIONS } from '../errors/log-safe.js';

export function capturedLog(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, done) {
      lines.push(String(chunk));
      done();
    },
  });
  return { log: pino({ ...LOG_SAFE_OPTIONS, level: 'info' }, sink), lines };
}
