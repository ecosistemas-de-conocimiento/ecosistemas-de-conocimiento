// Process-wide, 429-aware admission gate for `POST /v1/ingest`.
//
// ── WHY THIS LIVES IN THE CLIENT ────────────────────────────────────────────
// Packages hold MACHINERY, products hold CONTENT. So the gate lives here, below
// `IngestAPI.enqueue`, and every consumer inherits it.
//
// ── THE LIMIT IT RESPECTS ───────────────────────────────────────────────────
// ai-service rate-limits `/v1` per API key (`@fastify/rate-limit`, registered
// in `src/server.ts`). Read in `src/server-limits.ts`:
//
//     V1_DEFAULT_RATE_LIMIT_MAX = 100   // per minute, every /v1 route
//     GENERATE_RATE_LIMIT_MAX   = 30    // per minute, /v1/generate*,
//                                       // /v1/retrieve*, /v1/route ONLY
//     V1_RATE_LIMIT_WINDOW      = '1 minute'
//
// `POST /v1/ingest` declares NO `config.rateLimit` override — `routes/ingest.ts`
// sets only `bodyLimit` — so it lands on the **100/min** bucket, shared with
// `GET /v1/ingest/:id`, `/v1/corpora*`, `/v1/embed`, `/v1/budget` and the
// registry routes. A route-level override REPLACES the global for that route;
// it does not also consume it, so the 30/min figure is a separate bucket and is
// irrelevant here.
//
// Who shares the bucket: the limiter keys on `req.auth.apiKeyId`, which
// resolves from `sha256(rawKey)` in `plugins/auth.ts`. So the bucket is PER API
// KEY, not fleet-wide — one product's seed does not consume another's
// allowance. It IS one bucket for everything one key does. (Products still
// share ai-service's COMPUTE — one queue, one embedding worker, one database.
// That is a real reason not to fire everything at once; it is just not the
// limiter.) The limiter has no shared store, so it is also per ai-service
// PROCESS.
//
// ── WHY A GATE AND NOT A THROTTLE AT THE CALL SITE ──────────────────────────
// Per-call-site throttles DO NOT COMPOSE. Three callers each staying under the
// limit still add up to over it. Worse, a throttle shaped around BATCHES is
// defeated by a caller that hands over one document at a time: a measured
// production incident had 98.8% one-document calls sliding straight past a
// batch-of-40 throttle whose batch never filled and whose delay never fired.
//
// So this gate counts ADMISSIONS (HTTP requests), not documents, it lives below
// `IngestAPI`, and it is process-wide. One-document calls are bounded exactly
// as hard as hundred-document calls, which is the point.
//
// ── WHAT IT BOUNDS ──────────────────────────────────────────────────────────
//   1. RATE — a SLIDING window of admissions. Sliding, not fixed: ai-service's
//      window is fixed and unaligned with ours, so a fixed local window could
//      put 2x our budget inside one of theirs. A client paced at exactly the
//      server's rate still 429s, because we stamp on admission and the server
//      stamps on arrival. With a sliding window ANY `windowMs` interval
//      contains at most `maxPerWindow` of our requests, whatever the server's
//      boundaries are.
//   2. CONCURRENCY — a semaphore, so a bulk seed cannot fan out hundreds of
//      in-flight requests at once.
//   3. 429 — honoured from the SERVER'S OWN stated wait (see
//      `rateLimitRetryAfterMs`), shared process-wide as a COOLDOWN. The limiter
//      is keyed on one API key, so one 429 means every other in-flight call
//      would 429 too. Parking everyone on one clock beats each worker
//      discovering it alone. A retry ladder that gives up before the server's
//      stated wait elapses is a retry that is GUARANTEED to fail; both ported
//      implementations had shipped one.
//   4. ATTEMPTS *and* WALL CLOCK — a retry that never gives up is as bad as no
//      retry. Both are bounded; on exhaustion we throw
//      `IngestRateLimitExhaustedError`, which NAMES the corpus and every
//      document id that did not make it.
//   5. SHARE — bulk may never take the last `interactiveReserveShare` of a
//      window. Lanes alone only REORDER the queue; they cannot help an upload
//      that arrives after bulk has already spent the window. See the config
//      field for the measured incident.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
// 🔴 IT DOES NOT COALESCE single-document calls into batches. That would look
// like the obvious optimisation and it is a data-loss bug, measured in both
// consuming products: ingest callbacks are joined by `(ingestId, corpus)` and
// IGNORE the document id, while ai-service returns ONE `ingestId` per batch. So
// batching N documents into one call strands N-1 rows at `indexing` while all N
// callbacks report success. One consumer additionally binds a single version id
// into the callback URL, which cannot represent a batch at all.
//
// The prerequisite for safe batching is keying that callback join on the
// DOCUMENT id, not the ingest id. ai-service's per-document callbacks DO carry
// it (`docId` = the document's `id`, `src/workers/ingest.worker.ts`), so the
// gap is on the consumer side. Coalescing therefore stays OUT of this gate and
// out of `IngestAPI`, and lives in `IngestBatcher` (`./ingest-batcher.ts`),
// which a consumer opts into only once its callback join is per-document.
// `enqueueAll` chunks a caller's OWN large batch down to the schema cap, which
// is the opposite operation and is safe.
//
// 🔴 IT DOES NOT GATE `GET /v1/ingest/:id`. Status polls share the same 100/min
// bucket, which is exactly why `maxPerWindow` defaults to 40 rather than 100 —
// the 60% headroom is reserved for them, plus `/v1/corpora`, `/v1/budget` and
// the registry writes. Putting a latency-sensitive poll behind a 45-minute bulk
// queue would be worse than the problem.
//
// NO PRODUCT DOMAIN — this module is pure scheduling over an opaque `task`, so
// it is unit-testable with small numbers and real timers.

