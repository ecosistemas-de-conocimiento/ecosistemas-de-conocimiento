import { describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';

vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));
vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn() }));

const { default: Page } = await import('./+page.svelte');

const metrics = (citationSupport: number) => ({
  citationSupport, claims: 10, refusalAccuracy: 0.9, falseRefusals: 1, missedRefusals: 0, questions: 10,
  hit1: 0.5, hit3: 0.7, hit5: 0.8, retrievalItems: 8, leakRate: 0.1, overRedaction: 0.2, privateTerms: 10,
  publicTerms: 5, holds: 0, privacyItems: 2, styleShown: 1, styleItems: 3, errors: 0,
});

const latest = {
  id: 'r2', status: 'done', createdAt: '2026-10-29T00:00:00Z', finishedAt: '2026-10-29T00:05:00Z', costUsd: 0.084,
  commitSha: 'abcdef1234', models: { chat: ['deepseek/deepseek-chat-v3.1'], judge: [], gate: [] }, error: null,
  results: [{
    itemId: '1', kind: 'pregunta', question: '¿Qué mostró la red de ovitrampas?', shouldRefuse: false, expectedDocIds: [1114],
    answer: 'Bajaron [1].', sources: [{ n: 1, docId: '1114', title: 'Ovitrampas' }], rank: 1, refused: false, refusalOk: true,
    claims: [{ n: 1, claim: 'Bajaron', ok: true }], style: null, costUsd: 0.008, model: 'm',
  }],
};

const page = (over: Record<string, unknown> = {}) =>
  render(Page, {
    props: {
      form: null,
      data: {
        state: 'ready',
        ecosistemas: [{ id: '6', name: 'Dengue', slug: 'd' }],
        selected: { id: '6', name: 'Dengue', slug: 'd' },
        items: [{ id: '1', kind: 'pregunta', question: '¿Qué mostró la red de ovitrampas?', expectedDocIds: [1114], shouldRefuse: false, notes: '', text: '', privateNames: [], publicNames: [], gateKind: 'documento' }],
        trend: [
          { id: 'r1', createdAt: '', metrics: metrics(0.6), costUsd: 0.08 },
          { id: 'r2', createdAt: '', metrics: metrics(0.75), costUsd: 0.08 },
        ],
        latest,
        running: null,
        estimate: { usd: 0.0812, questions: 10, privacy: 2, basis: 'medido' },
        hasStyle: false,
        ...over,
      },
    } as never,
  }).body;

describe('/admin/evals page', () => {
  it('shows the latest metrics with the change against the previous run and a sparkline', () => {
    const body = page();
    expect(body).toMatch(/data-testid="evals-metric-citationSupport"[\s\S]*?75%[\s\S]*?\+15/);
    expect(body).toContain('<polyline');
    expect(body).toContain('$0.08');
    expect(body).toContain('abcdef1');
  });

  it('drill-down: question, answer, judge verdict and sources', () => {
    const body = page();
    expect(body).toContain('¿Qué mostró la red de ovitrampas?');
    expect(body).toContain('Bajaron [1].');
    expect(body).toMatch(/\[1\] SI/);
    expect(body).toContain('Ovitrampas');
  });

  it('"Ejecutar" first, the estimate only after it is pressed', () => {
    const body = page();
    expect(body).toContain('data-testid="evals-ejecutar"');
    expect(body).not.toContain('data-testid="evals-estimate"');
  });

  it('a running run shows its progress and hides "Ejecutar"', () => {
    const body = page({ running: { id: 'r3', status: 'running', progress: { done: 3, total: 12 } } });
    expect(body).toMatch(/En curso · 3\/12/);
    expect(body).not.toContain('data-testid="evals-ejecutar"');
  });

  it('an unreadable set says so', () => {
    expect(page({ state: 'unavailable' })).toContain('No pudimos cargar las evaluaciones');
  });
});
