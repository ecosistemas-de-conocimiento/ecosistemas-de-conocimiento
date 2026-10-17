// "Shutdown" — the shared naming and timing for a job aborted because its
// process was asked to stop.
//
// ---------------------------------------------------------------------------
// The gap this closes
// ---------------------------------------------------------------------------
//
// A redeploy sends SIGTERM. Before this, `src/index.ts` called `workers.stop()`
// → `worker.close()`, which asks BullMQ to stop taking new jobs and then WAITS
// for the active ones — with no bound. Two outcomes, both bad:
//
//   · the LLM call finishes inside the platform's stop timeout (Docker and
//     Coolify: 10 SECONDS) and all is well; or
//   · it does not, the platform SIGKILLs, and the job row is left at 'running'
//     with its budget reserve held. That is `worker_lost` (see `lost.ts`) —
//     recovered eventually by the reaper, minutes later, after the consumer has
//     been told nothing. A routine redeploy should not produce that.
//
// ---------------------------------------------------------------------------
// The rule (Rodrigo)
// ---------------------------------------------------------------------------
//
// On SIGTERM/SIGINT the workers stop taking new jobs IMMEDIATELY. Whatever is
// already running gets `SHUTDOWN_GRACE_MS` to finish on its own. Past that
// window every survivor is ABORTED through the very AbortController the
// `/cancel` fast path uses — so it settles the same way a cancel does: partial
// cost billed from the aborted stream, parent counters rolled up, terminal
// callback fired.
//
// ⚠ CORRECTED: "only then does `worker.close()` run" is what this paragraph
// used to say, and it was never true of the code underneath it. `close()` is
// STARTED FIRST, without being awaited — that is the only thing that actually
// cancels an outstanding blocking fetch — and it is AWAITED last, itself
// bounded (see `awaitBounded`). Starting it last would leave the worker taking
// new jobs for the whole grace window; awaiting it unbounded is the original
// defect. The order is: start close → drain → abort → await close, bounded.
//
// ---------------------------------------------------------------------------
// What the grace actually bounds
// ---------------------------------------------------------------------------
//
// THREE things, and it is worth naming them because two of them were added
// after this file was first written and the docstrings did not keep up:
//
//   1. BullMQ GENERATION jobs — the in-flight map in `startGenerationWorker`.
//   2. BullMQ INGEST jobs — the same seam in `startIngestWorker`.
//   3. HTTP generations on `/v1/generate/sync` and `/v1/generate/stream` —
//      through `Runtime.shutdownSignal`, which the route handlers compose into
//      the signal they hand the router. Without it, `app.close()` waits for
//      in-flight requests AFTER the grace has already expired: MEASURED, a
//      SIGTERM during a stream let the response complete normally 25 s later
//      against a 2 s grace.
//
// THE HONEST EXIT BOUND is `SHUTDOWN_GRACE_MS + SHUTDOWN_SETTLE_MS` (5 s), and
// it holds only because every wait on the shutdown path is bounded by one of
// those two numbers — including the final `await closing`.
//
// 🔴 NEVER `worker.close(true)` AND NEVER A SELF-`process.kill`. Force-closing
// BullMQ drops the job lock without settling the row, which reproduces exactly
// the `worker_lost` state this whole path exists to avoid. The app's job is to
// end its own work cleanly and exit; killing it is the platform's job.
//
// ---------------------------------------------------------------------------
// Why a NAMED reason, distinct from `worker_lost`
// ---------------------------------------------------------------------------
//
// Both end a job the consumer did not ask to end, but they mean opposite
// things operationally: `worker_lost` is "a process died and we found out
// late", `shutdown` is "we stopped it on purpose and told you immediately".
// Collapsing them would make a routine redeploy indistinguishable from a crash
// in `generation_jobs.error`, in the `generation.job.failed` event and in the
// `unit.failed` callback — which is the one place an operator looks to decide
// whether anything is actually wrong.

import { env } from '../../config/env.js';

/** `generation_jobs.error` for a job aborted by a cooperative shutdown. */
export const SHUTDOWN_ERROR = 'shutdown';

/** `errorCode` on the bus event and the `unit.failed` callback envelope. */
export const SHUTDOWN_CODE = 'SHUTDOWN';

/**
 * The value passed to `AbortController.abort(reason)` on shutdown, and read
 * back off `signal.reason` at the catch site.
 *
 * 🔴 THIS IS HOW A SHUTDOWN ABORT IS TOLD FROM A `/cancel` ABORT. Both arrive
 * at the same `catch` as an `AbortError`, and they must settle DIFFERENTLY: a
 * `/cancel` has already set the parent to 'cancelled' (that write is the
 * authoritative cancel — see `cancel-bus.ts`), so the job only has to record
 * itself; a shutdown has no such prior write, so the job must roll the parent
 * up itself or the request hangs at 'running' forever. Reading the reason is
 * the only signal available at that point — the thrown error is identical.
 */
export const SHUTDOWN_ABORT_REASON = 'ai-service:shutdown';

/**
 * How long, after aborting, to let the surviving jobs run their own settle
 * path (terminal write → parent rollup → callback insert) before giving up on
 * them and closing the worker anyway.
 *
 * Fixed rather than configurable: it bounds three local database round-trips,
 * not any provider call, so there is nothing about a deployment that would
 * make the right value different. It is also the whole reason the process can
 * promise to exit within `SHUTDOWN_GRACE_MS + 5s`.
 */
export const SHUTDOWN_SETTLE_MS = 5_000;

/** How often the drain loop re-checks. Small enough to be invisible. */
const DRAIN_POLL_MS = 25;

/**
 * Wait until `map` is empty, or until `timeoutMs` has passed.
 *
 * Returns `true` if it drained, `false` if it timed out — the caller branches
 * on that to decide whether an abort is needed at all. Deliberately polls
 * rather than counting completions: the map is mutated by a `finally` inside
 * the job handler, and the handler is the one place that knows a job is
 * genuinely done with its rollup.
 */
export async function waitForDrain(
  map: { readonly size: number },
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (map.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, DRAIN_POLL_MS));
  }
  return map.size === 0;
}

/**
 * The configured grace window, in ms.
 *
 * A function rather than a constant, and reading the parsed `env` rather than
 * `process.env`, so the Zod validation (positive integer, default 30 s, empty
 * string means unset) is the single definition of what a valid value is. Same
 * shape as `lostWindowMs()` next door.
 */
export function shutdownGraceMs(): number {
  return env.SHUTDOWN_GRACE_MS;
}

/**
 * `await p`, but never for longer than `ms`.
 *
 * 🔴 THE LAST UNBOUNDED WAIT ON THE SHUTDOWN PATH WAS A BARE `await closing`.
 * `worker.close()` waits for the active jobs, and step 3's abort is not a
 * guarantee that they all returned — a job wedged inside a provider socket
 * that ignores its AbortSignal keeps `close()` pending forever, so the process
 * that promises to exit within grace + 5 s sat there until the platform
 * SIGKILLed it. Racing it against the same grace makes the promise true: past
 * the window we stop waiting and let the reaper own whatever is left, which is
 * strictly better than being killed mid-rollup.
 *
 * Returns `true` if `p` settled in time, `false` if the timeout won. The timer
 * is `unref`'d so it can never be the reason the event loop stays alive.
 */
export async function awaitBounded(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([p.then(() => true), timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