/**
 * The part of `IngestResult` this module needs. Declared structurally rather
 * than imported so the gate stays dependency-free and importable on its own.
 */
export interface IngestResultLike {
  ingestId: string;
}

/** Which queue a call joins. See `IngestGateConfig.deadlineMs`. */
export type IngestLane = 'interactive' | 'bulk';

/**
 * ai-service's `ingestRequestSchema` caps a batch at 100 documents
 * (`documents: z.array(...).min(1).max(100)`). Exported so a batching caller
 * chunks to it instead of discovering the 400 in production.
 */
export const MAX_DOCS_PER_INGEST_REQUEST = 100;

/**
 * Default wording when ingest is refused for load.
 *
 * Deliberately neutral English: this package is consumed by every product and a
 * user-facing sentence is CONTENT, not machinery. Consumers that surface this
 * string to a person MUST set `busyMessage` to their own copy, in their own
 * language, via `configureIngestGate`.
 */
export const DEFAULT_INGEST_BUSY_MESSAGE =
  'The AI service is busy right now. Please try again in a minute.';

/** Structured trace emitted by the gate. Wire it to your logger; see `logger`. */
export interface IngestGateEvent {
  event: 'rate-limited' | 'retry' | 'exhausted';
  corpus: string;
  documentIds: string[];
  lane: IngestLane;
  attempt: number;
  /** Wait the gate is about to observe, ms. Present on `rate-limited`/`retry`. */
  waitMs?: number;
  /** Why the gate gave up. Present on `exhausted`. */
  reason?: 'attempts' | 'deadline' | 'queue';
}

export interface IngestGateConfig {
  /** Max ingest requests in flight at once. */
  maxConcurrent: number;
  /** Max admissions inside any `windowMs` interval (sliding). */
  maxPerWindow: number;
  /**
   * Share of `maxPerWindow` that `bulk` may NEVER use, in `[0, 1)`. The last
   * `floor(maxPerWindow * interactiveReserveShare)` admissions of every window
   * belong to `interactive`; `interactive` itself may use the whole window.
   *
   * 🔴 Why a RESERVE and not just a priority. Priority only reorders the queue.
   * Once bulk has spent the window, an upload arriving next has nothing left to
   * jump ahead INTO — it waits for a stamp to age out, which under a saturating
   * bulk load is up to `windowMs`, far past `queueDeadlineMs.interactive`, and
   * fails with `reason: 'queue'`. A reserve keeps a slot open for it instead.
   *
   * Always leaves bulk at least one admission per window, so a reserve can slow
   * a seed but never wedge it.
   */
  interactiveReserveShare: number;
  /** Width of the sliding rate window, ms. */
  windowMs: number;
  /** Total tries per call, including the first. */
  maxAttempts: number;
  /**
   * RETRY budget, per lane: wall clock allowed from the FIRST attempt onwards.
   * Bounds how long we keep re-trying a server that is refusing us.
   */
  deadlineMs: Record<IngestLane, number>;
  /**
   * QUEUE budget, per lane: wall clock a call may wait for its FIRST slot.
   *
   * 🔴 Kept SEPARATE from `deadlineMs` on purpose, and both ported
   * implementations hit this the hard way. A seed enqueues hundreds of calls at
   * once, so the LAST one legitimately waits (queue depth / rate) before its
   * first attempt — ten minutes or more for a few hundred documents. Under one
   * shared budget that call fails with `reason: 'deadline'` having NEVER been
   * ATTEMPTED, which is the silent partial-seed failure this module exists to
   * prevent. Waiting your turn is not the same as losing a fight with a busy
   * server.
   */
  queueDeadlineMs: Record<IngestLane, number>;
  /** Never wait longer than this on a single server hint. */
  maxRetryAfterMs: number;
  /** Padding added to the server's hint, for clock skew. */
  retryAfterPaddingMs: number;
  /** Used when a 429 arrives with no usable hint. */
  fallbackRetryAfterMs: number;
  /**
   * `message` carried by `IngestRateLimitExhaustedError`. Set this if you
   * interpolate the error into a user-facing surface. See
   * `DEFAULT_INGEST_BUSY_MESSAGE`.
   */
  busyMessage: string;
  /**
   * Optional trace sink. A gate that parks for a minute in silence is
   * indistinguishable from a hang, so wiring this is strongly recommended.
   * Must never throw — the gate swallows anything it does.
   */
  logger?: (e: IngestGateEvent) => void;
}

