// The capability document (ADR-0004) — ai-service's public statement of which
// coupled behaviours THIS deployment actually has.
//
// ── Why this exists ───────────────────────────────────────────────────────
// ai-service and its consumers are version-coupled in BOTH directions, and each
// environment (dev / stage / prod / demo-0) runs its own ai-service. Until now
// the only control on promotion order was a human remembering a runbook, and
// that failed twice in one week: once silently (service ahead of consumer —
// degraded output, HTTP 200, no error anywhere) and once loudly but late
// (consumer ahead of service — every call throwing mid-user-action for a
// condition that was fully knowable at deploy time).
//
// This module lets a consumer ask, at boot, "does the ai-service I'm pointed at
// have what I need?" and refuse to start with an actionable message if not.
//
// ── Named capabilities, and NOTHING else ──────────────────────────────────
// Deliberate (ADR-0004 option B, rejected): a semver range forces every
// consumer to encode "which release added what", and it breaks across forks and
// re-tagged lineages.
//
// The document therefore carries no version, build id, or commit hash — not
// even as a human-facing label. An earlier draft reported a `serviceVersion`
// stamped from the build. It decided nothing, and no build pipeline actually
// stamped it (`SOURCE_COMMIT` was never passed), so it would have read
// `unknown` forever. A permanently-unknown field in a
// public contract is worse than no field: it invites a future reader to trust it
// and a future maintainer to hand-maintain it. The consumer already knows which
// deployment it asked — it holds the URL.
//
// ── The honesty contract ──────────────────────────────────────────────────
// A capability that reports `true` while broken is WORSE than no check at all:
// it converts a loud failure into a silent one, which is the exact failure this
// ADR was written to kill. So:
//
//   1. Every name below is documented with the surface it promises.
//   2. `capabilities.test.ts` probes each one against the real server/module —
//      a capability cannot be declared without evidence it is wired.
//   3. Names are ADDITIVE and STABLE. Never rename or repurpose a name: an old
//      consumer asking for `systemPrompt` must keep meaning what it meant when
//      it was written. Retiring a behaviour means flipping the value to `false`
//      (and keeping the key), never deleting the key.

/**
 * The capabilities this build ships. Keys are the stable public names
 * consumers declare; values are `true` when the behaviour is wired.
 *
 * A key MUST NOT be removed once published — see the honesty contract above.
 */
export const SERVICE_CAPABILITIES = Object.freeze({
  /**
   * `unit.systemPrompt` / `systemPromptOverride` are sent to the model as a
   * real `{ role: 'system' }` message, and `/v1/generate/sync` echoes
   * `systemPromptApplied` on the response so callers can assert per request.
   *
   * A consumer that has removed its own "fold the system prompt into the user
   * turn" workaround REQUIRES this. Without it the instructions vanish
   * silently. See `src/services/generation/system-prompt.ts`.
   */
  systemPrompt: true,

  /**
   * `registry_entries.meta_prompt_template` is resolved and rendered as a
   * standing system-prompt default (precedence 4). Before this existed the
   * column was inert — a socket designed and never wired — so a stored row
   * could look live while doing nothing.
   *
   * Consumers that rely on registry-authored prompts REQUIRE this.
   */
  registryMetaPromptTemplate: true,

  /**
   * Structured output is gated strictly: when `responseSchema` is set, `parsed`
   * is surfaced ONLY if the value validates against the FULL schema. Invalid
   * output yields a blocker flag and NO `parsed` — ai-service never reports
   * structured output it cannot vouch for.
   *
   * A consumer that trusts `parsed` without re-validating (i.e. one that has
   * dropped its own `JSON.parse` fallback) REQUIRES this.
   * See `src/services/ai/router/router.ts` ("STRICT `parsed` GATE").
   */
  strictParsed: true,

  /** `POST /v1/tenant/provision` (admin) — one-call tenant bootstrap. */
  tenantProvision: true,

  /**
   * `GET /v1/tenant/readiness` — self-diagnosis that collapses the three
   * unrelated-looking "this tenant was never provisioned" failures (401 /
   * "no active registry entry" / 402 BudgetNotConfigured) into one answer.
   */
  tenantReadiness: true,

  /**
   * Async ingest accepts a `callbackUrl` and delivers HMAC-signed completion
   * callbacks. Consumers that wait on a callback instead of polling REQUIRE
   * this, or they wait forever.
   */
  ingestChunkCallback: true,

  /** `POST /v1/route` — cheap capability router over a caller-supplied list. */
  capabilityRouter: true,

  /**
   * `unit.specDefault` is accepted on `/v1/generate`, `/v1/generate/sync` and
   * `/v1/generate/stream`, and resolved as a FLOOR: an active
   * `registry_entries` row for the unit-type WINS over it.
   *
   * This is the slot a consumer's BUILT-IN prompt belongs in. Without it the
   * only inline slot is `specOverride`, a CEILING — so a consumer shipping a
   * default prompt (the shared client's `text-to-sql` one, say) silently
   * discarded every registered row, and the project's registry edits did
   * nothing with no error anywhere.
   *
   * A consumer that has moved a built-in from `specOverride` to `specDefault`
   * REQUIRES this: an ai-service without it rejects the unknown key with a
   * `400`, because the unit schema is strict.
   */
  specDefaultSlot: true,

  /**
   * Budget enforcement is FAIL-CLOSED (ADR-0003 D5): an org with no provisioned
   * budget gets `402 BudgetNotConfigured` rather than unmetered spend.
   *
   * Consumers that surface budget errors to users, or that provision budget as
   * part of onboarding, want to know this is on.
   */
  budgetFailClosed: true,
});

/** A published capability name. */
export type CapabilityName = keyof typeof SERVICE_CAPABILITIES;

/** The wire shape of `GET /v1/capabilities`. */
export interface CapabilityDocument {
  /** Capability name → whether this deployment has it. That is the whole document. */
  capabilities: Record<string, boolean>;
}

/** The document served by `GET /v1/capabilities`. */
export function getCapabilityDocument(): CapabilityDocument {
  return { capabilities: { ...SERVICE_CAPABILITIES } };
}
