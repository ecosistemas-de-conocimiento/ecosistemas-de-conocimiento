// 🔴 TRACES LEAVE THE BOX. LOGS DO NOT.
//
// THE DEFECT THIS PINS: `@opentelemetry/instrumentation-pino` defaults
// `disableLogSending` to FALSE. Left at the default, setting the ONE documented
// variable `OTEL_EXPORTER_OTLP_ENDPOINT` — the switch whose entire documented
// meaning is "export traces" — ALSO ships every pino line to the collector as
// an OTLP log record: full request URLs with their query strings, plus the
// resource attributes the SDK detects by itself (`host.name`, `host.id`,
// `process.owner`, the container's command line). That is a second egress
// channel, with a different blast radius, turned on by a switch that never
// mentioned it. Nothing logs it, nothing fails; the only way to see it is to
// watch the collector.
//
// WHY THIS TEST NEEDS ITS OWN PROCESS AND A LOADER FLAG:
// `@opentelemetry/instrumentation-pino` patches the pino MODULE, and under
// plain ESM (`node dist/index.js`, and vitest's own module graph) there is no
// module-load hook, so it patches nothing at all. Measured on this branch, node
// 26.7.0:
//
//   node probe.mjs                                      → hits: /v1/traces
//                                                         pino line: NO trace_id
//   node --experimental-loader=@opentelemetry/instrumentation/hook.mjs probe.mjs
//                                                       → hits: /v1/traces,
//                                                                /v1/logs
//                                                         pino line: HAS trace_id
//
// So the child below runs WITH the loader hook — the configuration in which the
// instrumentation is live. Two consequences worth stating plainly:
//   1. PRODUCTION NOW RUNS WITH THAT HOOK. It arrives by a different route —
//      `--import ./dist/telemetry/preload.js` on the start command, which calls
//      `module.register()` rather than taking a loader flag — but the patched
//      state this file exercises is the deployed one, not a hypothetical.
//      Adding it is exactly the change that would have switched log egress on
//      as a side effect; `disableLogSending: true` is what made that a boring
//      change instead of a silent one, and this file is the proof.
//      `telemetry/preload.test.ts` covers the production form end to end.
//   2. A test run WITHOUT the hook would pass no matter what, because nothing
//      is patched. That is why the probe reports the pino line back and the
//      assertions below check for `trace_id` FIRST: an inert instrumentation
//      fails this file loudly rather than passing it vacuously.
//
// SABOTAGE (measured, both directions):
//   `disableLogSending: false` → HITS: ['/v1/traces', '/v1/logs']  (RED)
//   `disableLogSending: true`  → HITS: ['/v1/traces']              (GREEN)

import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

// Resolved through Node's module lookup, not a cwd-relative path: a nested
// worktree has no node_modules of its own and finds tsx in a parent directory.
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');

const run = promisify(execFile);

interface ProbeOutput {
  hits: { path: string; bytes: number }[];
  logged: string;
}

async function runProbe(): Promise<ProbeOutput> {
  const { stdout } = await run(
    process.execPath,
    [
      TSX_CLI,
      '--experimental-loader=@opentelemetry/instrumentation/hook.mjs',
      'src/telemetry/fixtures/log-egress-probe.ts',
    ],
    { cwd: process.cwd(), timeout: 60_000 },
  );
  const last = stdout.trim().split('\n').at(-1);
  if (!last) throw new Error(`probe produced no output; stdout=${JSON.stringify(stdout)}`);
  return JSON.parse(last) as ProbeOutput;
}

describe('OTLP export surface', () => {
  it('exports traces and NEVER logs, with the pino instrumentation live', async () => {
    const { hits, logged } = await runProbe();
    const paths = hits.map((h) => h.path);

    // ── ANTI-VACUITY, FIRST ──────────────────────────────────────────────
    // `trace_id` on the pino line proves the instrumentation really patched
    // pino in the child. Without this, "no /v1/logs" would be satisfied by an
    // instrumentation that does nothing at all.
    expect(logged, 'probe emitted no pino line').toContain('"msg":"probe line"');
    expect(
      logged,
      'pino was NOT patched in the child — this run could not have detected log egress',
    ).toContain('trace_id');

    // The pipeline is live: spans really did reach the collector.
    expect(paths, `collector saw: ${paths.join(', ')}`).toContain('/v1/traces');

    // ── THE ASSERTION ────────────────────────────────────────────────────
    expect(paths, `collector saw: ${paths.join(', ')}`).not.toContain('/v1/logs');

    // And the line that would have shipped really did carry something worth
    // not shipping, so the assertion above is about a real payload.
    expect(logged).toContain('SHOULD-NOT-LEAVE-THE-BOX');
  }, 90_000);
});