/**
 * The shipped budget. Every number is justified against the limits read at the
 * top of this file, and deliberately leaves headroom rather than consuming the
 * whole allowance. Both ported implementations converged on these numbers
 * independently, which is the strongest evidence available that they are right.
 */
export const DEFAULT_INGEST_GATE_CONFIG: IngestGateConfig = {
  // 4 — ingest is an ENQUEUE (ai-service replies 202 after writing rows and
  // pushing to its queue), so concurrency only hides network latency; it does
  // not buy throughput. At 40/min the rate limiter binds at ~1 request / 1.5 s,
  // so more than a handful in flight is unreachable in steady state anyway. 4
  // is enough to keep the pipeline full when one request is slow.
  maxConcurrent: 4,

  // 40 of ai-service's 100/min — 40% of the bucket, 60% headroom. The headroom
  // is NOT spare: the same bucket carries `GET /v1/ingest/:id` status polls,
  // `/v1/embed`, `/v1/corpora*`, `/v1/budget` and the registry writes. A seed
  // that took the whole 100 would 429 its own status polls and every
  // interactive upload happening at the same time.
  //
  // Throughput sanity: 40 requests/min x up to 100 docs/request = 4 000
  // docs/min. Even the worst shape — one document per request, which is what
  // per-row hooks and upload routes do — clears 40 docs/min. A manual seed of a
  // few hundred rows finishes in minutes, which is the correct trade for never
  // failing.
  maxPerWindow: 40,
  windowMs: 60_000,

  // 25% -> 10 of the 40 admissions per window are interactive-only; bulk tops
  // out at 30/min. Sized against the measured failure it fixes: a consumer that
  // synced every edited row as its own bulk call (71 and 100 calls for one
  // bulk operation, measured with the AI stubbed -> a lower bound)
  // filled the window for minutes, and every user upload in that span failed after its 15 s
  // queue budget. 10/min of interactive headroom is far above one person's
  // upload rate, and the 25% it costs a seed is recovered many times over by
  // `IngestBatcher`, which turned those promotions into 3 calls each (same
  // measurement).
  interactiveReserveShare: 0.25,

  // 5 tries. Bounded because an unbounded retry turns a rate limit into a hang
  // and hides the failure; 5 covers a transient burst without pretending we can
  // outlast a genuinely saturated service.
  //
  // Sized against the REAL hint, not a guess: ai-service's `errorResponseBuilder`
  // answers `retryAfterMs: ctx.ttl`, up to a full 60 s window (an observed value
  // during a failed seed was 58 420 ms). Both retired ladders totalled ~15 s, so
  // they gave up ~44 s BEFORE the server would have accepted. 5 attempts against
  // a 59 s hint needs ~236 s, which is inside the 300 s bulk retry budget below.
  maxAttempts: 5,

  deadlineMs: {
    // 30 s — a person is holding an HTTP connection. ai-service's hint can be a
    // full 60 s window, so a long hint fails FAST here rather than parking the
    // request; the caller can stamp the row `failed` and keep its retry
    // affordance, which is a better experience than a minute of nothing.
    interactive: 30_000,
    // 5 min of RETRYING — roughly five full ai-service windows, comfortably more
    // than `maxAttempts` can use.
    bulk: 300_000,
  },

  queueDeadlineMs: {
    // 15 s — a person is waiting. If we cannot even start in 15 s, failing with
    // a "try again" beats holding the connection open.
    interactive: 15_000,
    // 45 min. Sized from measured seeds: a few hundred one-document calls at
    // 40/min is ~10-12 min for the last one, and 45 min is ~4x that headroom.
    // Still bounded, so a wedged gate surfaces as a loud failure rather than an
    // infinite wait, but it never fails a call that was merely queued behind a
    // legitimate seed.
    bulk: 2_700_000,
  },

  maxRetryAfterMs: 60_000,
  retryAfterPaddingMs: 250,
  fallbackRetryAfterMs: 5_000,
  busyMessage: DEFAULT_INGEST_BUSY_MESSAGE,
};

/** Everything needed to name what failed. */
export interface IngestCallMeta {
  corpus: string;
  documentIds: string[];
  lane?: IngestLane;
  /**
   * Abort while queued or between retries. Without this a cancelled HTTP
   * request keeps its place in the queue and burns a rate slot nobody wants.
   */
  signal?: AbortSignal;
}

/**
 * Thrown when a call ran out of attempts or wall clock against a rate limit.
 *
 * Carries the corpus and EVERY document id that did not make it, so a caller
 * can log exactly what remains un-ingested. A seed that silently half-finishes
 * is the failure mode this whole module exists to prevent — a batch index with
 * no ids is not good enough, because nothing can be re-driven from it.
 */
