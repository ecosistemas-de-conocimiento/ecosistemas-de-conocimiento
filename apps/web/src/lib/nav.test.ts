import { describe, expect, it } from 'vitest';

import {
  currentNavItem,
  isCurrentSection,
  NAV_ITEMS,
  shouldShowNav,
  visibleNavItems,
} from './nav';

const admin = { id: '1', isPlatformAdmin: true };
const member = { id: '2', isPlatformAdmin: false };

describe('the menu only offers pages that exist', () => {
  it('covers the chat, the library and the admin view, and nothing else', () => {
    expect(NAV_ITEMS.map((i) => i.href)).toEqual(['/', '/biblioteca', '/admin']);
  });

  it('names every section in Spanish', () => {
    expect(NAV_ITEMS.map((i) => i.label)).toEqual([
      'Conversaciones',
      'Biblioteca',
      'Administración',
    ]);
  });

  it('gives every item a plain-language hint, so no entry is a bare noun', () => {
    for (const item of NAV_ITEMS) {
      expect(item.hint.length).toBeGreaterThan(0);
    }
  });
});

describe('who sees the admin entry', () => {
  it('shows it to a platform admin', () => {
    expect(visibleNavItems(admin).map((i) => i.href)).toContain('/admin');
  });

  // ⚠ Presentation only — `routes/admin/+page.server.ts` is the control. This
  // asserts the menu stays honest, not that the page is protected.
  it('hides it from an ordinary member', () => {
    expect(visibleNavItems(member).map((i) => i.href)).toEqual(['/', '/biblioteca']);
  });

  it('hides it when the flag is missing, garbled or merely truthy', () => {
    for (const user of [null, undefined, {}, { isPlatformAdmin: 'true' }, { isPlatformAdmin: 1 }]) {
      expect(visibleNavItems(user).map((i) => i.href)).not.toContain('/admin');
    }
  });
});

describe('which section is current', () => {
  it('marks the chat only on the chat itself', () => {
    expect(isCurrentSection('/', '/')).toBe(true);
    expect(isCurrentSection('/biblioteca', '/')).toBe(false);
    expect(isCurrentSection('/admin', '/')).toBe(false);
  });

  it('marks Biblioteca on a document inside it', () => {
    expect(isCurrentSection('/biblioteca/42', '/biblioteca')).toBe(true);
  });

  it('does not let a prefix bleed across a word boundary', () => {
    expect(isCurrentSection('/bibliotecarios', '/biblioteca')).toBe(false);
  });

  it('treats a trailing slash as the same place', () => {
    expect(isCurrentSection('/biblioteca/', '/biblioteca')).toBe(true);
    expect(isCurrentSection('', '/')).toBe(true);
  });

  it('never marks two items at once', () => {
    for (const path of ['/', '/biblioteca', '/biblioteca/9', '/admin']) {
      const marked = visibleNavItems(admin).filter((i) => isCurrentSection(path, i.href));
      expect(marked).toHaveLength(1);
    }
  });

  it('returns nothing for a page outside every section', () => {
    expect(currentNavItem('/sign-in', admin)).toBeNull();
  });

  it('never reports the admin section as current for a non-admin', () => {
    expect(currentNavItem('/admin', member)).toBeNull();
  });
});

describe('where the menu is shown', () => {
  it('is shown on every signed-in section', () => {
    for (const path of ['/', '/biblioteca', '/biblioteca/7', '/admin']) {
      expect(shouldShowNav(path, member)).toBe(true);
    }
  });

  it('is hidden on the way in', () => {
    expect(shouldShowNav('/sign-in', member)).toBe(false);
    expect(shouldShowNav('/sign-up', member)).toBe(false);
  });

  it('is hidden when nobody is signed in', () => {
    expect(shouldShowNav('/', null)).toBe(false);
  });
});
