/**
 * Conversation titles (UX backlog #14).
 *
 * The auto-title is the first message, shortened. It used to be a raw
 * `slice(0, 48)`, which cut words in half ("¿Qué barreras enfrentan las
 * personas con discapa"). Now it cuts at the last space that fits and says it
 * was cut with "…".
 */

/** Longest auto-title, in characters, "…" included. */
export const AUTO_TITLE_MAX = 48;

/** Longest title a person can type when renaming. */
export const TITLE_MAX = 120;

export function autoTitle(text: string, max: number = AUTO_TITLE_MAX): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const room = clean.slice(0, max - 1);
  const lastSpace = room.lastIndexOf(' ');
  // A single very long word has no space to cut at: cut it, still with "…".
  const cut = lastSpace >= max / 3 ? room.slice(0, lastSpace) : room;
  return `${cut.replace(/[\s,.;:¿¡!?-]+$/, '')}…`;
}

/** A typed title, cleaned. `null` means "keep the old one". */
export function cleanTitle(raw: string): string | null {
  const t = raw.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
  return t ? t : null;
}
