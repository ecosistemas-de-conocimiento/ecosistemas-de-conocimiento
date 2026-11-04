// OFF BY DEFAULT — and "off" must mean nothing was started.
//
// The risk this pins is not a wrong span. It is a service that, with no
// telemetry configured, quietly loads the Node SDK, patches `ioredis`, and
// opens a socket to some default endpoint. That is two separate
// problems: the CI `test`/`build` jobs have no Redis service (a tracing hook
// that dials one turns a green suite red at teardown), and an exporter with a
// vendor default would ship tenant traffic shapes off the sovereign infra.

import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { trace } from '@opentelemetry/api';

import { otlpEndpoint, serviceName, telemetryEnabled, DEFAULT_SERVICE_NAME } from './config.js';
import { startTelemetry } from './otel.js';

// Resolved through Node's module lookup, not a cwd-relative path: a nested
// worktree has no node_modules of its own and finds tsx in a parent directory.
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');

const ENDPOINT_VAR = 'OTEL_EXPORTER_OTLP_ENDPOINT';
const NAME_VAR = 'OTEL_SERVICE_NAME';

let savedEndpoint: string | undefined;
let savedName: string | undefined;

beforeEach(() => {
  savedEndpoint = process.env[ENDPOINT_VAR];
  savedName = process.env[NAME_VAR];
  delete process.env[ENDPOINT_VAR];
  delete process.env[NAME_VAR];
});

afterEach(() => {
  if (savedEndpoint === undefined) delete process.env[ENDPOINT_VAR];
  else process.env[ENDPOINT_VAR] = savedEndpoint;
  if (savedName === undefined) delete process.env[NAME_VAR];
  else process.env[NAME_VAR] = savedName;
});

describe('telemetry config', () => {
  it('is disabled when OTEL_EXPORTER_OTLP_ENDPOINT is unset', () => {
    expect(otlpEndpoint()).toBeUndefined();
    expect(telemetryEnabled()).toBe(false);
  });

  it('treats a blank endpoint as unset', () => {
    // Coolify hands a declared-but-empty variable through as ''. An empty
    // string is not a collector, and `if (process.env.X)` style checks are
    // exactly what this guards.
    process.env[ENDPOINT_VAR] = '   ';
    expect(telemetryEnabled()).toBe(false);
  });

  it('is enabled by a plain URL, and trims it', () => {
    process.env[ENDPOINT_VAR] = ' http://collector.internal:4318 ';
    expect(telemetryEnabled()).toBe(true);
    expect(otlpEndpoint()).toBe('http://collector.internal:4318');
  });

  it('defaults the service name and lets the operator override it', () => {
    expect(serviceName()).toBe(DEFAULT_SERVICE_NAME);
    process.env[NAME_VAR] = 'ai-service-stage';
    expect(serviceName()).toBe('ai-service-stage');
  });
});

describe('startTelemetry with no endpoint configured', () => {
  it('starts no SDK at all', async () => {
    const handle = await startTelemetry();
    expect(handle).toBeNull();
  });

  it('leaves the global tracer non-recording, so no span is ever exported', async () => {
    await startTelemetry();
    // 🔴 THIS IS THE LOAD-BEARING ASSERTION. With no global TracerProvider
    // registered, `@opentelemetry/api` hands back its no-op tracer, whose
    // spans report `isRecording() === false` — meaning no span processor, no
    // batch queue, and no exporter socket exists to receive them.
    //
    // SABOTAGE (measured): remove the `telemetryEnabled()` guard from
    // `startTelemetry()` so the SDK boots unconditionally, and this flips to
    // `true` → RED, with the OTLP exporter falling back to its default
    // localhost endpoint. That is precisely the "off is not off" failure.
    const span = trace.getTracer('probe').startSpan('probe');
    expect(span.isRecording()).toBe(false);
    span.end();
  });

  it('does not leave a shutdown handle behind', async () => {
    const { getTelemetryHandle, getFastifyOtelPlugin } = await import('./otel.js');
    expect(getTelemetryHandle()).toBeNull();
    // No plugin ⇒ `server.ts` registers no Fastify instrumentation.
    expect(getFastifyOtelPlugin()).toBeNull();
  });
});


// ---------------------------------------------------------------------------
// "OFF loads no SDK" — as a COUNT, in a real process.
// ---------------------------------------------------------------------------

const run = promisify(execFile);

/**
 * Boot `telemetry/bootstrap.ts` in a child process and report which
 * `@opentelemetry/*` packages it actually loaded. A child is required: module
 * loading is a once-per-process event, and vitest's own worker has already
 * imported `@opentelemetry/api` by the time any test runs.
 */
async function loadedOtelPackages(endpoint?: string): Promise<string[]> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (endpoint === undefined) delete env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  else env['OTEL_EXPORTER_OTLP_ENDPOINT'] = endpoint;
  const { stdout } = await run(
    process.execPath,
    [TSX_CLI, 'src/telemetry/fixtures/module-load-probe.ts'],
    { cwd: process.cwd(), env, timeout: 60_000 },
  );
  const last = stdout.trim().split('\n').at(-1);
  if (!last) throw new Error(`probe produced no output; stdout=${JSON.stringify(stdout)}`);
  return (JSON.parse(last) as { packages: string[] }).packages;
}

describe('what a boot actually loads', () => {
  // ⚠ THIS MEASURES `import bootstrap`, NOT THE PRODUCTION COMMAND. Production
  // boots `node --import ./dist/telemetry/preload.js dist/index.js`, and the
  // flag is present whether or not telemetry is configured — so "off loads no
  // SDK" has to hold WITH the flag too, or it is a claim about a configuration
  // nobody runs. `telemetry/preload.test.ts` re-measures exactly that, and
  // additionally that no loader hook (`import-in-the-middle`) is registered.
  it('loads ONLY @opentelemetry/api with the endpoint unset', async () => {
    // 🔴 THIS IS THE PRECISE FORM OF THE CLAIM IN `server.ts`. "Telemetry off
    // imports no OpenTelemetry module" was WRONG and stated as fact: the API
    // package is loaded either way, because `telemetry/span.ts` imports it
    // statically to reach the no-op tracer. What matters is what is NOT there —
    // no SDK, no exporter, no instrumentation, therefore no module patching and
    // no socket. Counting is the only way to know; reading the imports is how
    // the wrong claim got written in the first place.
    const packages = await loadedOtelPackages(undefined);
    expect(packages).toEqual(['@opentelemetry/api']);
  }, 90_000);

  it('loads the SDK, the OTLP exporter and the instrumentations once an endpoint is set', async () => {
    // The other half: without this, the test above passes just as well against
    // a `startTelemetry()` that is broken and starts nothing at all.
    const packages = await loadedOtelPackages('http://127.0.0.1:14318');
    expect(packages).toContain('@opentelemetry/api');
    expect(packages).toContain('@opentelemetry/sdk-node');
    expect(packages).toContain('@opentelemetry/exporter-trace-otlp-http');
    expect(packages).toContain('@opentelemetry/instrumentation-pino');
    expect(packages).toContain('@opentelemetry/instrumentation-ioredis');
  }, 90_000);
});
