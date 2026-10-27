/**
 * The two kinds of conversation (owner ruling 2026-10-26), as pure data.
 *
 *  · `generales` — answers from the documents. Every conversation made before
 *    the split is one, and a row with no kind reads as one.
 *  · `resonancias` — every turn is an interview: the system asks how the
 *    person's own experience relates to a concept in the corpus
 *    (`resonanciasSystemPrompt` in `$lib/server/engine/prompt`).
 *
 * The kind is chosen when the conversation is created (the active tab in the
 * sidebar) and never changes: `sessions.kind` is immutable on the backend, and
 * the PATCH route drops it.
 *
 * Lives here, not in the Sidebar, because `apps/web` runs vitest in `node`
 * with no DOM (see `$lib/nav`): a plain module can be asserted.
 */

export type SessionKind = 'generales' | 'resonancias';

/** Tab order in the sidebar. */
export const SESSION_KINDS: readonly SessionKind[] = ['generales', 'resonancias'];

/** The tab labels. Labels only — no explainer copy (owner rule, minimal copy). */
export const SESSION_KIND_LABELS: Record<SessionKind, string> = {
  generales: 'Generales',
  resonancias: 'Resonancias',
};

/** `sessions.kind` → a kind. Missing, blank or unknown is `generales`. */
export function parseSessionKind(raw: unknown): SessionKind {
  return raw === 'resonancias' ? 'resonancias' : 'generales';
}

/** The conversations in one tab, order kept. */
export function sessionsOfKind<T extends { kind?: SessionKind }>(list: readonly T[], kind: SessionKind): T[] {
  return list.filter((s) => parseSessionKind(s.kind) === kind);
}

/** Per viewer, per browser. Not shared, not sent anywhere. */
export const SESSION_KIND_TAB_KEY = 'edc.conversaciones.pestana';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * The tab this viewer last picked, or `generales`.
 *
 * ⚠ Every storage access is wrapped (same rule as `graph/viewMode`): storage
 * can be missing, throw, or hold junk, and none of that may break the sidebar.
 */
export function readSessionKindTab(storage: () => StorageLike | null | undefined): SessionKind {
  try {
    return parseSessionKind(storage()?.getItem(SESSION_KIND_TAB_KEY));
  } catch {
    return 'generales';
  }
}

/** Remember the tab. A storage that throws just forgets it. */
export function writeSessionKindTab(storage: () => StorageLike | null | undefined, kind: SessionKind): void {
  try {
    storage()?.setItem(SESSION_KIND_TAB_KEY, kind);
  } catch {
    // Not remembered; the tab still switches for this visit.
  }
}
