/**
 * `@edc/ai-client/callbacks/claims` — the idempotency ledger a
 * receiver of ai-service webhook callbacks keeps: claim → dispatch → finish,
 * a 120 s lease for crashed dispatches, a fence on `claimed_at`, and
 * `findStuck` for what the lease cannot save.
 *
 * A SUBPATH, kept off the main entry: it is server-side by nature. It imports
 * nothing — no `pg`, no Payload, no node builtins — and takes any `pg`-shaped
 * `query(text, params)` as its pool.
 *
 * Contract: `plan/tecnología/ai-infra/callback-contract.md` §Idempotency.
 */

export {
  createCallbackClaims,
  CLAIM_LEASE_MS,
  RAW_BODY_LIMIT,
  DETAIL_LIMIT,
  TERMINAL_STATES,
  CallbackClaimsPoolError,
  type CallbackClaims,
} from './claims.js';

export {
  assertSqlIdentifier,
  buildCallbackClaimsSql,
  validateCallbackClaimsConfig,
  RESERVED_COLUMNS,
} from './sql.js';

export {
  CALLBACK_CLAIMS_CONFORMANCE_CASES,
  CallbackClaimsConformanceError,
  type CallbackClaimsConformanceCase,
  type CallbackClaimsConformanceContext,
} from './conformance.js';

export type {
  QueryablePool,
  CallbackNaturalKey,
  ClaimState,
  ClaimReason,
  ClaimResult,
  FinishExtraColumn,
  CallbackClaimsConfig,
  FinishPatch,
  StuckClaim,
  CallbackClaimsSql,
} from './types.js';
