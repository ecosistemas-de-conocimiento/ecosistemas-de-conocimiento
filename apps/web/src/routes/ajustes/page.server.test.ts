import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/auth', () => ({ backendUrl: () => 'http://backend.test', backendFetch: vi.fn() }));

import { actions, load } from './+page.server';
import { backendFetch } from '$lib/server/auth';
import { FEATURE_DEFAULTS, FEATURE_KEYS, FEATURE_LABELS } from '$lib/features';

const mocked = backendFetch as unknown as ReturnType<typeof vi.fn>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const event = (url = '/ajustes', form?: Record<string, string>) =>
  ({
    locals: { user: { id: 2 }, token: 'tok' },
    url: new URL(url, 'http://web.test'),
    request: {
      formData: async () => {
        const f = new FormData();
        for (const [k, v] of Object.entries(form ?? {})) f.set(k, v);
        return f;
      },
    },
  }) as never;

beforeEach(() => mocked.mockReset());

describe('/ajustes load', () => {
  it('🔴 a member or an admin-role person (backend 403) is denied', async () => {
    mocked.mockResolvedValue(json({ errors: [{ message: 'No administras este ecosistema.' }] }, 403));
    await expect(load(event())).rejects.toMatchObject({ status: 403 });
  });

  it('lists only what the backend says is editable, and picks ?eco=', async () => {
    mocked.mockResolvedValue(
      json({
        ecosistemas: [
          { id: '1', name: 'A', slug: 'a', features: { graph: false } },
          { id: '2', name: 'B', slug: 'b', features: null },
        ],
        plataforma: null,
      }),
    );
    const data = (await load(event('/ajustes?eco=2'))) as {
      selected: { id: string; features: Record<string, boolean> };
      plataforma: unknown;
    };
    expect(mocked.mock.calls[0]?.[1]).toBe('/api/funciones/editables');
    expect(data.selected.id).toBe('2');
    expect(data.selected.features.graph).toBe(true);
    expect(data.plataforma).toBeNull();
  });

  it('🔴 passes the backend\'s locked switches through; a backend that does not say locks the admin-only ones', async () => {
    mocked.mockResolvedValue(
      json({ ecosistemas: [{ id: '1', name: 'A', slug: 'a', features: null }], plataforma: null, lockedFeatures: [] }),
    );
    expect(((await load(event())) as { lockedFeatures: string[] }).lockedFeatures).toEqual([]);
    mocked.mockResolvedValue(json({ ecosistemas: [{ id: '1', name: 'A', slug: 'a', features: null }], plataforma: null }));
    expect(((await load(event())) as { lockedFeatures: string[] }).lockedFeatures).toEqual(['keepPublicFigures']);
  });
});

describe('/ajustes actions', () => {
  it('sends every switch: ticked = on, unticked = off', async () => {
    mocked.mockResolvedValue(json({ features: {} }));
    await actions.funciones!(event('/ajustes', { organization: '1', liveMic: 'on' }));
    const [, path, init] = mocked.mock.calls[0]!;
    expect(path).toBe('/api/funciones');
    const body = JSON.parse(String((init as RequestInit).body)) as { organization: string; features: Record<string, boolean> };
    expect(body.organization).toBe('1');
    expect(Object.keys(body.features).sort()).toEqual([...FEATURE_KEYS].sort());
    expect(body.features.liveMic).toBe(true);
    expect(body.features.graph).toBe(false);
  });

  it('keepPublicFigures: off by default, labelled in Spanish, sent when ticked', async () => {
    expect(FEATURE_DEFAULTS.keepPublicFigures).toBe(false);
    expect(FEATURE_LABELS.keepPublicFigures).toMatch(/figuras públicas/);
    mocked.mockResolvedValue(json({ features: {} }));
    await actions.funciones!(event('/ajustes', { organization: '1', keepPublicFigures: 'on' }));
    const body = JSON.parse(String((mocked.mock.calls[0]![2] as RequestInit).body)) as { features: Record<string, boolean> };
    expect(body.features.keepPublicFigures).toBe(true);
  });

  it('🔴 a locked switch is left out of the save, so a read-only toggle never reads as "off"', async () => {
    mocked.mockResolvedValue(json({ features: {} }));
    await actions.funciones!(event('/ajustes', { organization: '1', liveMic: 'on', locked: 'keepPublicFigures' }));
    const body = JSON.parse(String((mocked.mock.calls[0]![2] as RequestInit).body)) as { features: Record<string, boolean> };
    expect('keepPublicFigures' in body.features).toBe(false);
    expect(body.features.liveMic).toBe(true);
    expect(body.features.graph).toBe(false);
  });

  it('passes the backend refusal through', async () => {
    mocked.mockResolvedValue(json({ errors: [{ message: 'No administras este ecosistema.' }] }, 403));
    const out = (await actions.funciones!(event('/ajustes', { organization: '9' }))) as { status: number; data: { message: string } };
    expect(out.status).toBe(403);
    expect(out.data.message).toBe('No administras este ecosistema.');
  });

  it('platform: "env" sends null (back to the env value)', async () => {
    mocked.mockResolvedValue(json({}));
    await actions.plataforma!(event('/ajustes', { detectorFallback: 'env' }));
    expect(JSON.parse(String((mocked.mock.calls[0]![2] as RequestInit).body))).toEqual({ detectorFallback: null });
    await actions.plataforma!(event('/ajustes', { detectorFallback: 'none' }));
    expect(JSON.parse(String((mocked.mock.calls[1]![2] as RequestInit).body))).toEqual({ detectorFallback: 'none' });
  });
});
