// PII minimisation — the public surface of `src/services/ai/pii/`.
//
// THE ONE THING A CALLER NEEDS:
//
//   import { minimise } from './services/ai/pii/index.js';
//   const { payload, redacted, counts } = await minimise(opts.messages);
//
// Everything else on this file is for tests, the capability probe, and the
// caller that installs the NER model as a third detector.
//
// 🔴 `minimise` REJECTS rather than returning an unscrubbed payload. Do not
// wrap it in a try/catch that falls back to the original — that is the silent
// no-op §9.1 singles out as the one degradation this capability may not have.
// Let the refusal abort the egress call. See `types.ts` for the full list of
// what makes it refuse.
//
// ── DELIBERATELY NOT IN THIS LANE ────────────────────────────────────────────
// Lane D owns `src/services/ai/pii/` and `pii-service/` and nothing else, so
// the following are written but NOT WIRED. Each names the file that owns it:
//
//   1. The EGRESS CALL. §9.4 puts `minimise` inside the provider adapter
//      module — `src/services/ai/router/adapters/openrouter.ts`, which sends
//      `messages: opts.messages` at `:202` (sync) and `:303` (stream) — plus
//      the ingest path that embeds chunk text. §9.4 also asks for a test that
//      FAILS if a `messages` array reaches `fetch` unminimised.
//   2. The CAPABILITY. `piiMinimisation` in `src/capabilities.ts`, shipped in
//      the same commit as its probe, per the honesty contract at `:30-41`. The
//      probe sends `PROBE_CURP` (`fixtures.ts`) through the egress function and
//      asserts it does not survive — PRESENCE, not strength, and the doc must
//      say so.
//   3. `traces` SCRUBBING. `traces.inputPayload` / `outputPayload` are `jsonb`
//      holding raw text today (`src/db/schema/index.ts:458+`). §9.4 option A —
//      store the SCRUBBED text only, no reversible map.
//   4. The ENV SCHEMA. `PII_NER_*` belong in `src/config/env.ts` next to
//      `RERANK_URL` / `SPARSE_EMBED_URL`; `ner-client.ts` reads `process.env`
//      directly in one contained function until they are.

export {
  minimise,
  minimiseText,
  isMinimisationRefusal,
  RULE_DETECTORS,
  type MinimiseResult,
  type MinimiseTextResult,
} from './minimise.js';

export {
  DEFAULT_PLACEHOLDERS,
  PII_KINDS,
  PiiMinimisationFailedError,
  type ChecksumMode,
  type PiiDetector,
  type PiiKind,
  type PiiPolicy,
  type PiiSpan,
  type SyncPiiDetector,
} from './types.js';

export { CURP_ENTITY_CODES, curpCheckDigit, curpDetector, isValidCurp } from './curp.js';
export { isValidRfc, rfcCheckDigit, rfcDetector } from './rfc.js';
export { emailDetector, isValidEmail } from './email.js';
export { isValidMxPhone, nationalDigits, phoneDetector } from './phone.js';
export { addressDetector } from './address.js';

export type { ModelServerAdapter, ModelServerHealth } from './model-server.js';
export {
  createNerAdapter,
  nerDetector,
  DEFAULT_NER_LABELS,
  NerHttpError,
  NerNotConfiguredError,
  type NerAdapterOptions,
  type NerArgs,
  type NerDetectorOptions,
  type NerEntity,
  type NerLabelMap,
  type NerResult,
} from './ner-client.js';
