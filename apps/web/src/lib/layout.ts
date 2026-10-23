/**
 * The chat workspace's RESPONSIVE RULES, as pure data.
 *
 * ── 🔴 THE PROBLEM ──────────────────────────────────────────────────────────
 *
 * `routes/+page.svelte` puts three panes side by side: the conversation list
 * (256px), the chat, and the documents panel (384px). That is 640px of fixed
 * furniture before the chat gets a single pixel. On a 380px phone the chat is
 * off-screen entirely; at 768px it is a 128px column. The app's primary surface
 * was unreachable on the device most of its readers own.
 *
 * ── 🔴 THE DECISION, AND WHY ────────────────────────────────────────────────
 *
 * Below `NARROW_MAX_WIDTH` the chat takes the whole width and the other two
 * become OVERLAY DRAWERS, one at a time, opened from two word-labelled buttons
 * directly above the chat.
 *
 * Three alternatives were considered and rejected:
 *
 * · **Tabs (chat / conversaciones / documentos as peers).** Rejected. It makes
 *   the chat one of three equals when it is the reason the app exists, and
 *   swapping the chat out of the DOM loses the scroll position and whatever is
 *   half-typed in the composer. The brief's "must reach all three without
 *   losing their place in the conversation" is exactly this failure.
 * · **Stacking the three vertically.** Rejected. The composer has to stay
 *   pinned to the bottom of the viewport; a stacked document panel either
 *   pushes it off-screen or competes with it for the same edge.
 * · **A hamburger holding both.** Rejected on the same grounds as the primary
 *   nav — see `$lib/nav.ts`. One unlabelled glyph hiding two destinations is
 *   the fastest way to make this app unusable for its readers.
 *
 * An overlay keeps the conversation MOUNTED and SCROLLED underneath. Closing
 * the drawer returns to exactly the pixel the reader left.
 *
 * ── WHY THIS IS A MODULE AND NOT JUST CSS ───────────────────────────────────
 *
 * `apps/web` runs vitest in **node with no DOM**, so nothing rendered can be
 * asserted (see `$lib/nav.ts`, same reasoning). The breakpoint, the Spanish
 * labels, the ids that `aria-controls` points at, and the one-at-a-time rule
 * live here so they can be tested; `ChatWorkspace.svelte` only draws them.
 */

/**
 * Which supporting panel is showing on a narrow screen.
 *
 * ⚠ There is no `'both'`. Two 288px drawers do not fit on a 380px screen, and
 * a half-covered drawer behind another drawer is not a state anyone can act on.
 */
export type MobilePanel = 'none' | 'conversations' | 'documents';

/**
 * Below this width the three columns become chat + two drawers.
 *
 * 🔴 64rem (1024px), not a phone width. The arithmetic decides it: 256px of
 * conversation list plus 384px of documents leaves 128px of chat at 768px,
 * which is broken in the same way 380px is, only less obviously. A tablet in
 * portrait is a narrow screen for a three-pane app.
 *
 * ⚠ CSS `@media` cannot read a custom property, so the same number is written
 * out in `ChatWorkspace.svelte`'s media queries. The test below pins them
 * together by reading the component's source.
 */
export const NARROW_MAX_WIDTH_REM = 64;

/** The `matchMedia` query for the drawer mode. Matches the component's CSS. */
export const NARROW_MEDIA_QUERY = `(max-width: ${NARROW_MAX_WIDTH_REM - 0.01}rem)`;

/**
 * Toggle rule: pressing the open panel's own button closes it, pressing the
 * other one swaps.
 *
 * ⚠ Swapping rather than stacking is deliberate — see `MobilePanel`.
 */
export function toggleMobilePanel(current: MobilePanel, requested: MobilePanel): MobilePanel {
  if (requested === 'none') return 'none';
  return current === requested ? 'none' : requested;
}

/**
 * The buttons that open the drawers.
 *
 * 🔴 EVERY ONE OF THEM IS A WORD. No hamburger, no chevron, no paper-clip. This
 * product's readers are people for whom a glyph is a guess, and a control whose
 * only label is a shape is a control they will not press. Same rule as the
 * primary nav, for the same reason.
 *
 * ⚠ `panelId` is what the button's `aria-controls` points at and what the
 * drawer element's `id` must be. If they drift, a screen-reader user is told
 * the button controls something that is not on the page.
 */
export interface MobilePanelToggle {
  panel: Exclude<MobilePanel, 'none'>;
  /** The visible word on the button. Plain Spanish, no jargon. */
  label: string;
  /** The drawer's own accessible name, and the heading a reader lands on. */
  drawerLabel: string;
  /** `id` of the drawer element; the button's `aria-controls`. */
  panelId: string;
}

export const MOBILE_PANEL_TOGGLES: readonly MobilePanelToggle[] = [
  {
    panel: 'conversations',
    label: 'Conversaciones',
    drawerLabel: 'Tus conversaciones',
    panelId: 'panel-conversaciones',
  },
  {
    panel: 'documents',
    label: 'Documentos',
    drawerLabel: 'Documentos de esta conversación',
    panelId: 'panel-documentos',
  },
];

/** The word on the button that closes an open drawer. Never a bare “×”. */
export const CLOSE_PANEL_LABEL = 'Cerrar';

/**
 * The accessible name of the bar holding the two buttons.
 *
 * ⚠ It is NOT a `<nav>`. The app already has two navigation landmarks — the
 * primary section menu and the conversation list — and both are named so a
 * screen-reader user can tell them apart. A third one that opens panels rather
 * than going anywhere would make that list worse, not better. It is a plain
 * labelled group of buttons.
 */
export const MOBILE_PANEL_BAR_LABEL = 'Mostrar u ocultar paneles';

/** Is this toggle's drawer the one currently showing? Drives `aria-expanded`. */
export function isPanelOpen(current: MobilePanel, panel: MobilePanel): boolean {
  return current === panel && current !== 'none';
}

/**
 * What the message box says when it is empty.
 *
 * ⚠ SHORT ON PURPOSE, AT EVERY WIDTH (owner, 2026-10-21). The old hints about
 * `@` and `Shift+Enter` wrapped and were cut off mid-word on a phone, and on a
 * wide screen they were noise.
 */
export function composerPlaceholder(busy: boolean): string {
  return busy ? 'Generando…' : 'Escribe un mensaje…';
}
