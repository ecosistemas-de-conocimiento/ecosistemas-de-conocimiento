/**
 * Where chat's prompt spec comes from: chat's own inline override, or
 * ai-service's prompt registry.
 *
 * ## Why this is a runtime flag and not just a code change
 *
 * ai-service resolves a generation spec through a precedence chain
 * (`src/services/registry/resolve.ts`) whose TOP slot is the caller's inline
 * `unit.specOverride`. chat has always filled that slot, so it has never read
 * the registry. Moving to the registry means simply not sending the override —
 * but that is only safe once a registry row EXISTS for chat's tenant:
 *
 *   `resolve.ts` throws `SpecResolutionError` → HTTP 400 when there is no
 *   inline override, no active registry row AND no `project_configs` row.
 *   `project_configs` is empty on dev, stage and prod, so flipping before the
 *   row is seeded is a 400 on every chat turn — not a degraded path.
 *
 * The row is seeded by the backend at boot (`src/seed/registry.ts`). Those are
 * two separately-deployed services, so the flip cannot be a code constant: it
 * has to be something an operator turns on AFTER confirming the row landed, and
 * can turn off again in seconds without a code deploy. Hence an env var.
 *
 * ## Operating it
 *
 *   1. Deploy the backend with the registry seed. Check its boot log for
 *      `[seed-registry] verified: chat app key resolves this row`.
 *      ⚠ If it logs `SCOPE FAULT`, STOP — the admin and app keys are scoped to
 *      different projects and the row is invisible to chat.
 *   2. Only then set `PROMPT_SOURCE=registry` on the chat FE.
 *   3. Rollback is unsetting it again — no deploy.
 *
 * Default is `inline`, i.e. exactly today's behaviour, so this whole branch is
 * safe to land and deploy at any point in that sequence.
 */

import { env } from '$env/dynamic/private';

/** Value of `PROMPT_SOURCE` that switches chat onto the registry. */
export const PROMPT_SOURCE_REGISTRY = 'registry';

/**
 * The decision, as a pure function of the configured value — split out from the
 * env read so it is testable without mutating SvelteKit's `$env` module (which
 * resolves once and cannot be poked at runtime).
 *
 * Fails CLOSED on anything that is not the exact opt-in string. The asymmetry is
 * deliberate: being wrongly OFF is exactly today's behaviour, while being
 * wrongly ON is an HTTP 400 on every chat turn in an environment whose registry
 * row has not been seeded. A typo must therefore not half-enable the flip.
 */
export function isRegistrySource(value: string | undefined): boolean {
  return value === PROMPT_SOURCE_REGISTRY;
}

/**
 * `true` when chat should let ai-service's registry supply the prompt spec, so
 * the wire builder omits `unit.specOverride` entirely.
 *
 * Read per call rather than memoised: `$env/dynamic/private` is resolved at
 * runtime, so an operator flipping this does not need a code deploy.
 */
export function useRegistryPrompt(): boolean {
  return isRegistrySource(env.PROMPT_SOURCE);
}
