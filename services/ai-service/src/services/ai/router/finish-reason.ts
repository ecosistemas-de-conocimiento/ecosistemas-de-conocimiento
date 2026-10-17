// Normalize a provider's `finish_reason` onto the small closed set consumers
// can actually branch on.
//
// Why this exists
// ---------------
// Consumers need ONE question answered reliably: "was this response cut off
// because it hit the token cap?" A chat product that meters per-user credits
// by output tokens caps generation via
// `unit.specOverride.effortProfile.maxOutputTokens`, and must know whether the
// model stopped because it was done ('stop') or because it ran into that cap
// ('length'). Those two settle credits differently.
//
// The raw string cannot be used for that. OpenRouter fans out to providers
// that each spell the same event differently, and it does not fully normalize
// them:
//
//   OpenAI      stop | length | content_filter | tool_calls
//   Anthropic   end_turn | max_tokens | stop_sequence
//   Google      STOP | MAX_TOKENS | SAFETY | RECITATION      (upper-case)
//   Cohere      COMPLETE | MAX_TOKENS
//   Mistral     stop | length | model_length
//
// So `raw === 'length'` is a bug waiting for the first Anthropic-backed model:
// it reports `max_tokens` and the check silently returns false. We fold all of
// them into four values instead.
//
// Unknown values map to 'other' rather than throwing or guessing. A provider
// inventing a new reason must never fail a generation that already succeeded,
// and must never be silently reported as 'stop' — 'other' is the honest answer
// and leaves the caller free to treat it conservatively.
//
// A missing reason maps to `undefined`, NOT to 'stop'. Absent and "finished
// normally" are different facts, and the wire contract omits the field rather
// than asserting something we were never told.

/**
 * The closed set of finish reasons exposed on the wire.
 *
 * - `stop`           — the model finished on its own.
 * - `length`         — output was truncated at the token cap. The one that
 *                      matters for billing/credit settlement.
 * - `content_filter` — the provider withheld or truncated on safety grounds.
 * - `other`          — anything else, including provider-specific reasons we
 *                      do not model (tool calls, recitation, errors).
 */
export type FinishReason = 'stop' | 'length' | 'content_filter' | 'other';

/**
 * Provider spellings that mean "the model decided it was done".
 * `stop_sequence` belongs here: a stop sequence is a normal, intended end.
 */
const STOP_ALIASES = new Set([
  'stop',
  'stop_sequence',
  'end_turn',
  'eos',
  'eos_token',
  'complete',
  'completed',
  'finished',
]);

/**
 * Provider spellings that mean "truncated at the token cap". This is the set
 * the credits path depends on — adding a provider means adding it HERE.
 */
const LENGTH_ALIASES = new Set([
  'length',
  'max_tokens',
  'model_length',
  'max_output_tokens',
  'token_limit',
  'output_limit',
  'max_length',
]);

/** Provider spellings that mean "withheld on safety/policy grounds". */
const CONTENT_FILTER_ALIASES = new Set([
  'content_filter',
  'content_filtered',
  'safety',
  'recitation',
  'blocklist',
  'prohibited_content',
  'spii',
  'image_safety',
]);

/**
 * Fold a raw provider `finish_reason` onto {@link FinishReason}.
 *
 * Returns `undefined` when the provider told us nothing (null, undefined, or
 * an empty/whitespace string) so callers can omit the field instead of
 * inventing a value.
 *
 * Matching is case-insensitive and trims surrounding whitespace, because
 * Google returns SCREAMING_CASE and some gateways pad the value.
 */
export function normalizeFinishReason(
  raw: string | null | undefined,
): FinishReason | undefined {
  if (raw === null || raw === undefined) return undefined;
  const key = raw.trim().toLowerCase();
  if (key === '') return undefined;

  if (STOP_ALIASES.has(key)) return 'stop';
  if (LENGTH_ALIASES.has(key)) return 'length';
  if (CONTENT_FILTER_ALIASES.has(key)) return 'content_filter';

  return 'other';
}
