/**
 * Answer ratings — pure helpers shared by the store, the BFF proxy route and
 * the star-rating UI.
 *
 * Wire contract (backend `ratings` collection, exposed at `/api/ratings`):
 *   message      relationship → messages   (required)
 *   session      relationship → sessions   (required)
 *   organization relationship → organizations
 *   user         relationship → users
 *   stars        integer 1–5               (required)
 *   comment      text                      (optional)
 *
 * One row per (message, user): re-rating UPDATES the existing row. The proxy
 * route enforces that by looking the row up first (see
 * `routes/api/sessions/[id]/ratings/+server.ts`), so the invariant holds even
 * if the collection itself has no upsert hook.
 *
 * `organization` and `user` are NOT sent from the browser — the backend derives
 * them from the authenticated request. The frontend has no trustworthy org id
 * and must not be able to claim one.
 */

export const MIN_STARS = 1;
export const MAX_STARS = 5;

/**
 * Normalise a Payload id, which arrives as a number, a numeric string, or a
 * populated relationship object (`depth > 0`). Returns '' when there is none.
 */
export function idOf(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number') return String(raw);
  if (raw && typeof raw === 'object' && 'id' in raw) {
    return idOf((raw as { id: unknown }).id);
  }
  return '';
}

/** True for an integer in [MIN_STARS, MAX_STARS]. Rejects '4', 4.5, NaN, null. */
export function isValidStars(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_STARS &&
    value <= MAX_STARS
  );
}

/** Every value on the scale, in order. The one place the scale is enumerated. */
export const STAR_VALUES: readonly number[] = Array.from(
  { length: MAX_STARS - MIN_STARS + 1 },
  (_, i) => MIN_STARS + i,
);

/**
 * Clamp an arbitrary number onto the 1–5 integer scale. Used by the keyboard
 * handler, which walks the value up and down past the ends of the scale.
 * `NaN` has no position on the scale at all, so it collapses to the minimum.
 */
export function clampStars(value: number): number {
  if (Number.isNaN(value)) return MIN_STARS;
  return Math.min(MAX_STARS, Math.max(MIN_STARS, Math.round(value)));
}

/** What a key press means to a rating group, or null when it means nothing. */
export type StarMove = 'next' | 'prev' | 'first' | 'last';

/**
 * Map a `KeyboardEvent.key` to a movement, per the WAI-ARIA radio-group
 * pattern: **Down/Right = next, Up/Left = previous**, Home/End = the ends.
 *
 * Getting Up/Down the wrong way round is a silent a11y bug — a screen-reader
 * user gets the opposite of what the pattern trained them to expect — so the
 * mapping lives here where a test can pin it.
 */
export function starMoveForKey(key: string): StarMove | null {
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return 'next';
    case 'ArrowLeft':
    case 'ArrowUp':
      return 'prev';
    case 'Home':
      return 'first';
    case 'End':
      return 'last';
    default:
      return null;
  }
}

/**
 * Where focus goes from `from` for a given movement. Saturates at both ends
 * (a radio group does not wrap) and always lands on a real star.
 *
 * `from` is null / off-scale when the group has no value and has not been
 * navigated yet. In that state the FIRST arrow press lands on the first star
 * whichever direction it was — there is nothing to step away from, and
 * stepping "next from nothing" must not skip star one.
 */
export function nextStarFocus(from: number | null | undefined, move: StarMove): number {
  if (move === 'first') return MIN_STARS;
  if (move === 'last') return MAX_STARS;
  if (!isValidStars(from)) return MIN_STARS;
  return clampStars(move === 'next' ? from + 1 : from - 1);
}

/**
 * Fold a `/api/ratings` list read into `messageId → stars`.
 *
 * Rows with an unusable `message` relationship or an out-of-range `stars` are
 * dropped rather than rendered — a bad row must not paint a wrong value on an
 * answer. Later rows win, so a duplicate (which the one-row-per-pair invariant
 * should prevent) resolves to the most recently returned one.
 */
