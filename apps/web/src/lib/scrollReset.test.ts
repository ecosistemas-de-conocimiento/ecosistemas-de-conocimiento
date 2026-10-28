import { describe, expect, it } from 'vitest';

import { shouldResetScroll } from './scrollReset';

const at = (path: string) => ({ url: new URL(path, 'http://localhost') });

describe('a finished navigation resets the scroll only when the section changes', () => {
  it('resets on a link to another section', () => {
    expect(shouldResetScroll({ type: 'link', from: at('/biblioteca'), to: at('/grafo') })).toBe(true);
  });

  it('resets on a goto to another section', () => {
    expect(shouldResetScroll({ type: 'goto', from: at('/documentos'), to: at('/') })).toBe(true);
  });

  // 🔴 The audit blocker: SvelteKit 2.70, SSR off, first client navigation.
  it('does not throw when from.url is null, and resets', () => {
    expect(() =>
      shouldResetScroll({ type: 'enter', from: { url: null }, to: at('/biblioteca') }),
    ).not.toThrow();
    expect(shouldResetScroll({ type: 'enter', from: { url: null }, to: at('/biblioteca') })).toBe(
      true,
    );
  });

  it('does not throw when from is null', () => {
    expect(shouldResetScroll({ type: 'enter', from: null, to: at('/') })).toBe(true);
  });

  it('does not throw when to is null or to.url is null', () => {
    expect(() => shouldResetScroll({ type: 'link', from: at('/'), to: null })).not.toThrow();
    expect(() => shouldResetScroll({ type: 'link', from: at('/'), to: { url: null } })).not.toThrow();
  });

  it('leaves back/forward alone', () => {
    expect(shouldResetScroll({ type: 'popstate', from: at('/grafo'), to: at('/biblioteca') })).toBe(
      false,
    );
  });

  it('leaves #anchor links alone', () => {
    expect(
      shouldResetScroll({ type: 'link', from: at('/biblioteca'), to: at('/biblioteca#doc-3') }),
    ).toBe(false);
    expect(shouldResetScroll({ type: 'link', from: at('/'), to: at('/grafo#nodo') })).toBe(false);
  });

  it('leaves a query-only change alone (biblioteca filters, grafo search)', () => {
    expect(
      shouldResetScroll({
        type: 'goto',
        from: at('/biblioteca'),
        to: at('/biblioteca?tipo=voz&tema=agua'),
      }),
    ).toBe(false);
    expect(
      shouldResetScroll({ type: 'goto', from: at('/grafo?q=agua'), to: at('/grafo?q=suelo') }),
    ).toBe(false);
  });
});