export class IngestRateLimitExhaustedError extends Error {
  readonly corpus: string;
  readonly documentIds: string[];
  readonly attempts: number;
  readonly waitedMs: number;
  readonly reason: 'attempts' | 'deadline' | 'queue';
  readonly lane: IngestLane;
  /** The last 429 we saw, when there was one. */
  readonly lastError?: unknown;
  /**
   * Batches that DID land before the failure, when this came out of a chunked
   * `enqueueAll`. Their `ingestId`s are live and their callbacks will still
   * arrive, so a caller must not treat the whole call as a no-op.
   */
  readonly partialResults?: IngestResultLike[];

  constructor(args: {
    corpus: string;
    documentIds: string[];
    attempts: number;
    waitedMs: number;
    reason: 'attempts' | 'deadline' | 'queue';
    lane: IngestLane;
    busyMessage?: string;
    lastError?: unknown;
    partialResults?: IngestResultLike[];
  }) {
    super(args.busyMessage ?? DEFAULT_INGEST_BUSY_MESSAGE);
    this.name = 'IngestRateLimitExhaustedError';
    this.corpus = args.corpus;
    this.documentIds = args.documentIds;
    this.attempts = args.attempts;
    this.waitedMs = args.waitedMs;
    this.reason = args.reason;
    this.lane = args.lane;
    this.lastError = args.lastError;
    this.partialResults = args.partialResults;
  }

  /** One-line, log-safe description naming what did not land. */
  describe(): string {
    const ids = this.documentIds.length > 0 ? this.documentIds.join(', ') : '(no document ids)';
    const landed =
      this.partialResults && this.partialResults.length > 0
        ? ` (${this.partialResults.length} earlier batch(es) DID land: ` +
          `${this.partialResults.map((r) => r.ingestId).join(', ')})`
        : '';
    return (
      `ingest gave up after ${this.attempts} attempt(s) / ${this.waitedMs}ms ` +
      `(${this.reason}, lane=${this.lane}); NOT ingested into ${this.corpus}: ${ids}${landed}`
    );
  }
}

/**
 * Thrown by `IngestAPI.enqueue` when a caller hands it more documents than
 * ai-service's schema accepts. Fails BEFORE the network call, so it costs no
 * rate slot and no round trip; the server would answer 400 for the same reason.
 * Use `IngestAPI.enqueueAll`, which chunks.
 */
export class IngestBatchTooLargeError extends Error {
  readonly corpus: string;
  readonly documentCount: number;
  readonly maxDocuments: number;
  constructor(corpus: string, documentCount: number) {
    super(
      `ai-service accepts at most ${MAX_DOCS_PER_INGEST_REQUEST} documents per ingest call; ` +
        `got ${documentCount} for corpus "${corpus}". Use client.ingest.enqueueAll() to chunk.`,
    );
    this.name = 'IngestBatchTooLargeError';
    this.corpus = corpus;
    this.documentCount = documentCount;
    this.maxDocuments = MAX_DOCS_PER_INGEST_REQUEST;
  }
}

/** Internal signal: the waiter's deadline passed before a slot opened. */
class DeadlinePassed extends Error {}
/** Internal signal: the caller's `AbortSignal` fired while queued. */
class Aborted extends Error {
  constructor(readonly reason: unknown) {
    super('ingest call aborted');
  }
}

/**
 * Extract a retry delay from an ai-service rate-limit refusal.
 *
 * ai-service puts the number the `Retry-After` header is derived from into the
 * JSON body at higher precision: `errorResponseBuilder` sets
 * `retryAfterMs: ctx.ttl`, and the header is `Math.ceil(ttl / 1000)`. So
 * honouring the body honours the header, with the rounding error removed.
 *
 * The header is now also reachable — `HttpClient.json()` used to throw
 * `errorFromResponse(status, body)` and DISCARD the `Response`, which is why
 * both ported implementations documented the header as unreachable and read the
 * body only. That is fixed in this package: `errorFromResponse` receives the
 * headers and `RateLimitError.retryAfterMs` is populated from either source.
 *
 * FIVE shapes are read, most precise first, so an error that has been re-thrown
 * as a plain `Error` somewhere in a consumer still yields a usable wait:
 *   1. `err.retryAfterMs`           — `RateLimitError` from this package.
 *   2. `err.body.retryAfterMs`      — any client that kept the parsed body.
 *   3. JSON embedded in the message — a raw-`fetch` wrapper's text.
 *   4. `"Retry after 59s."`         — ai-service's own wording.
 *   5. `fallbackRetryAfterMs`       — a 429 with no usable hint at all.
 *
 * @returns delay in ms, or `null` when this is not a rate-limit error at all.
 */
