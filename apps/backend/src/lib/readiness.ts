/**
 * Readiness probes for this backend.
 *
 * These rules exist because a sibling product's `/api/health` returned 200 for
 * 20 hours through a total chat + generation outage. It was not lying: it
 * queried Postgres and Postgres was fine. It was INCOMPLETE — it only ever
 * checked what somebody remembered to add. Every rule below follows from that.
 *
 *   Rule 1  — any declared dependency unreachable ⇒ `down` ⇒ HTTP 503.
 *             There is no `degraded`. Two states, and that is the whole point:
 *             a state that reports 200 while a core capability is dead is the
 *             20-hour outage in a softer form.
 *   Rule 1a — `ai-service` is REQUIRED for every consuming product. Chat is a
 *             consuming product, so it is declared unconditionally here.
 *   Rule 2  — liveness (`/api/health`) must NEVER check dependencies; readiness
 *             (`/api/health/ready`) checks all of them. Do not merge them, and
 *             do not wire this route to a restart policy or a load balancer
 *             without making the cascading-failure trade explicitly.
 *   Rule 4b — probe a dependency by DOING the thing you need it to do, never by
 *             asking it how it feels. RustFS answers 200 on its own
 *             `/health/ready` (`"storage":{"ready":true}`, measured) while every
 *             S3 call against it 503s.
 *   Rule 4c — a dependency is `down` only after 2 CONSECUTIVE failed probes,
 *             and the result is cached 5s. Accepted cost, written down so nobody
 *             "fixes" it: during the 1-of-2 window the body carries an `error`
 *             while `status` is still `ok`. Monitors must treat a populated
 *             `error` as a signal even when `status` is `ok`. Do NOT add a third
 *             status to model the in-between — that undoes Rule 1.
 *   Rule 5  — probes stay cheap and bounded: `select 1`, `/health/ready`.
 *             🔴 Never an LLM call, an embedding or an extraction, and never a
 *             `/v1/*` route (it burns the 100/min rate-limit budget, which is
 *             keyed by API key).
 *
 * 🔴 REDACTION. This route is unauthenticated. The body carries a FIXED
 *    vocabulary only (see `ErrorCode`); the full error goes to `console.error`
 *    and nowhere else. A sibling product shipped `err.message` here, and Postgres
 *    emits `password authentication failed for user "…"`.
 *
 * 📝 Keeping the machinery here and the route thin means extracting it into a
 *    shared package later is a swap, not a redesign.
 */

/** The two states. There is no third one — see Rule 1. */
export type CheckStatus = 'ok' | 'down'

/**
 * 🔴 The complete, CLOSED vocabulary that may appear in the response body.
 *
 * Anything not on this list is `unknown`. Nothing derived from an error message,
 * a connection string, a hostname or a dependency's response body may ever be
 * added — `http_<code>` is the only generated member and its input is validated
 * to be an integer HTTP status.
 */
export type ErrorCode =
  | 'ECONNREFUSED'
  | 'timeout'
  | 'unreachable'
  | 'not_configured'
  | 'unknown'
  | `http_${number}`

export interface CheckResult {
  status: CheckStatus
  /** Probe latency, so a SLOW dependency is visible before it is an unreachable one. */
  ms: number
  /** Redacted, fixed-vocabulary reason. Present on failure — including the 1-of-2 window. */
  error?: ErrorCode
}

export interface ReadinessReport {
  status: CheckStatus
  checks: Record<string, CheckResult>
}

/** A probe resolves when the dependency demonstrably works, and throws otherwise. */
export interface Dependency {
  name: string
  probe: () => Promise<void>
}

/** Rule 4c: cache the result so a 5s container probe and a 5min monitor do not multiply load. */
export const CACHE_TTL_MS = 5_000
/** Rule 4c: one dropped packet must not page anybody. */
export const DOWN_AFTER_CONSECUTIVE_FAILURES = 2
/** Rule 5: every probe is bounded, so readiness can never hang. */
export const PROBE_TIMEOUT_MS = 3_000

/**
 * Marker for "the dependency answered, but with a failing HTTP status".
 * Carries the status CODE only — never the response body.
 */
class HttpStatusError extends Error {
  httpStatus: number

  constructor(httpStatus: number) {
    super(`http_${httpStatus}`)
    this.name = 'HttpStatusError'
    this.httpStatus = httpStatus
  }
}

/** Marker for a REQUIRED dependency that is not configured at all. */
class NotConfiguredError extends Error {
  constructor(what: string) {
    super(`${what} is not configured`)
    this.name = 'NotConfiguredError'
  }
}

