// Child-process probe for `telemetry/log-egress.test.ts`. Run by that test,
// never by vitest directly (it is not a `*.test.ts`).
//
// Boots the REAL `startTelemetry()` against a throwaway local collector, emits
// one span and one pino line, flushes, and prints the collector's hit list as
// JSON on stdout. The test reads that and asserts `/v1/logs` was never asked
// for. See the header of `log-egress.test.ts` for why this needs its own
// process and its own loader flag.

import http from 'node:http';
import { Writable } from 'node:stream';

interface Hit {
  path: string;
  bytes: number;
}

const hits: Hit[] = [];
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    hits.push({ path: req.url ?? '', bytes: Buffer.concat(chunks).length });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address() as { port: number };

process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = `http://127.0.0.1:${port}`;
process.env['OTEL_SERVICE_NAME'] = 'log-egress-probe';

const { startTelemetry } = await import('../otel.js');
const handle = await startTelemetry();
if (!handle) throw new Error('probe: startTelemetry() returned null with an endpoint set');

const { trace } = await import('@opentelemetry/api');
const { pino } = await import('pino');

// The log line goes INSIDE an active span on purpose. Its `trace_id` field is
// how the test knows the pino instrumentation actually patched pino in this
// process — without that proof a green "no /v1/logs" result would only mean the
// instrumentation was inert, which is the exact false green this file exists to
// avoid.
// A pino destination we can read back. The line's `trace_id` is how the test
// knows the pino instrumentation actually patched pino in this process —
// without that proof a green "no /v1/logs" result would only mean the
// instrumentation was inert, which is the exact false green this file exists to
// avoid.
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

await handle.shutdown();
await new Promise<void>((resolve) => server.close(() => resolve()));

process.stdout.write(`${JSON.stringify({ hits, logged: lines.join('') })}\n`);
