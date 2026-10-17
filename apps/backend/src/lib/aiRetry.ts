/**
 * 🔴 BACKING OFF WHEN ai-service SAYS "TOO FAST" — the consumer half of the
 * rate limit.
 *
 * ── The incident this exists for, measured ───────────────────────────────────
 *
 * A seed published 285 documents at concurrency. ai-service caps `/v1` at 100
 * requests per minute per API key (`services/ai-service/src/server-limits.ts`).
 * 145 documents ended stuck in `publicationStatus: 'publishing'`, and 99 of
 * those carried NO error and NO `publishIngestId` — a non-terminal state with
 * nothing written down and nothing to retry from. The state sat frozen for 25+
 * minutes because nothing in this backend was watching it.
 *
 * The refusals themselves were correct. `beginPublish` flips the row to
 * `publishing` and THEN calls `ingest.enqueue`; when that call threw, the row
 * was already in the in-flight state and every caller simply logged and moved
 * on.
 *
 * ── 🔴 THE CEILING IS DELIBERATE. RAISING THE SERVER'S LIMIT IS NOT THE FIX ──
 *
 * ai-service's 100/min and 30/min are cost control, decided upstream. The
 * consumer is what changes. So this module never tries to outrun the limiter —
 * it waits exactly as long as the server asked, and gives up loudly when the
 * budget runs out.
 *
 * ── ⚠ WHY THE BUDGET IS SMALL, AND WHAT PAYS FOR IT ──────────────────────────
 *
 * `beginPublish` runs inside `POST /api/documents/:id/publish`, an HTTP request
 * a person is waiting on. Every second spent sleeping here is a second that
 * request is held open, and a reverse proxy will eventually cut it. So the
 * default total wait is ~2 minutes, not the ~10 that would let a 285-document
 * burst drain on its own.
 *
 * That is a real trade, and the OTHER half of the fix is what makes it safe:
 * whatever this gives up on ends with a VISIBLE `publicationError` (see
 * `publishDocument.ts`), and `publishJanitor.ts` sweeps anything that got stuck
 * without one. A bounded wait plus a legible failure beats an unbounded wait,
 * because a user can retry a failure and cannot retry a hung request.
 *
 * Both bounds are env-overridable so a bulk seed — no user waiting, and the one
 * workload that genuinely benefits — can be told to be patient.
 *
 * ── ⚠ WHAT THIS DOES NOT RETRY ──────────────────────────────────────────────
 *
 * ONLY a 429. A 401 will not fix itself, a 402 budget refusal will not fix
 * itself, a 400 will not fix itself, and a 500 might mean the work half
 * happened. Retrying any of those wastes the caller's time at best and
 * duplicates work at worst. See {@link isRateLimited}.
 */

import { RateLimitError } from '@edc/ai-client'

/** Env var names, so log lines and tests never hand-type a string that can drift. */
export const AI_RETRY_MAX_ATTEMPTS_VAR = 'AI_RETRY_MAX_ATTEMPTS'
export const AI_RETRY_TOTAL_WAIT_MS_VAR = 'AI_RETRY_TOTAL_WAIT_MS'

/**
 * Total tries, including the first. 4 = one attempt plus three retries.
 *
 * ⚠ THE BUDGET, NOT THIS NUMBER, IS USUALLY WHAT STOPS THE LOOP — so 4 is a
 * ceiling and not a promise. Whether all four are used depends entirely on how
 * long the server asks for:
 *
 *   · ai-service's own 429 carries the remaining window, typically a few
 *     seconds under a short burst. Four attempts easily fit in the budget.
 *   · a 429 with NO timing at all falls back to {@link MAX_SINGLE_WAIT_MS}
 *     (61s), and two of those overrun the 120s budget — so that case stops at
 *     two attempts. That is the intended trade: when the server will not say
 *     how long, minutes of blind waiting are worth less than a visible failure.
 */
export const DEFAULT_MAX_ATTEMPTS = 4

/**
 * 🔴 THE CEILING. Total time this may spend ASLEEP across all retries, in ms.
 *
 * 120s. See the header for why it is not larger: a human is on the other end of
 * the request that most often triggers this.
 *
 * ⚠ Measured against cumulative sleep, not wall clock. The time ai-service takes
 * to answer is not counted, because that is work being done rather than time
 * being wasted — and counting it would make a slow-but-succeeding call
 * indistinguishable from a throttled one.
 */
export const DEFAULT_TOTAL_WAIT_MS = 120_000

/**
 * Hard cap on a single sleep. One rate-limit window plus a second of slack.
 *
 * A server that asks for longer than its own window is either misconfigured or
 * fronted by something else; either way, waking a little early costs one wasted
 * attempt, while obeying it blindly can burn the whole budget on one sleep.
 */
export const MAX_SINGLE_WAIT_MS = 61_000

/**
 * ⚠ JITTER IS NOT COSMETIC HERE — it is the reason the retry works at all.
 *
 * The failure was N documents refused within the same second. Told to "retry
 * after 47s", all N would wake at the same instant and re-stampede the window
 * that just opened: the first 100 pass, the rest are refused again, and the
 * retry has reproduced the original burst one minute later.
 *
 * So each waiter adds an independent random smear, proportional to the wait it
 * was given (up to 5s). Spreading arrivals over several seconds is what lets a
 * queue drain instead of oscillate.
 */
export const JITTER_FRACTION = 0.25
export const MAX_JITTER_MS = 5_000

