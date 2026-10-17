// Server-side bounds on the caller-influenceable knobs of an `EffortProfile`.
//
// ── Why this module exists ────────────────────────────────────────────────
// Security audit, finding C4 (the only Critical in
// `findings/ai-service.md`): "Budget & token/cost caps fully bypassable via
// caller-supplied `effortProfile`".
//
// Three of `resolveSpec`'s six profile layers arrive over the wire, and all
// three are typed `z.record(z.string(), z.unknown())` — i.e. NOT validated at the edge:
//
//   • `unit.specOverride.effortProfile`         (the inline CEILING, merges last)
//   • `unit.specDefault.effortProfile`          (the inline FLOOR)
//   • `requestOverrides.effortOverrides[key]`   (per-unit, batch path)
//
// `mergeProfile` overlays them on top of the admin-controlled layers, so
// without a bound a hostile-but-authenticated tenant could POST
// `{ estimatedCostUsdPerCall: 0, maxOutputTokens: 200000, multiSample: 50 }`
// and drain the platform's single shared `OPENROUTER_API_KEY`.
//
// ── CLAMP, never DELETE ───────────────────────────────────────────────────
// The audit's fix spec (step 4) proposed *dropping* the caller-supplied
// fields from the overlays. For `maxOutputTokens` that is a trap, and there is
// a whole doc about it: `plan/open-maxoutputtokens-clamp-not-delete.md`.
// The chat product meters per-user credits by output tokens and enforces its
// per-user cap by sending `maxOutputTokens`. Delete the overlay and that cap
// silently stops being applied — bigger bills, no error, and the
// `finishReason: 'length'` signal chat uses to detect truncation stops firing
// at the boundary it reasoned about. A silent failure with a broken detector.
//
// So every field here is BOUNDED, not removed. A caller may still supply any
// of them; it simply cannot use one to exceed a server limit.
//
// ── Bound DIRECTION is per-field, and it is the whole subtlety ────────────
// Which way a field has to be bounded depends on which way it moves spend:
//
//   `maxOutputTokens`          ceiling only. Raising it costs money; LOWERING
//                              it is exactly what a caller enforcing a
//                              per-user cap needs, and must keep working.
//   `multiSample`              ceiling AND floor. It multiplies real provider
//                              calls, and `< 1` understates the pre-flight
//                              estimate while the router still makes 1 call.
//   `validationPasses`         floor only. It does NOT drive provider calls —
//                              it only multiplies the pre-flight estimate
//                              (`estimate.ts`), so `0` zeroes the estimate and
//                              slips the advisory budget gate. A ceiling would
//                              make the gate weaker, not stronger, so there
//                              isn't one.
//   `estimatedCostUsdPerCall`  floor only, and the floor is the ADMIN-resolved
//                              value rather than a constant. This is the field
//                              the Critical actually turns on: it becomes the
//                              budget RESERVE, and `budgetReserve` returns
//                              early when `amountUsd <= 0`, so a caller
//                              sending `0` skipped the budget check entirely.
//                              A caller may still raise its own reserve; it
//                              can never undercut what an admin configured.
//
// Bounding `estimatedCostUsdPerCall` against the admin baseline — instead of
// recomputing the reserve from live pricing, which is what the audit's step 2
// proposes — is deliberate. Step 2 is classed FLAG (owner-only) precisely
// because it rewrites core billing math for every consumer. This floor closes
// the same hole with zero blast radius: when the caller supplies nothing (the
// normal case), the resolved number is byte-identical to today's.

import type { EffortProfile } from './resolve.js';

/**
 * Ceiling on `max_tokens` for a single provider call.
 *
 * 8000 comfortably clears the largest built-in profile (`maximum` = 6000), so
 * no legitimate configuration is affected. Matches the constant introduced on
 * the security branches (`4ca0838` / `936a427`), which never reached `main`.
 */
export const MAX_OUTPUT_TOKENS = 8000;

