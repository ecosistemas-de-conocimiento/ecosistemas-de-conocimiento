// "Worker lost" — the shared rule for a job row whose worker died mid-run.
//
// ---------------------------------------------------------------------------
// The gap this closes
// ---------------------------------------------------------------------------
//
// The claim guard (`claimJob` / `claimIngestJob`) made a stalled RE-DELIVERY
// harmless: only a row in 'queued' can be claimed, so a second worker handed
// the same job finds nothing to take and returns. That is the right answer for
// a worker that is still alive.
//
// It is the wrong answer for a worker that is DEAD. MEASURED on this tree with
// a worker SIGKILLed mid-job (real Postgres + Redis):
//   · `generation_jobs` stays `status='running'`, `finished_at` null, forever.
//   · the parent `generation_requests` row never goes terminal — it sits at
//     'running' 1/2, or at 'queued' when the dead job was the only one.
//   · BullMQ redelivers once after the lock expires, the claim refuses, the
//     redelivery returns cleanly and BullMQ marks the queue job COMPLETED —
//     so every queue-level health reading is green.
//   · zero callback deliveries, zero bus events, zero SSE frames.
//   · `GET /v1/generate/:requestId` answers 200 in-progress forever.
//   · the router's per-call budget reserve for that unit is never trued up:
//     0.000737 USD of the org's cap is held against work that will never run.
// One dead process at concurrency 5 strands five requests.
//
// ---------------------------------------------------------------------------
// The rule (Rodrigo)
// ---------------------------------------------------------------------------
//
// A job whose worker died is NEVER automatically re-run — the reasons in the
// `claimJob` block comment still stand: a silent second LLM call charges the
// org twice, writes a second trace, and (for ingest) poisons the corpus with a
// duplicate document. What changes is that "stuck" stops being silent. It
// becomes a NAMED FAILURE the consumer is told about, with the reserve
// refunded.
//
// ---------------------------------------------------------------------------
// How "dead" is decided
// ---------------------------------------------------------------------------
//
// Time, not a lease column — same trade-off as the callback sweeper, and for
// the same reason: a claim column needs a migration, and a stale claim marker
// left by a crashed process is its own recovery problem.
//
// A row is LOST when `status = 'running'` AND `started_at < now() − window`,
// where the window is `workerRuntimeOptions().lockDuration` (which honours
// `WORKER_LOCK_DURATION_MS`) times `WORKER_LOST_WINDOW_MULTIPLIER`. Inside the
// window a live worker may still legitimately own the row, so it is left
// alone and logged exactly as before.
//
// The multiplier is why the window is not the raw lock duration: BullMQ renews
// the lock on a timer, and a healthy job may run for many lock windows. What
// the lock window actually bounds is the gap between renewals — so a row that
// is `running` and older than the window is only a candidate once BullMQ has
// ALSO given up on it, which it does after `lockDuration` without a renewal.
// Two lock windows is the smallest value that is unambiguously past that
// point on both clocks. `WORKER_LOST_WINDOW_MS` overrides the whole
// derivation for an operator who has measured their own jobs.
//
// ⚠ CLOCK: the comparison is made by POSTGRES (`now()`), never by the node
// process, so several replicas with drifting clocks still agree.

import { workerRuntimeOptions } from '../../queue/queues.js';

/** `generation_jobs.error` / `ingest_jobs.error` for a lost job. */
export const WORKER_LOST_ERROR = 'worker_lost';

/** Machine-readable code, written to `generation_jobs.metadata.errorCode`. */
export const WORKER_LOST_CODE = 'WORKER_LOST';

/** Reason written when `POST /cancel` is the thing that clears a lost row. */
export const CANCELLED_LOST_ERROR = 'cancelled';

/**
 * Lock windows a `running` row must outlive before it is presumed lost. See
 * the block comment above for why this is 2 and not 1.
 */
export const WORKER_LOST_WINDOW_MULTIPLIER = 2;

/**
 * How old a `running` row must be, in ms, before it is presumed lost.
 * `WORKER_LOST_WINDOW_MS` overrides the derivation outright.
 */
export function lostWindowMs(): number {
  const raw = process.env.WORKER_LOST_WINDOW_MS;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return workerRuntimeOptions().lockDuration * WORKER_LOST_WINDOW_MULTIPLIER;
}

export interface ReaperConfig {
  /** How often the periodic sweep runs. */
  intervalMs: number;
  /** How old a `running` row must be to be reaped. */
  windowMs: number;
  /** Max rows reaped per sweep, per table — bounds a first run's blast radius. */
  batchSize: number;
}

export function reaperConfigFromEnv(over: Partial<ReaperConfig> = {}): ReaperConfig {
  const num = (key: string, fallback: number): number => {
    const raw = process.env[key];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const windowMs = lostWindowMs();
  return {
    // Sweeping once per window is enough: a row cannot become lost faster than
    // the window itself, so this bounds the delay on telling a consumer to one
    // window on top of the window.
    intervalMs: num('WORKER_REAP_INTERVAL_MS', windowMs),
    windowMs,
    batchSize: num('WORKER_REAP_BATCH_SIZE', 100),
    ...over,
  };
}

/** Default ON. `WORKER_REAP_ENABLED=false` is an incident escape hatch only. */
export function reaperEnabled(): boolean {
  const raw = process.env.WORKER_REAP_ENABLED;
  if (raw === undefined || raw === '') return true;
  return !(raw === 'false' || raw === '0');
}
