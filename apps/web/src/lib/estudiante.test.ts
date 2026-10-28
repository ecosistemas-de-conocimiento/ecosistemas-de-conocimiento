import { describe, expect, it } from 'vitest';

import { docsLabel, ESTUDIANTE_TABS, initials, tabAfterKey, trabajosLabel } from './estudiante';

describe('tabAfterKey (WAI-ARIA tabs keyboard)', () => {
  it('arrows move and wrap; Home and End jump; other keys do nothing', () => {
    const first = ESTUDIANTE_TABS[0].id;
    const last = ESTUDIANTE_TABS[ESTUDIANTE_TABS.length - 1]!.id;
    expect(tabAfterKey(first, 'ArrowRight')).toBe(ESTUDIANTE_TABS[1].id);
    expect(tabAfterKey(first, 'ArrowLeft')).toBe(last);
    expect(tabAfterKey(last, 'ArrowRight')).toBe(first);
    expect(tabAfterKey('privacidad', 'Home')).toBe(first);
    expect(tabAfterKey('autores', 'End')).toBe(last);
    expect(tabAfterKey('autores', 'Enter')).toBeNull();
  });
});

describe('labels', () => {
  it('initials: first and last word', () => {
    expect(initials('María Fernanda Ortega Villaseñor')).toBe('MV');
    expect(initials('  luis ')).toBe('L');
    expect(initials('')).toBe('·');
  });

  it('singular and plural', () => {
    expect(docsLabel(1)).toBe('1 documento');
    expect(docsLabel(6)).toBe('6 documentos');
    expect(trabajosLabel(1)).toBe('1 trabajo');
    expect(trabajosLabel(3)).toBe('3 trabajos');
  });
});

describe('links', () => {
  it('topicHref focuses the entity in that ecosistema graph (`/grafo?entidad=&eco=`)', async () => {
    const { topicHref } = await import('./estudiante');
    expect(topicHref('7', 41)).toBe('/grafo?entidad=41&eco=7');
  });

  it('companeroHref uses the opaque id as is, encoded', async () => {
    const { companeroHref } = await import('./estudiante');
    expect(companeroHref('Zq3xY_-abcdefghijklmno')).toBe('/estudiante/companero/Zq3xY_-abcdefghijklmno');
    expect(companeroHref('a/b')).toBe('/estudiante/companero/a%2Fb');
  });
});
