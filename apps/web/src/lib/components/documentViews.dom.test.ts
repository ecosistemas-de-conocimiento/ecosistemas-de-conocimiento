/**
 * 🔴 Every view that shows document text renders it as Markdown (owner,
 * 2026-10-28: notes, documents and testimonios showed raw `**`, `#` and
 * `[[…]]`). Mounted in jsdom, because `Markdown.svelte` renders on the client
 * only (DOMPurify needs `window`). Each view gets the same hostile note
 * (`HOSTILE_MD`): headings, emphasis, a list, wikilinks, a `[3]`, a remote
 * image and a script; `expectRenderedDocument` is the bar.
 *
 * And a note opens on its RENDERED text; "Editar" is the second step, and
 * still reaches the editor (`note-edit-<id>`) and "Publicar cambios".
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount, type Component } from 'svelte';
import { readable } from 'svelte/store';
import { expectRenderedDocument, HOSTILE_MD } from '$lib/markdown.testkit';
import type { WorkingDoc } from '$lib/types';

const pageStore = vi.hoisted(() => ({ value: { data: { studentAccess: { student: true } }, params: { id: '5' } } as Record<string, unknown> }));
vi.mock('$app/stores', () => ({
  page: { subscribe: (fn: (v: unknown) => void) => readable(pageStore.value).subscribe(fn) },
}));
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));
vi.mock('$app/navigation', () => ({ goto: async () => {} }));
vi.mock('$env/dynamic/public', () => ({ env: {} }));

import Markdown from './Markdown.svelte';
import NoteSheet from './documentos/NoteSheet.svelte';
import DocsPanel from './DocsPanel.svelte';
import Message from './Message.svelte';
import { app } from '$lib/stores/app.svelte';

beforeAll(() => {
  // jsdom has no modal dialogs.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  Element.prototype.scrollIntoView ??= function () {};
  globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch;
});

const mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const c of mounted.splice(0)) unmount(c);
  document.body.innerHTML = '';
});

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    flushSync();
    await tick();
    await new Promise((r) => setTimeout(r, 0));
  }
  flushSync();
}

async function show<P extends Record<string, unknown>>(C: Component<P>, props: P): Promise<HTMLElement> {
  const target = document.createElement('div');
  document.body.append(target);
  mounted.push(mount(C as Component<Record<string, unknown>>, { target, props }));
  await settle();
  return target;
}

const byTestId = (root: ParentNode, id: string) => root.querySelector(`[data-testid="${id}"]`);

function note(over: Partial<WorkingDoc> = {}): WorkingDoc {
  return {
    id: '7',
    title: 'Mi nota',
    body: HOSTILE_MD,
    processedBody: HOSTILE_MD,
    isNote: true,
    uploadedByCaller: true,
    kind: 'markdown',
    ingestStatus: 'ready',
    publicationStatus: 'published',
    includeInContext: true,
    sessionIds: ['1'],
    updatedAt: 0,
    ...over,
  } as WorkingDoc;
}

describe('Markdown.svelte, document mode', () => {
  it('renders the hostile note', async () => {
    const root = await show(Markdown, { source: HOSTILE_MD, document: true, testid: 'x' });
    expectRenderedDocument(byTestId(root, 'x')!.innerHTML);
  });
});

describe('NoteSheet (/documentos "Abrir")', () => {
  it('opens on the rendered note; Editar → note-edit-<id>; "Publicar cambios" stays in reach', async () => {
    const edits: unknown[] = [];
    const root = await show(NoteSheet, {
      open: true,
      editing: note({ id: '9' }),
      onSave: async () => true,
      onEdit: (p: unknown) => edits.push(p),
      publish: { label: 'Publicar cambios', pending: false, onClick: () => {} },
    });
    const preview = byTestId(root, 'note-preview-9')!;
    expect(preview).not.toBeNull();
    expectRenderedDocument(preview.innerHTML);
    expect(byTestId(root, 'note-edit-9')).toBeNull();
    expect(byTestId(root, 'note-sheet-title')!.textContent).toBe('Mi nota');

    (byTestId(root, 'note-sheet-edit') as HTMLButtonElement).click();
    await settle();
    const editor = byTestId(root, 'note-edit-9') as HTMLTextAreaElement;
    expect(editor.value).toBe(HOSTILE_MD);
    editor.value = 'cambio';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(edits).toContainEqual({ body: 'cambio' });
    expect(byTestId(root, 'note-sheet-publish')!.textContent).toContain('Publicar cambios');

    (byTestId(root, 'note-sheet-preview') as HTMLButtonElement).click();
    await settle();
    expect(byTestId(root, 'note-preview-9')!.innerHTML).toContain('cambio');
  });

  it('a note that cannot be edited is read only', async () => {
    const root = await show(NoteSheet, { open: true, editing: note({ id: '9' }), canEdit: false, onSave: async () => true });
    expect(byTestId(root, 'note-preview-9')).not.toBeNull();
    expect(byTestId(root, 'note-sheet-edit')).toBeNull();
  });
});

describe('DocsPanel (the conversation’s documents)', () => {
  function panel(d: WorkingDoc) {
    app.sessions = [{ id: '1', title: 'C', createdAt: 0, updatedAt: 0, messages: [], docs: [d] }];
    app.activeSessionId = '1';
    app.docsPanelOpen = true;
    return show(DocsPanel, { openId: d.id });
  }

  it('own note: opens on the rendered text; Editar → note-edit-<id>; Vista previa back', async () => {
    const root = await panel(note());
    expectRenderedDocument(byTestId(root, 'note-preview-7')!.innerHTML);
    expect(byTestId(root, 'note-edit-7')).toBeNull();

    (byTestId(root, 'note-edit-open-7') as HTMLButtonElement).click();
    await settle();
    expect((byTestId(root, 'note-edit-7') as HTMLTextAreaElement).value).toBe(HOSTILE_MD);

    (byTestId(root, 'note-preview-open-7') as HTMLButtonElement).click();
    await settle();
    expect(byTestId(root, 'note-preview-7')).not.toBeNull();
  });

  it('a new, empty note opens on the editor, and typing keeps it there', async () => {
    const root = await panel(note({ body: '', processedBody: '', ingestStatus: 'n/a', publicationStatus: 'draft' }));
    const editor = byTestId(root, 'note-edit-7') as HTMLTextAreaElement;
    expect(editor).not.toBeNull();
    editor.value = '# Hola';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(byTestId(root, 'note-edit-7')).not.toBeNull();
  });

  it('someone else’s note: the rendered text, no editor', async () => {
    const root = await panel(note({ uploadedByCaller: false }));
    expectRenderedDocument(byTestId(root, 'note-preview-7')!.innerHTML);
    expect(byTestId(root, 'note-edit-7')).toBeNull();
    expect(byTestId(root, 'note-edit-open-7')).toBeNull();
  });

  it('an audio transcript renders through the same component', async () => {
    const d = note({ kind: 'audio', isNote: false, transcript: HOSTILE_MD });
    app.sessions = [{ id: '1', title: 'C', createdAt: 0, updatedAt: 0, messages: [], docs: [d] }];
    app.activeSessionId = '1';
    const root = await show(DocsPanel, { openId: d.id });
    (byTestId(root, 'transcript-tab-7') as HTMLButtonElement).click();
    await settle();
    expectRenderedDocument(byTestId(root, 'transcript-text-7')!.innerHTML);
  });
});

describe('Message source cards', () => {
  it('quote the passage as text, without its notation', async () => {
    const root = await show(Message, {
      msg: {
        id: 'm1',
        role: 'assistant',
        content: 'Respuesta [1].',
        provenance: {
          chunks: [
            {
              chunkId: 'c1',
              documentId: 'u1',
              score: 0.9,
              corpus: 'published',
              text: '# Título\n\nUn **dato** con [[Tema]].',
              metadata: { docId: '1', title: 'Doc 1', publication: 'published' },
            },
          ],
        },
        createdAt: 0,
      } as never,
    });
    // The card opens on a click of the answer's [1].
    (root.querySelector('button[data-cite="1"]') as HTMLButtonElement).click();
    await settle();
    const quote = root.querySelector('.citation-card-passage');
    expect(quote?.textContent).toBe('Título Un dato con Tema.');
  });
});

describe('route views', () => {
  it('/biblioteca/[id] renders the document text', async () => {
    pageStore.value = { params: { id: '5' }, data: {} };
    globalThis.fetch = vi.fn(async () =>
      Response.json({
        doc: {
          id: '5',
          title: 'Nota publicada',
          kind: 'markdown',
          createdAt: 0,
          updatedAt: 0,
          contributor: 'Ana',
          lengua: null,
          fromAudio: false,
          subtitle: null,
          text: HOSTILE_MD,
        },
        ecosystem: { name: 'Semiosis' },
      }),
    ) as typeof fetch;
    const { default: Page } = await import('../../routes/biblioteca/[id]/+page.svelte');
    const root = await show(Page as Component<Record<string, unknown>>, {});
    expectRenderedDocument(byTestId(root, 'library-document-text')!.innerHTML);
  });

  it('/seguimiento renders a cleared testimonio', async () => {
    const { default: Page } = await import('../../routes/seguimiento/+page.svelte');
    const root = await show(Page as Component<Record<string, unknown>>, {
      data: {
        estudiantes: [{ id: 4, name: 'Ana' }],
        sugerencias: [],
        chosen: '4',
        reporte: {
          student: { id: 4, name: 'Ana' },
          summary: { documents: 1, published: 1, topics: 0, conversations: 0 },
          uploads: [],
          topics: [],
          chatThemes: [],
          gaps: [],
          readings: [],
          testimonios: [{ id: 20, createdAt: '2026-10-03T00:00:00.000Z', state: 'visible', title: 'El río', text: HOSTILE_MD }],
        },
      },
    });
    expectRenderedDocument(byTestId(root, 'testimonio-text-20')!.innerHTML);
  });

  it('/revision/[id] renders the held text with its highlights', async () => {
    const { default: Page } = await import('../../routes/revision/[id]/+page.svelte');
    const text = `${HOSTILE_MD}\n\nHabló Juan Pérez.`;
    const start = text.indexOf('Juan Pérez');
    const root = await show(Page as Component<Record<string, unknown>>, {
      data: {
        state: 'ready',
        hold: {
          id: '3',
          title: 'Testimonio retenido',
          heldText: text,
          survivors: [{ start, end: start + 'Juan Pérez'.length, type: 'persona' }],
          publicFiguresKept: [],
          updatedAt: '2026-10-28T00:00:00.000Z',
          stage: 'survivors',
          reason: null,
        },
      },
      form: null,
    });
    const reader = byTestId(root, 'hold-text')!;
    expectRenderedDocument(reader.innerHTML);
    expect([...reader.querySelectorAll('mark')].map((m) => m.textContent)).toEqual(['Juan Pérez']);
  });

  it('/estudiante renders the generated questions inline', async () => {
    const { default: Page } = await import('../../routes/estudiante/+page.svelte');
    const root = await show(Page as Component<Record<string, unknown>>, {
      data: {
        ecosystemName: 'Semiosis',
        organization: 8,
        overview: {
          temas: [],
          documentos: [],
          autores: [],
          autoresParaLeer: [],
          companeros: [],
          perfil: { shareWithPeers: false, shareActivity: false, shareTestimonios: false },
          testimoniosEnReporte: false,
        },
      },
      form: { preguntas: ['¿Qué dice **Peirce** sobre [[Semiótica]]? [2]', '![x](https://evil.example/i.png) ¿y la *otra*?'] },
    });
    const list = byTestId(root, 'preguntas')!;
    const html = list.innerHTML;
    expect(html).toContain('<strong>Peirce</strong>');
    expect(html).toContain('<em>otra</em>');
    expect(html).toContain('Semiótica');
    expect(html).not.toContain('**');
    expect(html).not.toContain('[[');
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toContain('evil.example');
  });
});
