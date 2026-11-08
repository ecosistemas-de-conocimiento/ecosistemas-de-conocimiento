import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/auth', () => ({ backendUrl: () => 'http://backend.test', backendFetch: vi.fn() }));

import { actions, load } from './+page.server';
import { backendFetch } from '$lib/server/auth';
import { CONVERSACIONES_HREF } from '$lib/inicio';
import { FEATURE_DEFAULTS, FEATURE_KEYS, FEATURE_LABELS, PLATFORM_ADMIN_ONLY_FEATURES } from '$lib/features';

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

  it('the deny page goes back to the conversations, not to the start screen', async () => {
    mocked.mockResolvedValue(json({}, 403));
    const err = await Promise.resolve(load(event())).catch((e: unknown) => e);
    expect(JSON.stringify(err)).toContain(`"href":"${CONVERSACIONES_HREF}"`);
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

  it('a retired ecosistema is neither the default nor a chip, but ?eco= still opens it (R54)', async () => {
    // A Response body reads once: a fresh one per load.
    mocked.mockImplementation(async () =>
      json({
        ecosistemas: [
          { id: '3', name: 'A retirado', slug: 'a', isActive: false, features: null },
          { id: '4', name: 'B', slug: 'b', isActive: true, features: null },
          { id: '5', name: 'C', slug: 'c', features: null },
        ],
        plataforma: null,
      }),
    );
    const plain = (await load(event())) as { selected: { id: string }; ecosistemas: Array<{ id: string }> };
    expect(plain.selected.id).toBe('4');
    expect(plain.ecosistemas.map((e) => e.id)).toEqual(['4', '5']);
    const byUrl = (await load(event('/ajustes?eco=3'))) as { selected: { id: string } };
    expect(byUrl.selected.id).toBe('3');
  });

  it('🔴 passes the backend\'s locked switches through; a backend that does not say locks the admin-only ones', async () => {
    mocked.mockResolvedValue(
      json({ ecosistemas: [{ id: '1', name: 'A', slug: 'a', features: null }], plataforma: null, lockedFeatures: [] }),
    );
    expect(((await load(event())) as { lockedFeatures: string[] }).lockedFeatures).toEqual([]);
    mocked.mockResolvedValue(json({ ecosistemas: [{ id: '1', name: 'A', slug: 'a', features: null }], plataforma: null }));
    expect(((await load(event())) as { lockedFeatures: string[] }).lockedFeatures).toEqual([
      'keepPublicFigures',
      'studentTestimonios',
    ]);
  });
});

describe('/ajustes load — the answer style', () => {
  it('passes each ecosistema\'s styles and whether this caller may edit them; missing = read-only', async () => {
    mocked.mockResolvedValue(
      json({
        ecosistemas: [{ id: '7', name: 'D', slug: 'd', features: null, answerStyles: { generales: 'G', resonancias: '  ' } }],
        plataforma: null,
        answerStylesEditable: true,
      }),
    );
    const data = (await load(event())) as {
      selected: { answerStyles: Record<string, string | null> };
      answerStylesEditable: boolean;
    };
    expect(data.selected.answerStyles).toEqual({ generales: 'G', resonancias: null, interviewer: null });
    expect(data.answerStylesEditable).toBe(true);
    mocked.mockResolvedValue(json({ ecosistemas: [{ id: '7', name: 'D', slug: 'd', features: null }], plataforma: null }));
    expect(((await load(event())) as { answerStylesEditable: boolean }).answerStylesEditable).toBe(false);
  });
});

describe('/ajustes actions', () => {
  it('estilo: sends all three texts to /api/funciones/estilo; blank is sent as blank', async () => {
    mocked.mockResolvedValue(json({ answerStyles: {} }));
    const out = await actions.estilo!(
      event('/ajustes', { organization: '7', 'style-generales': 'Tono cálido.', 'style-resonancias': '' }),
    );
    expect(out).toEqual({ saved: true, scope: 'estilo' });
    const [, path, init] = mocked.mock.calls[0]!;
    expect(path).toBe('/api/funciones/estilo');
    expect((init as RequestInit).method).toBe('PATCH');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      organization: '7',
      answerStyles: { generales: 'Tono cálido.', resonancias: '', interviewer: '' },
    });
  });

  it('estilo: passes the backend refusal through (403 not admin, 400 refused text)', async () => {
    mocked.mockResolvedValue(
      json({ errors: [{ message: 'Solo administración de la plataforma puede cambiar el estilo de respuesta.' }] }, 403),
    );
    const refused = (await actions.estilo!(event('/ajustes', { organization: '7' }))) as {
      status: number;
      data: { message: string };
    };
    expect(refused.status).toBe(403);
    expect(refused.data.message).toMatch(/estilo de respuesta/);
    mocked.mockResolvedValue(json({ errors: [{ message: 'El estilo de respuesta no puede incluir etiquetas <fuente>.' }] }, 400));
    const bad = (await actions.estilo!(event('/ajustes', { organization: '7' }))) as { status: number };
    expect(bad.status).toBe(400);
  });

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

  it.each([
    ['keepDocumentAuthor', 'Conservar al autor del documento'],
    ['keepCitedAuthors', 'Conservar autores citados'],
  ] as const)('%s: off by default, labelled in Spanish, not admin-only, sent when ticked', async (key, label) => {
    expect(FEATURE_DEFAULTS[key]).toBe(false);
    expect(FEATURE_LABELS[key]).toBe(label);
    expect(PLATFORM_ADMIN_ONLY_FEATURES).not.toContain(key);
    mocked.mockResolvedValue(json({ features: {} }));
    await actions.funciones!(event('/ajustes', { organization: '1', [key]: 'on' }));
    const body = JSON.parse(String((mocked.mock.calls[0]![2] as RequestInit).body)) as { features: Record<string, boolean> };
    expect(body.features[key]).toBe(true);
  });

  it('studentTestimonios: off by default, labelled in Spanish, admin-only', async () => {
    expect(FEATURE_DEFAULTS.studentTestimonios).toBe(false);
    expect(FEATURE_LABELS.studentTestimonios).toBe('Testimonios de estudiantes en el reporte (anonimizados)');
    expect(PLATFORM_ADMIN_ONLY_FEATURES).toContain('studentTestimonios');
  });

  it('🔴 a locked switch is left out of the save, so a read-only toggle never reads as "off"', async () => {
    mocked.mockResolvedValue(json({ features: {} }));
    await actions.funciones!(event('/ajustes', { organization: '1', liveMic: 'on', locked: 'keepPublicFigures' }));
    const body = JSON.parse(String((mocked.mock.calls[0]![2] as RequestInit).body)) as { features: Record<string, boolean> };
    expect('keepPublicFigures' in body.features).toBe(false);
    expect(body.features.liveMic).toBe(true);
    expect(body.features.graph).toBe(false);
  });

  it('says which form it answers, so the page shows the result under that form', async () => {
    mocked.mockResolvedValue(json({}));
    expect(await actions.funciones!(event('/ajustes', { organization: '1' }))).toEqual({ saved: true, scope: 'funciones' });
    expect(await actions.plataforma!(event('/ajustes', { detectorFallback: 'env' }))).toEqual({ saved: true, scope: 'plataforma' });
    mocked.mockResolvedValue(json({ errors: [{ message: 'No.' }] }, 403));
    const out = (await actions.funciones!(event('/ajustes', { organization: '1' }))) as { data: { scope: string } };
    expect(out.data.scope).toBe('funciones');
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
