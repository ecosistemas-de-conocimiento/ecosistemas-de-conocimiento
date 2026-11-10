import { describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';

/** 🔴 P-01: a `content` hold is never offered "aprobar tal cual". */

vi.mock('$app/forms', () => ({ enhance: () => ({}) }));

const { default: Detail } = await import('./+page.svelte');

const hold = (over: Record<string, unknown>) => ({
  id: '11',
  title: 'Testimonio retenido',
  label: 'Testimonio retenido',
  generatedTitle: null,
  contentKind: 'testimonio',
  stage: 'verify',
  reason: null,
  survivorCount: 0,
  updatedAt: null,
  heldText: 'Vivo con [Persona A].',
  survivors: [],
  report: null,
  publicFiguresKept: [],
  ...over,
});

const page = (h: Record<string, unknown>) =>
  render(Detail, { props: { form: null, data: { state: 'ready', hold: hold(h) } } as never }).body;

describe('/revision/[id] — approve as-is', () => {
  it('a verify hold offers approve', () => {
    const body = page({});
    expect(body).toContain('data-testid="hold-approve"');
    expect(body).not.toContain('hold-edit-to-approve');
  });

  it('🔴 a content hold with text: no approve until the text is edited; the edit is the way', () => {
    const body = page({ stage: 'content' });
    expect(body).not.toContain('data-testid="hold-approve"');
    expect(body).toContain('data-testid="hold-edit-to-approve"');
    expect(body).toContain('Corregir el texto');
    expect(body).toContain('data-testid="hold-reject"');
  });

  it('🔴 a content hold with no text: reject only', () => {
    const body = page({ stage: 'content', heldText: null });
    expect(body).not.toContain('data-testid="hold-approve"');
    expect(body).toContain('data-testid="hold-no-text"');
    expect(body).toContain('No hay texto revisado que aprobar');
    expect(body).toContain('data-testid="hold-reject"');
  });
});
