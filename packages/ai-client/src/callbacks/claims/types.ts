/**
 * Types for the callback claim ledger. Pure types, no runtime.
 */

/**
 * The one thing the module needs from a database driver: a `pg`-shaped
 * `query(text, params)`. A `pg` `Pool`, a `PoolClient` inside a transaction,
 * Payload's `payload.db.pool`, or a three-line adapter over postgres-js all fit.
 * Typed structurally so this package never imports `pg`.
 */
export type QueryablePool = {
  query: <R = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ) => Promise<{ rows: R[]; rowCount?: number | null }>;
};

/**
 * The natural key of a callback delivery — one row per unique tuple.
 * Contract §Idempotency: generate `(requestId, unitKey, event)`, ingest
 * `(ingestId, docId, event)`. Never the timestamp or the signature.
 */
export type CallbackNaturalKey = {
  /** `'ingest' | 'generate'` in every consumer today; typed open so a consumer enum can narrow it. */
  source: string;
  /** `requestId` / `ingestId`. */
  sourceId: string;
  /** `docId` / `unitKey`; EMPTY STRING (never null) for batch-level events. */
  itemKey: string;
  event: string;
};

/**
 * Lifecycle state of a claim row, stored in the configured `stateColumn`.
 *
 * `done` is the ONLY state that permanently suppresses re-delivery. A new
 * terminal-success state must NOT be added to the reclaim predicate; anything
 * unrecognised (including legacy NULL) is non-reclaimable, the safe direction.
 */
export type ClaimState = 'in_progress' | 'done' | 'error';

/** Why a claim attempt resolved the way it did — for logs and for tests. */
export type ClaimReason =
  /** No row existed; this delivery is genuinely first. */
  | 'fresh'
  /** A previous dispatch recorded `error`; we are legitimately re-running it. */
  | 'reclaimed_error'
  /** A previous claim was stranded past its lease (crash mid-dispatch). */
  | 'reclaimed_stale'
  /** Already dispatched successfully — the dedupe guarantee doing its job. */
  | 'duplicate'
  /** Another delivery holds a live, unexpired claim right now. */
  | 'in_flight';

export type ClaimResult = {
  /** True ⇒ the caller owns this delivery and must run the side effects. */
  claimed: boolean;
  /** Row id of the claim, or null when the claim was skipped/lost. */
  rowId: number | null;
  /**
   * Fencing token: the `claimed_at` this claim was stamped with. Pass it back
   * to `finish` so a zombie cannot overwrite a newer claim's outcome.
   */
  claimedAt: Date | null;
  /** How many times this natural key has been claimed, including this one. */
  attempts: number;
  reason: ClaimReason;
};

/** An extra column `finish` writes in the same UPDATE as the state. */
export type FinishExtraColumn = {
  /** Column name; validated against `^[a-z_][a-z0-9_]*$`. */
  column: string;
  /**
   * Postgres type the value is cast to. A builtin (`int`, `varchar`, `text`,
   * `boolean`, `timestamptz`, `jsonb`, `uuid`, …) is emitted bare; anything
   * else — a consumer ENUM such as `enum_ai_service_callbacks_outcome` — is
   * emitted double-quoted. Validated like an identifier.
   */
  type: string;
  /**
   * Set to NULL when a row is re-claimed. Use it for columns that describe the
   * PREVIOUS attempt (an audit `outcome`), which would otherwise linger
   * as a misleading audit line while the new attempt is in flight.
   */
  clearOnReclaim?: boolean;
};

export type CallbackClaimsConfig<X extends Record<string, FinishExtraColumn> = Record<string, never>> = {
  /** Table name. Unqualified; set `search_path` for a non-public schema. */
  table: string;
  /** Column holding the lifecycle (`in_progress | done | error`). For example `outcome` or `claim_state`. */
  stateColumn: string;
  /** ENUM type of the `source` column, when it is one (Payload `select`). Default: `varchar`. */
  sourceEnumType?: string;
  /** Columns `finish` may write alongside the state, keyed by the patch field name. */
  finishExtras?: X;
  /** Lease in ms. Default `CLAIM_LEASE_MS` (120 s). Read the sizing note before changing it. */
  leaseMs?: number;
};

export type FinishPatch<X extends Record<string, FinishExtraColumn>> = {
  state: Exclude<ClaimState, 'in_progress'>;
  /** Error message or note; truncated to `DETAIL_LIMIT` characters. */
  detail?: string;
  /** Values for the declared `finishExtras`. An omitted extra is written as NULL. */
  extras?: { [K in keyof X]?: unknown };
};

export type StuckClaim = {
  id: number;
  source: string;
  sourceId: string;
  itemKey: string;
  event: string;
  attempts: number;
  claimedAt: Date | null;
  rawBody: string | null;
  /**
   * Which unfinished state this row is in. Do NOT collapse the two:
   * `in_progress` means a worker died holding the claim, `error` means a
   * dispatch ran and failed. Different causes, different fixes.
   */
  claimState: Extract<ClaimState, 'in_progress' | 'error'>;
};

/** The SQL the factory runs, exposed so consumers can EXPLAIN or diff it. */
export type CallbackClaimsSql = {
  /** $1 source, $2 source_id, $3 item_key, $4 event, $5 now, $6 raw_body. */
  insert: string;
  /** Same params as `insert` plus $7 lease ms (as text/bigint). */
  reclaim: string;
  /** $1..$4 natural key. */
  currentState: string;
  /** $1 id, $2 state, $3 detail, $4 fencing claimed_at, $5.. extras in declaration order. */
  finish: string;
  /** $1 older-than ms, $2 limit. */
  findStuck: string;
};