export function rateLimitRetryAfterMs(
  err: unknown,
  cfg: Pick<
    IngestGateConfig,
    'maxRetryAfterMs' | 'retryAfterPaddingMs' | 'fallbackRetryAfterMs'
  > = DEFAULT_INGEST_GATE_CONFIG,
): number | null {
  if (err == null || typeof err !== 'object') return null;
  const e = err as {
    status?: unknown;
    body?: unknown;
    message?: unknown;
    retryAfterMs?: unknown;
  };
  const message = typeof e.message === 'string' ? e.message : '';

  const isRateLimit =
    e.status === 429 ||
    (e.body as { error?: unknown } | undefined)?.error === 'RateLimitExceeded' ||
    /rate limit exceeded/i.test(message) ||
    // A refusal re-thrown as a plain Error by a raw-`fetch` wrapper, which has
    // lost `.status` but kept the wording.
    /\bHTTP 429\b/.test(message);
  if (!isRateLimit) return null;

  const clamp = (ms: number): number =>
    Math.min(Math.max(0, ms) + cfg.retryAfterPaddingMs, cfg.maxRetryAfterMs);

  const usable = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0;

  if (usable(e.retryAfterMs)) return clamp(e.retryAfterMs);

  const fromBody = (e.body as { retryAfterMs?: unknown } | undefined)?.retryAfterMs;
  if (usable(fromBody)) return clamp(fromBody);

  // `ai-service /v1/ingest -> HTTP 429: {"error":"RateLimitExceeded","retryAfterMs":58420}`
  const embedded = /"retryAfterMs"\s*:\s*(\d+)/.exec(message);
  if (embedded) return clamp(Number(embedded[1]));

  // "Rate limit exceeded. Retry after 59s." — ai-service's own wording.
  const hinted = /retry after\s+(\d+)\s*s/i.exec(message);
  if (hinted) return clamp(Number(hinted[1]) * 1000);

  return clamp(cfg.fallbackRetryAfterMs);
}

interface Waiter {
  lane: IngestLane;
  deadlineAt: number;
  settled: boolean;
  settle: (outcome: 'go' | 'deadline') => void;
}

/**
 * The gate itself. Instantiable (with a small config) for tests; production
 * uses the process-wide singleton from `getIngestGate`.
 */
export class IngestGate {
  private cfg: IngestGateConfig;
  private inFlight = 0;
  /** Admission timestamps inside the current sliding window. */
  private admits: number[] = [];
  /** Nobody is admitted before this instant (set by a 429). */
  private cooldownUntil = 0;
  private waiting: Waiter[] = [];
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeAt = 0;

  constructor(cfg: Partial<IngestGateConfig> = {}) {
    this.cfg = mergeConfig(DEFAULT_INGEST_GATE_CONFIG, cfg);
  }

  /**
   * Apply a partial config to a LIVE gate. Needed because the singleton may be
   * built by the first `AIClient` constructed, which in a bundled app can be
   * earlier than the consumer's own startup hook.
   */
  reconfigure(cfg: Partial<IngestGateConfig>): void {
    this.cfg = mergeConfig(this.cfg, cfg);
    this.pump();
  }

  /** The effective config. Read-only copy; mutate through `reconfigure`. */
  config(): IngestGateConfig {
    return {
      ...this.cfg,
      deadlineMs: { ...this.cfg.deadlineMs },
      queueDeadlineMs: { ...this.cfg.queueDeadlineMs },
    };
  }

  /** Live counters — for tests, and for a drain check before process exit. */
  stats(): { inFlight: number; waiting: number; admitsInWindow: number; cooldownMs: number } {
    const now = Date.now();
    this.trimAdmits(now);
    return {
      inFlight: this.inFlight,
      waiting: this.waiting.length,
      admitsInWindow: this.admits.length,
      cooldownMs: Math.max(0, this.cooldownUntil - now),
    };
  }

  /**
   * Run `task` under the gate: wait for a rate + concurrency slot, execute, and
   * on a 429 park the whole process and retry until attempts or the lane's
   * wall-clock budget runs out.
   *
   * Errors that are NOT rate limits (budget, 400, network) propagate unchanged
   * and IMMEDIATELY — the gate is a rate limiter, not a general retry loop, and
   * every call site already has its own handling for those.
   */
  async run<T>(task: () => Promise<T>, meta: IngestCallMeta): Promise<T> {
    const lane: IngestLane = meta.lane ?? 'interactive';
    const startedAt = Date.now();
    // Two clocks, deliberately. Until the first attempt lands we are only
    // waiting our turn behind other queued work, which on a seed is expected and
    // long; after it, we are retrying a server that is refusing us, which must
    // be short. See `queueDeadlineMs`.
    let deadlineAt = startedAt + this.cfg.queueDeadlineMs[lane];
    let admitted = false;
    let attempt = 0;
    let lastError: unknown;

    const giveUp = (reason: 'attempts' | 'deadline' | 'queue'): IngestRateLimitExhaustedError => {
      this.trace({
        event: 'exhausted',
        corpus: meta.corpus,
        documentIds: meta.documentIds,
        lane,
        attempt,
        reason,
      });
      return new IngestRateLimitExhaustedError({
        corpus: meta.corpus,
        documentIds: meta.documentIds,
        attempts: attempt,
        waitedMs: Date.now() - startedAt,
        reason,
        lane,
        busyMessage: this.cfg.busyMessage,
        lastError,
      });
    };

    for (;;) {
      attempt += 1;
      try {
        await this.acquire(lane, deadlineAt, meta.signal);
      } catch (err) {
        if (err instanceof DeadlinePassed) throw giveUp(admitted ? 'deadline' : 'queue');
        if (err instanceof Aborted) throw err.reason ?? err;
        throw err;
      }
      if (!admitted) {
        // First slot. From here on the retry budget applies.
        admitted = true;
        deadlineAt = Date.now() + this.cfg.deadlineMs[lane];
      }

      try {
        return await task();
      } catch (err) {
        lastError = err;
        const retryAfterMs = rateLimitRetryAfterMs(err, this.cfg);
        // Not a rate limit — the caller owns this error.
        if (retryAfterMs == null) throw err;

        this.noteRateLimited(retryAfterMs);
        this.trace({
          event: 'rate-limited',
          corpus: meta.corpus,
          documentIds: meta.documentIds,
          lane,
          attempt,
          waitMs: retryAfterMs,
        });

        if (attempt >= this.cfg.maxAttempts) throw giveUp('attempts');
        // No point burning an attempt on a wait we cannot afford. This is the
        // check that stops us giving up 44 s BEFORE the server would accept:
        // we compare the SERVER'S stated wait against our remaining budget,
        // rather than running a fixed ladder that ignores it.
        if (Date.now() + retryAfterMs >= deadlineAt) throw giveUp('deadline');
        this.trace({
          event: 'retry',
          corpus: meta.corpus,
          documentIds: meta.documentIds,
          lane,
          attempt: attempt + 1,
          waitMs: retryAfterMs,
        });
        // Loop: `acquire` parks on the cooldown we just set.
      } finally {
        this.release();
      }
    }
  }

