/**
 * RATE LIMITING for the endpoints that hand out credentials or read the grant map.
 *
 * ⚠ WHICH STORE IS RUNNING DECIDES WHETHER THESE LIMITS HOLD ACROSS REPLICAS.
 *
 * The store below (`InProcessSlidingWindowStore`) keeps counters in THIS Node
 * process's heap. Two containers behind one load balancer therefore allow up to
 * 2× every limit below, N containers allow N×, and a deploy resets every
 * counter to zero. It is the default, and it is correct at exactly one replica.
 *
 * THE SEAM: {@link RateLimitStore}. It is the whole abstraction — one method,
 * allowed to return a promise precisely so a networked store can slot in.
 *
 * ⚠ IT IS CURRENTLY UNFILLED, DELIBERATELY. This app is one backend. Until
 * it runs more than one replica the in-process counters are
 * the honest implementation, and the seam below means adding a shared store
 * later is one new file plus one `setRateLimitStore` call at boot — not a
 * refactor.
 *
 * ⚠ SO: N replicas allow N× every limit published below. If this app is ever
 * scaled horizontally, either implement the seam or treat these numbers as
 * per-replica. Do not assume they are global.
 *
 * WHAT THIS DOES AND DOES NOT PROTECT
 *   Does:      credential amplification (one stolen session → unlimited tokens),
 *              service-token brute force, grant-map enumeration.
 *   Does NOT:  volumetric DoS. A request has to reach this code to be counted,
 *              so raw flood protection belongs at the reverse proxy, not here.
 *
 * FAIL CLOSED. If the store throws, the request is DENIED, not allowed. A
 * limiter that fails open is decoration. See {@link checkRateLimits}.
 *
 * ⚠ A future networked store must NOT rely on that catch as its failure policy.
 * Denying every login because a cache blipped turns a dependency hiccup into an
 * auth outage; such a store should degrade to the in-process one first and let
 * this catch be the last resort it is.
 */

/** Every limit in this app uses a one-minute window, except failed logins (below). */
export const RATE_LIMIT_WINDOW_MS = 60_000

/**
 * The per-IP ceiling on failed logins is counted over an hour: Payload's lockout
 * runs on a 10-minute clock (5 failures lock an account for 10 minutes; quoted,
 * `payload/dist/collections/config/defaults.js`, Payload 3.88), and a one-minute
 * window cannot see an attacker who needs only 5 tries every 10 minutes. The
 * per-(IP, email) bucket has its own window, `rateLimits.loginFailPerIpEmailWindowMs`.
 */
export const LOGIN_FAIL_WINDOW_MS = 60 * 60_000

/** Answer for one bucket. `resetAt` is epoch ms. */
export interface RateLimitDecision {
  allowed: boolean
  limit: number
  /** Requests still available in the current window. 0 when denied. */
  remaining: number
  /** Epoch ms at which the oldest counted hit falls out of the window. */
  resetAt: number
  /** What to put in `Retry-After`. Always ≥1 when denied, 0 when allowed. */
  retryAfterSeconds: number
}

/**
 * The replaceable counter backend — the seam a shared store slots into.
 *
 * `hit` must be atomic per key: count this request and answer whether it is
 * within `limit` over the trailing `windowMs`. It may return a promise, so a
 * Redis- or Postgres-backed implementation needs no other change in this app.
 */
export interface RateLimitStore {
  hit(key: string, limit: number, windowMs: number): RateLimitDecision | Promise<RateLimitDecision>
  /**
   * Give back the most recent counted hit on this key. For a bucket that counts
   * only some outcomes (failed logins): `hit` reserves the slot BEFORE the
   * outcome is known, so concurrent requests cannot all pass a check that has
   * not counted any of them yet, and `release` returns it once the outcome turns
   * out not to count. See {@link reserveRateLimits}.
   */
  release(key: string): void | Promise<void>
  /** Drop all counters. Tests, and nothing else. */
  reset(): void
}

// --- the default, in-process store -------------------------------------------

