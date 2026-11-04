/**
 * 🔴 "Publicar cambios" was unreachable (dev, 2026-10-28): a student's
 * PUBLISHED note (`ingestStatus: 'ready'`) opened in the conversation's panel
 * showed "MARKDOWN · Listo para el chat" and no editor, so its body could never
 * differ from the published one. SSR render, panel open on that note.
 */
import { describe, expect, it, vi } from 'vitest';
import { readable } from 'svelte/store';

vi.mock('$app/stores', () => ({
  page: readable({ data: { studentAccess: { student: true } } }),
}));
vi.mock('$env/dynamic/public', () => ({ env: {} }));

import { render } from 'svelte/server';
import DocsPanel from './DocsPanel.svelte';
import { app } from '$lib/stores/app.svelte';
import type { WorkingDoc } from '$lib/types';

function note(over: Partial<WorkingDoc> = {}): WorkingDoc {
  return {
    id: '7',
    title: 'Mi nota',
    body: 'texto publicado',
    processedBody: 'texto publicado',
    isNote: true,
    uploadedByCaller: true,
    kind: 'markdown',
    ingestStatus: 'ready',
    publicationStatus: 'published',
    includeInContext: true,
    sessionIds: ['1'],
    updatedAt: 0,
    ...over,
  };
}

function panel(d: WorkingDoc): string {
  app.sessions = [{ id: '1', title: 'C', createdAt: 0, updatedAt: 0, messages: [], docs: [d] }];
  app.activeSessionId = '1';
  app.docsPanelOpen = true;
  return render(DocsPanel, { props: { openId: d.id } }).body;
}

describe('DocsPanel — a published note', () => {
  // Opens on the rendered text, "Editar" second (owner, 2026-10-28); the click
  // through to `note-edit-7` is in `documentViews.dom.test.ts`.
  it('own: opens on the preview with "Editar", no button while the text is unchanged', () => {
    const html = panel(note());
    expect(html).toContain('data-testid="note-preview-7"');
    expect(html).toContain('data-testid="note-edit-open-7"');
    expect(html).not.toContain('data-testid="note-edit-7"');
    expect(html).not.toContain('Listo para el chat');
    expect(html).not.toContain('data-testid="publish-7"');
  });

  it('own, edited: "Publicar cambios" appears', () => {
    const html = panel(note({ body: 'texto con un cambio' }));
    expect(html).toContain('data-testid="note-edit-open-7"');
    expect(html).toContain('data-testid="publish-7"');
    expect(html).toContain('Publicar cambios');
  });

  it('own, changes on their way: the button stays, disabled', () => {
    const html = panel(note({ body: 'texto con un cambio', changesPending: true }));
    expect(html).toMatch(/data-testid="publish-7"/);
    expect(html).toMatch(/data-testid="publish-7"[^>]*disabled=""/);
  });

  it('someone else’s: no editor, no button', () => {
    const html = panel(note({ uploadedByCaller: false, body: 'texto con un cambio' }));
    expect(html).not.toContain('data-testid="note-edit-7"');
    expect(html).not.toContain('Publicar cambios');
  });
});