  /** Park the whole gate until the server says it will accept traffic again. */
  private noteRateLimited(retryAfterMs: number): void {
    const until = Date.now() + retryAfterMs;
    if (until > this.cooldownUntil) this.cooldownUntil = until;
  }

  private trace(e: IngestGateEvent): void {
    const log = this.cfg.logger;
    if (!log) return;
    try {
      log(e);
    } catch {
      // A broken logger must never break ingest.
    }
  }

  private acquire(lane: IngestLane, deadlineAt: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Aborted(signal.reason));
        return;
      }
      let onAbort: (() => void) | undefined;
      const waiter: Waiter = {
        lane,
        deadlineAt,
        settled: false,
        settle: (outcome) => {
          if (waiter.settled) return;
          waiter.settled = true;
          if (onAbort && signal) signal.removeEventListener('abort', onAbort);
          if (outcome === 'go') resolve();
          else reject(new DeadlinePassed());
        },
      };
      if (signal) {
        onAbort = () => {
          if (waiter.settled) return;
          waiter.settled = true;
          this.waiting = this.waiting.filter((w) => w !== waiter);
          reject(new Aborted(signal.reason));
          this.pump();
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.waiting.push(waiter);
      this.pump();
    });
  }

  private release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.pump();
  }

  /** Drop admission stamps that have aged out of the sliding window. */
  private trimAdmits(now: number): void {
    const cutoff = now - this.cfg.windowMs;
    let drop = 0;
    while (drop < this.admits.length && this.admits[drop]! <= cutoff) drop += 1;
    if (drop > 0) this.admits.splice(0, drop);
  }

  /**
   * Admit as many waiters as the rate + concurrency + cooldown allow, then arm a
   * single timer for the next moment anything could change.
   */
  private pump(): void {
    const now = Date.now();
    this.trimAdmits(now);

    // Expire first, so a dead waiter never holds up the queue.
    if (this.waiting.length > 0) {
      const expired = this.waiting.filter((w) => w.deadlineAt <= now);
      if (expired.length > 0) {
        this.waiting = this.waiting.filter((w) => w.deadlineAt > now);
        for (const w of expired) w.settle('deadline');
      }
    }

    while (this.waiting.length > 0) {
      if (now < this.cooldownUntil) break;
      if (this.inFlight >= this.cfg.maxConcurrent) break;
      const next = this.takeNext();
      if (!next) break;
      this.inFlight += 1;
      this.admits.push(now);
      next.settle('go');
    }

    this.rescheduleWake(now);
  }

  /** Admissions per window a lane may use. Bulk stops short of the reserve. */
  private laneCap(lane: IngestLane): number {
    const max = this.cfg.maxPerWindow;
    if (lane === 'interactive') return max;
    const share = Math.min(Math.max(this.cfg.interactiveReserveShare || 0, 0), 1);
    // `max - 1` floor keeps bulk at >= 1 per window: a reserve slows a seed, it
    // never wedges it.
    const reserve = Math.min(Math.floor(max * share), Math.max(0, max - 1));
    return max - reserve;
  }

  /**
   * Interactive work jumps the queue; within a lane it is FIFO. Returns nothing
   * when the only lane waiting has spent its share of the window.
   */
  private takeNext(): Waiter | undefined {
    let idx = this.waiting.findIndex((w) => w.lane === 'interactive');
    if (idx === -1) idx = 0;
    const w = this.waiting[idx];
    if (!w || this.admits.length >= this.laneCap(w.lane)) return undefined;
    return this.waiting.splice(idx, 1)[0];
  }

  private rescheduleWake(now: number): void {
    let at = Number.POSITIVE_INFINITY;

    if (this.waiting.length > 0) {
      // Someone will time out.
      for (const w of this.waiting) at = Math.min(at, w.deadlineAt);
      // The cooldown will lift.
      if (now < this.cooldownUntil) at = Math.min(at, this.cooldownUntil);
      // A rate slot will age out of the sliding window. The cap is the one the
      // queue head is held to: bulk alone waits for enough stamps to age out to
      // get back under its share, not merely under `maxPerWindow`.
      const head = this.waiting.some((w) => w.lane === 'interactive') ? 'interactive' : 'bulk';
      const cap = this.laneCap(head);
      if (this.admits.length >= cap && this.admits.length > 0) {
        at = Math.min(at, this.admits[this.admits.length - cap]! + this.cfg.windowMs + 1);
      }
      // A concurrency slot needs no timer — `release()` re-pumps.
    }

    if (!Number.isFinite(at)) {
      this.clearWake();
      return;
    }
    // An armed timer that already fires early enough is left alone.
    if (this.wakeTimer !== null && this.wakeAt <= at) return;

    this.clearWake();
    this.wakeAt = at;
    // 🔴 NOT `unref()`ed — a deliberate divergence from both ported
    // implementations, and a real bug found by running the built package in a
    // plain Node process.
    //
    // The timer is armed ONLY when `this.waiting.length > 0` (see above), so an
    // armed timer always means real pending work. Unref'ing it let Node exit
    // while a seed still had documents queued: the first window's calls landed,
    // the process ended, and the rest vanished with no error at all — exactly
    // the silent partial seed this module exists to prevent. A long-running
    // server never noticed, because its HTTP listener held the loop open; a CLI
    // or seed script, which is what the `bulk` lane is FOR, did.
    //
    // Holding the loop open while work is queued is the correct semantics.
    // Every waiter is bounded by `queueDeadlineMs`, so the gate cannot hold a
    // process open indefinitely — it fails loudly instead.
    this.wakeTimer = setTimeout(
      () => {
        this.wakeTimer = null;
        this.pump();
      },
      Math.max(0, at - now),
    );
  }

  private clearWake(): void {
    if (this.wakeTimer !== null) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
    this.wakeAt = 0;
  }

  /**
   * Resolve once nothing is queued or in flight.
   *
   * The gate now keeps the event loop alive on its own while work is queued
   * (see `rescheduleWake`), so this is no longer required just to stop a CLI
   * exiting early. It is still useful for a script that fires ingests WITHOUT
   * awaiting them and wants one barrier before it finishes.
   *
   * Returns `false` if `timeoutMs` elapsed with work still outstanding.
   */
  async drain(timeoutMs = 600_000): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const { inFlight, waiting } = this.stats();
      if (inFlight === 0 && waiting === 0) return true;
      if (Date.now() >= until) return false;
      await new Promise<void>((r) => setTimeout(r, 50));
    }
  }
}

