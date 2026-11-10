/**
 * Biblioteca card: a testimonio's system-proposed title over its short day
 * (owner ruling 2026-10-26); "Testimonio · <tema>" alone when it has none.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/auth', () => ({
  backendUrl: () => 'http://backend.test',
  backendFetch: vi.fn(),
}));

import { chatSourceTitle, generatedTestimonyTitle, shortDay, testimonyHeading, workingDocHeading } from '$lib/biblioteca';
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
  createdAt: '2026-10-24T18:00:00.000Z',
};

describe('testimonyHeading', () => {
  it('generated title first, its short day as the secondary line', () => {
    expect(testimonyHeading('La escuela sin intérprete de señas', 'Discapacidad', '2026-10-24T18:00:00.000Z')).toEqual({
      title: 'La escuela sin intérprete de señas',
      subtitle: '24 oct',
    });
  });

  it('a generated title with no usable date: empty subtitle, never null', () => {
    expect(testimonyHeading('La escuela sin intérprete de señas', 'Discapacidad').subtitle).toBe('');
    expect(testimonyHeading('La escuela sin intérprete de señas', 'Discapacidad', 'nope').subtitle).toBe('');
  });

  it('shortDay: Mexico City day, short Spanish month', () => {
    expect(shortDay('2026-10-25T03:00:00Z')).toBe('24 oct');
    expect(shortDay(null)).toBe('');
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

  it('a testimonio with a title: title + short-day subtitle, never the filename', () => {
    const item = toLibraryItem({ ...voz, testimonioTitle: 'La escuela sin intérprete de señas' }, null);
    expect(item.title).toBe('La escuela sin intérprete de señas');
    expect(item.subtitle).toBe('24 oct');
    expect(JSON.stringify(item)).not.toContain('Juana');
  });

  it('a testimonio without one keeps the plain label and no subtitle', () => {
    const item = toLibraryItem(voz, null);
    expect(item.title).toBe('Testimonio · Discapacidad');
    expect(item.subtitle).toBeNull();
  });

  it('🔴 a documento never gets the testimonio treatment, even with the field set', () => {
    const item = toLibraryItem(
      { ...voz, contentKind: 'documento', anonymise: false, kind: 'pdf', name: 'Acta.pdf', testimonioTitle: 'x y z w' },
      null,
    );
    expect(item.title).toBe('Acta.pdf');
    expect(item.subtitle).toBeNull();
  });
});

describe('chatSourceTitle with a generated title', () => {
  it('reads "<title> · <short day>", or the title alone with no day', () => {
    expect(
      chatSourceTitle(
        'Testimonio',
        { kind: 'testimonio', testimonioTitle: 'La escuela sin intérprete', testimonioDate: '2026-10-24T18:00:00.000Z' },
        'Discapacidad',
      ),
    ).toBe('La escuela sin intérprete · 24 oct');
    expect(
      chatSourceTitle('Testimonio', { kind: 'testimonio', testimonioTitle: 'La escuela sin intérprete' }, 'Discapacidad'),
    ).toBe('La escuela sin intérprete');
  });

  it('🔴 keyed on `kind`, never the title: a documento keeps its own title', () => {
    expect(chatSourceTitle('Testimonio', { kind: 'documento', testimonioTitle: 'x y z' }, 'Eco')).toBe('Testimonio');
  });
});

describe('workingDocHeading (Mis documentos, conversation panel)', () => {
  it('a titled testimonio: generated title, its short day under it', () => {
    expect(
      workingDocHeading({
        name: 'grabacion.webm',
        contentKind: 'testimonio',
        testimonioTitle: 'Limpiar los patios',
        createdAt: '2026-10-24T18:00:00.000Z',
      }),
    ).toEqual({ title: 'Limpiar los patios', subtitle: '24 oct' });
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
