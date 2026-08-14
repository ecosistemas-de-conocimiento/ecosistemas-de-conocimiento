// Atomic budget reserve / refund / adjust against `budget_state`.
//
// Ported from a prototype's `services/ai/router/budget-enforcer.ts`. A prototype reserved
// against `organizations.budget_remaining_usd`; ai-service has no
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
//   - If `now() >= next_reset_at`, run the reset UPDATE BEFORE the reserve,
//     wrapped in the same `db.transaction` so the pair is atomic.
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
  /** Soft link only; logged via the trace writer, not consulted here. */
  traceId?: string;
}

export interface ReserveResult {
  remainingUsd: number;
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
}

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
      const softCap = await this.evaluateSoftCap(input.org, attempt);
      return {
        remainingUsd: attempt,
        softCap,
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

  /** Refund a previously reserved amount. Never throws; missing rows no-op. */
  async refund(input: RefundInput): Promise<void> {
    if (!(input.amountUsd > 0)) return;
    await this.db.execute(sql`
      UPDATE "budget_state"
         SET "remaining_usd" = "remaining_usd" + ${input.amountUsd}::numeric,
             "updated_at" = now()
       WHERE "org" = ${input.org}
    `);
  }

  /**
   * True-up: apply `deltaUsd` (positive ⇒ refund, negative ⇒ further reserve).
   * No floor enforcement — actuals can briefly push the row below zero; the
   * reconciliation job (future) is responsible for catching sustained drift.
   */
  async adjust(input: AdjustInput): Promise<void> {
    if (Math.abs(input.deltaUsd) < 1e-9) return;
    await this.db.execute(sql`
      UPDATE "budget_state"
         SET "remaining_usd" = "remaining_usd" + ${input.deltaUsd}::numeric,
             "updated_at" = now()
       WHERE "org" = ${input.org}
    `);
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

  /** After a successful reserve, decide whether the soft-cap threshold is
   *  breached and (subject to a 5-min throttle) emit `softCap: true`. */
  private async evaluateSoftCap(org: string, newRemaining: number): Promise<boolean> {
    const snap = await this.readBudgetRow(org);
    if (!snap) return false;
    if (snap.limitUsd <= 0) return false;
    if (snap.softCapPct >= 100) return false; // disabled
    const threshold = snap.limitUsd * (1 - snap.softCapPct / 100);
    if (newRemaining >= threshold) return false;

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
