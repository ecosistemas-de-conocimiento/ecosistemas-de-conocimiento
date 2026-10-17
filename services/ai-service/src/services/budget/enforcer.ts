// Atomic budget reserve / refund / adjust against `budget_state`.
//
// ai-service has no
// `organizations` table — its mutable counter lives on `budget_state` keyed by
// the opaque `org` text. See `plan/m3-m4-decisions.md` §2.
//
// The core primitive is a single atomic SQL statement:
//
//   UPDATE budget_state
//      SET remaining_usd = remaining_usd - $amount, updated_at = now()
//    WHERE org = $org AND remaining_usd >= $amount
//   RETURNING remaining_usd;
//
// Returning zero rows means "either no budget_state row OR insufficient
// balance". We disambiguate by reading the row:
//   - No row at all  ⇒ the org has NO explicit budget. Per ADR-0003 D5 the
//     service is FAIL-CLOSED: we throw `BudgetNotConfigured` (402) instead of
//     fabricating a $100 bootstrap. Every org must be provisioned a cap via
//     seed/admin (see `scripts/set-budget.ts` + migration 0008).
//   - Row exists but `remaining_usd < amount` ⇒ throw `BudgetExceeded`.
//
// ── Budget reset (0007_budget_reset) ──────────────────────────────────────
// Lazy reset semantics from `plan/budget-reset-followup.md`:
//   - On every `reserve()`, read the row's `reset_*` fields.
//   - If `now() >= next_reset_at`, run the reset UPDATE BEFORE the reserve.
//     ⚠ There is NO `db.transaction` here — reset and reserve are two separate
//     statements, and an earlier version of this comment claimed otherwise.
//     Each is atomic ON ITS OWN and that is sufficient:
//       · the reset UPDATE carries `AND next_reset_at = <the value we read>`,
//         so of N concurrent callers that all see the boundary as passed,
//         exactly one matches a row and flips it; the losers match zero rows
//         and simply proceed (`maybeReset` returns false).
//       · the reserve UPDATE carries `AND remaining_usd >= amount`, so it
//         re-reads and re-checks the balance under Postgres' own row lock,
//         whatever the reset did in between.
//     The only thing the missing transaction costs is ordering across the two:
//     a caller can reserve against the PRE-reset balance and get a
//     `BudgetExceeded` a few milliseconds before the reset that would have
//     covered it. No money is ever created or lost by that interleaving.
//   - Append a `usage_logs` row with `endpoint = 'budget-reset'` for the
//     audit trail. Audit-only — doesn't move money.
//   - After the reserve, evaluate soft-cap: if remaining is below the
//     per-org threshold, mark `softCap: true` and stamp `soft_cap_warned_at`,
//     but only if the previous warning was > 5 min old (throttle).

import { sql } from 'drizzle-orm';

import type { Db } from '../../db/client.js';
import { BudgetExceeded, BudgetNotConfigured } from './errors.js';
import { shouldResetNow } from './reset.js';

const SOFT_CAP_THROTTLE_MS = 5 * 60 * 1000; // 5 minutes

interface ReserveInput {
  org: string;
  amountUsd: number;
  /**
   * The router's per-call trace id.
   *
   * ⚠ This used to be documented as "soft link only; logged via the trace
   * writer, not consulted here" — and it genuinely was IGNORED. It is now the
   * key the `budget_reservations` ledger row is written under, which is what
   * lets a hold be found and settled later.
   */
  traceId?: string;
  /** Opaque scoping tag, copied onto the ledger row for per-project audit. */
  project?: string | undefined;
  /**
   * `generation_jobs.id`, when this reserve belongs to a queued job. THE
   * REAPER'S ONLY HANDLE: a worker that dies leaves nothing but the job row,
   * so a hold with no `job_id` cannot be recovered by amount and falls back to
   * the old `metadata.reservePerCallUsd` guess.
   */
  jobId?: string | undefined;
}

