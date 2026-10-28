/**
 * "Hazme preguntas" — the per-conversation switch that lets a Generales
 * conversation meet the interviewer (owner ruling 2026-10-27). Off by default.
 *
 * The server rule (`routes/api/generate/+server.ts`): interviewer on Generales
 * only when the ecosistema's `interviewerMode` is on AND this switch is on AND
 * `chatTurnMode` reads the message as the person's own story. Resonancias
 * ignores it.
 *
 * ⚠ Remembered per conversation id, per browser, in `localStorage` — no backend
 * field, so no migration. Another device starts with it off.
 */

/** The switch's label. Short, no explainer copy (owner rule). */
export const ENTREVISTA_LABEL = 'Hazme preguntas';

const KEY_PREFIX = 'edc.entrevista.';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const entrevistaKey = (sessionId: string): string => `${KEY_PREFIX}${sessionId}`;

/** On for this conversation? Any storage failure, or no id, reads as off. */
export function readEntrevista(storage: () => StorageLike | null | undefined, sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  try {
    return storage()?.getItem(entrevistaKey(sessionId)) === '1';
  } catch {
    return false;
  }
}

/** Remember it. Off removes the key, so nothing piles up. A throwing storage forgets. */
export function writeEntrevista(
  storage: () => StorageLike | null | undefined,
  sessionId: string | null | undefined,
  on: boolean,
): void {
  if (!sessionId) return;
  try {
    const s = storage();
    if (!s) return;
    if (on) s.setItem(entrevistaKey(sessionId), '1');
    else s.removeItem(entrevistaKey(sessionId));
  } catch {
    // Not remembered; the switch still holds for this visit.
  }
}

/** Is the switch shown? Generales, with the ecosistema's `interviewerMode` on. */
export function showsEntrevista(kind: string, interviewerMode: boolean): boolean {
  return kind === 'generales' && interviewerMode;
}
