// Readiness probing for the chat frontend.
//
// Implements the health-check contract. The rules
// that shape this file, and why each one is load-bearing:
//
//   Rule 1  — two states only: `ok`/200 or `down`/503. There is NO `degraded`.
//             A status that says "mostly fine" while a core capability is dead
//             is a multi-hour outage in a softer form.
//   Rule 2  — this is READINESS. Liveness lives in `routes/api/health` and
//             checks nothing. Never point a restart policy at readiness.
//   Rule 3  — a frontend has no dependencies of its own, so its readiness is
//             "can I reach my backend". We proxy one level down and surface
//             the backend's checks, so a dead dependency *behind* the backend
//             is visible from here.
//   Rule 4c — a dependency is `down` only after 2 CONSECUTIVE failed probes,
//             and the result is cached 5s. One dropped packet must not flip
//             the product to down.
//   Rule 5  — probes stay cheap and bounded. One HTTP GET, explicit timeout,
//             never an LLM/embedding/extraction call.
//
// 🔴 REDACTION IS THE SHARPEST RULE HERE. These routes are UNAUTHENTICATED.
// Nothing derived from an exception message or from the backend's response
// body may reach our response body. This is not hypothetical: a sibling app
// once shipped `err.message` into its readiness body, and Postgres emits
// `password authentication failed for user "<name>"` — a credential-shaped
// string on a public endpoint. Every value we emit comes from the closed
// vocabulary below. Full detail goes to `console.error`, server-side only.

import { backendUrl } from '$lib/server/auth';

export type HealthStatus = 'ok' | 'down';

/**
 * 🔴 The CLOSED vocabulary of error tokens this module may emit.
 *
 * Every value is a compile-time literal. No value is ever derived from an
 * exception message, a hostname, a URL, or an upstream response body. The one
 * computed form is `http_<status>`, whose variable part is an HTTP status code
 * — an integer, not attacker- or database-controlled text.
 */
export const PROBE_ERROR = {
  /** The probe exceeded PROBE_TIMEOUT_MS, or was otherwise aborted. */
  TIMEOUT: 'timeout',
  /** Connection actively refused — backend process is not listening. */
  REFUSED: 'ECONNREFUSED',
  /** DNS lookup failed — the backend hostname does not resolve. */
  DNS: 'ENOTFOUND',
  /** Connection dropped mid-flight. */
  RESET: 'ECONNRESET',
  /** Any other transport-level failure. The catch-all. */
  UNREACHABLE: 'unreachable',
  /** 2xx response whose body was not the JSON shape the contract defines. */
  BAD_RESPONSE: 'bad_response',
  /** Backend answered, and reported itself or one of its own deps as down. */
  UPSTREAM_DOWN: 'upstream_down',
  /**
   * An upstream check carried its own `error` string. We record THAT it did,
   * never WHAT it said — the upstream string is the credential-leak vector.
   */
  UPSTREAM_REPORTED_ERROR: 'upstream_reported_error',
} as const;

export type ProbeErrorToken =
  | (typeof PROBE_ERROR)[keyof typeof PROBE_ERROR]
  | `http_${number}`;

export interface HealthCheck {
  status: HealthStatus;
  ms: number;
  error?: ProbeErrorToken;
  /**
   * Populated only while a failure is not yet confirmed, or once it is.
   * Rule 4c creates a deliberate window where `status` is still `ok` but a
   * probe has already failed once. The contract calls that window out as a
   * "visible lying window" and asks for the count to be emitted so a flapping
   * dependency is observable rather than smoothed away.
   *
   * ⚠ A monitor must treat a populated `error` as a signal EVEN WHEN
   * `status` is `ok`.
   */
  consecutiveFailures?: number;
}

/** An upstream check, stripped to the fields that cannot carry a secret. */
export interface UpstreamCheck {
  status: HealthStatus;
  ms?: number;
  error?: typeof PROBE_ERROR.UPSTREAM_REPORTED_ERROR;
}