export interface ReserveResult {
  remainingUsd: number;
  /**
   * The `budget_reservations` row this hold wrote, when one was written.
   *
   * Absent for a $0 reserve (nothing is held) and when the ledger INSERT
   * failed — see the ledger's "audit, not authority" note in
   * `src/db/schema/index.ts`.
   */
  reservationId?: string;
  /** True when this reserve crossed (or stayed below) the soft-cap threshold
   *  AND the throttle window has elapsed. Audit-only; the reserve still
   *  succeeded. */
  softCap: boolean;
  /** True when this call lazily reset the row before the reserve. */
  resetOccurred?: boolean;
}

interface AdjustInput {
  org: string;
  /** Positive ⇒ refund / increase; negative ⇒ further reserve. */
  deltaUsd: number;
}

interface RefundInput {
  org: string;
  amountUsd: number;
  /** Close out this call's live holds as `refunded`. */
  traceId?: string | undefined;
  /** Close out this job's live holds as `refunded`. */
  jobId?: string | undefined;
}

interface AdjustInputWithLedger extends AdjustInput {
  traceId?: string | undefined;
}

/** Ledger row lifecycle. See `budgetReservations` in `src/db/schema/index.ts`. */
export type ReservationState = 'reserved' | 'settled' | 'refunded';

type AnyDb = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

function asNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v);
  return 0;
}