/**
 * Keys are dropped once untouched for this long, or for their own window if
 * that is longer (the login-failure bucket keeps an hour). Evicting a bucket
 * before its window ends hands its owner a fresh budget.
 */
const IDLE_KEY_TTL_MS = 10 * 60_000
/** How often the sweep runs in the normal case, at most. */
const SWEEP_INTERVAL_MS = 30_000
/**
 * Minimum gap between sweeps when the map is over its cap.
 *
 * ⚠ THIS EXISTS TO STOP THE DEFENCE BECOMING THE ATTACK. Without it, "sweep
 * whenever we are over the cap" means a full scan (and a sort) on EVERY
 * request for as long as the map stays full — measured at 1.5-9.5ms per
 * request at 50k keys, which is synchronous work on Node's single thread and
 * would cap the whole IdP at ~100 req/s. Bounding the sweep to once a second
 * bounds that cost to roughly 1% of one core no matter how hard it is pushed.
 */
const OVER_CAP_SWEEP_MIN_MS = 1_000
/**
 * Hard ceiling on tracked keys, so a flood of distinct keys (spoofed
 * `X-Forwarded-For`, say) cannot exhaust memory. ~20MB at this size.
 *
 * ⚠ Reaching it evicts live buckets, which hands their owners fresh budget, so
 * one caller must not be able to reach it alone. The login buckets see to that
 * for themselves: one IP holds at most its per-IP ceiling of (IP, email) keys,
 * because a refused request creates none and a refund deletes an emptied one
 * (see `loginRateLimit.ts`).
 */
const MAX_TRACKED_KEYS = 50_000
/**
 * Evict down to here, not merely to the cap. Landing exactly on the cap leaves
 * the map instantly over it again on the next insert, which re-triggers the
 * sweep forever; the 10% headroom means an eviction pass actually buys quiet.
 */
const EVICTION_TARGET_KEYS = Math.floor(MAX_TRACKED_KEYS * 0.9)

/** One key's state. `lastSeen` is separate from `hits` on purpose — see `hit()`. */
type Bucket = {
  /** Timestamps of ALLOWED requests inside the window. Denied ones are not here. */
  hits: number[]
  /** Last time this key was touched AT ALL, allowed or denied. Eviction order. */
  lastSeen: number
  /** The window this key is counted over; it is never evicted sooner. */
  windowMs: number
}

/**
 * Sliding window over a log of hit timestamps.
 *
 * Chosen over a fixed window because a fixed window lets 2× the limit through
 * across a boundary — you get `limit` at 11:59:59 and `limit` again at
 * 12:00:00. Memory is bounded: at most `limit` timestamps per key, and `limit`
 * is at most a few hundred here.
 */
class InProcessSlidingWindowStore implements RateLimitStore {
  private buckets = new Map<string, Bucket>()
  private lastSweepAt = 0

  hit(key: string, limit: number, windowMs: number): RateLimitDecision {
    const now = Date.now()
    this.sweep(now)

    const cutoff = now - windowMs
    const previous = this.buckets.get(key)
    const recent = previous === undefined ? [] : previous.hits.filter((at) => at > cutoff)

    if (recent.length >= limit) {
      // Denied. Two separate decisions here, and they pull in opposite
      // directions, so both are explicit:
      //
      //   - The hit is NOT appended to `hits`. A client hammering a closed
      //     door must not push its own reset time further out on every
      //     attempt, which would let it lock itself out indefinitely.
      //   - `lastSeen` IS updated. Eviction (below) orders by `lastSeen`, and
      //     if denied requests did not refresh it, an active abuser's bucket
      //     would look idle, be evicted first, and come back empty — handing
      //     them a fresh budget for spraying keys. Tracking "touched" apart
      //     from "counted" is what makes the eviction comment true.
      this.buckets.set(key, { hits: recent, lastSeen: now, windowMs })
      return denied(recent, limit, windowMs, now)
    }

    recent.push(now)
    this.buckets.set(key, { hits: recent, lastSeen: now, windowMs })
    return {
      allowed: true,
      limit,
      remaining: limit - recent.length,
      resetAt: (recent[0] ?? now) + windowMs,
      retryAfterSeconds: 0,
    }
  }

