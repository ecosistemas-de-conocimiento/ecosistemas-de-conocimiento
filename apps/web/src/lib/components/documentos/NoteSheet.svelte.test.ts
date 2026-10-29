import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import NoteSheet from './NoteSheet.svelte';
import type { WorkingDoc } from '$lib/types';

const published = {
  id: '9',
  title: 'Mi nota',
  body: 'texto con un cambio',
  processedBody: 'texto publicado',
  isNote: true,
  uploadedByCaller: true,
  kind: 'markdown',
  ingestStatus: 'ready',
  publicationStatus: 'published',
  includeInContext: false,
  sessionIds: [],
  updatedAt: 0,
} as WorkingDoc;

describe('NoteSheet — editing an existing note (/documentos "Editar")', () => {
  it('shows the editor with the note’s text and the page’s "Publicar cambios"', () => {
    const html = render(NoteSheet, {
      props: {
        onSave: async () => true,
        editing: published,
        publish: { label: 'Publicar cambios', pending: false, onClick: () => {} },
      },
    }).body;
    expect(html).toContain('Editar nota');
    expect(html).toContain('data-testid="note-edit-9"');
    expect(html).toContain('texto con un cambio');
    expect(html).toContain('data-testid="note-sheet-publish"');
    expect(html).toContain('Publicar cambios');
    expect(html).not.toContain('data-testid="note-save"');
  });

  it('"Nueva nota" is unchanged: no editor tabs, Guardar', () => {
    const html = render(NoteSheet, { props: { onSave: async () => true } }).body;
    expect(html).toContain('Nueva nota');
    expect(html).toContain('data-testid="note-save"');
    expect(html).not.toContain('note-sheet-publish');
  });
});
