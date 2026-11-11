/**
 * Run lifecycle with every model call mocked: queued → running (progress per
 * item) → done with results, metrics, cost and models; the conversation is
 * always deleted; a failure lands on the row as `failed`.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/aiService', () => ({ getAIClient: vi.fn(() => { throw new Error('no real model calls in tests'); }) }));

import { claimRun, executeRun, releaseRun, type TurnFn } from './runner';
import type { JudgeFn } from './judge';
import type { EvalStore } from './store';
import type { EvalItem } from './types';

const item = (o: Partial<EvalItem>): EvalItem => ({
  id: '1', kind: 'pregunta', question: '¿Qué mostró la red de ovitrampas?', expectedDocIds: [1114], shouldRefuse: false,
  notes: '', text: '', privateNames: [], publicNames: [], gateKind: 'documento', ...o,
});

let sessionsFor: string[] = [];
function fakeStore(overrides: Partial<EvalStore> = {}) {
  const updates: Array<Record<string, unknown>> = [];
  const deleted: string[] = [];
  sessionsFor = [];
  const store: EvalStore = {
    listItems: async () => [],
    saveItem: async () => ({ ok: true }),
    deleteItem: async () => true,
    seed: async () => ({ ok: true }),
    listRuns: async () => [],
    createRun: async () => 'r1',
    updateRun: async (_id, data) => (updates.push(data), true),
    createSession: async (runId) => (sessionsFor.push(runId), 's1'),
    deleteSession: async (id) => void deleted.push(id),
    gate: async () => ({
      status: 'ready', detector: 'openai-compat:qwen', model: 'qwen', terms: [
        { term: 'Lucía', cls: 'privado', before: 2, after: 0, ok: true },
        { term: 'Cuautla', cls: 'publico', before: 1, after: 0, ok: false },
      ],
    }),
    expansionCost: async () => 0.0001,
    ...overrides,
  };
  return { store, updates, deleted };
}

const tap = {
  matches: [{ documentId: 'a', chunkId: 'c1', score: 1, corpus: 'eco-6', text: '<fuente>\nLas ovitrampas bajaron 40%.\n</fuente>', metadata: { docId: 1114 } }],
  provenance: { chunks: [{ chunkId: 'c1', documentId: 'a', score: 1, corpus: 'eco-6', metadata: { docId: 1114, title: 'Ovitrampas' } }] },
};

describe('executeRun', () => {
  it('runs each item through the turn, the judge and the gate, then writes done', async () => {
    const { store, updates, deleted } = fakeStore();
    const turns: string[] = [];
    const turn: TurnFn = async ({ sessionId, question }) => {
      turns.push(`${sessionId}:${question}`);
      return question.startsWith('¿Cuál')
        ? { text: 'Los documentos no mencionan eso.', costUsd: 0.001, model: 'deepseek/deepseek-chat-v3.1', messageId: 'm2', tap: { matches: [], provenance: null } }
        : { text: 'Las ovitrampas bajaron [1]. Y subió la lluvia [2].', costUsd: 0.002, model: 'deepseek/deepseek-chat-v3.1', messageId: 'm1', tap };
    };
    const judgeCalls: string[] = [];
    const judge: JudgeFn = async (system, user) => {
      judgeCalls.push(system.slice(0, 12));
      return { text: user.includes('ESTILO') ? 'NO: tono técnico' : 'SI', costUsd: 0.0005, model: 'deepseek/deepseek-chat-v3.1' };
    };
    await executeRun({
      runId: 'r1', orgId: '6', store, turn, judge, style: 'Modelo social.', commitSha: 'abc1234',
      items: [
        item({ id: '1' }),
        item({ id: '2', question: '¿Cuál es la capital de Australia?', expectedDocIds: [], shouldRefuse: true }),
        item({ id: '3', kind: 'privacidad', question: '', text: 'sintético', notes: 'kinship' }),
      ],
      now: () => new Date('2026-10-29T00:00:00Z'),
    });

    expect(turns).toEqual(['s1:¿Qué mostró la red de ovitrampas?', 's1:¿Cuál es la capital de Australia?']);
    // [1] judged, [2] names no source (no call), one style call; the refusal gets no judge call.
    expect(judgeCalls).toEqual(['Eres un veri', 'Eres un eval']);
    expect(updates[0]).toMatchObject({ status: 'running', progress: { done: 0, total: 3 } });
    expect(updates.filter((u) => 'progress' in u && !('status' in u)).map((u) => (u.progress as { done: number }).done)).toEqual([1, 2, 3]);
    const done = updates.at(-1)!;
    expect(done.status).toBe('done');
    expect(done.commitSha).toBe('abc1234');
    expect(done.models).toEqual({ chat: ['deepseek/deepseek-chat-v3.1'], judge: ['deepseek/deepseek-chat-v3.1'], gate: ['openai-compat:qwen (qwen)'] });
    // 0.002 + 0.0001 expansion + 2 × 0.0005 judge; 0.001 + 0.0001 for the refusal.
    expect(done.costUsd).toBeCloseTo(0.0042, 6);
    expect(done.metrics).toMatchObject({
      citationSupport: 0.5, refusalAccuracy: 1, hit1: 1, styleShown: 0, leakRate: 0, overRedaction: 1, errors: 0,
    });
    const [first] = done.results as Array<Record<string, unknown>>;
    expect(first).toMatchObject({ rank: 1, refused: false, style: { ok: false, reason: 'tono técnico' } });
    // The privacy result holds verdicts, never the text.
    expect(JSON.stringify(done.results)).not.toContain('sintético');
    expect(deleted).toEqual(['s1']);
    // R77: the conversation is asked for THIS run, after it is marked running.
    expect(sessionsFor).toEqual(['r1']);
  });

  it('an item error is recorded and the run goes on', async () => {
    const { store, updates } = fakeStore();
    const turn: TurnFn = async () => {
      throw Object.assign(new Error('x'), { status: 402, body: { message: 'Sin presupuesto' } });
    };
    await executeRun({ runId: 'r1', orgId: '6', store, turn, judge: vi.fn(), style: null, items: [item({}), item({ id: '2' })] });
    const done = updates.at(-1)!;
    expect(done.status).toBe('done');
    expect((done.results as Array<{ error?: string }>).map((r) => r.error)).toEqual(['402 Sin presupuesto', '402 Sin presupuesto']);
    expect(done.metrics).toMatchObject({ errors: 2, questions: 0 });
  });

  it('🔴 an item error that quotes a row is stored as its summary', async () => {
    const { store, updates } = fakeStore();
    const turn: TurnFn = async () => {
      throw new Error('Failed query: select $1\nparams: Me llamo Lucía Hernández');
    };
    await executeRun({ runId: 'r1', orgId: '6', store, turn, judge: vi.fn(), style: null, items: [item({})] });
    expect((updates.at(-1)!.results as Array<{ error?: string }>).map((r) => r.error)).toEqual(['Error']);
  });

  it('a failure outside an item marks the run failed and still deletes the conversation', async () => {
    const { store, updates, deleted } = fakeStore({
      updateRun: vi.fn(async (_id: string, data: Record<string, unknown>) => {
        if ((data.progress as { done?: number } | undefined)?.done === 1) throw new Error('backend down');
        return true;
      }),
    });
    const calls = (store.updateRun as ReturnType<typeof vi.fn>).mock.calls;
    const turn: TurnFn = async () => ({ text: 'x', costUsd: 0, model: null, messageId: null, tap: null });
    await executeRun({ runId: 'r1', orgId: '6', store, turn, judge: vi.fn(), style: null, items: [item({})] });
    expect(calls.at(-1)![1]).toMatchObject({ status: 'failed', error: 'backend down' });
    expect(deleted).toEqual(['s1']);
    void updates;
  });
});

describe('claimRun', () => {
  it('🔴 one start per ecosistema: a second claim is refused until released', () => {
    expect(claimRun('6')).toBe(true);
    expect(claimRun('6')).toBe(false);
    expect(claimRun('7')).toBe(true);
    releaseRun('6');
    expect(claimRun('6')).toBe(true);
    releaseRun('6');
    releaseRun('7');
  });
});
