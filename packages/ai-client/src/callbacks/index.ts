/**
 * `@edc/ai-client/callbacks` — the receiving half of ai-service's
 * webhook wire contract.
 *
 * A SUBPATH, not part of the main entry, on purpose: this module imports
 * `node:crypto`, and `@edc/ai-client`'s main entry is bundled into
 * browser/edge builds by at least one consumer. Keeping the verifier off the
 * main entry means no consumer pays for a node builtin it never calls.
 *
 * Contract: `plan/tecnología/ai-infra/callback-contract.md`.
 */

export {
  CALLBACK_TIMESTAMP_HEADER,
  CALLBACK_SIGNATURE_HEADER,
  CALLBACK_EVENT_HEADER,
  CALLBACK_SKEW_WINDOW_SECONDS,
  signCallback,
  verifyCallbackSignature,
  type CallbackVerifyReason,
  type CallbackVerifyFailure,
  type CallbackVerifyOutcome,
  type VerifyCallbackOptions,
} from './verify.js';

export {
  CALLBACK_VERIFIER_CONFORMANCE_CASES,
  runCallbackVerifierConformance,
  CONFORMANCE_SECRET,
  CONFORMANCE_BODY,
  CONFORMANCE_NOW,
  type CallbackVerifierConformanceCase,
  type ConformanceFailure,
} from './conformance.js';

// The SOURCE guard: the check that no repo has grown a
// hand-rolled verifier in a file nobody imports.
export {
  findLocalVerifierReimplementations,
  type VerifierReimplementationScanOptions,
} from './conformance.js';
