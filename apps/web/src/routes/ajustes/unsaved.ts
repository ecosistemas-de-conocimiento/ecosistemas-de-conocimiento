/**
 * `/ajustes` — ask before leaving with unsaved changes (switching ecosistema,
 * any link, back, reload, closing the tab).
 *
 * ⚠ ONE HOOK COVERS BOTH. SvelteKit's `beforeNavigate` also fires on a full
 * unload (`type: 'leave'`); cancelling that makes the browser show its own
 * beforeunload prompt, since a page may not show a custom one there. Every
 * other navigation gets a native `confirm`.
 */

export const LEAVE_PROMPT = 'Hay cambios sin guardar. ¿Salir?';

export interface LeavingNav {
  type: string;
  cancel: () => void;
}

export function guardLeave(dirty: boolean, nav: LeavingNav, ask: (message: string) => boolean): void {
  if (!dirty) return;
  if (nav.type === 'leave' || !ask(LEAVE_PROMPT)) nav.cancel();
}