function mergeConfig(base: IngestGateConfig, cfg: Partial<IngestGateConfig>): IngestGateConfig {
  return {
    ...base,
    ...cfg,
    // Both records are merged FIELD-WISE. One ported implementation spread only
    // `deadlineMs` and let `...cfg` clobber `queueDeadlineMs` wholesale, so
    // `{ queueDeadlineMs: { interactive: 50 } }` left `bulk` undefined and every
    // bulk call expired instantly.
    deadlineMs: { ...base.deadlineMs, ...(cfg.deadlineMs ?? {}) },
    queueDeadlineMs: { ...base.queueDeadlineMs, ...(cfg.queueDeadlineMs ?? {}) },
  };
}

// ---------------------------------------------------------------------------
// Process-wide singleton registry
// ---------------------------------------------------------------------------

/**
 * 🔴 The registry lives on `globalThis`, NOT in a module-level `let`.
 *
 * A bundler — Next.js above all — evaluates the same module in more than one
 * bundle (route handlers, `instrumentation.ts`, an admin app, a server action),
 * and each copy would get its OWN gate. Two gates each honouring 40/min is 80/min
 * against a 100/min limit shared with everything else, which is precisely the
 * "throttles that do not compose" bug this module exists to fix. A `Symbol.for`
 * key is registered per realm, so it survives module duplication inside one
 * process. Both ported implementations found this the hard way; keep it.
 *
 * `apiVersion` guards the other half of the problem: two DIFFERENT VERSIONS of
 * this package in one process share the symbol but not the class. Sharing a gate
 * across versions is what we want, so we do it whenever the contract matches;
 * when it does not, the newer copy builds its own rather than calling a method
 * the older instance never had. Bump this only on a breaking change to `run`.
 */
const GATE_API_VERSION = 1;
const REGISTRY_KEY = Symbol.for('edc.ai-client.ingestGates');

interface GateSlot {
  apiVersion: number;
  gate: IngestGate;
}
interface GateRegistry {
  /** Per-scope gates. Scope defaults to (baseUrl, api key) — see `ingestGateScope`. */
  gates: Map<string, GateSlot>;
  /** Config applied to every gate, existing and future. */
  defaults: Partial<IngestGateConfig>;
  /**
   * Test-only: a gate returned for EVERY scope, whatever the client asked for.
   * See `_setIngestGateForTests`.
   */
  override?: IngestGate;
}
type RegistryHolder = { [REGISTRY_KEY]?: GateRegistry };

