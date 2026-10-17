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

import { STRICT_SCHEMA_MODELS } from './services/ai/router/strict-schema.js';

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

  /**
   * `POST /v1/retrieve` reports `legs` — the retrieval legs that actually
   * CONTRIBUTED rows to the response — and names the two lexical legs apart
   * (`lexical` = Postgres full-text, `sparse` = learned-sparse bge-m3) instead
   * of labelling both `lexical`.
   *
   * This is the capability that makes retrieval degradation checkable, and the
   * reason it needs a capability rather than a feature-detect is that its
   * absence is INDISTINGUISHABLE from its failure case. The rerank rung is
   * fail-safe: a dead reranker returns the fused order, so the response is
   * byte-identical to `rerank: false` minus `rerankScore`. A consumer probing
   * "is `legs` there?" against an older deployment reads `undefined` and cannot
   * tell "this service does not report legs" from "no leg ran". Requiring the
   * capability makes the older service refuse to boot instead of answering
   * plausibly and wrongly.
   *
   * A consumer that asserts on `legs` — a canary asserting `rerank` really ran,
   * an eval comparing leg coverage — REQUIRES this. See
   * `src/services/rag/retrieve.ts` (stage 2.5) and `retrieveResponseSchema` in
   * `src/contract/responses.ts`.
   */
  retrievalLegs: true,

  /**
   * Outbound payloads are PII-MINIMISED at the egress seams before they leave
   * the perimeter: both OpenRouter chat paths (sync and streaming), the
   * embeddings adapter (so ingest, `/v1/embed` and retrieve alike), the RERANK
   * client (the whole candidate pool, `min(topK * 4, 50)` passages), the SPARSE-EMBED client (`callSparseEmbed`, chunk and query
   * text sent to `SPARSE_EMBED_URL`; SECURITY_OPEN §15, added on
   * `fix/pii-sparse-embed-scrub`), and the two free-prose `traces` columns (`input_payload` /
   * `output_payload`, stored SCRUBBED ONLY with no reversible map). CURP, RFC,
   * email, MX phone numbers and MX addresses are replaced by placeholder tokens
   * (`[CURP]`, `[RFC]`, `[EMAIL]`, `[TELEFONO]`, `[DIRECCION]`).
   *
   * 🔴 THIS FILE DESCRIBES THE CODE, NOT ANY RUNNING SERVICE, and for the rerank
   * seam those differ RIGHT NOW. A deployment serves whatever image it was built
   * from, so a service running a build older than `ee844cd` answers
   * `piiMinimisation: true` from code where the rerank pool is UNSCRUBBED.
   * MEASURED: `ai.dev.example.org/v1/capabilities` returned `true`
   * while dev ran an image that predated the rerank seam; stage and prod were
   * further behind. That is a dated snapshot, not current state: which commit
   * each environment runs now is a deploy fact (assumed per handoff, not
   * measured here — dev exposes no commit; `/health` returns only
   * `{status, service}`, measured). Check the deploy record.
   * ⇒ Do NOT date this seam's protection from a commit or a merge. Protection
   * begins when an environment is DEPLOYED with the code, and this file cannot
   * know which environment is reading it.
   *
   * ⚠ This is the honesty contract at the top of this file failing in the
   * OPPOSITE direction from the one it was written for. It exists to stop a
   * capability reading `true` while the wiring is inert. Here the SOURCE is more
   * protective than the running service — and the wire, being
   * `Record<string, boolean>`, cannot tell the two apart either way.
   *
   * ⚠ THIS LIST WAS WRONG BEFORE THE RERANK SEAM LANDED, and the correction is
   * recorded rather than silently applied because a consumer may have read the
   * earlier version. The rerank leg sent its pool UNSCRUBBED from the
   * DeepInfra cutover until the wiring landed. Before the cutover the
   * rung was dead, so nothing crossed the perimeter there and the omission was
   * harmless; between those two dates it was not.
   *
   * 🔴 AND THE INFERENCE THIS NEW SEAM INVITES, WHICH IS WRONG: "the rerank pool
   * is scrubbed" does NOT mean "personal records are safe to rerank on a third
   * party". The scrub removes the five PATTERNS below and nothing else. A corpus
   * of council minutes or citizen correspondence is mostly NAMES, and names are
   * exactly what survives — see the ceiling immediately below. Scrubbing the
   * pool changed what a reranker receives; it did not change what may be sent.
   *
   * ⚠ THE CEILING, and a consumer MUST NOT read past it: this is PRESENCE, not
   * STRENGTH. What it promises is that the minimiser RUNS at the seam and that a
   * synthetic CURP does not survive it. It promises NOTHING about recall on real
   * Spanish text, and in particular the rules layer has NO `person` detector — a
   * name written in running Spanish is not a pattern, so names still reach the
   * provider. Quote no eval number against this capability; no real Spanish
   * golden set exists. A consumer with a legal obligation about names needs the
   * NER detector installed, which is a separate, unmade decision.
   *
   * It fails CLOSED, which is the second half of what the name is worth: if the
   * minimiser cannot finish, the provider call is REFUSED rather than made with
   * the raw payload. A consumer that sees a 503 `ERR_PII_MINIMISATION_FAILED` is
   * seeing this working, not this broken.
   *
   * Two consumers need to know: one that must state where personal data goes,
   * and one whose prompts contain identifiers and would otherwise be surprised
   * to read `[CURP]` back in a model's answer. See
   * `src/services/ai/pii-egress.ts` and `src/services/ai/pii/`.
   *
   * 🔴 NONE OF THIS CEILING CROSSES THE WIRE. `CapabilityDocument` is
   * `Record<string, boolean>` (see below), so a consumer receives `true` and
   * cannot learn which seams are covered, that names are not detected, or that
   * the list above was once incomplete. Everything qualifying this capability is
   * SOURCE-ONLY. A consumer with a legal obligation must read this comment or
   * ask; it cannot discover any of it from `GET /v1/capabilities`.
   */
  piiMinimisation: true,

  /**
   * `responseSchemaStrict: true` (in `unit.specOverride` / `unit.specDefault`)
   * is honoured: the provider is asked for STRICT schema-constrained output
   * (`response_format: json_schema`, `strict: true`, plus OpenRouter's
   * `provider.require_parameters` so an endpoint cannot drop it), instead of
   * JSON mode. An unsupported model or a schema outside the strict subset is a
   * `400 SpecResolutionError` — never a silent fall back to JSON mode.
   *
   * WHICH MODELS: the document also carries one key per supported model,
   * `strictStructuredOutput:<model id>` (see `strictModelCapabilityName` and
   * `getCapabilityDocument`). A consumer that pins a model REQUIRES both names,
   * e.g. `['strictStructuredOutput', 'strictStructuredOutput:openai/gpt-4o-mini']`,
   * so a deployment that cannot run that model strictly refuses at boot rather
   * than 400ing mid-request. Older ai-service builds lack both, and an older
   * build would otherwise reject the unknown spec key with a 400 (the unit
   * schema is strict). See `src/services/ai/router/strict-schema.ts`.
   */
  strictStructuredOutput: true,
});

/**
 * The per-model capability name for strict structured output. One per entry in
 * `STRICT_SCHEMA_MODELS`. Same honesty rule as every other name: a model that
 * loses support flips to `false`, its key is never deleted.
 */
export function strictModelCapabilityName(model: string): string {
  return `strictStructuredOutput:${model}`;
}

/** A published capability name. */
export type CapabilityName = keyof typeof SERVICE_CAPABILITIES;

/** The wire shape of `GET /v1/capabilities`. */
export interface CapabilityDocument {
  /** Capability name → whether this deployment has it. That is the whole document. */
  capabilities: Record<string, boolean>;
}

/** The document served by `GET /v1/capabilities`. */
export function getCapabilityDocument(): CapabilityDocument {
  const strictModels = Object.fromEntries(
    STRICT_SCHEMA_MODELS.map((m) => [strictModelCapabilityName(m), true] as const),
  );
  return { capabilities: { ...SERVICE_CAPABILITIES, ...strictModels } };
}
