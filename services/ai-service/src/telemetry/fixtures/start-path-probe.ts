// Entry for `telemetry/preload.test.ts`. Run by that test, never by vitest
// directly (it is not a `*.test.ts`).
//
// It does NOT start telemetry: the `--import ../preload.ts` under test is what
// starts it, exactly as the production `start` command does. That is the
// measurement — run this file WITHOUT the preload and it reports no
// `trace_id`, which is the sabotage contrast the test asserts.
//
// The imports below are deliberately STATIC and pino is deliberately at the
// top: that reproduces production's load order, where `pino` is loaded as part
// of the entry graph and can only be patched by a hook installed before the
// graph was loaded at all.

import { Writable } from 'node:stream';

import { trace } from '@opentelemetry/api';
import { pino } from 'pino';

import { getTelemetryHandle } from '../otel.js';

const lines: string[] = [];
const sink = new Writable({
  write(chunk: Buffer, _enc, cb) {
    lines.push(chunk.toString('utf8'));
    cb();
  },
});
const log = pino({ name: 'probe' }, sink);

await trace.getTracer('probe').startActiveSpan('probe-span', async (span) => {
  log.info({ url: 'https://example.test/x?token=SHOULD-NOT-LEAVE-THE-BOX' }, 'probe line');
  span.end();
});

// Read BEFORE the flush: `shutdown()` clears the handle.
const telemetryStarted = getTelemetryHandle() !== null;

// Flush the batch processor so the collector sees the span before we report.
await getTelemetryHandle()?.shutdown();

process.stdout.write(`${JSON.stringify({ logged: lines.join(''), telemetryStarted })}\n`);
process.exit(0);