function asDateOrNull(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function rowsFromExecute(out: unknown): Array<Record<string, unknown>> {
  if (!out) return [];
  if (Array.isArray(out)) return out as Array<Record<string, unknown>>;
  const maybe = out as { rows?: Array<Record<string, unknown>> };
  return maybe.rows ?? [];
}

/** Subset of the row read at the top of `reserve()`. */
interface BudgetRowSnapshot {
  limitUsd: number;
  remainingUsd: number;
  resetCadence: string;
  resetAnchorDay: number;
  resetTz: string;
  lastResetAt: Date | null;
  nextResetAt: Date | null;
  softCapPct: number;
  softCapWarnedAt: Date | null;
}

export class BudgetEnforcer {
  constructor(private readonly db: AnyDb) {}

  /**
   * Atomically reserve `amountUsd` from `budget_state.remaining_usd`.
   *
   * FAIL-CLOSED (ADR-0003 D5): if no `budget_state` row exists for `org`, this
   * throws `BudgetNotConfigured` — the org must be explicitly provisioned a cap
   * (seed/admin) before it can spend. No silent $100 bootstrap.
   *
   * Throws `BudgetExceeded` when the row exists but cannot cover `amountUsd`.
   */
  async reserve(input: ReserveInput): Promise<ReserveResult> {
    if (!(input.amountUsd >= 0)) {
      throw new Error('BudgetEnforcer.reserve: amountUsd must be >= 0');
    }
    if (input.amountUsd === 0) {
      // Free call — skip the UPDATE but still return current remaining for the
      // caller to log. Still fail-closed: a $0 call against an unconfigured org
      // is rejected so callers can't sneak spend in under a rounding floor.
      if (!(await this.rowExists(input.org))) {
        throw new BudgetNotConfigured(input.org);
      }
      const current = await this.getRemaining(input.org);
      return { remainingUsd: current, softCap: false };
    }

    // Step 1: lazy-reset if due. Reads the row, evaluates the boundary, and
    // applies a reset UPDATE + audit row when needed. Best-effort under
    // concurrency — the predicate on the UPDATE ensures only one of N
    // concurrent first-callers actually flips the row.
    const resetOutcome = await this.maybeReset(input.org);

    // Step 2: attempt the atomic reserve.
    const attempt = await this.tryReserve(input.org, input.amountUsd);
    if (attempt !== null) {
      // Ledger row AFTER the atomic UPDATE won, never before: a row written
      // ahead of the decrement would record a hold that a concurrent caller's
      // `remaining_usd >= amount` predicate then refused, and the reaper would
      // refund money that was never taken.
      const reservationId = await this.writeReservation(input);
      const softCap = await this.evaluateSoftCap(input.org, attempt);
      return {
        remainingUsd: attempt,
        softCap,
        ...(reservationId ? { reservationId } : {}),
        ...(resetOutcome ? { resetOccurred: true } : {}),
      };
    }

    // No row decremented. Disambiguate: a missing row is a configuration error
    // (fail-closed), a present-but-short row is a genuine overspend.
    if (!(await this.rowExists(input.org))) {
      throw new BudgetNotConfigured(input.org);
    }
    const remaining = await this.getRemaining(input.org);
    throw new BudgetExceeded(input.org, input.amountUsd, remaining);
  }

  /**
   * Refund a previously reserved amount. Never throws; missing rows no-op.
   *
   * When a `traceId` / `jobId` is given, the matching LIVE ledger rows are
   * closed out as `refunded` — otherwise the reaper would find them still
   * `reserved` on its next sweep and refund the same money again.
   *
   * 🔴 CLAMPED AT `limit_usd`. A refund credits money that was supposedly
   * reserved, but nothing here proves it was: a double refund, or a refund of
   * a hold whose reserve was already released, would otherwise MINT budget —
   * measured, a $10.00 cap ended at $10.00574. `LEAST(...)` caps the credit at
   * the org's own limit. It stays ONE statement: a read-then-write would
   * reintroduce the race the atomic UPDATE exists to avoid.
   */
  async refund(input: RefundInput): Promise<void> {
    if (!(input.amountUsd > 0)) return;
    await this.db.execute(sql`
      UPDATE "budget_state"
         SET "remaining_usd" = LEAST(
               "remaining_usd" + ${input.amountUsd}::numeric,
               "limit_usd"
             ),
             "updated_at" = now()
       WHERE "org" = ${input.org}
    `);
    await this.closeReservations(input, 'refunded');
  }

  /**
   * Close out every LIVE hold for a call/job, without moving money.
   *
   * The router's true-up (`adjust`) already reconciles the org counter in one
   * statement; this is the ledger's half of the same event. Idempotent by the
   * `state = 'reserved'` predicate: a second call matches nothing.
   */
  async settleReservations(key: { traceId?: string | undefined; jobId?: string | undefined }): Promise<void> {
    await this.closeReservations(key, 'settled');
  }

  /**
   * The exact amount still HELD for a job — the number a lost-worker refund
   * must return, and the reason this table exists.
   *
   * `null` (not 0) when the job has no ledger rows at all, so the caller can
   * tell "nothing held" apart from "this job predates the ledger" and fall
   * back to the old `metadata.reservePerCallUsd` estimate for the latter.
   */
  async heldReserveUsd(jobId: string): Promise<number | null> {
    const out = await this.db.execute(sql`
      SELECT
        COALESCE(SUM("amount_usd") FILTER (WHERE "state" = 'reserved'), 0) AS held,
        COUNT(*) AS total
      FROM "budget_reservations"
      WHERE "job_id" = ${jobId}
    `);
    const rows = rowsFromExecute(out);
    const row = rows[0];
    if (!row) return null;
    if (asNumber(row['total']) === 0) return null;
    return asNumber(row['held']);
  }

  /** Insert one ledger row. Best-effort — see the schema's audit-not-authority note. */
  private async writeReservation(input: ReserveInput): Promise<string | undefined> {
    try {
      const out = await this.db.execute(sql`
        INSERT INTO "budget_reservations"
          ("org", "project", "trace_id", "job_id", "amount_usd", "state")
        VALUES (
          ${input.org},
          ${input.project ?? null},
          ${input.traceId ?? null},
          ${input.jobId ?? null},
          ${input.amountUsd}::numeric,
          'reserved'
        )
        RETURNING "id"
      `);
      const id = rowsFromExecute(out)[0]?.['id'];
      return typeof id === 'string' ? id : undefined;
    } catch (err) {
      // The MONEY already moved and the call is valid. Losing the audit row
      // costs precision in a later lost-worker refund, not correctness now.
      console.warn(
        `[budget] budget_reservations insert failed for org=${input.org} ` +
          `traceId=${input.traceId ?? '-'} jobId=${input.jobId ?? '-'}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  /** Flip live holds to a terminal state. No key ⇒ no-op (never a mass update). */
  private async closeReservations(
    key: { traceId?: string | undefined; jobId?: string | undefined },
    state: 'settled' | 'refunded',
  ): Promise<void> {
    // 🔴 A missing key must NOT widen to "every reserved row". Callers that
    // have neither id (an ad-hoc refund, `/v1/embed`) simply leave the ledger
    // alone — a stale `reserved` row is a reporting artefact; a mass close-out
    // would erase every other tenant's live holds.
    if (!key.traceId && !key.jobId) return;
    try {
      await this.db.execute(sql`
        UPDATE "budget_reservations"
           SET "state" = ${state}, "settled_at" = now()
         WHERE "state" = 'reserved'
           AND (
             (${key.traceId ?? null}::text IS NOT NULL AND "trace_id" = ${key.traceId ?? null})
             OR (${key.jobId ?? null}::text IS NOT NULL AND "job_id" = ${key.jobId ?? null})
           )
      `);
    } catch (err) {
      console.warn(
        `[budget] budget_reservations close-out (${state}) failed for ` +
          `traceId=${key.traceId ?? '-'} jobId=${key.jobId ?? '-'}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * True-up: apply `deltaUsd` (positive ⇒ refund, negative ⇒ further reserve).
   * No floor enforcement — actuals can briefly push the row below zero; the
   * reconciliation job (future) is responsible for catching sustained drift.
   */
  async adjust(input: AdjustInputWithLedger): Promise<void> {
    // ⚠ The ledger close-out runs even for a zero delta. A true-up whose
    // actual cost landed exactly on the reserve moves no money but the holds
    // are just as finished, and leaving them `reserved` would let the reaper
    // refund a completed call.
    if (Math.abs(input.deltaUsd) >= 1e-9) {
      await this.db.execute(sql`
        UPDATE "budget_state"
           SET "remaining_usd" = "remaining_usd" + ${input.deltaUsd}::numeric,
               "updated_at" = now()
         WHERE "org" = ${input.org}
      `);
    }
    await this.closeReservations({ traceId: input.traceId }, 'settled');
  }

  /** Read-only view of the current `remaining_usd` for an org. 0 if no row. */
  async getRemaining(org: string): Promise<number> {
    const out = await this.db.execute(sql`
      SELECT "remaining_usd" FROM "budget_state" WHERE "org" = ${org} LIMIT 1
    `);
    const rows = rowsFromExecute(out);
    if (rows.length === 0) return 0;
    return asNumber(rows[0]?.['remaining_usd']);
  }

  /**
   * Fail-closed guard (ADR-0003 D5): throw `BudgetNotConfigured` if the org has
   * no explicit `budget_state` row. Lets a caller's advisory pre-flight (e.g.
   * the orchestrator's `estimateBatch` gate) surface the clear "no budget
   * configured" 402 BEFORE doing work, instead of bottoming out as a $0
   * `BudgetExceeded`. The atomic `reserve()` enforces the same invariant on its
   * own, so this is a UX nicety, not the security boundary.
   */
  async assertConfigured(org: string): Promise<void> {
    if (!(await this.rowExists(org))) {
      throw new BudgetNotConfigured(org);
    }
  }

  /**
   * Soft-cap probe for a batch that is ABOUT to run.
   *
   * Exists because the async `/v1/generate` path no longer reserves the batch
   * estimate (see the header of `services/generation/orchestrator.ts`), and the
   * `BUDGET_SOFT_CAP` warning in the launch response used to be a side effect
   * of that reserve. Dropping the reserve without this would have silently
   * removed a consumer-visible warning — a client-facing regression.
   *
   * 🔴 `projectedSpendUsd` IS NOT OPTIONAL IN SPIRIT. The old reserve evaluated
   * the soft cap on the POST-reserve remaining, so the batch that CROSSES the
   * threshold is the one that warns. A probe on the PRE-spend remaining warns
   * one batch too late — the crossing batch says nothing, and a consumer can treat this
   * as "the one advance notice".
   *
   * MEASURED on real Postgres (limit 100, soft_cap_pct 90 ⇒ threshold 10,
   * remaining 10.5, batch estimate 1.0): the post-reserve evaluation fires
   * (9.5 < 10); a pre-spend evaluation does not (10.5 >= 10). Callers therefore
   * pass the batch estimate so the projected remaining is what gets judged.
   *
   * ⚠ NOT strictly read-only: it moves no MONEY (`remaining_usd` is untouched),
   * but a firing warning stamps `soft_cap_warned_at` via `evaluateSoftCap` —
   * that is the 5-minute throttle's bookkeeping, and it is why two probes in a
   * row do not both warn.
   */
  async checkSoftCap(org: string, projectedSpendUsd = 0): Promise<boolean> {
    const remaining = await this.getRemaining(org);
    // Clamp: a negative "projected spend" must never inflate the remaining and
    // suppress a warning that is genuinely due.
    const projected = remaining - Math.max(0, projectedSpendUsd);
    return this.evaluateSoftCap(org, projected);
  }

  /** Internal: one atomic reserve attempt. Returns the new remaining, or null
   *  when the UPDATE matched zero rows (no row, or row didn't cover amount). */
  private async tryReserve(org: string, amount: number): Promise<number | null> {
    const out = await this.db.execute(sql`
      UPDATE "budget_state"
         SET "remaining_usd" = "remaining_usd" - ${amount}::numeric,
             "updated_at" = now()
       WHERE "org" = ${org}
         AND "remaining_usd" >= ${amount}::numeric
      RETURNING "remaining_usd"
    `);
    const rows = rowsFromExecute(out);
    if (rows.length === 0) return null;
    return asNumber(rows[0]?.['remaining_usd']);
  }

  /** Internal: does a `budget_state` row exist for this org? Used to keep the
   *  reserve path FAIL-CLOSED — a missing row is a configuration error
   *  (`BudgetNotConfigured`), not an overspend. */
  private async rowExists(org: string): Promise<boolean> {
    const out = await this.db.execute(sql`
      SELECT 1 FROM "budget_state" WHERE "org" = ${org} LIMIT 1
    `);
    return rowsFromExecute(out).length > 0;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Reset + soft-cap helpers (0007_budget_reset)
  // ─────────────────────────────────────────────────────────────────────────

  /** Read the full reset/cap fields. Returns null when no row exists. */
  private async readBudgetRow(org: string): Promise<BudgetRowSnapshot | null> {
    const out = await this.db.execute(sql`
      SELECT
        "limit_usd",
        "remaining_usd",
        "reset_cadence",
        "reset_anchor_day",
        "reset_tz",
        "last_reset_at",
        "next_reset_at",
        "soft_cap_pct",
        "soft_cap_warned_at"
      FROM "budget_state"
      WHERE "org" = ${org}
      LIMIT 1
    `);
    const rows = rowsFromExecute(out);
    if (rows.length === 0) return null;
    const r = rows[0]!;
    return {
      limitUsd: asNumber(r['limit_usd']),
      remainingUsd: asNumber(r['remaining_usd']),
      resetCadence: String(r['reset_cadence'] ?? 'monthly_anniversary'),
      resetAnchorDay: Number(r['reset_anchor_day'] ?? 1),
      resetTz: String(r['reset_tz'] ?? 'UTC'),
      lastResetAt: asDateOrNull(r['last_reset_at']),
      nextResetAt: asDateOrNull(r['next_reset_at']),
      softCapPct: asNumber(r['soft_cap_pct']),
      softCapWarnedAt: asDateOrNull(r['soft_cap_warned_at']),
    };
  }

  /** Apply a lazy reset to the row if `nextResetAt` has passed. Returns true
   *  when the UPDATE actually flipped a row (false = no row, not due, or a
   *  concurrent caller beat us to it — the predicate makes this idempotent). */
  private async maybeReset(org: string): Promise<boolean> {
    const snap = await this.readBudgetRow(org);
    if (!snap) return false; // Row doesn't exist yet — bootstrap path takes over.
    const now = new Date();
    const decision = shouldResetNow(
      {
        lastResetAt: snap.lastResetAt,
        nextResetAt: snap.nextResetAt,
        cadence: snap.resetCadence,
        anchorDay: snap.resetAnchorDay,
        tz: snap.resetTz,
      },
      now,
    );
    if (!decision.shouldReset) return false;

    // Atomic reset: only flip if `next_reset_at` is still what we read (the
    // predicate handles the race — a concurrent reserve that won the reset
    // already advanced `next_reset_at`, so our UPDATE matches zero rows).
    const observedNextReset = snap.nextResetAt!.toISOString();
    const newNextReset = decision.nextResetAt
      ? decision.nextResetAt.toISOString()
      : null;
    const nowIso = now.toISOString();
    const out = await this.db.execute(sql`
      UPDATE "budget_state"
         SET "remaining_usd" = "limit_usd",
             "last_reset_at" = ${nowIso}::timestamptz,
             "next_reset_at" = ${newNextReset}::timestamptz,
             "soft_cap_warned_at" = NULL,
             "updated_at" = now()
       WHERE "org" = ${org}
         AND "next_reset_at" = ${observedNextReset}::timestamptz
      RETURNING "remaining_usd"
    `);
    const flipped = rowsFromExecute(out).length > 0;
    if (flipped) {
      // Audit row — non-fatal on failure. `usage_logs.endpoint = 'budget-reset'`.
      try {
        await this.db.execute(sql`
          INSERT INTO "usage_logs" (
            "org", "project", "endpoint",
            "input_tokens", "output_tokens",
            "actual_cost_usd", "metadata"
          )
          VALUES (
            ${org}, NULL, ${'budget-reset'},
            ${0}, ${0},
            ${0}::numeric,
            ${JSON.stringify({
              resetFrom: snap.remainingUsd,
              resetTo: snap.limitUsd,
              cadence: snap.resetCadence,
            })}::jsonb
          )
        `);
      } catch {
        // Audit write is best-effort; the reset itself already landed.
      }
    }
    return flipped;
  }

  /** Decide whether the soft-cap threshold is breached at `projectedRemaining`
   *  and (subject to a 5-min throttle) emit `softCap: true`. Two callers pass
   *  two different numbers for the SAME semantics — "what remains once this
   *  spend lands": `reserve()` passes the post-UPDATE remaining, `checkSoftCap`
   *  passes remaining minus the batch estimate it was handed. Stamps
   *  `soft_cap_warned_at` when it returns true; moves no money. */
  private async evaluateSoftCap(
    org: string,
    projectedRemaining: number,
  ): Promise<boolean> {
    const snap = await this.readBudgetRow(org);
    if (!snap) return false;
    if (snap.limitUsd <= 0) return false;
    if (snap.softCapPct >= 100) return false; // disabled
    const threshold = snap.limitUsd * (1 - snap.softCapPct / 100);
    if (projectedRemaining >= threshold) return false;

    // Throttle: only emit if the last warning was > 5 min ago (or never).
    const now = new Date();
    if (
      snap.softCapWarnedAt &&
      now.getTime() - snap.softCapWarnedAt.getTime() < SOFT_CAP_THROTTLE_MS
    ) {
      return false;
    }
    // Stamp the warning. Best-effort.
    try {
      await this.db.execute(sql`
        UPDATE "budget_state"
           SET "soft_cap_warned_at" = ${now.toISOString()}::timestamptz,
               "updated_at" = now()
         WHERE "org" = ${org}
      `);
    } catch {
      // Non-fatal — the warning still surfaces this call; throttle window
      // restarts at the next stamped write.
    }
    return true;
  }
}
