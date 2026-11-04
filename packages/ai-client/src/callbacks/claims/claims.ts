/**
 * The callback claim ledger — idempotent receipt of ai-service webhook
 * callbacks. Contract: `plan/tecnología/ai-infra/callback-contract.md`
 * §Idempotency, items 1-7.
 *
 * This module is the one copy.
 *
 * ai-service WILL re-deliver the same event: up to five attempts, and its own
 * `callback_deliveries` has no uniqueness. Recognising a repeat is the
 * receiver's job. Idempotency is defence in depth beside the 300 s HMAC skew
 * window in `@edc/ai-client/callbacks`, never a licence to widen it.
 *
 * CLAIM ≠ COMPLETION
 * ------------------
 * A row that means "seen", written before dispatch, turns a failed dispatch
 * into a silently dropped event: the retry matches the row and is waved
 * through. So a delivery moves through a lifecycle in the state column:
 *
 *   in_progress ──dispatch ok──▶ done   (terminal; NEVER re-claimable)
 *        └──────dispatch failed──▶ error  (immediately re-claimable)
 *
 * The reclaim predicate ENUMERATES `error` and expired `in_progress`. `done`,
 * legacy NULL, and anything unrecognised are not reclaimable.
 *
 * THE LEASE (read before changing `CLAIM_LEASE_MS`)
 * ------------------------------------------------
 * A process killed mid-dispatch strands its row at `in_progress`. Recovery is
 * a lease, not a sweep job: a claim older than the lease is presumed abandoned
 * and the next delivery re-claims it. ai-service's cumulative schedule is
 * 0, 5s, 35s, 2m35s, 12m35s; 120 s sits between attempts 3 and 4, so a crash
 * on the first delivery is recovered by attempt 4 with attempt 5 as backup,
 * while staying far longer than any plausible dispatch. Too short: a slow,
 * live dispatch is double-applied. Too long: the event is lost anyway. The
 * value is a property of ai-service's retry schedule, not of the consumer.
 *
 * WHY RAW SQL, AND WHY TWO STATEMENTS
 * -----------------------------------
 * The conflict must be resolved by the database; a read-then-write check is
 * racy against concurrent retries. The insert pairs `WHERE NOT EXISTS` (keeps
 * SEQUENTIAL re-deliveries deduped if the unique index is lost) with a BARE `ON CONFLICT DO NOTHING` (closes the
 * concurrent race when the index exists; inferring a conflict target would 500
 * every callback if the index vanished).
 * ⚠ The race without the index is NOT microseconds-wide, as both source copies
 * claimed: MEASURED (repo integration suite, throwaway Postgres,
 * 8 parallel claims on 4 connections) 4 of 8 won. The index is required for
 * concurrency; the conformance race case goes red without it. Reclaim is therefore a separate conditional
 * UPDATE, since `ON CONFLICT DO UPDATE` needs inference. Under READ COMMITTED
 * the losing reclaimer blocks on the row lock, re-evaluates its WHERE against
 * the winner's fresh `in_progress`, and updates nothing. The `FOR UPDATE`
 * sub-select also hands back the PRE-update state, the only way to tell a
 * retried failure from a stranded claim (Postgres has no OLD in RETURNING).
 *
 * FENCING
 * -------
 * `claimed_at` doubles as a fencing token. `finish` writes only while the row
 * still carries the caller's `claimedAt`, so a zombie past its lease cannot
 * stamp `done` over a live re-claim, nor `error` under someone still working.
 *
 * VISIBILITY
 * ----------
 * `findStuck` lists rows the reclaim predicate would still take, past an age:
 * BOTH `in_progress` and `error` (`error` rows used to be
 * invisible after ai-service gave up — permanent silent loss), ordered by the
 * SAME age expression it filters on (ordering by `claimed_at` sorted
 * NULL-claimed rows last and truncated them off a LIMIT). A partial index
 * `btree ((COALESCE(claimed_at, received_at, created_at))) WHERE <state> IN
 * ('in_progress','error')` serves it as an index-ordered scan; correctness
 * never depends on that index.
 *
 * THE POOL IS PER CALL
 * --------------------
 * Every method takes the `QueryablePool` as its first argument, so `finish`
 * can run on a transaction's connection (so a stuck-claim auto-retry can
 * commit the side effect and `done` together) through the SAME statement and
 * fencing predicate — never a second copy of the SQL.
 *
 * NO DEGRADED MODE. A missing pool THROWS `CallbackClaimsPoolError` from every
 * method; nothing ever processes a delivery without dedupe: a hard dependency fails
 * loudly. A receiver whose database is unreachable answers 5xx, and
 * ai-service's retry schedule re-delivers once it is back.
 */

