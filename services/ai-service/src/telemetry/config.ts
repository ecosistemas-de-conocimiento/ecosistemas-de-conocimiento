// Telemetry configuration — a VALUE read off a `process.env`-shaped record.
//
// 🔴 WHY THIS STILL READS `process.env` AND NOT `src/config/env.ts`.
// `src/telemetry/preload.ts` runs via `node --import`, i.e. BEFORE the entry
// graph is loaded, and it must decide whether to install the loader hook. It
// therefore cannot reach a Config that `src/index.ts` builds — index.ts has not
// been loaded yet. Importing `config/env.ts` from the preload would also drag
// the whole zod parse (which can `process.exit`) into the preload position.
//
// The fold phase 2 asked for is done the only way that keeps the preload
// contract: `readTelemetryConfig()` is a PURE function of an env record, the
// Config value in `src/config/config.ts` carries its result as `config.otel`,
// and the preload calls the same pure function directly. One reader, two
// call sites, no second source of truth.
//
// The names are the OpenTelemetry SPEC names (`OTEL_EXPORTER_OTLP_ENDPOINT`,
// `OTEL_SERVICE_NAME`, …), not ours. That is the point: any collector — a
// self-hosted Grafana Alloy, an OTel Collector, a Jaeger — is configured the
// same way, with a plain URL. There is no vendor SDK and no SaaS default: with
// the endpoint unset, `startTelemetry()` starts nothing at all.

/** Default `service.name` when the operator has not set `OTEL_SERVICE_NAME`. */
export const DEFAULT_SERVICE_NAME = 'ai-service';

export interface TelemetryConfig {
  /**
   * The OTLP/HTTP collector base URL, trimmed, or `undefined` when telemetry is
   * off. An empty / whitespace-only value counts as unset — Coolify hands every
   * declared-but-blank variable through as `''`, and "" is not a collector.
   */
  endpoint: string | undefined;
  /**
   * Telemetry is enabled IFF an OTLP endpoint is configured. There is no second
   * switch on purpose: "off" must mean no SDK, no instrumentation patching, and
   * no socket — see `startTelemetry()`.
   */
  enabled: boolean;
  serviceName: string;
}

/** Pure reader. Called by `loadConfig()` and, one beat earlier, by the preload. */
export function readTelemetryConfig(
  source: Record<string, string | undefined> = process.env,
): TelemetryConfig {
  const rawEndpoint = source['OTEL_EXPORTER_OTLP_ENDPOINT']?.trim();
  const endpoint = rawEndpoint ? rawEndpoint : undefined;
  const rawName = source['OTEL_SERVICE_NAME']?.trim();
  return {
    endpoint,
    enabled: endpoint !== undefined,
    serviceName: rawName ? rawName : DEFAULT_SERVICE_NAME,
  };
}

// ── Late-reading wrappers ───────────────────────────────────────────────────
// `otel.ts` and `preload.ts` read at the moment they act, not at import, and
// `otel.test.ts` mutates `process.env` between cases. These keep that exact
// timing; they are one-line delegates, not a second implementation.

export function otlpEndpoint(): string | undefined {
  return readTelemetryConfig().endpoint;
}

export function telemetryEnabled(): boolean {
  return readTelemetryConfig().enabled;
}

export function serviceName(): string {
  return readTelemetryConfig().serviceName;
}
