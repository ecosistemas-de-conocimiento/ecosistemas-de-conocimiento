import { describe, expect, it } from 'vitest';

import { FEATURE_DEFAULTS, FEATURE_KEYS, PLATFORM_ADMIN_ONLY_FEATURES } from '$lib/features';
import { keysOf, SECCIONES, seccionDirty, seccionLocked } from './secciones';

const seccion = (id: string) => SECCIONES.find((s) => s.id === id)!;

describe('/ajustes tabs', () => {
  it('🔴 every switch sits in exactly one tab — a missing one would be saved as "off"', () => {
    const placed = SECCIONES.flatMap(keysOf);
    expect([...placed].sort()).toEqual([...FEATURE_KEYS].sort());
    expect(new Set(placed).size).toBe(placed.length);
  });

  it('the answer style is a tab of its own, with no switches', () => {
    expect(seccion('estilo').switches).toEqual([]);
  });

  it('nests the switches that only work under another (backend rules)', () => {
    expect(seccion('grafo').switches).toEqual([{ key: 'graph', children: ['graph3d', 'combinedGraph'] }]);
    expect(seccion('estudiantes').switches).toEqual([{ key: 'studentView', children: ['studentTestimonios'] }]);
  });

  it('the two keep-names switches sit in Publicación, next to public figures', () => {
    expect(keysOf(seccion('publicacion'))).toEqual([
      'autoPublishMembers',
      'testimonioTitles',
      'keepPublicFigures',
      'keepDocumentAuthor',
      'keepCitedAuthors',
    ]);
  });

  it('a tab is dirty when an editable switch in it changed; a locked one never counts', () => {
    const saved = { ...FEATURE_DEFAULTS };
    expect(seccionDirty(seccion('grafo'), { ...saved, graph3d: false }, saved, [])).toBe(true);
    expect(seccionDirty(seccion('grafo'), { ...saved, liveMic: false }, saved, [])).toBe(false);
    expect(seccionDirty(seccion('publicacion'), { ...saved, keepPublicFigures: true }, saved, ['keepPublicFigures'])).toBe(false);
  });

  it('a tab is read-only only when every switch in it is locked', () => {
    const locked = [...PLATFORM_ADMIN_ONLY_FEATURES];
    expect(seccionLocked(seccion('publicacion'), locked)).toBe(false);
    expect(seccionLocked(seccion('estudiantes'), locked)).toBe(false);
    expect(seccionLocked(seccion('estudiantes'), ['studentView', 'studentTestimonios'])).toBe(true);
    expect(seccionLocked(seccion('estilo'), locked)).toBe(false);
  });
});
