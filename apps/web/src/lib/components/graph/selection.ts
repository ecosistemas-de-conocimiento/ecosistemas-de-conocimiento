/**
 * Node selection on the whole-graph map, as pure rules (owner, 2026-10-21):
 * a click on a node selects it, a second click on it clears it (as before);
 * Esc or a click on empty space clears it. Same
 * rules in 2D and 3D. Kept out of the `.svelte` file because `apps/web`'s
 * vitest has no DOM.
 */

export type SelectionEvent =
  | { kind: 'node'; id: string }
  | { kind: 'background' }
  | { kind: 'escape' };

/** The selection after `event`. A click on the selected node toggles it off. */
export function nextSelection(current: string | null, event: SelectionEvent): string | null {
  switch (event.kind) {
    case 'node':
      return event.id === current ? null : event.id;
    case 'background':
    case 'escape':
      return null;
  }
}

/** The bits of a `KeyboardEvent` the Esc rule reads. */
export interface EscapeKeyLike {
  key: string;
  defaultPrevented?: boolean;
  target?: unknown;
}

/**
 * Whether an Esc press belongs to the map.
 *
 * ⚠ NOT WHILE TYPING, and not when something else already used it: Esc in the
 * search box clears the box, and Esc in the ecosistema picker closes the
 * picker. Neither may also drop the selected entity.
 */
export function isMapEscape(event: EscapeKeyLike): boolean {
  if (event.key !== 'Escape' || event.defaultPrevented) return false;
  const target = event.target as { tagName?: unknown; isContentEditable?: unknown } | null;
  const tag = typeof target?.tagName === 'string' ? target.tagName.toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return false;
  return target?.isContentEditable !== true;
}
