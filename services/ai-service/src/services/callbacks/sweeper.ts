// Callback retry sweeper — durability for the retry schedule in `emit.ts`.
//
// ---------------------------------------------------------------------------
// The gap this closes
// ---------------------------------------------------------------------------
//
// `attemptDelivery` schedules its retries with an in-process `setTimeout`
// (`.unref()`'d, so it does not even hold the event loop open). The schedule
// spans ~2h43m. If the process restarts inside that window — a deploy, an
// OOM, a crash — the timer dies with it. The `callback_deliveries` row stays
// `pending` with a `next_attempt_at` in the past FOREVER: nothing else in the
// service ever transitions it. The delivery is silently lost, and the only
// recovery is an operator noticing and calling
// `POST /v1/admin/callbacks/:id/replay` by hand.
//
// The `callback_deliveries_next_attempt_idx` index was already in the schema
// waiting for this. The sweeper is the reader it was built for.
//
// ---------------------------------------------------------------------------
// Coordination rule (the part that matters)
// ---------------------------------------------------------------------------
//
// Three things can try to deliver the same row: an in-process timer, this
// sweeper, and this sweeper running on ANOTHER replica. The rules:
//
//  1. **Grace period vs. in-process timers.** The sweeper only considers rows
//     whose `next_attempt_at` is older than `graceMs` (default 2 minutes). A
//     live process fires its timer *at* `next_attempt_at`; being overdue by
//     minutes means the timer is gone (process died) or the event loop is
//     wedged. This is what keeps the sweeper from racing a healthy timer.
//     It is deliberately a time-based rule and not a claim column: adding a
//     column would need a migration, and a stale claim marker left by a
//     crashed process is its own recovery problem.
//
//  2. **Lease, not lock, for multi-replica safety.** Claiming is a single
//     atomic `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`
//     that pushes `next_attempt_at` forward by `leaseMs`. Two replicas
//     sweeping concurrently get DISJOINT row sets — `SKIP LOCKED` makes the
//     loser skip the row rather than block on it, and once committed the
//     row's `next_attempt_at` is in the future so the next sweep ignores it.
//     The transaction covers only the claim UPDATE; the HTTP delivery happens
//     AFTER it commits.
//
//     ⚠ Deliberately NOT a `pg_advisory_lock` held across the work. An
//     advisory lock held while doing I/O has previously deadlocked a pool and
//     wedged an entire backend in this fleet. `SKIP LOCKED` on a short
//     transaction has no such failure mode: the lock lifetime is bounded by
//     the UPDATE itself.
//
//  3. **Crash during delivery self-heals.** If a replica dies mid-POST, its
//     lease simply expires and a later sweep re-claims the row. That is the
//     same at-least-once guarantee the retry schedule already has, and the
//     contract already requires receivers to dedupe on the envelope's natural
//     key.
//
// Delivery itself goes through the SAME `attemptDelivery` as the timers — one
// delivery implementation, so per-attempt HMAC re-stamping, the attempt cap,
// the terminal-state transitions and the dead-letter behaviour are inherited
// rather than reimplemented.
//
// ---------------------------------------------------------------------------
// Age ceiling
// ---------------------------------------------------------------------------
//
// A sweeper switched on against a long-abandoned backlog would fire a flood of
// stale callbacks at every consumer at once. Measured across local,
// dev, stage and prod: ZERO pending rows, so there is no backlog today — but
// the ceiling exists so that stays true after an outage. Rows older than
// `maxAgeMs` (default 24h) are never delivered; they are moved to the existing
// terminal `dead_letter` status with an explicit reason, which keeps them
// visible to `GET /v1/admin/callbacks?status=dead_letter` and replayable by
// hand. No new enum value, therefore NO MIGRATION.

import { sql } from 'drizzle-orm';

import { db as defaultDb, type Db } from '../../db/client.js';
import { rootLogger, type ComponentLogger } from '../../logger.js';
import { markSweeperRun, setCallbackDeliveryCounts } from '../../metrics/callbacks.js';
import { attemptDelivery, MAX_ATTEMPTS, reportDeliveryTransition } from './emit.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

