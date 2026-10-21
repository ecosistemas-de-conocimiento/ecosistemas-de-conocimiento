/**
 * Canonical user-facing wording for "the AI service cannot serve this turn".
 *
 * This module is deliberately CLIENT-SAFE (no `$lib/server` imports, no env
 * access) because both the BFF and the browser bundle need the exact same
 * bytes: the server puts it in the error body, and `Chat.svelte` falls back to
 * it whenever the server tagged a failure with `AI_UNAVAILABLE_CODE`.
 * `$lib/server/aiService/messages.ts` re-exports it for server callers so the
 * server-only barrel stays the single import site there.
 */

/**
 * Shown for EVERY budget failure the requester does not own: both "no budget
 * row exists for this org" and "the org burned through its cap" render this
 * same sentence. The distinction is an operator concern, not a user concern —
 * a user can do nothing about either, and the upstream English text leaks the
 * org name and the budget state. The real cause is logged server-side instead;
 * see `logBudgetFailure()` in `$lib/server/aiService/errors.ts`.
 */
export const AI_UNAVAILABLE_MESSAGE =
  'El servicio de IA no está disponible. Contacta a la persona que administra el sistema.';

/**
 * Machine-readable tag carried alongside the message (HTTP 503, no
 * `Retry-After` — the outage is a provisioning problem with no predictable
 * clear time, so inviting an automatic retry would be a lie).
 */
export const AI_UNAVAILABLE_CODE = 'ai_unavailable';

/**
 * Warning code on a turn whose answer was generated but NOT saved (audit C-14).
 * The BFF sends it in `warnings` with `messageId: null`; `Chat.svelte` shows
 * `ANSWER_NOT_SAVED_MESSAGE` under the answer. Without it the failure was
 * silent: the answer vanished on reload, could not be rated, and was never
 * ingested.
 */
export const ANSWER_NOT_SAVED_CODE = 'ANSWER_NOT_SAVED';

export const ANSWER_NOT_SAVED_MESSAGE = 'No pudimos guardar esta respuesta.';

/** The notice to show under an answer, from the turn's warnings; `undefined` when none applies. */
export function answerNotice(
  warnings: readonly { code: string }[] | null | undefined,
): string | undefined {
  return warnings?.some((w) => w.code === ANSWER_NOT_SAVED_CODE) ? ANSWER_NOT_SAVED_MESSAGE : undefined;
}
