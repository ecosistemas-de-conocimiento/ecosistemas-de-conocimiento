// OpenTelemetry bootstrap — env-switchable, OFF by default.
//
// 🔴 "OFF" MEANS THE SDK IS NEVER LOADED, not merely never exported to.
//
// Every OpenTelemetry module below is behind a *dynamic* `import()` inside
// `startTelemetry()`. With `OTEL_EXPORTER_OTLP_ENDPOINT` unset:
//   - `@opentelemetry/sdk-node` and the instrumentations are never evaluated,
//   - no module is monkey-patched (ioredis in particular stays untouched, so
//     the CI `test`/`build` jobs — which have no Redis service — cannot be
//     made to dial one by a tracing hook),
//   - no global TracerProvider is registered, so `trace.getTracer(...)` keeps
//     handing back the API's no-op tracer and `span.isRecording()` is `false`.
// A static top-level import would defeat all three, so do not "tidy" these
// into the import block. `otel.test.ts` pins the behaviour.
//
// Sovereign infra: the only destination is the plain OTLP/HTTP URL in
// `OTEL_EXPORTER_OTLP_ENDPOINT`. No vendor SDK, no SaaS default, no fallback
// endpoint — unset means off, never "send it somewhere".

import { diag, DiagLogLevel } from '@opentelemetry/api';
import type { FastifyPluginCallback } from 'fastify';
import { pino } from 'pino';

import { otlpEndpoint, serviceName, telemetryEnabled } from './config.js';

export interface TelemetryHandle {
  /** The resolved collector URL, echoed for the boot log. */
  endpoint: string;
  shutdown(): Promise<void>;
}

let handle: TelemetryHandle | null = null;
let fastifyPlugin: FastifyPluginCallback<Record<never, never>> | null = null;

/**
 * The `@fastify/otel` plugin, or `null` when telemetry is off.
 *
 * `server.ts` registers it when present. It is exposed as a getter rather than
 * imported directly by `server.ts` so the HTTP layer keeps zero static
 * OpenTelemetry imports — see the note at the top of this file. The official
 * `@fastify/otel` is used deliberately; the contrib
 * `@opentelemetry/instrumentation-fastify` package is archived.
 */
export function getFastifyOtelPlugin(): FastifyPluginCallback<Record<never, never>> | null {
  return fastifyPlugin;
}

export function getTelemetryHandle(): TelemetryHandle | null {
  return handle;
}

/**
 * Start the Node SDK if — and only if — an OTLP endpoint is configured.
 * Returns `null` when telemetry is off. Idempotent.
 */
export async function startTelemetry(): Promise<TelemetryHandle | null> {
  if (handle) return handle;
  const endpoint = otlpEndpoint();
  if (!telemetryEnabled() || endpoint === undefined) return null;

  // `NodeSDK` picks `service.name` off `OTEL_SERVICE_NAME` via the env
  // resource detector, so defaulting it here beats threading a Resource
  // object through — one fewer dependency, same result.
  process.env['OTEL_SERVICE_NAME'] ??= serviceName();

  const [{ NodeSDK }, { OTLPTraceExporter }, { PinoInstrumentation }, { IORedisInstrumentation }, fastifyOtel] =
    await Promise.all([
      import('@opentelemetry/sdk-node'),
      import('@opentelemetry/exporter-trace-otlp-http'),
      import('@opentelemetry/instrumentation-pino'),
      import('@opentelemetry/instrumentation-ioredis'),
      import('@fastify/otel'),
    ]);

  const FastifyOtelInstrumentation = fastifyOtel.FastifyOtelInstrumentation;
  const fastifyInstrumentation = new FastifyOtelInstrumentation({
    registerOnInitialization: false,
    // `GET /metrics` is polled every few seconds forever and is the one route
    // whose spans describe nothing but the monitoring itself. Left in, it is
    // the highest-volume trace in the system and pushes real requests out of
    // any sampled window. The route opts out of its own histogram for the
    // same reason (`config.disableMetrics` in `routes/metrics.ts`), so the
    // scrape is neither traced nor timed — only served.
    ignorePaths: '/metrics',
  });
  fastifyPlugin = fastifyInstrumentation.plugin() as FastifyPluginCallback<Record<never, never>>;

  const sdk = new NodeSDK({
    // No `url` — the exporter reads `OTEL_EXPORTER_OTLP_ENDPOINT` itself and
    // appends the spec's `/v1/traces` path, so operators configure exactly the
    // one standard variable.
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      // Stamps `trace_id` / `span_id` onto every pino line, which is what
      // makes a log line and a span the same incident rather than two.
      //
      // ⚠ IT IS LIVE ONLY BECAUSE THE START COMMAND CARRIES A LOADER HOOK.
      // This instrumentation patches the pino MODULE, and under plain ESM —
      // which is how the service runs (`"type": "module"`) — there is no
      // module-load hook, so on its own it patches nothing: measured on node
      // 26.7.0, log lines carried NO `trace_id`. Production therefore boots as
      // `node --import ./dist/telemetry/preload.js dist/index.js`, and
      // `telemetry/preload.ts` installs that hook (gated on the same endpoint
      // variable, so it is absent when telemetry is off).
      // `telemetry/preload.test.ts` measures both directions — with the
      // preload a line carries `trace_id`, without it the same line does not.
      // (The same applies to `IORedisInstrumentation` below; `@fastify/otel` is
      // unaffected because it is registered as a plugin, not patched in.)
      //
      // 🔴 `disableLogSending: true` IS NOT OPTIONAL, AND IT IS NOT THE
      // DEFAULT. Left off, this instrumentation ALSO ships every pino line to
      // the collector's `/v1/logs` as an OTLP log record — measured against a
      // local listener: full request URLs with their query strings, plus the
      // resource attributes the SDK detects on its own (`host.name`,
      // `host.id`, `process.owner`, `process.command_args` — the container's
      // full command line). Only TRACE export was ever intended or reviewed
      // here, and log egress is a separate decision with a separate blast
      // radius: an operator who points this at a collector must not silently
      // start shipping the service's logs off-box too. Enrichment stays,
      // sending goes.
      new PinoInstrumentation({ disableLogSending: true }),
      new IORedisInstrumentation(),
      fastifyInstrumentation,
    ],
  });
  sdk.start();

  // Export failures are otherwise SILENT: the batch processor swallows them and
  // the only symptom is traces that never arrive, which looks identical to a
  // service nobody called. OpenTelemetry routes them through its `diag`
  // channel, so give that channel somewhere to land. ERROR level only — DEBUG
  // on this channel is extremely chatty and would itself become a log volume
  // problem.
  const diagLog = pino({ name: 'otel', level: 'warn' });
  diag.setLogger(
    {
      error: (message, ...args) => diagLog.warn({ args }, message),
      warn: (message, ...args) => diagLog.warn({ args }, message),
      info: () => undefined,
      debug: () => undefined,
      verbose: () => undefined,
    },
    DiagLogLevel.ERROR,
  );

  handle = {
    endpoint,
    async shutdown() {
      await sdk.shutdown();
      diag.disable();
      handle = null;
      fastifyPlugin = null;
    },
  };
  return handle;
}