export interface ReadinessReport {
  status: HealthStatus;
  service: 'chat';
  /**
   * Serialises to the contract's `checks` object. Typed as an exact shape
   * rather than `Record<string, HealthCheck>` because a frontend has exactly
   * one dependency — its backend — and saying so in the type keeps callers
   * from having to null-check a key that is always present.
   *
   * ⚠ Monitors still must not assert on the name `backend`; check names differ
   * between services. Assert on the top-level `status`.
   */
  checks: { backend: HealthCheck };
  /**
   * What the backend said about ITS dependencies, sanitised. Present only
   * when the backend answered with a usable `checks` object, so one request
   * tells the whole story instead of forcing a second hop.
   */
  upstream?: Record<string, UpstreamCheck>;
}

/** Rule 5: bounded. A readiness probe must never hang. */
const PROBE_TIMEOUT_MS = 3_000;
/** Rule 4c: cache the result 5s so a 5s container probe and a 5min monitor
 *  do not multiply load on a shared dependency. */
const CACHE_TTL_MS = 5_000;
/** Rule 4c: `down` only after 2 consecutive failures. */
const FAILURES_BEFORE_DOWN = 2;
/** Defensive caps so a broken or hostile backend cannot inflate our body. */
const MAX_UPSTREAM_CHECKS = 20;
const CHECK_NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * ⚠ Module-scope state. Under `@sveltejs/adapter-node` this file is evaluated
 * once per server process, so the counter and cache live for the process
 * lifetime. Multiple replicas each keep their own — which is correct: each
 * replica is reporting on its own ability to reach the backend.
 */
let cached: { at: number; report: ReadinessReport } | null = null;
let consecutiveFailures = 0;
/** De-duplicates concurrent cache misses so a probe burst counts as one
 *  failure, not N — otherwise a single outage instant could jump the
 *  consecutive-failure counter straight past the tolerance. */
let inFlight: Promise<ReadinessReport> | null = null;

export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>;

/**
 * Map a thrown fetch error onto the closed vocabulary.
 *
 * 🔴 Deliberately allowlist-based. Node's `fetch` wraps transport failures as
 * `TypeError: fetch failed` with the real code on `.cause.code`. Those codes
 * are a fixed OS-level set, but we still match them explicitly rather than
 * passing `code` through — an unrecognised value becomes `unreachable`, so the
 * emitted set stays provably closed.
 */
function classifyError(err: unknown): ProbeErrorToken {
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return PROBE_ERROR.TIMEOUT;
  }
  const code = (err as { cause?: { code?: unknown } } | undefined)?.cause?.code;
  switch (code) {
    case 'ECONNREFUSED':
      return PROBE_ERROR.REFUSED;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return PROBE_ERROR.DNS;
    case 'ECONNRESET':
    case 'EPIPE':
      return PROBE_ERROR.RESET;
    case 'ETIMEDOUT':
      return PROBE_ERROR.TIMEOUT;
    default:
      return PROBE_ERROR.UNREACHABLE;
  }
}

/**
 * 🔴 The redaction boundary for everything the backend sends us.
 *
 * Keeps the check NAME (so a monitor can see *which* dependency broke) and the
 * two non-textual fields. Replaces any upstream `error` with a fixed token —
 * the upstream string is exactly where `password authentication failed for
 * user "<name>"` came from, and this route is unauthenticated.
 */
export function sanitizeUpstreamChecks(raw: unknown): Record<string, UpstreamCheck> {
  const out: Record<string, UpstreamCheck> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;

  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_UPSTREAM_CHECKS) break;
    // A name that isn't a plain identifier is not a dependency name we
    // recognise; dropping it keeps arbitrary upstream text out of our keys.
    if (!CHECK_NAME_RE.test(name)) continue;

    const v = (value ?? {}) as { status?: unknown; ms?: unknown; error?: unknown };
    // Anything that is not explicitly `ok` counts as down. Rule 1 has no
    // third state, so an unrecognised status must fail closed, not open.
    const check: UpstreamCheck = { status: v.status === 'ok' ? 'ok' : 'down' };
    if (typeof v.ms === 'number' && Number.isFinite(v.ms)) check.ms = v.ms;
    if (v.error !== undefined && v.error !== null) {
      check.error = PROBE_ERROR.UPSTREAM_REPORTED_ERROR;
    }
    out[name] = check;
  }
  return out;
}

