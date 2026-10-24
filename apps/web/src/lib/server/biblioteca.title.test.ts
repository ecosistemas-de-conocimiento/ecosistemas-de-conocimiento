/**
 * Biblioteca card: a testimonio's system-proposed title over "Testimonio ·
 * <tema>" (owner ruling 2026-10-24); the label alone when it has none.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/auth', () => ({
  backendUrl: () => 'http://backend.test',
  backendFetch: vi.fn(),
}));

import { chatSourceTitle, generatedTestimonyTitle, testimonyHeading, workingDocHeading } from '$lib/biblioteca';
import { LIBRARY_LIST_FIELDS, toLibraryItem } from './biblioteca';

const voz = {
  id: 5,
  name: 'Testimonio de Juana Pérez.m4a',
  kind: 'audio',
  contentKind: 'testimonio',
  organization: '7',
  publicationStatus: 'published',
  anonymisationStatus: 'ready',
  redactedText: 'Una madre cuenta que la escuela no tenía intérprete de señas para su hijo, durante años.',
  tema: 'discapacidad',
};

describe('testimonyHeading', () => {
  it('generated title first, the label as the secondary line', () => {
    expect(testimonyHeading('La escuela sin intérprete de señas', 'Discapacidad')).toEqual({
      title: 'La escuela sin intérprete de señas',
      subtitle: 'Testimonio · Discapacidad',
    });
  });

  it('falls back to the label alone when there is no usable title', () => {
    expect(testimonyHeading(null, 'Discapacidad')).toEqual({ title: 'Testimonio · Discapacidad', subtitle: null });
    expect(testimonyHeading('   ', 'Discapacidad').subtitle).toBeNull();
  });

  it('🔴 never shows a bracketed title (a placeholder)', () => {
    expect(generatedTestimonyTitle('[Persona A] y la escuela')).toBeNull();
    expect(testimonyHeading('Lo que vivió [Persona A]', 'Discapacidad').title).toBe('Testimonio · Discapacidad');
  });
});

describe('toLibraryItem with a generated title', () => {
  it('the list reads `testimonioTitle` with `anonymisationStatus` (the backend read rule needs both)', () => {
    expect(LIBRARY_LIST_FIELDS).toContain('testimonioTitle');
    expect(LIBRARY_LIST_FIELDS).toContain('anonymisationStatus');
  });

  it('a testimonio with a title: title + "Testimonio · <tema>" subtitle, never the filename', () => {
    const item = toLibraryItem({ ...voz, testimonioTitle: 'La escuela sin intérprete de señas' }, null);
    expect(item.title).toBe('La escuela sin intérprete de señas');
    expect(item.subtitle).toBe('Testimonio · Discapacidad');
    expect(JSON.stringify(item)).not.toContain('Juana');
  });

  it('a testimonio without one keeps the d8763ec label and no subtitle', () => {
    const item = toLibraryItem(voz, null);
    expect(item.title).toBe('Testimonio · Discapacidad');
    expect(item.subtitle).toBeNull();
  });

  it('🔴 a documento never gets the testimonio treatment, even with the field set', () => {
    const item = toLibraryItem(
      { ...voz, contentKind: 'documento', kind: 'pdf', name: 'Acta.pdf', testimonioTitle: 'x y z w' },
      null,
    );
    expect(item.title).toBe('Acta.pdf');
    expect(item.subtitle).toBeNull();
  });
});

describe('chatSourceTitle with a generated title', () => {
  it('reads "<title> — Testimonio · <ecosistema>"', () => {
    expect(
      chatSourceTitle('Testimonio', { kind: 'testimonio', testimonioTitle: 'La escuela sin intérprete' }, 'Discapacidad'),
    ).toBe('La escuela sin intérprete — Testimonio · Discapacidad');
  });

  it('🔴 keyed on `kind`, never the title: a documento keeps its own title', () => {
    expect(chatSourceTitle('Testimonio', { kind: 'documento', testimonioTitle: 'x y z' }, 'Eco')).toBe('Testimonio');
  });
});

describe('workingDocHeading (Mis documentos, conversation panel)', () => {
  it('a titled testimonio: generated title, "Testimonio · <tema>" under it', () => {
    expect(
      workingDocHeading({ name: 'grabacion.webm', contentKind: 'testimonio', tema: 'dengue', testimonioTitle: 'Limpiar los patios' }),
    ).toEqual({ title: 'Limpiar los patios', subtitle: 'Testimonio · Prevención del dengue' });
  });

  it('no generated title, or a documento: the name, no subtitle', () => {
    expect(workingDocHeading({ name: 'grabacion.webm', contentKind: 'testimonio' })).toEqual({
      title: 'grabacion.webm',
      subtitle: null,
    });
    expect(workingDocHeading({ name: 'Acta.pdf', contentKind: 'documento', testimonioTitle: 'x y z' })).toEqual({
      title: 'Acta.pdf',
      subtitle: null,
    });
    expect(workingDocHeading({}).title).toBe('Documento sin título');
  });
});