function registry(): GateRegistry {
  const holder = globalThis as unknown as RegistryHolder;
  let reg = holder[REGISTRY_KEY];
  if (!reg || !(reg.gates instanceof Map)) {
    reg = { gates: new Map(), defaults: {} };
    holder[REGISTRY_KEY] = reg;
  }
  return reg;
}

/** The scope used when a consumer does not name one. */
export const DEFAULT_INGEST_GATE_SCOPE = 'default';

/**
 * The process-wide gate for `scope`.
 *
 * Scope exists because ai-service's limiter is keyed on the API KEY. A process
 * holding two keys has two independent server-side buckets, and one shared gate
 * would halve each one's throughput AND — worse — let a 429 on one key park the
 * other. `AIClient` therefore derives a scope from `(baseUrl, apiKey)` by
 * default. Pass `ingestGateScope` to force two clients to share, or to split.
 */
export function getIngestGate(scope: string = DEFAULT_INGEST_GATE_SCOPE): IngestGate {
  const reg = registry();
  // A test-installed gate wins over every scope. Without this a suite that
  // injects a fast gate is SILENTLY IGNORED by a real `AIClient`, because the
  // client derives its scope from (baseUrl, apiKey) and the test installed one
  // under the default scope. The test then runs against the production 40/min
  // budget and appears to hang.
  if (reg.override) return reg.override;
  const slot = reg.gates.get(scope);
  if (slot && slot.apiVersion === GATE_API_VERSION) return slot.gate;
  const gate = new IngestGate(reg.defaults);
  reg.gates.set(scope, { apiVersion: GATE_API_VERSION, gate });
  return gate;
}

/**
 * Set the gate budget for this process.
 *
 * Call it once at startup, BEFORE or AFTER building clients — it applies to
 * gates that already exist as well as to future ones, because in a bundled app
 * the first `AIClient` can be constructed before your startup hook runs.
 *
 * Omit `scope` to change every gate in the process (the usual case: a product
 * holds one API key). Pass one to tune a single key.
 */
export function configureIngestGate(cfg: Partial<IngestGateConfig>, scope?: string): void {
  const reg = registry();
  if (scope === undefined) {
    reg.defaults = mergeConfig(
      { ...DEFAULT_INGEST_GATE_CONFIG, ...reg.defaults } as IngestGateConfig,
      cfg,
    );
    reg.override?.reconfigure(cfg);
    for (const slot of reg.gates.values()) slot.gate.reconfigure(cfg);
    return;
  }
  getIngestGate(scope).reconfigure(cfg);
}

/**
 * Stable, non-reversible scope id for an `(baseUrl, apiKey)` pair.
 *
 * The raw key is NOT retained: it is folded to a 32-bit FNV-1a hash, which is
 * enough to bucket by key and cannot be read back. A hash collision would merge
 * two keys onto one gate, which errs toward being MORE conservative than
 * necessary — the safe direction.
 */
export function ingestGateScopeFor(baseUrl: string, apiKey: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < apiKey.length; i += 1) {
    h ^= apiKey.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${baseUrl}#${h.toString(16)}`;
}

/** Test-only: drop every gate and default so a suite starts clean. */
export function _resetIngestGatesForTests(): void {
  const holder = globalThis as unknown as RegistryHolder;
  delete holder[REGISTRY_KEY];
}

/**
 * Test-only: install a small-config gate so a suite runs in milliseconds
 * instead of waiting on production's 60-second window.
 *
 * 🔴 With NO `scope`, the gate is installed as a process-wide OVERRIDE returned
 * for every scope — which is what a test almost always means. Scoping it to the
 * default would silently miss every real `AIClient`, because a client derives
 * its scope from `(baseUrl, apiKey)`, not from the default. Pass an explicit
 * `scope` (see `ingestGateScopeFor`) only when a test deliberately exercises
 * two keys at once.
 *
 * Clear it with `_resetIngestGatesForTests`.
 */
export function _setIngestGateForTests(gate: IngestGate, scope?: string): void {
  const reg = registry();
  if (scope === undefined) {
    reg.override = gate;
    return;
  }
  reg.gates.set(scope, { apiVersion: GATE_API_VERSION, gate });
}

/**
 * Split `documents` into chunks of at most `MAX_DOCS_PER_INGEST_REQUEST`.
 *
 * This is CHUNKING, not coalescing: it makes one caller's oversized batch legal.
 * It never merges separate calls together — see the note at the top of this file
 * for why that would strand rows at `indexing`.
 */
export function chunkDocuments<T>(
  documents: readonly T[],
  size: number = MAX_DOCS_PER_INGEST_REQUEST,
): T[][] {
  const limit = Math.max(1, Math.min(size, MAX_DOCS_PER_INGEST_REQUEST));
  const out: T[][] = [];
  for (let i = 0; i < documents.length; i += limit) {
    out.push(documents.slice(i, i + limit) as T[]);
  }
  return out;
}