export interface SweeperConfig {
  /** How often to sweep. */
  intervalMs: number;
  /**
   * How far past `next_attempt_at` a row must be before the sweeper will touch
   * it. Guards against racing a healthy in-process timer.
   */
  graceMs: number;
  /** How far forward a claim pushes `next_attempt_at`. */
  leaseMs: number;
  /** Rows older than this are dead-lettered instead of delivered. */
  maxAgeMs: number;
  /** Max rows claimed per sweep — bounds the blast radius of a first run. */
  batchSize: number;
  /** Report what would happen; make no writes and send nothing. */
  dryRun: boolean;
}

export const DEFAULT_SWEEPER_CONFIG: SweeperConfig = {
  intervalMs: 60_000,
  // 2 minutes. The largest in-schedule gap is 2 hours, but a timer fires AT
  // its due time — overdue-by-2-minutes means the timer is gone, not late.
  graceMs: 120_000,
  // Comfortably longer than one delivery attempt plus its DB writes.
  leaseMs: 120_000,
  maxAgeMs: 24 * 60 * 60_000,
  batchSize: 50,
  dryRun: false,
};

/**
 * Read config from env, falling back to the defaults above.
 *
 * Every knob defaults to CORRECT behaviour, never to off: the sweeper is on,
 * dry-run is off. `CALLBACK_SWEEP_ENABLED=false` exists only as an operator
 * escape hatch for an incident, not as the normal state.
 */
