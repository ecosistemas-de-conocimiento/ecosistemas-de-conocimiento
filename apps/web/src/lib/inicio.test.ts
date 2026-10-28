import { describe, expect, it } from 'vitest';
import { CONVERSACIONES_HREF, navHref, showsStartScreen } from './inicio';
import { shouldShowNav } from './nav';

const bare = () => new URLSearchParams('');
const full = () => new URLSearchParams('conversaciones');

describe('start screen — who lands on it', () => {
  it('participante and estudiante get it on a bare /', () => {
    expect(showsStartScreen({ role: 'member', search: bare() })).toBe(true);
    expect(showsStartScreen({ role: 'estudiante', search: bare() })).toBe(true);
  });

  it('investigador, owner, admin role, no role: today\'s /', () => {
    for (const role of ['investigador', 'owner', 'admin', null] as const) {
      expect(showsStartScreen({ role, search: bare() })).toBe(false);
    }
  });

  it('a platform admin never, whatever the membership', () => {
    expect(showsStartScreen({ role: 'member', isPlatformAdmin: true, search: bare() })).toBe(false);
  });

  it('?conversaciones opens the full UI', () => {
    expect(showsStartScreen({ role: 'member', search: full() })).toBe(false);
    expect(CONVERSACIONES_HREF).toBe('/?conversaciones');
  });

  it('the menu\'s "/" points at the full UI; other entries unchanged', () => {
    expect(navHref('/')).toBe(CONVERSACIONES_HREF);
    expect(navHref('/biblioteca')).toBe('/biblioteca');
  });

  it('the start screen has no menu', () => {
    const user = { id: 1 };
    expect(shouldShowNav('/', user, { startScreen: true })).toBe(false);
    expect(shouldShowNav('/', user, { startScreen: false })).toBe(true);
    expect(shouldShowNav('/', user)).toBe(true);
  });
});
