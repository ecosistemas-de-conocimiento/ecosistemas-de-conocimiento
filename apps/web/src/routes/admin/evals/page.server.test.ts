/**
 * `/admin/evals` — 🔴 platform admin only (load AND every action), and
 * "Ejecutar" queues a run only after the confirm.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = {
  listItems: vi.fn(),
  listRuns: vi.fn(),
  updateRun: vi.fn(async () => true),
  saveItem: vi.fn(async () => ({ ok: true })),
  deleteItem: vi.fn(async () => true),
  seed: vi.fn(async () => ({ ok: true })),
  createRun: vi.fn(async () => 'r9'),
};
vi.mock('$lib/server/evals/store', () => ({ makeEvalStore: () => store }));
vi.mock('$lib/server/evals/runner', () => ({
  activeRunIds: vi.fn(() => new Set<string>()),
  enqueueRun: vi.fn(),
  productionTurn: vi.fn(() => async () => ({})),
}));
vi.mock('$lib/server/admin', () => ({
  listAllEcosystems: vi.fn(async () => ({ rows: [{ id: '6', name: 'Dengue', slug: 'prevencion-dengue' }, { id: '7', name: 'Discapacidad', slug: 'discapacidad' }], ok: true })),
}));
vi.mock('$lib/server/features', () => ({
  fetchEcosystemSettings: vi.fn(async () => ({ features: {}, answerStyles: { generales: 'Modelo social.', resonancias: null, interviewer: null } })),
}));

import { actions, load } from './+page.server';
import { enqueueRun } from '$lib/server/evals/runner';

const ADMIN = { id: 1, email: 'a@x', isPlatformAdmin: true };
const OWNER = { id: 2, email: 'o@x', isPlatformAdmin: false, memberships: [{ organization: '6', role: 'owner' }] };
const q = { id: '1', kind: 'pregunta', question: '¿?', expectedDocIds: [1], shouldRefuse: false, notes: '', text: '', privateNames: [], publicNames: [], gateKind: 'documento' };

const event = (user: unknown, url = '/admin/evals', body?: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(body ?? {})) fd.set(k, v);
  return { locals: { user, token: 't' }, url: new URL(url, 'http://web.test'), request: { formData: async () => fd } } as never;
};

beforeEach(() => {
  vi.clearAllMocks();
  store.listItems.mockResolvedValue([q]);
  store.listRuns.mockResolvedValue([]);
});

const status = async (p: unknown) => {
  try {
    await p;
    return 200;
  } catch (e) {
    return (e as { status?: number }).status;
  }
};

describe('access', () => {
  it('🔴 load and every action are 403 for anyone but a platform admin', async () => {
    for (const user of [null, OWNER, { ...ADMIN, isPlatformAdmin: 'true' }]) {
      expect(await status(load(event(user)))).toBe(403);
      for (const name of ['guardar', 'borrar', 'cargar', 'ejecutar'] as const) {
        expect(await status(actions[name]!(event(user, '/admin/evals', { organization: '6', confirm: 'si' })))).toBe(403);
      }
    }
    expect(store.createRun).not.toHaveBeenCalled();
    expect(enqueueRun).not.toHaveBeenCalled();
  });
});

describe('load', () => {
  it('picks ?eco, returns items, the estimate and whether a style exists', async () => {
    const data = (await load(event(ADMIN, '/admin/evals?eco=7'))) as Record<string, unknown>;
    expect(data).toMatchObject({ state: 'ready', selected: { id: '7' }, hasStyle: true, estimate: { questions: 1, privacy: 0, basis: 'supuesto' } });
    expect(store.listItems).toHaveBeenCalledWith('7');
  });

  it('marks a run lost to a restart as failed', async () => {
    store.listRuns.mockResolvedValue([{ id: 'r1', status: 'running', results: [], createdAt: '' }]);
    const data = (await load(event(ADMIN))) as { running: unknown };
    expect(store.updateRun).toHaveBeenCalledWith('r1', { status: 'failed', error: 'interrumpida' });
    expect(data.running).toBeNull();
  });
});

describe('ejecutar', () => {
  it('refuses without the confirm', async () => {
    const res = (await actions.ejecutar!(event(ADMIN, '/admin/evals', { organization: '6' }))) as { status: number };
    expect(res.status).toBe(400);
    expect(store.createRun).not.toHaveBeenCalled();
  });

  it('with the confirm: creates the row with the estimate and queues it on that ecosistema', async () => {
    await actions.ejecutar!(event(ADMIN, '/admin/evals', { organization: '6', confirm: 'si' }));
    expect(store.createRun).toHaveBeenCalledWith('6', expect.objectContaining({ status: 'queued', triggeredBy: 1 }));
    expect(enqueueRun).toHaveBeenCalledWith(expect.objectContaining({ runId: 'r9', orgId: '6', style: 'Modelo social.' }));
  });
});
