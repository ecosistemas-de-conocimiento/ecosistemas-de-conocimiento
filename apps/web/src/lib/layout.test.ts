import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CLOSE_PANEL_LABEL,
  MOBILE_PANEL_BAR_LABEL,
  MOBILE_PANEL_TOGGLES,
  NARROW_MAX_WIDTH_REM,
  NARROW_MEDIA_QUERY,
  composerPlaceholder,
  emptyChatHint,
  isPanelOpen,
  toggleMobilePanel,
  type MobilePanel,
} from './layout';

/**
 * vitest here runs in **node with no DOM**, so `ChatWorkspace.svelte` cannot be
 * rendered. What CAN be asserted is the rules and the strings it draws — plus,
 * by reading its source as text, the couple of facts that have to agree between
 * the module and the stylesheet.
 */

const workspaceSrc = readFileSync(
  fileURLToPath(new URL('./components/ChatWorkspace.svelte', import.meta.url)),
  'utf8',
);

describe('one supporting panel at a time', () => {
  it('opens the one that was asked for', () => {
    expect(toggleMobilePanel('none', 'conversations')).toBe('conversations');
    expect(toggleMobilePanel('none', 'documents')).toBe('documents');
  });

  it('closes when the open panel is asked for again', () => {
    expect(toggleMobilePanel('documents', 'documents')).toBe('none');
  });

  it('swaps rather than stacking — two drawers do not fit on 380px', () => {
    expect(toggleMobilePanel('conversations', 'documents')).toBe('documents');
    expect(toggleMobilePanel('documents', 'conversations')).toBe('conversations');
  });

  it('never reports two panels open', () => {
    const states: MobilePanel[] = ['none', 'conversations', 'documents'];
    for (const s of states) {
      const openCount = MOBILE_PANEL_TOGGLES.filter((t) => isPanelOpen(s, t.panel)).length;
      expect(openCount).toBeLessThanOrEqual(1);
    }
    expect(isPanelOpen('none', 'none')).toBe(false);
  });
});

describe('every control says a word', () => {
  it('labels both toggles in plain Spanish', () => {
    expect(MOBILE_PANEL_TOGGLES.map((t) => t.label)).toEqual(['Conversaciones', 'Documentos']);
  });

  it('closes with a word, not a glyph', () => {
    expect(CLOSE_PANEL_LABEL).toBe('Cerrar');
  });

  it('has no label that is only punctuation or a symbol', () => {
    // 🔴 The established constraint: no icon-only controls. A label made of
    // "×", "‹" or "☰" is an icon wearing a string's clothes.
    const labels = [
      ...MOBILE_PANEL_TOGGLES.flatMap((t) => [t.label, t.drawerLabel]),
      CLOSE_PANEL_LABEL,
      MOBILE_PANEL_BAR_LABEL,
    ];
    for (const l of labels) {
      expect(l).toMatch(/^[\p{L}][\p{L}\p{M} .,áéíóúñÁÉÍÓÚÑ]+$/u);
      expect(l.trim().length).toBeGreaterThan(3);
    }
  });

  it('gives every drawer its own accessible name, distinct from the button', () => {
    const names = MOBILE_PANEL_TOGGLES.map((t) => t.drawerLabel);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('the aria wiring points at something real', () => {
  it('every aria-controls id is the id of a drawer in the component', () => {
    for (const t of MOBILE_PANEL_TOGGLES) {
      expect(t.panelId).toMatch(/^panel-[a-z]+$/);
    }
    // The component sets both `aria-controls={t.panelId}` and `id={t.panelId}`
    // from the same field, so they cannot drift — assert that shape survives.
    expect(workspaceSrc).toContain('aria-controls={t.panelId}');
    expect(workspaceSrc).toContain('id={t.panelId}');
  });

  it('reports the open state to assistive tech, not only in colour', () => {
    expect(workspaceSrc).toContain('aria-expanded={expanded}');
  });

  it('does not add a third navigation landmark', () => {
    // ⚠ The app has exactly two named <nav>s — the primary menu and the
    // conversation list. The panel bar goes nowhere; it is a group of buttons.
    expect(workspaceSrc).not.toMatch(/<nav[\s>]/);
  });

  it('keeps the scrim out of the tab order', () => {
    expect(workspaceSrc).toMatch(/class="scrim"[\s\S]{0,200}aria-hidden="true"/);
    expect(workspaceSrc).toMatch(/class="scrim"[\s\S]{0,200}tabindex="-1"/);
  });

  it('lets Escape close an open drawer', () => {
    expect(workspaceSrc).toContain("e.key === 'Escape'");
  });
});

describe('the copy tells the truth about the screen it is on', () => {
  it('never points a phone user at a panel on the right', () => {
    // 🔴 The wide copy said "el panel de la derecha". On a phone there is no
    // panel on the right, there is a button. Sending someone to look at
    // furniture that is not there teaches them the app is broken.
    expect(emptyChatHint(false)).toContain('derecha');
    expect(emptyChatHint(true)).not.toContain('derecha');
  });

  it('names the button a phone user can actually press', () => {
    const narrowHint = emptyChatHint(true);
    const documentos = MOBILE_PANEL_TOGGLES.find((t) => t.panel === 'documents');
    expect(documentos).toBeDefined();
    expect(narrowHint).toContain(documentos!.label);
  });

  it('keeps the @-mention hint in both placeholders', () => {
    // It is the only half of the hint a touch user can act on.
    expect(composerPlaceholder(false, true)).toContain('@');
    expect(composerPlaceholder(false, false)).toContain('@');
  });

  it('drops the keyboard-only half on a narrow screen', () => {
    // ⚠ Not a style preference — the long string wraps to four lines in a
    // one-row box at 380px and is cut off mid-word.
    expect(composerPlaceholder(false, false)).toContain('Shift+Enter');
    expect(composerPlaceholder(false, true)).not.toContain('Shift+Enter');
    expect(composerPlaceholder(false, true).length).toBeLessThan(45);
  });

  it('says the same thing while generating, at any width', () => {
    expect(composerPlaceholder(true, true)).toBe(composerPlaceholder(true, false));
    expect(composerPlaceholder(true, false)).toContain('Detener');
  });
});

describe('the breakpoint is written once', () => {
  it('derives the media query from the constant', () => {
    expect(NARROW_MEDIA_QUERY).toBe('(max-width: 63.99rem)');
  });

  it('matches the component stylesheet, which cannot read a custom property', () => {
    // 🔴 The one genuine duplication. If someone changes the CSS and not the
    // module, `matchMedia` disagrees with what is on screen: `inert` lands on a
    // visible drawer, or a drawer stays focusable while hidden.
    expect(workspaceSrc).toContain(`@media (max-width: ${NARROW_MAX_WIDTH_REM - 0.01}rem)`);
  });

  it('is a tablet width, not a phone width', () => {
    // 256px of conversation list + 384px of documents = 640px of furniture.
    // At 768px that leaves 128px of chat, which is broken too.
    expect(NARROW_MAX_WIDTH_REM * 16).toBeGreaterThan(640 + 128);
  });
});