export function configFromEnv(
  over: Partial<SweeperConfig> = {},
): SweeperConfig {
  const e = process.env;
  const num = (key: string, fallback: number): number => {
    const raw = e[key];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const bool = (key: string, fallback: boolean): boolean => {
    const raw = e[key];
    if (raw === undefined || raw === '') return fallback;
    return raw === 'true' || raw === '1';
  };
  return {
    intervalMs: num('CALLBACK_SWEEP_INTERVAL_MS', DEFAULT_SWEEPER_CONFIG.intervalMs),
    graceMs: num('CALLBACK_SWEEP_GRACE_MS', DEFAULT_SWEEPER_CONFIG.graceMs),
    leaseMs: num('CALLBACK_SWEEP_LEASE_MS', DEFAULT_SWEEPER_CONFIG.leaseMs),
    maxAgeMs: num('CALLBACK_SWEEP_MAX_AGE_MS', DEFAULT_SWEEPER_CONFIG.maxAgeMs),
    batchSize: num('CALLBACK_SWEEP_BATCH_SIZE', DEFAULT_SWEEPER_CONFIG.batchSize),
    dryRun: bool('CALLBACK_SWEEP_DRY_RUN', DEFAULT_SWEEPER_CONFIG.dryRun),
    ...over,
  };
}

export function sweeperEnabled(): boolean {
  const raw = process.env.CALLBACK_SWEEP_ENABLED;
  if (raw === undefined || raw === '') return true; // default ON
  return !(raw === 'false' || raw === '0');
}

// ---------------------------------------------------------------------------
// Result shape — what the sweep saw and did. Logged with counts every run that
// touched anything, so a silent failure cannot stay silent.
// ---------------------------------------------------------------------------

export interface SweepResult {
  /** Rows dead-lettered for exceeding `maxAgeMs`. */
  abandonedAge: string[];
  /** Rows dead-lettered for already being at the attempt cap. */
  abandonedCap: string[];
  /** Rows claimed for delivery this sweep. */
  claimed: string[];
  /** Claimed rows whose delivery ended `delivered`. */
  delivered: string[];
  /** Claimed rows still `pending` afterwards — a later attempt is scheduled. */
  deferred: string[];
  /** Claimed rows that ended in a terminal non-delivered state. */
  gaveUp: string[];
  /** Delivery threw (network stack failure, not an HTTP error). */
  errored: string[];
  dryRun: boolean;
}

const emptyResult = (dryRun: boolean): SweepResult => ({
  abandonedAge: [],
  abandonedCap: [],
  claimed: [],
  delivered: [],
  deferred: [],
  gaveUp: [],
  errored: [],
  dryRun,
});

export interface SweepDeps {
  db?: Db;
  fetcher?: typeof fetch;
  clock?: () => Date;
  config?: Partial<SweeperConfig>;
  /**
   * Optional to INJECT, never optional to USE.
   *
   * Every call site below resolves `deps.logger ?? rootLogger` and then logs
   * unconditionally. It used to be `deps.logger?.warn(...)`, and because
   * `src/index.ts` called `startWorkers()` with no arguments, every line the
   * sweeper ever wrote — boot, counts, AND 'sweep failed' — went nowhere.
   * A broken sweeper was indistinguishable from a healthy quiet one.
   *
   * ⚠ Do not reintroduce `?.` here. Silence must stay a statement about the
   * BACKLOG (which is empty in every environment, so quiet is normal), never
   * about the wiring. See `src/logger.ts`.
   */
  logger?: ComponentLogger;
}

interface ClaimRow {
  id: string;
}

/** What a retire UPDATE returns: enough to report the transition. */
interface RetiredRow {
  id: string;
  org: string;
  project: string | null;
  source: string;
  source_id: string;
  item_key: string | null;
  event: string;
  attempt: number;
  response_status: number | null;
}

/** Rows are only sweepable in `pending`; every other status is terminal. */
const SWEEPABLE_STATUS = 'pending';

// ---------------------------------------------------------------------------
// One sweep
// ---------------------------------------------------------------------------

/**
 * Run a single sweep: retire what is too old or capped out, claim what is
 * genuinely stranded, and deliver it through the normal path.
 *
 * Safe to call concurrently with itself, on this process or another replica.
 */
export async function sweepOnce(deps: SweepDeps = {}): Promise<SweepResult> {
  const db = deps.db ?? defaultDb;
  const fetcher = deps.fetcher ?? fetch;
  const clock = deps.clock ?? (() => new Date());
  const cfg = { ...DEFAULT_SWEEPER_CONFIG, ...configFromEnv(), ...deps.config };
  const log = deps.logger ?? rootLogger;
  const result = emptyResult(cfg.dryRun);

  const now = clock();
  const dueBefore = new Date(now.getTime() - cfg.graceMs);
  const bornBefore = new Date(now.getTime() - cfg.maxAgeMs);

  // -------------------------------------------------------------------------
  // Pass 1 — retire rows we must never deliver.
  //
  // Runs BEFORE the claim so an ancient or capped-out row can never be picked
  // up by pass 2 in the same sweep.
  //
  //   (a) too old      — `created_at` beyond the age ceiling.
  //   (b) capped out   — `attempt` already at MAX_ATTEMPTS. `attemptDelivery`
  //                      normally dead-letters these itself, so this is a
  //                      belt-and-braces guard against a row left `pending` at
  //                      the cap by a crash between the POST and the UPDATE.
  //                      Without it the sweeper would keep re-delivering a row
  //                      that has already used its whole schedule.
  // -------------------------------------------------------------------------
  const retire = async (
    where: ReturnType<typeof sql>,
    reason: string,
  ): Promise<string[]> => {
    if (cfg.dryRun) {
      const rows = (await db.execute(
        sql`SELECT id FROM callback_deliveries
            WHERE status = ${SWEEPABLE_STATUS} AND ${where}
            LIMIT ${cfg.batchSize}`,
      )) as unknown as ClaimRow[];
      return rows.map((r) => r.id);
    }
    const rows = (await db.execute(
      sql`UPDATE callback_deliveries
          SET status = 'dead_letter',
              next_attempt_at = NULL,
              last_error = ${reason},
              updated_at = ${now.toISOString()}
          WHERE id IN (
            SELECT id FROM callback_deliveries
            WHERE status = ${SWEEPABLE_STATUS} AND ${where}
            ORDER BY next_attempt_at NULLS FIRST
            LIMIT ${cfg.batchSize}
            FOR UPDATE SKIP LOCKED
          )
          RETURNING id, org, project, source, source_id, item_key, event, attempt, response_status`,
    )) as unknown as RetiredRow[];
    // Each of these is a callback the consumer will never get: same ERROR
    // line and counter as a dead-letter from the attempt loop.
    for (const r of rows) {
      reportDeliveryTransition(
        log,
        {
          id: r.id,
          org: r.org,
          project: r.project,
          source: r.source,
          sourceId: r.source_id,
          itemKey: r.item_key,
          event: r.event,
        },
        'dead_letter',
        { attempt: r.attempt, responseStatus: r.response_status, lastError: reason },
      );
    }
    return rows.map((r) => r.id);
  };

  result.abandonedAge = await retire(
    sql`created_at < ${bornBefore.toISOString()}`,
    `abandoned by sweeper: older than the ${Math.round(cfg.maxAgeMs / 60_000)}m age ceiling; not delivered (replay by hand if still wanted)`,
  );
  result.abandonedCap = await retire(
    sql`attempt >= ${MAX_ATTEMPTS}`,
    `abandoned by sweeper: attempt cap (${MAX_ATTEMPTS}) already reached`,
  );

  // -------------------------------------------------------------------------
  // Pass 2 — claim genuinely stranded rows.
  //
  // The single atomic UPDATE is the whole concurrency story:
  //   - `FOR UPDATE SKIP LOCKED` → a concurrent replica skips rather than
  //     blocks, so the two get disjoint sets and never double-deliver.
  //   - pushing `next_attempt_at` to now+lease → once committed, subsequent
  //     sweeps (here or elsewhere) no longer see the row as due.
  //   - the transaction ends here; the HTTP POST happens afterwards, so no
  //     lock is ever held across network I/O.
  // -------------------------------------------------------------------------
  const claimCondition = sql`status = ${SWEEPABLE_STATUS}
      AND next_attempt_at IS NOT NULL
      AND next_attempt_at < ${dueBefore.toISOString()}
      AND attempt < ${MAX_ATTEMPTS}
      AND created_at >= ${bornBefore.toISOString()}`;

  if (cfg.dryRun) {
    const rows = (await db.execute(
      sql`SELECT id FROM callback_deliveries
          WHERE ${claimCondition}
          ORDER BY next_attempt_at
          LIMIT ${cfg.batchSize}`,
    )) as unknown as ClaimRow[];
    result.claimed = rows.map((r) => r.id);
    logSweep(log, result, cfg);
    return result;
  }

  const leaseUntil = new Date(now.getTime() + cfg.leaseMs);
  const claimed = (await db.execute(
    sql`UPDATE callback_deliveries
        SET next_attempt_at = ${leaseUntil.toISOString()},
            updated_at = ${now.toISOString()}
        WHERE id IN (
          SELECT id FROM callback_deliveries
          WHERE ${claimCondition}
          ORDER BY next_attempt_at
          LIMIT ${cfg.batchSize}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id`,
  )) as unknown as ClaimRow[];
  result.claimed = claimed.map((r) => r.id);

  // -------------------------------------------------------------------------
  // Pass 3 — deliver, one row at a time, through the normal path.
  //
  // Sequential on purpose: a sweep that just recovered a backlog should not
  // fan out a burst at a receiver that may itself be recovering.
  // -------------------------------------------------------------------------
  for (const id of result.claimed) {
    try {
      await attemptDelivery(id, { db, fetcher, clock, logger: log });
    } catch (err) {
      result.errored.push(id);
      // ERROR, not warn: the row has been claimed and its `next_attempt_at`
      // pushed out by the lease, but nothing was delivered. It self-heals on
      // a later sweep, so this is not fatal — it IS a delivery that did not
      // happen, which is the one thing this subsystem exists to prevent.
      log.error(
        { deliveryId: id, err: err instanceof Error ? err.message : String(err) },
        'callback sweeper: delivery threw',
      );
      continue;
    }
    const after = (await db.execute(
      sql`SELECT status FROM callback_deliveries WHERE id = ${id} LIMIT 1`,
    )) as unknown as Array<{ status: string }>;
    const status = after[0]?.status;
    if (status === 'delivered') result.delivered.push(id);
    else if (status === SWEEPABLE_STATUS) result.deferred.push(id);
    else result.gaveUp.push(id);
  }

  logSweep(log, result, cfg);
  return result;
}

/**
 * Counts for a sweep that did something.
 *
 * ⚠ Deliberately NOT a heartbeat. The callback backlog is zero in local, dev,
 * stage and prod, so a sweep that touched nothing is the normal state and
 * runs every 60s. Logging those would be 1,440 lines a day saying "nothing
 * happened", which buries the lines that matter. Proof-of-life belongs in the
 * one-shot boot line, and proof-of-breakage in the ERROR path — neither needs
 * a per-tick line.
 */
function logSweep(
  logger: ComponentLogger,
  r: SweepResult,
  cfg: SweeperConfig,
): void {
  const touched =
    r.claimed.length + r.abandonedAge.length + r.abandonedCap.length;
  if (touched === 0) return; // a quiet sweep is the normal case; stay silent
  logger.info(
    {
      dryRun: r.dryRun,
      claimed: r.claimed.length,
      delivered: r.delivered.length,
      deferred: r.deferred.length,
      gaveUp: r.gaveUp.length,
      errored: r.errored.length,
      abandonedAge: r.abandonedAge.length,
      abandonedCap: r.abandonedCap.length,
      batchSize: cfg.batchSize,
      graceMs: cfg.graceMs,
    },
    r.dryRun
      ? 'callback sweeper: DRY RUN — would recover stranded deliveries'
      : 'callback sweeper: recovered stranded deliveries',
  );
}

/**
 * Refresh the `aiservice_callback_deliveries{status}` gauge from one GROUP BY.
 * `callback_deliveries_status_idx` serves it.
 */
export async function refreshDeliveryCounts(db: Db): Promise<void> {
  const rows = (await db.execute(
    sql`SELECT status::text AS status, count(*)::int AS n FROM callback_deliveries GROUP BY status`,
  )) as unknown as Array<{ status: string; n: number }>;
  setCallbackDeliveryCounts(Object.fromEntries(rows.map((r) => [r.status, Number(r.n)])));
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

export interface SweeperHandle {
  stop: () => Promise<void>;
  /** Exposed for tests / ops: run one sweep right now. */
  sweepNow: () => Promise<SweepResult>;
}

/**
 * Start the periodic sweeper. Returns a handle whose `stop()` waits for an
 * in-flight sweep so shutdown never abandons a half-swept batch.
 *
 * A sweep runs immediately at boot — that is the whole point, since the rows
 * it recovers were stranded by the previous process going away.
 */
export function startCallbackSweeper(deps: SweepDeps = {}): SweeperHandle {
  const cfg = { ...DEFAULT_SWEEPER_CONFIG, ...configFromEnv(), ...deps.config };
  const log = deps.logger ?? rootLogger;
  let stopped = false;
  let inFlight: Promise<unknown> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | null = null;

  // The ONLY routine line this component emits, and it fires once.
  //
  // Before this existed, the sole way to tell a running sweeper from a dead
  // one was to read `pg_stat_user_indexes` on the deployed database and count
  // scans on `callback_deliveries_next_attempt_idx`. That is not a check
  // anyone runs after a deploy. One boot line with the effective interval
  // makes "did it start, and on what schedule" answerable from the log.
  log.info(
    {
      intervalMs: cfg.intervalMs,
      graceMs: cfg.graceMs,
      leaseMs: cfg.leaseMs,
      maxAgeMs: cfg.maxAgeMs,
      batchSize: cfg.batchSize,
      dryRun: cfg.dryRun,
    },
    'callback sweeper: started',
  );

  const runOnce = async (): Promise<SweepResult> => {
    try {
      const result = await sweepOnce(deps);
      // Metrics for the dead-letter queue (plan §2.3). Inside the try on
      // purpose: a count that fails is a sweep that failed, and it gets the
      // same ERROR below. The timestamp moves only on a fully good tick, so a
      // stale `aiservice_callback_sweeper_last_run_timestamp_seconds` means
      // dead OR failing — both are alerts.
      await refreshDeliveryCounts(deps.db ?? defaultDb);
      markSweeperRun((deps.clock ?? (() => new Date()))());
      return result;
    } catch (err) {
      // 🔴 ERROR, unconditionally, every single time.
      //
      // This is the whole reason the file was touched. A sweep that throws
      // means the recovery mechanism for silently-lost callbacks is itself
      // down. It swallows the error and retries, which is right — one bad
      // sweep must not kill the loop — but swallowing it QUIETLY is what made
      // a permanently broken sweeper look identical to a healthy idle one.
      log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
          intervalMs: cfg.intervalMs,
        },
        'callback sweeper: sweep failed; will retry next interval',
      );
      return emptyResult(cfg.dryRun);
    }
  };

  const tick = (): void => {
    if (stopped) return;
    inFlight = runOnce().finally(() => {
      if (stopped) return;
      timer = setTimeout(tick, cfg.intervalMs);
      timer.unref?.();
    });
  };

  // Boot sweep, deferred a tick so startup ordering stays predictable.
  timer = setTimeout(tick, 0);
  timer.unref?.();

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight.catch(() => undefined);
    },
    sweepNow: () => sweepOnce(deps),
  };
}
