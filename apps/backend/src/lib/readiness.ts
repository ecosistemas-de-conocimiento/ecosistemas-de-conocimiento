/**
 * Readiness probes for this backend.
 *
 * These rules exist because a `/api/health` can return 200 through a total chat
 * + generation outage. It is not lying: it queries Postgres and Postgres is
 * fine. It is INCOMPLETE — it only checks what somebody remembered to add.
 * Every rule below follows from that.
 *
 *   Rule 1  — any declared dependency unreachable ⇒ `down` ⇒ HTTP 503.
 *             There is no `degraded`. Two states, and that is the whole point:
 *             a state that reports 200 while a core capability is dead is that
 *             outage in a softer form.
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
 *    and nowhere else. `err.message` must not go here: Postgres
 *    emits `password authentication failed for user "…"`.
 *
 * 📝 Keeping the machinery here and the route thin means extracting it into a
 *    shared package later is a swap, not a redesign.
 */

// The ONLY static imports here, and deliberately leaves: `errorSummary` imports
// nothing, `storage/client` reads `process.env` and nothing else. The AWS SDK
// stays behind a dynamic import inside `getBucketOps`, so a local-disk boot
// never loads it.
import { safeErrMessage } from './errorSummary'
import { isStorageConfigured } from './storage/client'

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

  /**
   * AWS SDK errors carry the status on `$metadata`, never on `httpStatus`.
   *
   * 🔴 This branch reads a NUMBER out of a structured field and passes it
   * through `httpCode`, which validates it is an integer 100–599. No string
   * from the SDK — not `err.name`, not `err.message`, not the response body —
   * is ever read here, so the redaction boundary holds. It matters because a
   * `HeadBucket` failure is only distinguishable by status: 403 (forbidden or
   * absent — the store will not say which), 404 (absent), 503 (storage layer
   * down while the control plane is up, which is RustFS's signature failure).
   */
  const metaStatus = (e as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode
  if (typeof metaStatus === 'number') {
    const fromMetadata = httpCode(metaStatus)
    // Fall through to `.cause` on a nonsense status rather than reporting
    // `unknown` for an error whose real reason is one level down.
    if (fromMetadata !== 'unknown') return fromMetadata
  }

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
 *   on the probe interval, forever. `payload.count()` is the acceptable
 *   fallback; the raw pool is cheaper
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
 * storage — object storage, probed with a REAL S3 CALL.
 *
 * 🔴 WHY THIS DOES NOT CALL RUSTFS'S OWN `/health` OR `/health/ready`.
 * Measured by the user against `rustfs/rustfs:1.0.0-rc.1`: both endpoints
 * answer 200 — `/health/ready` reporting `"storage":{"ready":true}` — WHILE
 * EVERY S3 CALL AGAINST THE SAME PROCESS RETURNS 503. That is Rule 4b's whole
 * point, and it is worse because the endpoint has a reassuring name. So this probe
 * does the thing: one `HeadBucket` on the real bucket with the real app
 * credential. Rule 5 — bounded, cheap (~1ms), no data transferred, no
 * rate-limit budget spent.
 *
 * ⚠ THE 403 AMBIGUITY, AND WHICH WAY WE CHOSE. In the S3 API generally, a
 * `HeadBucket` 403 means either "this bucket is not yours" or "it does not
 * exist and you may not find out" — the two are deliberately not distinguished.
 *
 *   DECISION: a 403 is `down`. It is NOT treated as healthy, and it is NOT
 *   given its own fatal path distinct from any other failure.
 *
 *   WHY: both readings mean the same operational thing — THIS APP CANNOT SERVE
 *   OR STORE FILES with the credential it has. Reporting `ok` on a 403 would be
 *   a fabricated green of exactly the kind Rule 1 exists to prevent.
 *
 * ✅ MEASURED against `rustfs/rustfs:1.0.0-rc.1`, and better than the general
 * case: this build DOES separate the two, so the reported code is actionable
 * and each code has ONE operator action.
 *
 *   `http_404` — the bucket is genuinely absent. RustFS answers 404 (not 403)
 *                for a missing bucket, with `err.name === 'NotFound'`.
 *                → PROVISIONING HAS NOT RUN. `pnpm provision:storage`.
 *   `http_403` — the credential or its policy is wrong. Measured with a bogus
 *                key: 403, and `err.name` is the useless `'Unknown'` because a
 *                HEAD carries no body to parse a code out of. This is also what
 *                a wiped IAM volume looks like.
 *                → RE-CREATE THE CREDENTIAL. A restart will not help.
 *   `http_503` — storage layer down under a healthy control plane. RustFS's
 *                signature failure, and the reason this probe exists.
 *                → WAIT OR RESTART THE STORE.
 *
 * 🔴 Do NOT collapse 403 and 404 into one message. They are different fixes,
 * and only the status code carries the difference — never `err.name`.
 *
 * ⚠ Undeclared when unset ⇒ the check is OMITTED, not reported healthy. With no
 * `S3_ENDPOINT` this process stores files on local disk and there is no object
 * storage that could be down; emitting `storage: {status:'ok'}` would let a
 * monitor assert on a dependency the environment does not have.
 */
export async function probeStorage(): Promise<void> {
  const { getBucketOps, getStorageBucket } = await import('./storage/client')
  const ops = await getBucketOps()
  await ops.headBucket(getStorageBucket())
}

/**
 * Rule 4 — the checks list is DERIVED from what the service actually wires up,
 * not hand-maintained. A hand-written list is correct exactly until the next
 * dependency is added and nobody updates it, which is the original bug.
 *
 * This backend wires three:
 *   - postgres via `DATABASE_URI` (`src/payload.config.ts`) — always required.
 *   - ai-service via `AI_SERVICE_URL` (`src/lib/aiClient.ts`) — always required
 *     under Rule 1a, declared even when unset so a LOST env var reports `down`
 *     rather than silently disappearing from `checks`.
 *   - storage via `S3_*` (`src/lib/storage/`) — declared ONLY when configured,
 *     because "not configured" here is a real supported mode (local disk), not
 *     a lost variable. Contrast ai-service above: there, unset is a fault.
 */
export function declaredDependencies(): Dependency[] {
  const deps: Dependency[] = [
    { name: 'database', probe: probeDatabase },
    { name: 'ai-service', probe: probeAiService },
  ]
  // Read through the storage module so there is exactly one definition of
  // "configured", shared with the plugin wiring and the boot log.
  if (isStorageConfigured()) deps.push({ name: 'storage', probe: probeStorage })
  return deps
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
    const code = classifyError(err)

    // 🔴 The ONLY place the real error is allowed to exist. Never the response.
    console.error(
      `[readiness] ${dep.name} probe failed (${failures}/${DOWN_AFTER_CONSECUTIVE_FAILURES}, ${ms}ms, reported as "${code}")`,
      safeErrMessage(err),
    )

    // Rule 4c: below the threshold the check still reports `ok`, but carries the
    // error so a monitor can see the flap. This window is a known, accepted cost.
    const status: CheckStatus = failures >= DOWN_AFTER_CONSECUTIVE_FAILURES ? 'down' : 'ok'
    return { status, ms, error: code }
  }
}

/**
 * Run every declared dependency and fold the results into the one report shape.
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