/** Marker for a probe that blew its own deadline. */
class ProbeTimeoutError extends Error {
  constructor() {
    super('probe timed out')
    this.name = 'ProbeTimeoutError'
  }
}

const REFUSED_CODES = new Set(['ECONNREFUSED', 'UND_ERR_SOCKET'])
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ETIME', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'])
const UNREACHABLE_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ECONNRESET',
  'EPIPE',
  'EHOSTDOWN',
])

/**
 * Map ANY thrown value onto the closed vocabulary.
 *
 * 🔴 This function is the redaction boundary. It reads only structured, non-free-text
 * fields (`name`, `code`, numeric HTTP status) and returns only constants. It must
 * never return, embed or interpolate `err.message`.
 */
export function classifyError(err: unknown, depth = 0): ErrorCode {
  if (depth > 3 || err === null || typeof err !== 'object') return 'unknown'

  const e = err as { name?: unknown; code?: unknown; httpStatus?: unknown; cause?: unknown }

  if (err instanceof HttpStatusError) return httpCode(err.httpStatus)
  if (err instanceof NotConfiguredError) return 'not_configured'
  if (err instanceof ProbeTimeoutError) return 'timeout'

  const name = typeof e.name === 'string' ? e.name : ''
  if (name === 'AbortError' || name === 'TimeoutError') return 'timeout'

  const code = typeof e.code === 'string' ? e.code : ''
  if (REFUSED_CODES.has(code)) return 'ECONNREFUSED'
  if (TIMEOUT_CODES.has(code)) return 'timeout'
  if (UNREACHABLE_CODES.has(code)) return 'unreachable'

  // undici wraps the real socket error: `TypeError: fetch failed` with `.cause`.
  if (e.cause !== undefined && e.cause !== null) {
    const fromCause = classifyError(e.cause, depth + 1)
    if (fromCause !== 'unknown') return fromCause
  }

  // Everything else — notably Postgres SQLSTATE errors such as 28P01, whose
  // message is `password authentication failed for user "chat"` — is `unknown`.
  // The real error is logged; it is never returned.
  return 'unknown'
}

function httpCode(status: number): ErrorCode {
  if (!Number.isInteger(status) || status < 100 || status > 599) return 'unknown'
  return `http_${status}`
}

/** Bound any promise. The underlying work may continue; the probe does not wait for it. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ProbeTimeoutError()), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// The probes
// ---------------------------------------------------------------------------

/**
 * database — a real `select 1` on the raw pg pool Payload already owns.
 *
 * ⚠ NOT `payload.find({ collection: 'users', limit: 0 })`. Payload's drizzle
 *   adapter treats `limit: 0` as NO LIMIT, so that SELECTs every row at depth 2
 *   on the probe interval, forever. That exact bug has shipped in this lineage
 *   before. `payload.count()` is the acceptable fallback; the raw pool is cheaper
 *   and is what actually proves the connection works.
 */
export async function probeDatabase(): Promise<void> {
  const { getPayload } = await import('payload')
  const { default: config } = await import('@payload-config')
  const payload = await getPayload({ config })
  const pool = (payload.db as unknown as { pool?: { query: (sql: string) => Promise<unknown> } }).pool
  if (!pool) {
    // No pool means no postgres adapter — the product cannot do its job.
    throw new NotConfiguredError('postgres pool')
  }
  await pool.query('select 1')
}

/**
 * ai-service — REQUIRED (Rule 1a: "ai-service is crucial for all our services").
 *
 * ⚠ Probe `/health/ready` and ONLY that:
 *     - `/health` is two literal constants and proves nothing (Rule 4b).
 *     - any `/v1/*` route consumes the rate-limit budget (100/min, keyed by API
 *       key); `/health/ready` sits OUTSIDE the limiter, and runs `select 1` plus
 *       a Redis `PING` on the far side — a real use-probe.
 *
 * Unauthenticated on purpose: the route is outside the limiter and needs no key,
 * so the probe never spends budget and never risks leaking one.
 */
export async function probeAiService(baseUrl = process.env.AI_SERVICE_URL): Promise<void> {
  if (!baseUrl) {
    // Rule 1a + Rule 1: a REQUIRED dependency that is not configured is not
    // reachable, and the product is `down`. This is deliberately strict — the
    // contract explicitly rejects "survivable but degraded" for ai-service.
    throw new NotConfiguredError('AI_SERVICE_URL')
  }
  const url = `${baseUrl.replace(/\/+$/, '')}/health/ready`
  const res = await fetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    headers: { accept: 'application/json' },
    cache: 'no-store',
  })
  // 🔴 The body is never read into our response — only the status code is used.
  await res.body?.cancel().catch(() => {})
  if (!res.ok) throw new HttpStatusError(res.status)
}