  release(key: string): void {
    // `hits` is in time order, so the newest is last. It is the slot just
    // reserved, or one taken a moment later; either way the count drops by one.
    const bucket = this.buckets.get(key)
    if (!bucket) return
    bucket.hits.pop()
    // An empty bucket holds no budget, so it goes: a refunded attempt leaves
    // no key behind, and a stream of refunds cannot fill the map to its cap.
    if (bucket.hits.length === 0) this.buckets.delete(key)
  }

  reset(): void {
    this.buckets.clear()
    this.lastSweepAt = 0
  }

  /**
   * Drop idle keys, and cap total keys. Amortised — never on every request,
   * even when full. See OVER_CAP_SWEEP_MIN_MS.
   */
  private sweep(now: number): void {
    const overCap = this.buckets.size > MAX_TRACKED_KEYS
    const minInterval = overCap ? OVER_CAP_SWEEP_MIN_MS : SWEEP_INTERVAL_MS
    if (now - this.lastSweepAt < minInterval) return
    this.lastSweepAt = now

    for (const [key, bucket] of this.buckets) {
      if (bucket.lastSeen <= now - Math.max(IDLE_KEY_TTL_MS, bucket.windowMs)) this.buckets.delete(key)
    }

    if (this.buckets.size <= MAX_TRACKED_KEYS) return

    // Still over the cap: evict least-recently-TOUCHED first. Because
    // `lastSeen` counts denied requests too, the keys evicted here are the
    // ones nobody is currently hitting — an active abuser sorts to the end and
    // keeps their counter. Bounded to once a second by the guard above.
    const byRecency = [...this.buckets.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)
    const excess = this.buckets.size - EVICTION_TARGET_KEYS
    for (let i = 0; i < excess; i += 1) {
      const entry = byRecency[i]
      if (entry) this.buckets.delete(entry[0])
    }
  }
}

function denied(recent: number[], limit: number, windowMs: number, now: number): RateLimitDecision {
  const resetAt = (recent[0] ?? now) + windowMs
  return {
    allowed: false,
    limit,
    remaining: 0,
    resetAt,
    retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
  }
}

/**
 * A fresh in-process store.
 *
 * Exported because it is no longer only "the default": it is also the FALLBACK
 * the Redis store degrades to when Redis is unreachable (see
 * `rateLimit.redis.ts`). The class itself stays private — callers get an
 * instance, not a subclassable type, so the sliding-window guarantees above
 * cannot be partly overridden.
 */
export function createInProcessRateLimitStore(): RateLimitStore {
  return new InProcessSlidingWindowStore()
}

/**
 * ⚠⚠ THE INSTALLED STORE LIVES ON `globalThis`, NOT IN A MODULE VARIABLE. ⚠⚠
 *
 * This is not cargo cult. It was MEASURED, and a plain `let store` is
 * broken here in a way that is completely silent.
 *
 * Next evaluates this module MORE THAN ONCE in a single process — an
 * `instrumentation.ts` bundle and the route-handler bundle get separate module
 * instances. A dev-server run with a probe in this file logged four distinct
 * instances: a boot hook called `setRateLimitStore` on one, and every request
 * went through a different one that still held the in-process default. The
 * installed store was constructed, connected, logged "installed", and then
 * served exactly zero requests. Every test passed. Nothing in the logs said the
 * feature was inert.
 *
 * A `Symbol.for` slot on `globalThis` is the fix, because the global symbol
 * registry is per PROCESS, not per module instance — so whichever instance
 * installs a store, every instance sees it. It also survives dev HMR, which
 * re-evaluates this module and would otherwise silently reset the limiter's
 * counters on every code change.
 *
 * ⚠ This matters EVEN WITH ONLY THE BUILT-IN STORE: the default is created
 * lazily INTO the slot rather than eagerly per instance, so the in-process store
 * is one shared object. Otherwise four module instances would mean four sets of
 * counters in one process — the same "N× the published limit" bug, at a smaller
 * scale.
 */