import { buildCallbackClaimsSql, validateCallbackClaimsConfig } from './sql.js';
import type {
  CallbackClaimsConfig,
  CallbackClaimsSql,
  CallbackNaturalKey,
  ClaimResult,
  FinishExtraColumn,
  FinishPatch,
  QueryablePool,
  StuckClaim,
} from './types.js';

/** Lease before a claim is presumed abandoned. See "THE LEASE" above. */
export const CLAIM_LEASE_MS = 120_000;

/** Max characters of the raw body retained for debugging / manual replay. */
export const RAW_BODY_LIMIT = 100_000;

/** Max characters of an error message retained on the claim row. */
export const DETAIL_LIMIT = 2_000;

/** States that must never be re-claimed. Success happens exactly once. */
export const TERMINAL_STATES = ['done'] as const;

/** Thrown when a method is called without a usable pool. Never caught internally. */
export class CallbackClaimsPoolError extends Error {
  override name = 'CallbackClaimsPoolError';
}

function requirePool(pool: unknown, method: string): asserts pool is QueryablePool {
  if (!pool || typeof (pool as QueryablePool).query !== 'function') {
    throw new CallbackClaimsPoolError(
      `callback claims: ${method}() needs a pg-shaped pool with query(text, params); got ` +
        `${pool === null ? 'null' : typeof pool}. There is no degraded mode: without the ` +
        'database a delivery cannot be deduped, so the receiver must fail (5xx) and let ' +
        'ai-service re-deliver.',
    );
  }
}

export type CallbackClaims<X extends Record<string, FinishExtraColumn>> = {
  /** The validated config, with `leaseMs` resolved. */
  readonly config: Readonly<CallbackClaimsConfig<X> & { leaseMs: number }>;
  /** The exact statements this instance runs. */
  readonly sql: CallbackClaimsSql;
  /**
   * Claim a delivery for dispatch. Marks it IN PROGRESS, not done — call
   * `finish` once dispatch settles.
   *
   * @returns `claimed: true` when the caller now owns the delivery (fresh, or
   *          a legitimate re-run of a failed or abandoned one); `claimed:
   *          false` when it is done or in flight elsewhere — answer 200, do nothing.
   * @throws  `CallbackClaimsPoolError` without a pool, or on a database error.
   *          Surface a 5xx so ai-service retries.
   */
  claim(
    pool: QueryablePool,
    key: CallbackNaturalKey,
    rawBody: string,
    opts?: { leaseMs?: number },
  ): Promise<ClaimResult>;
  /**
   * Record the terminal state. This, not the claim, makes a delivery
   * permanently deduped. Fenced on `claimedAt`.
   *
   * @returns true if written, false if fenced out or the claim has no row id.
   * @throws  `CallbackClaimsPoolError` without a pool.
   */
  finish(
    pool: QueryablePool,
    claim: Pick<ClaimResult, 'rowId' | 'claimedAt'>,
    patch: FinishPatch<X>,
  ): Promise<boolean>;
  /** Unfinished rows (`in_progress` or `error`) older than `olderThanMs` (default: the lease), oldest first. */
  findStuck(
    pool: QueryablePool,
    opts?: { olderThanMs?: number; limit?: number },
  ): Promise<StuckClaim[]>;
};

type ClaimRow = { id: number; claimed_at: Date | null; attempts: number | null };