/**
 * Rule 4 — the checks list is DERIVED from what the service actually wires up,
 * not hand-maintained. A hand-written list is correct exactly until the next
 * dependency is added and nobody updates it, which is the original bug.
 *
 * This backend wires exactly two:
 *   - postgres via `DATABASE_URI` (`src/payload.config.ts`) — always required.
 *   - ai-service via `AI_SERVICE_URL` (`src/lib/aiClient.ts`) — always required
 *     under Rule 1a, declared even when unset so a LOST env var reports `down`
 *     rather than silently disappearing from `checks`.
 *
 * ⚠ There is NO object storage here: no `@payloadcms/storage-s3`
 *   dependency and no `S3_*` env var is read anywhere in `src/` (verified by
 *   grep). So no `storage` check is emitted — emitting a hardcoded `ok` would be
 *   a fabricated green, which is the failure mode this contract exists to stop.
 *   If storage is ever configured, add it HERE, probed with `HeadBucket` on the
 *   real bucket (Rule 4b), and branch on `err.$metadata.httpStatusCode` — a
 *   `HeadBucket` 403 has no response body, so the SDK reports
 *   `err.name === 'Unknown'`.
 */
export function declaredDependencies(): Dependency[] {
  return [
    { name: 'database', probe: probeDatabase },
    { name: 'ai-service', probe: probeAiService },
  ]
}

// ---------------------------------------------------------------------------
// Rule 4c state: consecutive-failure tolerance + result cache
// ---------------------------------------------------------------------------

const consecutiveFailures = new Map<string, number>()
let cached: { at: number; report: ReadinessReport } | null = null
let inFlight: Promise<ReadinessReport> | null = null

/** Test-only: clear the failure counters, the cache and any in-flight probe. */
export function __resetReadinessStateForTests(): void {
  consecutiveFailures.clear()
  cached = null
  inFlight = null
}

async function runOne(dep: Dependency): Promise<CheckResult> {
  const started = Date.now()
  try {
    await withTimeout(dep.probe(), PROBE_TIMEOUT_MS)
    consecutiveFailures.set(dep.name, 0)
    return { status: 'ok', ms: Date.now() - started }
  } catch (err) {
    const ms = Date.now() - started
    const failures = (consecutiveFailures.get(dep.name) ?? 0) + 1
    consecutiveFailures.set(dep.name, failures)
    const error = classifyError(err)

    // 🔴 The ONLY place the real error is allowed to exist. Never the response.
    console.error(
      `[readiness] ${dep.name} probe failed (${failures}/${DOWN_AFTER_CONSECUTIVE_FAILURES}, ${ms}ms, reported as "${error}")`,
      err,
    )

    // Rule 4c: below the threshold the check still reports `ok`, but carries the
    // error so a monitor can see the flap. This window is a known, accepted cost.
    const status: CheckStatus = failures >= DOWN_AFTER_CONSECUTIVE_FAILURES ? 'down' : 'ok'
    return { status, ms, error }
  }
}

/**
 * Run every declared dependency and fold the results into the one fleet shape.
 *
 * Probes run in parallel: readiness latency is the slowest dependency, not their
 * sum, so a single slow dependency cannot push the route past a probe deadline.
 */
export async function probeAll(deps: Dependency[] = declaredDependencies()): Promise<ReadinessReport> {
  const results = await Promise.all(deps.map(async (dep) => [dep.name, await runOne(dep)] as const))
  const checks: Record<string, CheckResult> = {}
  for (const [name, result] of results) checks[name] = result
  // Rule 1: ANY check down ⇒ the service is down. No third state.
  const status: CheckStatus = results.some(([, r]) => r.status === 'down') ? 'down' : 'ok'
  return { status, checks }
}

/**
 * The route's entry point: cached (Rule 4c) and de-duplicated.
 *
 * De-duplication matters as much as the cache — a burst of concurrent requests
 * on a cold cache would otherwise fan out one probe each onto a shared
 * dependency that may already be the thing that is struggling.
 */
export async function getReadiness(deps?: Dependency[]): Promise<ReadinessReport> {
  const now = Date.now()
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.report
  if (inFlight) return inFlight

  inFlight = probeAll(deps)
    .then((report) => {
      cached = { at: Date.now(), report }
      return report
    })
    .finally(() => {
      inFlight = null
    })

  return inFlight
}

/** Rule 1: `down` ⇒ 503, `ok` ⇒ 200. */
export function httpStatusFor(report: ReadinessReport): number {
  return report.status === 'ok' ? 200 : 503
}