const STORE_SLOT = Symbol.for('edc.backend.rateLimit.store')

const globalSlot = globalThis as unknown as { [STORE_SLOT]?: RateLimitStore }

/** The one store this PROCESS uses, whichever module instance is asking. */
function currentStore(): RateLimitStore {
  const existing = globalSlot[STORE_SLOT]
  if (existing !== undefined) return existing
  const created = createInProcessRateLimitStore()
  globalSlot[STORE_SLOT] = created
  return created
}

/** Install a different backend — the shared-store seam. Call once, at boot. */
export function setRateLimitStore(next: RateLimitStore): void {
  globalSlot[STORE_SLOT] = next
}

/** Restore the built-in in-process store. Tests. */
export function useDefaultRateLimitStore(): void {
  globalSlot[STORE_SLOT] = createInProcessRateLimitStore()
}

/** Drop every counter. Tests. */
export function resetRateLimits(): void {
  currentStore().reset()
}

// --- limits, and where they come from ----------------------------------------

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (typeof raw !== 'string' || raw.trim() === '') return fallback
  const parsed = Number.parseInt(raw.trim(), 10)
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  return parsed
}

/**
 * Every limit is per 60 seconds (failed logins have their own windows), and
 * every one is env-tunable so ops can raise a ceiling without a deploy of new
 * code. Read at call time, never memoised.
 *
 * The numbers, and why they are these numbers:
 *
 * `tokenPerUser` 30 — a token lives ≤900s, so a well-behaved client mints
 *   ~4/hour per organization. Even a renew-at-half-life loop with several
 *   organizations open is under 1/min. 30/min is ~100× normal use and still
 *   turns "unlimited tokens from one stolen cookie" into "30 tokens a minute,
 *   and a visible spike".
 *
 * `tokenPerIp` 120 — the floor, catching one host working through several
 *   stolen sessions. Four users at their full personal limit.
 *   ⚠ If a whole team sits behind one NAT and trips this, raise it; a shared
 *   egress IP is the one false positive this bucket can produce.
 *
 * `mePerUser` 60 — `/me` mints nothing, but it resolves EVERY organization for
 *   the caller (the most DB work per request in the app) off the same session
 *   cookie as `/token`. Limiting `/token` and leaving its sibling open would be
 *   a hole. Generous, because a front-end may legitimately poll it.
 *
 * `mePerIp` 240 — the matching floor, so N stolen sessions from one host do not
 *   multiply into 60N/min against the heaviest read in the app. Four users'
 *   worth, the same ratio `tokenPerIp` uses.
 *
 * `resolvePerConsumer` 600 — service-to-service, 10/s sustained per consumer.
 *   A service calls it on request paths that hold an email but no session, so it
 *   has to absorb real traffic. It still caps how fast one leaked service token
 *   can enumerate the grant map.
 *
 * `serviceAuthFailurePerIp` 20 — the brute-force gate. Only REJECTED service
 *   tokens count, so a correctly configured consumer never touches this bucket
 *   no matter how much traffic it sends. 20 wrong guesses a minute per IP makes
 *   guessing a secret hopeless while still letting a misconfigured consumer
 *   fail loudly rather than silently.
 */