/** Ceiling on parallel samples per unit — the largest built-in (`maximum`) is 3. */
export const MAX_MULTI_SAMPLE = 3;

/** A profile must always be worth at least one sample / one pass. */
const MIN_SAMPLES = 1;
const MIN_PASSES = 1;
/** `max_tokens: 0` is not a meaningful request; treat it as one token. */
const MIN_OUTPUT_TOKENS = 1;

/**
 * `undefined` unless `v` is a real, finite JS number.
 *
 * Load-bearing: the wire schemas accept `z.record(z.string(), z.unknown())`, so these
 * fields can arrive as `"200000"`, `NaN`, `Infinity`, `null` or an object.
 * A bare `Math.min(caller, CEILING)` propagates `NaN` straight into the
 * provider's `max_tokens`, which is a worse failure than the one being fixed.
 */
function finiteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Clamp to `[min, max]` and floor to an integer. */
function clampInt(n: number, min: number, max: number): number {
  return Math.min(Math.max(Math.floor(n), min), max);
}

/**
 * Bound every caller-influenceable cost knob on a merged effort profile.
 *
 * @param merged   the full `mergeProfile(...)` result — admin layers with the
 *                 caller-supplied overlays already applied on top.
 * @param baseline the same merge with ONLY the admin-controlled layers
 *                 (built-in defaults, `project_configs`, `registry_entries`).
 *                 Used as the floor for `estimatedCostUsdPerCall`, and as the
 *                 fallback whenever a caller sends a non-numeric value.
 *
 * Pure: returns a new object, never mutates either argument.
 */
export function clampCallerLimits(
  merged: EffortProfile,
  baseline: EffortProfile,
): EffortProfile {
  // ── maxOutputTokens — CEILING ONLY ──────────────────────────────────────
  // Anything at or below the ceiling is passed through untouched. That is the
  // contract the chat product's per-user credit cap depends on; see the
  // module header and `plan/open-maxoutputtokens-clamp-not-delete.md`.
  const requestedTokens =
    finiteNumber(merged.maxOutputTokens) ?? finiteNumber(baseline.maxOutputTokens);
  const maxOutputTokens =
    requestedTokens === undefined
      ? baseline.maxOutputTokens
      : clampInt(requestedTokens, MIN_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS);

  // ── multiSample — CEILING AND FLOOR ─────────────────────────────────────
  // Each extra sample is an extra billed provider call.
  const requestedSamples =
    finiteNumber(merged.multiSample) ?? finiteNumber(baseline.multiSample);
  const multiSample =
    requestedSamples === undefined
      ? baseline.multiSample
      : clampInt(requestedSamples, MIN_SAMPLES, MAX_MULTI_SAMPLE);

  // ── validationPasses — FLOOR ONLY ───────────────────────────────────────
  // Estimate-only multiplier; a ceiling here would weaken the budget gate.
  const requestedPasses =
    finiteNumber(merged.validationPasses) ?? finiteNumber(baseline.validationPasses);
  const validationPasses =
    requestedPasses === undefined
      ? baseline.validationPasses
      : Math.max(Math.floor(requestedPasses), MIN_PASSES);

  // ── estimatedCostUsdPerCall — FLOOR AT THE ADMIN BASELINE ───────────────
  // This is the number that becomes the budget reserve. A caller may reserve
  // MORE than an admin configured, never less — which is what stops
  // `budgetReserve`'s `amountUsd <= 0` early-return being reachable from the
  // wire.
  const baselineCost = finiteNumber(baseline.estimatedCostUsdPerCall) ?? 0;
  const requestedCost = finiteNumber(merged.estimatedCostUsdPerCall);
  const estimatedCostUsdPerCall =
    requestedCost === undefined ? baselineCost : Math.max(requestedCost, baselineCost);

  return {
    ...merged,
    maxOutputTokens,
    multiSample,
    validationPasses,
    estimatedCostUsdPerCall,
  };
}
