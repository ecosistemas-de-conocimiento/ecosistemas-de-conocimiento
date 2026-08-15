import { describe, expect, it } from 'vitest';

import { AUTH_ROUTES, hydrationAction, isAuthRoute } from './hydration';

describe('isAuthRoute', () => {
  it('recognises every unauthenticated route', () => {
    for (const path of AUTH_ROUTES) expect(isAuthRoute(path)).toBe(true);
  });

  it('treats everything else as part of the app', () => {
    expect(isAuthRoute('/')).toBe(false);
    expect(isAuthRoute('/sessions/42')).toBe(false);
  });

  it('tolerates a trailing slash without swallowing the root', () => {
    expect(isAuthRoute('/sign-in/')).toBe(true);
    // `/` must stay an APP route: stripping its slash would leave '' and a
    // future `AUTH_ROUTES` entry of '' would then silently match the home page.
    expect(isAuthRoute('/')).toBe(false);
  });

  it('does not match a route that merely starts with an auth route', () => {
    expect(isAuthRoute('/sign-in-help')).toBe(false);
  });
});

describe('hydrationAction', () => {
  it('hydrates on an app route that has not been read yet', () => {
    expect(hydrationAction({ pathname: '/', hydrated: false })).toBe('hydrate');
  });

  it('does not hydrate twice for the same visit', () => {
    expect(hydrationAction({ pathname: '/', hydrated: true })).toBe('none');
  });

  it('never hydrates on the sign-in or sign-up form', () => {
    expect(hydrationAction({ pathname: '/sign-in', hydrated: false })).toBe('none');
    expect(hydrationAction({ pathname: '/sign-up', hydrated: false })).toBe('none');
  });

  /**
   * 🔴 THE REGRESSION. This is the sign-in journey, step by step, as a
   * sequence of routes the root layout sees WITHOUT ever remounting.
   *
   * The old code answered this by asking "is this an auth route?" exactly once,
   * on `/sign-in`, and never asked again — so the second line below produced no
   * hydration and the app sat on "Cargando…" until the user reloaded.
   */
  it('hydrates after a client-side sign-in, with no remount in between', () => {
    let hydrated = false;
    const visit = (pathname: string): string => {
      const action = hydrationAction({ pathname, hydrated });
      if (action === 'hydrate') hydrated = true;
      if (action === 'reset') hydrated = false;
      return action;
    };

    expect(visit('/sign-in')).toBe('none'); // layout mounts here
    expect(visit('/')).toBe('hydrate'); // goto('/') — the step that used to be lost
    expect(visit('/')).toBe('none'); // any later navigation within the app
  });

  /**
   * Signing out and back in must re-read. Today sign-out is a full page load
   * (`window.location.href`), which tears the store down anyway — but the
   * latch must not be the only thing standing between two different users'
   * conversations if that ever becomes a client-side navigation.
   */
  it('forgets the previous visit when the user returns to the sign-in form', () => {
    let hydrated = false;
    const visit = (pathname: string): string => {
      const action = hydrationAction({ pathname, hydrated });
      if (action === 'hydrate') hydrated = true;
      if (action === 'reset') hydrated = false;
      return action;
    };

    expect(visit('/')).toBe('hydrate');
    expect(visit('/sign-in')).toBe('reset');
    expect(visit('/')).toBe('hydrate');
  });
});