/** Everything this user said about one answer. */
export interface StoredRating {
  stars: number;
  reason: string | null;
  comment: string | null;
}

/**
 * Index the caller's ratings by message id.
 *
 * ⚠ Carries the REASON too, not only the score. Without it a reload showed the
 * stars but silently dropped the chip the person had picked — so the UI said
 * "no reason given" about a reason that was stored, and clicking a chip again
 * rewrote a value that had never changed.
 */
export function ratingsByMessage(docs: unknown): Map<string, StoredRating> {
  const out = new Map<string, StoredRating>();
  if (!Array.isArray(docs)) return out;
  for (const row of docs) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const messageId = idOf(r.message);
    if (!messageId) continue;
    const stars = typeof r.stars === 'number' ? r.stars : Number(r.stars);
    if (!isValidStars(stars)) continue;
    out.set(messageId, {
      stars,
      reason: typeof r.reason === 'string' && r.reason ? r.reason : null,
      comment: typeof r.comment === 'string' && r.comment ? r.comment : null,
    });
  }
  return out;
}

/**
 * A message can only be rated once the backend has issued it an id. Optimistic
 * placeholders carry a `local-…` id (see `addLocalMessage`) and there is
 * nothing to attach a rating row to yet.
 */
export function isRatableMessageId(id: string): boolean {
  return Boolean(id) && !id.startsWith('local-');
}

// ---------------------------------------------------------------------------
// WHY a score was given
// ---------------------------------------------------------------------------

/**
 * The preset reasons, and their Spanish labels.
 *
 * 🔴 THE VALUES MUST MATCH THE BACKEND. They are the stored column
 * (`ratings.reason`), and the backend rejects a value that is not in the list
 * for that score — see `Ratings.ts > normalizeFeedback`. The labels are ours;
 * the keys are a contract.
 *
 * ⚠ TWO LISTS, PICKED BY SCORE. "What went wrong" and "what worked" are
 * different questions. Showing "se lo inventó" under a 5-star rating is noise,
 * and one neutral list ends up phrased so vaguely that nobody picks anything.
 * The split is at 4, same as the backend's.
 */
export const LOW_SCORE_REASONS = [
  { value: 'not-grounded', label: 'Cita algo que la fuente no dice' },
  { value: 'invented', label: 'Se lo inventó' },
  { value: 'incomplete', label: 'Le faltó lo importante' },
  { value: 'unclear', label: 'No se entiende' },
  { value: 'wrong-language', label: 'Idioma o tono equivocado' },
] as const;

export const HIGH_SCORE_REASONS = [
  { value: 'accurate', label: 'Coincide con la fuente' },
  { value: 'well-sourced', label: 'Fácil de verificar' },
  { value: 'clear', label: 'Se entiende bien' },
  { value: 'complete', label: 'Respondió todo' },
] as const;

export const OTHER_REASON = 'other';
export const OTHER_REASON_LABEL = 'Otro';

export interface RatingReasonOption {
  value: string;
  label: string;
}

/**
 * The reasons offered for a score. `Otro` is always last, and always present —
 * it is what lets someone disagree with the whole list instead of picking the
 * least-wrong option.
 */
export function reasonsForStars(stars: number): RatingReasonOption[] {
  const base = stars <= 3 ? LOW_SCORE_REASONS : HIGH_SCORE_REASONS;
  return [...base, { value: OTHER_REASON, label: OTHER_REASON_LABEL }];
}

/** Is this reason offered for this score? Mirrors the backend's check. */
export function isReasonValidFor(stars: number, reason: string | null | undefined): boolean {
  if (!reason) return true; // no reason at all is always valid
  return reasonsForStars(stars).some((r) => r.value === reason);
}

/**
 * The prompt above the chips. Asks the question the score implies, so the
 * chips read as answers rather than as a taxonomy.
 */
export function reasonPromptFor(stars: number): string {
  return stars <= 3 ? '¿Qué salió mal?' : '¿Qué estuvo bien?';
}