export const rateLimits = {
  tokenPerUser: (): number => envInt('IDENTITY_RATELIMIT_TOKEN_USER_MAX', 30),
  tokenPerIp: (): number => envInt('IDENTITY_RATELIMIT_TOKEN_IP_MAX', 120),
  mePerUser: (): number => envInt('IDENTITY_RATELIMIT_ME_USER_MAX', 60),
  mePerIp: (): number => envInt('IDENTITY_RATELIMIT_ME_IP_MAX', 240),
  resolvePerConsumer: (): number => envInt('IDENTITY_RATELIMIT_RESOLVE_CONSUMER_MAX', 600),
  serviceAuthFailurePerIp: (): number =>
    envInt('IDENTITY_RATELIMIT_SERVICE_AUTH_FAIL_IP_MAX', 20),

  /**
   * Failed `POST /api/users/login` for one email from one client IP (A-11).
   * The email is trimmed and lowercased, as Payload does before its lookup.
   *
   * 4, one below Payload's 5-try lockout (quoted above), so within one window
   * a single IP cannot move that account's counter to the lock. Other people
   * behind the same NAT, signing in to other accounts, share nothing with it.
   *
   * ⚠ Payload's `loginAttempts` does not decay with time: only a successful
   * sign-in (back to 0) or an expired lock (back to 1) resets it (measured,
   * `payload/dist/auth/strategies/local/incrementLoginAttempts.js`, 3.88). So
   * once this window rolls over, one IP can add 4 more and reach the lock. At
   * 10 minutes that was a lock roughly every other 10 minutes against an account
   * nobody signs in to; at an hour, one 10-minute lock an hour (both inferred
   * from that code, not measured). The price: a person who mistyped their own
   * password 4 times waits up to an hour on that connection.
   */
  loginFailPerIpEmail: (): number => envInt('IDENTITY_RATELIMIT_LOGIN_FAIL_IP_EMAIL_MAX', 4),
  /** 3600 s: see the ⚠ above (the counter does not decay, so 600 s let one IP lock half the time). */
  loginFailPerIpEmailWindowMs: (): number =>
    envInt('IDENTITY_RATELIMIT_LOGIN_FAIL_IP_EMAIL_WINDOW_S', 3600) * 1000,

  /**
   * Failed `POST /api/users/login` per client IP across EVERY email, per HOUR
   * ({@link LOGIN_FAIL_WINDOW_MS}). It throttles password spraying from one
   * address; the per-(IP, email) bucket above is what protects one account.
   *
   * 100, set far above what a room of real people produces: a workshop of 30
   * where everyone mistypes 3 times an hour spends 90 (inferred, not measured).
   * ⚠ A shared egress IP still shares it; raise it for a bigger room.
   */
  loginFailPerIp: (): number => envInt('IDENTITY_RATELIMIT_LOGIN_FAIL_IP_MAX', 100),

  // --- corpus graph ----------------------------------------------------------
  //
  // 🔴 PER-USER AND PER-ORGANIZATION ONLY. THERE IS DELIBERATELY NO PER-IP
  // BUCKET, and adding one "for consistency with the identity routes" would be
  // a self-inflicted outage.
  //
  // Every graph request arrives from the WEB BFF, not from a browser. Until
  // 2026-11-10 the BFF forwarded no client IP, so `clientIp(req)` was the
  // literal `'unknown'` for EVERY caller and a per-IP bucket would have been
  // ONE GLOBAL BUCKET shared by every user of every ecosistema.
  //
  // `backendFetch` now forwards the browser's IP as `X-Forwarded-For` (see
  // `apps/web/src/lib/server/clientIp.ts`), so a per-IP bucket here would be
  // keyed correctly. It is still not added: the user bucket identifies the
  // caller, and the org bucket bounds the aggregate SQL cost for one tenant.

  /** Browsing the graph: lists, then a node, then another node. */
  graphViewPerUser: (): number => envInt('GRAPH_RATELIMIT_VIEW_USER_MAX', 120),

  /**
   * The GraphRAG leg, which runs on EVERY chat turn.
   *
   * ⚠ Set generously on purpose. This is not a spam surface — it is the normal
   * path of a conversation, and a limit tight enough to be "safe" would show up
   * as answers that silently lose their graph context (the fallback is silent by
   * design, ADR §8.2). 60/min is already far past human conversation speed, and
   * the generation the turn goes on to do is both slower and separately capped
   * by ai-service.
   */
  graphRetrievePerUser: (): number => envInt('GRAPH_RATELIMIT_RETRIEVE_USER_MAX', 60),

  /**
   * A ceiling for one ecosistema across all its members.
   *
   * This is the bucket that actually bounds cost: the reads are aggregate
   * `GROUP BY … HAVING` over one tenant's rows, so the thing worth limiting is
   * total work per tenant, not per person. Generous enough that a whole team
   * browsing at once never notices it.
   */
  graphPerOrganization: (): number => envInt('GRAPH_RATELIMIT_ORG_MAX', 600),
}

