/**
 * WORD BREAKS — the one definition of "whole word" for the anonymiser.
 *
 * Stage 2's roster (`deterministic.ts`) and stage 3's findings (`gate.ts`) both
 * match names as whole words. They must agree on where a word ends, or a name
 * that one stage removes the other leaves in the corpus (Rodrigo's ruling,
 * 2026-10-21). Do not write a second copy of these rules.
 */

const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u

/** The character at or before `i`, skipping accent marks: the letter they sit on. */
function baseAt(text: string, i: number): string {
  while (i >= 0 && /\p{M}/u.test(text.charAt(i))) i--
  return i >= 0 ? text.charAt(i) : ''
}

/**
 * True when `left` and `right`, side by side, belong to ONE word.
 *
 * An accent mark is always part of the letter before it. A letter-digit change
 * and a lower-to-upper change are word breaks (final audit 2026-10-21): a name
 * glued to digits ("lucrecia88") or to another name ("MaríaLópez") is still a
 * word of its own. "ana" inside "mañana" or "anabel" is not.
 */
function glued(left: string, right: string): boolean {
  if (!WORD_CHAR.test(left) || !WORD_CHAR.test(right)) return false
  if (/\p{M}/u.test(right)) return true
  if (/\p{N}/u.test(left) !== /\p{N}/u.test(right)) return false
  return !(/\p{Ll}/u.test(left) && /\p{Lu}/u.test(right))
}

/** True when position `i` of `text` (between `i - 1` and `i`) is a word break. */
export function breakAt(text: string, i: number): boolean {
  return !glued(baseAt(text, i - 1), text.charAt(i))
}

/** True when `[start, end)` is a whole word: not glued to the text on either side. */
export function wholeWord(text: string, start: number, end: number): boolean {
  return breakAt(text, start) && breakAt(text, end)
}