/**
 * Build a claim ledger over one table.
 *
 * @example `outcome` as the state column
 *   createCallbackClaims({ table: 'callback_dedupe', stateColumn: 'outcome',
 *     sourceEnumType: 'enum_callback_dedupe_source' })
 * @example `claim_state` as the state column
 *   createCallbackClaims({ table: 'ai_service_callbacks', stateColumn: 'claim_state',
 *     sourceEnumType: 'enum_ai_service_callbacks_source',
 *     finishExtras: {
 *       outcome: { column: 'outcome', type: 'enum_ai_service_callbacks_outcome', clearOnReclaim: true },
 *       versionId: { column: 'document_version_id', type: 'int' } } })
 *
 * @throws when an identifier is not `^[a-z_][a-z0-9_]*$`, or clashes with a lifecycle column.
 */
export function createCallbackClaims<
  X extends Record<string, FinishExtraColumn> = Record<string, never>,
>(input: CallbackClaimsConfig<X>): CallbackClaims<X> {
  validateCallbackClaimsConfig(input);
  const config = Object.freeze({ ...input, leaseMs: input.leaseMs ?? CLAIM_LEASE_MS });
  const sql = Object.freeze(buildCallbackClaimsSql(config));
  const extraNames = Object.keys(config.finishExtras ?? {});

  const keyParams = (k: CallbackNaturalKey): unknown[] => [k.source, k.sourceId, k.itemKey, k.event];

  return {
    config,
    sql,

    async claim(pool, key, rawBody, opts = {}) {
      requirePool(pool, 'claim');
      const leaseMs = opts.leaseMs ?? config.leaseMs;
      const now = new Date().toISOString();
      const body = rawBody.length > RAW_BODY_LIMIT ? rawBody.slice(0, RAW_BODY_LIMIT) : rawBody;

      const inserted = await pool.query<ClaimRow>(sql.insert, [...keyParams(key), now, body]);
      const fresh = inserted.rows[0];
      if (fresh) {
        return {
          claimed: true,
          rowId: fresh.id,
          claimedAt: fresh.claimed_at,
          attempts: fresh.attempts ?? 1,
          reason: 'fresh',
            };
      }

      const reclaimed = await pool.query<ClaimRow & { prev_state: string | null }>(sql.reclaim, [
        ...keyParams(key),
        now,
        body,
        String(leaseMs),
      ]);
      const retaken = reclaimed.rows[0];
      if (retaken) {
        return {
          claimed: true,
          rowId: retaken.id,
          claimedAt: retaken.claimed_at,
          attempts: retaken.attempts ?? 2,
          reason: retaken.prev_state === 'error' ? 'reclaimed_error' : 'reclaimed_stale',
            };
      }

      const existing = await pool.query<{ state: string | null }>(sql.currentState, keyParams(key));
      const state = existing.rows[0]?.state ?? 'done';
      return {
        claimed: false,
        rowId: null,
        claimedAt: null,
        attempts: 0,
        reason: state === 'in_progress' ? 'in_flight' : 'duplicate',
        };
    },

    async finish(pool, claim, patch) {
      const extras = (patch.extras ?? {}) as Record<string, unknown>;
      for (const name of Object.keys(extras)) {
        if (!extraNames.includes(name)) {
          throw new Error(`callback claims: finish got extra "${name}", which finishExtras does not declare.`);
        }
      }
      requirePool(pool, 'finish');
      if (claim.rowId === null) return false;
      const detail = patch.detail ? patch.detail.slice(0, DETAIL_LIMIT) : null;
      const rs = await pool.query<{ id: number }>(sql.finish, [
        claim.rowId,
        patch.state,
        detail,
        claim.claimedAt,
        ...extraNames.map((n) => extras[n] ?? null),
      ]);
      return rs.rows.length > 0;
    },

    async findStuck(pool, opts = {}) {
      requirePool(pool, 'findStuck');
      const rs = await pool.query<{
        id: number;
        source: string;
        source_id: string;
        item_key: string;
        event: string;
        attempts: number | null;
        claimed_at: Date | null;
        raw_body: string | null;
        state: string | null;
      }>(sql.findStuck, [String(opts.olderThanMs ?? config.leaseMs), opts.limit ?? 100]);
      return rs.rows.map((r) => ({
        id: r.id,
        source: r.source,
        sourceId: r.source_id,
        itemKey: r.item_key,
        event: r.event,
        attempts: r.attempts ?? 0,
        claimedAt: r.claimed_at,
        rawBody: r.raw_body,
        claimState: r.state === 'error' ? 'error' : 'in_progress',
      }));
    },
  };
}