// --- checking ----------------------------------------------------------------

export interface RateLimitRule {
  /**
   * Short label for logs and the 429 message, e.g. `token:user`. It names the
   * BUCKET KIND, never the value — an email must not reach a log line here.
   */
  scope: string
  /** The bucket. Namespace it with the scope so two kinds cannot collide. */
  key: string
  limit: number
  windowMs?: number
}

export interface RateLimitVerdict {
  allowed: boolean
  /** The rule that denied the request, when one did. */
  rule: RateLimitRule | null
  decision: RateLimitDecision | null
}

const ALLOWED: RateLimitVerdict = { allowed: true, rule: null, decision: null }

/** A verdict that holds its slots. `release` gives them back; a second call does nothing. */
export interface RateLimitReservation extends RateLimitVerdict {
  release(): Promise<void>
}

const NOTHING_HELD = async (): Promise<void> => {}

/**
 * Count the request against every rule NOW, before the outcome is known, and
 * hand back a way to un-count it. For buckets that should count only some
 * outcomes (failed logins): reserve, do the work, `release` when it did not
 * count. Checking first and counting after lets every concurrent request pass
 * the check before any of them is counted.
 *
 * Unlike {@link checkRateLimits}, a denial counts nothing: the rules already
 * hit are given back before it returns.
 *
 * ⚠ FAILS CLOSED, like `checkRateLimits`. A `release` that throws is logged and
 * the slot stays counted.
 */
export async function reserveRateLimits(rules: RateLimitRule[]): Promise<RateLimitReservation> {
  const held: RateLimitRule[] = []
  let done = false
  const release = async (): Promise<void> => {
    if (done) return
    done = true
    for (const rule of held) {
      try {
        await currentStore().release(rule.key)
      } catch (err) {
        console.error(`[identity/rateLimit] release failed on scope "${rule.scope}" — the slot stays counted:`, err)
      }
    }
  }
  for (const rule of rules) {
    const verdict = await checkRateLimits([rule])
    if (!verdict.allowed) {
      await release()
      return { ...verdict, release: NOTHING_HELD }
    }
    held.push(rule)
  }
  return { ...ALLOWED, release }
}

/**
 * Apply rules in order, counting each. The first denial wins and short-circuits.
 *
 * A rule earlier in the list has already counted the request when a later rule
 * denies it — a deliberate simplification. It can only over-count, never
 * under-count, so it never lets a request through that should have been held.
 *
 * ⚠ FAILS CLOSED. A store that throws produces a denial, not a pass.
 */
export async function checkRateLimits(rules: RateLimitRule[]): Promise<RateLimitVerdict> {
  for (const rule of rules) {
    const windowMs = rule.windowMs ?? RATE_LIMIT_WINDOW_MS
    let decision: RateLimitDecision
    try {
      decision = await currentStore().hit(rule.key, rule.limit, windowMs)
    } catch (err) {
      console.error(
        `[identity/rateLimit] store failed on scope "${rule.scope}" — DENYING the request (fail closed):`,
        err,
      )
      const resetAt = Date.now() + windowMs
      return {
        allowed: false,
        rule,
        decision: {
          allowed: false,
          limit: rule.limit,
          remaining: 0,
          resetAt,
          retryAfterSeconds: Math.ceil(windowMs / 1000),
        },
      }
    }
    if (!decision.allowed) return { allowed: false, rule, decision }
  }
  return ALLOWED
}