/**
 * Is this the one error worth waiting on?
 *
 * ⚠ DUCK-TYPED ON TOP OF THE `instanceof`, on purpose, and both branches are
 * load-bearing:
 *
 *   · `instanceof RateLimitError` is the real path and carries the server's
 *     own `retryAfterMs` (0 when the server gave no hint).
 *   · The structural check keeps this usable from `publishDocument.ts`, which
 *     deliberately depends on a hand-written `CorpusMover` interface rather than
 *     the concrete `AIClient` so its transitions stay testable with plain fake
 *     clients. It also survives the case where two copies of `@edc/ai-client`
 *     end up in the tree and `instanceof` quietly stops matching — a real hazard
 *     in a pnpm workspace, and one that would silently disable every retry.
 */
export function isRateLimited(err: unknown): boolean {
  if (err instanceof RateLimitError) return true
  return Boolean(err) && typeof err === 'object' && (err as { status?: unknown }).status === 429
}

/** The server's requested wait in ms, or the default when it did not say. */
export function requestedWaitMs(err: unknown): number {
  const ms = (err as { retryAfterMs?: unknown } | null)?.retryAfterMs
  if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) {
    return Math.min(MAX_SINGLE_WAIT_MS, ms)
  }
  return MAX_SINGLE_WAIT_MS
}

/** How long to actually sleep: what the server asked, plus this waiter's own smear. */
export function waitWithJitter(err: unknown, random: () => number = Math.random): number {
  const base = requestedWaitMs(err)
  const jitter = Math.min(MAX_JITTER_MS, base * JITTER_FRACTION) * random()
  return Math.round(base + jitter)
}

export function maxAttempts(): number {
  const raw = Number(process.env[AI_RETRY_MAX_ATTEMPTS_VAR])
  // Floor of 1: "no retries" is a legitimate setting, "no attempts" is not.
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_MAX_ATTEMPTS
}

export function totalWaitBudgetMs(): number {
  // ⚠ THE EMPTY STRING IS "UNSET", NOT ZERO. This is the one setting whose valid
  // range includes 0, and `Number('')` is 0 — so a deployment that declares the
  // variable and leaves it blank (routine in a Coolify/compose env file) would
  // silently switch every retry off and look exactly like the bug this module
  // fixes. Blank means "I did not choose", so it takes the default.
  const text = (process.env[AI_RETRY_TOTAL_WAIT_MS_VAR] ?? '').trim()
  if (text === '') return DEFAULT_TOTAL_WAIT_MS
  const raw = Number(text)
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_TOTAL_WAIT_MS
}

const sleepFor = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/** Just the one method of Payload's logger this module uses. */
export interface RetryLogger {
  warn(obj: Record<string, unknown>, msg: string): void
}

export interface RetryOptions {
  /** Named in log lines so a stuck queue can be traced to a call site. */
  label?: string
  log?: RetryLogger
  /** Injected in tests so the suite does not actually sleep for two minutes. */
  sleep?: (ms: number) => Promise<void>
  /** Injected in tests so jitter is deterministic. */
  random?: () => number
  attempts?: number
  budgetMs?: number
}

/**
 * Run `fn`, and on a 429 wait what the server asked and run it again.
 *
 * ⚠ THE LAST ERROR IS RE-THROWN, NOT SWALLOWED. Giving up has to be visible to
 * the caller, because the caller is the only one that knows what row to write
 * the failure onto. The 99 silent rows in the incident above are exactly what a
 * swallow would reproduce.
 *
 * ⚠ NOT SAFE FOR NON-IDEMPOTENT WORK WHOSE OUTCOME IS UNKNOWN. A 429 is refused
 * BEFORE the handler runs, so nothing happened and re-sending is free. That is
 * the only reason this can retry blindly, and it is why {@link isRateLimited} is
 * narrow — a 500 could mean the work half-happened, and repeating it would
 * enqueue the same document twice.
 */
export async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const attempts = opts.attempts ?? maxAttempts()
  const budgetMs = opts.budgetMs ?? totalWaitBudgetMs()
  const sleep = opts.sleep ?? sleepFor
  const random = opts.random ?? Math.random
  const label = opts.label ?? 'ai-service call'

  let slept = 0

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn()
    } catch (err) {
      if (!isRateLimited(err)) throw err
      if (attempt >= attempts) {
        opts.log?.warn(
          { label, attempt, attempts, sleptMs: slept },
          `[ai-retry] ${label} is still rate-limited after ${attempt} attempts — giving up. ` +
            'The caller must record this failure somewhere a human can see it.',
        )
        throw err
      }

      const wait = waitWithJitter(err, random)
      if (slept + wait > budgetMs) {
        // ⚠ Stop BEFORE the sleep, not after. Sleeping past the budget and then
        // discovering it would hold the request open for the very duration the
        // budget exists to bound.
        opts.log?.warn(
          { label, attempt, attempts, sleptMs: slept, nextWaitMs: wait, budgetMs },
          `[ai-retry] ${label} would exceed the ${budgetMs}ms backoff budget — giving up early. ` +
            'Raise AI_RETRY_TOTAL_WAIT_MS for bulk jobs where nobody is waiting on the request.',
        )
        throw err
      }

      opts.log?.warn(
        { label, attempt, attempts, waitMs: wait },
        `[ai-retry] ${label} was rate-limited by ai-service; waiting ${Math.round(wait / 1000)}s before retry.`,
      )
      await sleep(wait)
      slept += wait
    }
  }
}