interface ProbeOutcome {
  ok: boolean;
  ms: number;
  error?: ProbeErrorToken;
  upstream?: Record<string, UpstreamCheck>;
}

/**
 * One bounded GET against the backend's READINESS route.
 *
 * ⚠ Probes `/api/health/ready`, never `/api/health`. Rule 4b: a dependency's
 * own liveness constant is not evidence it works — RustFS returned 200 from
 * `/health/ready` while every S3 call against it 503'd.
 */
async function probeBackend(fetchImpl: FetchLike): Promise<ProbeOutcome> {
  const started = Date.now();
  try {
    const res = await fetchImpl(`${backendUrl()}/api/health/ready`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const ms = Date.now() - started;

    // Parse before branching on status: a 503 body still tells us WHICH of the
    // backend's dependencies failed, and that is the useful part.
    const body = (await res.json().catch(() => null)) as {
      status?: unknown;
      checks?: unknown;
    } | null;
    const upstream = sanitizeUpstreamChecks(body?.checks);

    if (!res.ok) {
      console.error(`[health] the backend /api/health/ready responded HTTP ${res.status}`);
      return { ok: false, ms, error: `http_${res.status}`, upstream };
    }
    if (!body || typeof body !== 'object') {
      console.error('[health] the backend /api/health/ready returned an unparseable body');
      return { ok: false, ms, error: PROBE_ERROR.BAD_RESPONSE };
    }
    // Rule 1: any check down ⇒ we are down. Belt and braces — a contract-
    // compliant backend pairs `status:"down"` with a 503, but we must not
    // depend on it having done so.
    const anyCheckDown = Object.values(upstream).some((c) => c.status === 'down');
    if (body.status !== 'ok' || anyCheckDown) {
      console.error('[health] the backend reported itself not ready');
      return { ok: false, ms, error: PROBE_ERROR.UPSTREAM_DOWN, upstream };
    }
    return { ok: true, ms, upstream };
  } catch (err) {
    // 🔴 The full error goes HERE and only here. It may contain a connection
    // string, a hostname, or a database message.
    console.error('[health] the backend readiness probe failed', err);
    return { ok: false, ms: Date.now() - started, error: classifyError(err) };
  }
}

async function computeReadiness(fetchImpl: FetchLike): Promise<ReadinessReport> {
  const outcome = await probeBackend(fetchImpl);

  if (outcome.ok) consecutiveFailures = 0;
  else consecutiveFailures += 1;

  // Rule 4c tolerance: one failure is not yet down.
  const confirmedDown = !outcome.ok && consecutiveFailures >= FAILURES_BEFORE_DOWN;

  const check: HealthCheck = {
    status: confirmedDown ? 'down' : 'ok',
    ms: outcome.ms,
  };
  if (!outcome.ok) {
    check.error = outcome.error;
    check.consecutiveFailures = consecutiveFailures;
  }

  const report: ReadinessReport = {
    status: confirmedDown ? 'down' : 'ok',
    service: 'chat',
    checks: { backend: check },
  };
  if (outcome.upstream && Object.keys(outcome.upstream).length > 0) {
    report.upstream = outcome.upstream;
  }
  return report;
}

/**
 * The readiness report, cached for CACHE_TTL_MS.
 *
 * `fetchImpl` is injectable for tests only; production always uses the global
 * `fetch`. Note this is deliberately NOT SvelteKit's `event.fetch` — that is
 * for same-origin relative requests, and this is an absolute cross-service URL.
 */
export async function getReadiness(fetchImpl: FetchLike = fetch as FetchLike): Promise<ReadinessReport> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.report;
  if (inFlight) return inFlight;

  inFlight = computeReadiness(fetchImpl)
    .then((report) => {
      cached = { at: Date.now(), report };
      return report;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/** Test-only. Clears the module-scope cache, counter and in-flight probe. */
export function __resetHealthStateForTests(): void {
  cached = null;
  consecutiveFailures = 0;
  inFlight = null;
}
