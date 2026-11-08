import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/auth', () => ({ backendUrl: () => 'http://backend.test', backendFetch: vi.fn() }));

import { actions, load } from './+page.server';
import { backendFetch } from '$lib/server/auth';

const mocked = backendFetch as unknown as ReturnType<typeof vi.fn>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const view = {
  id: '42',
  name: 'Informe',
  contentKind: 'documento',
  gated: true,
  publicationStatus: 'published',
  status: 'held',
  kept: { authors: [], publicFigures: ['Benito Juárez'], citedAuthors: [] },
  counts: { stages: [{ stage: 'verify', removed: 1 }], pseudonyms: 2, addresses: 0 },
  switches: {
    keepDocumentAuthor: { value: false, origin: 'ecosistema' },
    keepCitedAuthors: { value: true, origin: 'documento' },
  },
};

const event = (form?: Record<string, string>, url = '/documentos/42/anonimizacion', user: unknown = { id: 2 }) =>
  ({
    locals: { user, token: 'tok' },
    params: { id: '42' },
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

describe('/documentos/[id]/anonimizacion load', () => {
  it('reads the backend view with the caller\'s token', async () => {
    mocked.mockResolvedValue(json(view));
    const data = (await load(event(undefined, '/documentos/42/anonimizacion?volver=/revision'))) as {
      state: string;
      view: { status: string; kept: { publicFigures: string[] } };
      back: string;
    };
    expect(mocked.mock.calls[0]?.[0]).toBe('tok');
    expect(mocked.mock.calls[0]?.[1]).toBe('/api/documents/42/anonimizacion');
    expect(data.state).toBe('ready');
    expect(data.view.status).toBe('held');
    expect(data.view.kept.publicFigures).toEqual(['Benito Juárez']);
    expect(data.back).toBe('/revision');
  });

  it('🔴 a backend 403 is the normal access-denied page, not a broken one', async () => {
    mocked.mockResolvedValue(json({ errors: [{ message: 'No.' }] }, 403));
    await expect(load(event())).rejects.toMatchObject({ status: 403, body: { kind: 'access-denied' } });
  });

  it('a backend 404 is the not-found page', async () => {
    mocked.mockResolvedValue(json({}, 404));
    await expect(load(event())).rejects.toMatchObject({ status: 404, body: { kind: 'not-found' } });
  });

  it('a signed-out caller is denied without asking the backend', async () => {
    await expect(load(event(undefined, undefined, null))).rejects.toMatchObject({ status: 403 });
    expect(mocked).not.toHaveBeenCalled();
  });

  it('a backend failure is "unavailable", not an error page', async () => {
    mocked.mockResolvedValue(json({}, 500));
    expect(await load(event())).toMatchObject({ state: 'unavailable', view: null });
    mocked.mockResolvedValue(json({ not: 'a view' }));
    expect(await load(event())).toMatchObject({ state: 'unavailable', view: null });
  });
});

describe('/documentos/[id]/anonimizacion guardar', () => {
  const sent = () => {
    const [, path, init] = mocked.mock.calls[0]!;
    expect(path).toBe('/api/documents/42/anonimizacion');
    expect((init as RequestInit).method).toBe('PATCH');
    return JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
  };

  it('sends the switch that moved and says the document is being checked again', async () => {
    mocked.mockResolvedValue(json({ ...view, regate: 'started' }));
    const out = await actions.guardar!(
      event({ 'was-keepDocumentAuthor': 'off', keepDocumentAuthor: 'on', 'was-keepCitedAuthors': 'on', keepCitedAuthors: 'on' }),
    );
    expect(sent()).toEqual({ keepDocumentAuthor: true });
    expect(out).toEqual({ saved: true, message: 'Guardado. Se está revisando de nuevo.', regate: 'started' });
  });

  it('"Usar el del ecosistema" sends null (the ecosistema\'s value)', async () => {
    mocked.mockResolvedValue(json({ ...view, regate: 'not-needed' }));
    const out = await actions.guardar!(event({ reset: 'keepCitedAuthors', 'was-keepCitedAuthors': 'on', keepCitedAuthors: 'on' }));
    expect(sent()).toEqual({ keepCitedAuthors: null });
    expect(out).toMatchObject({ saved: true, message: 'Guardado.' });
  });

  it('nothing moved: no call', async () => {
    const out = await actions.guardar!(event({ 'was-keepDocumentAuthor': 'off', 'was-keepCitedAuthors': 'off' }));
    expect(mocked).not.toHaveBeenCalled();
    expect(out).toMatchObject({ saved: true, message: 'Sin cambios.' });
  });

  it('409: the document is busy — a short message', async () => {
    mocked.mockResolvedValue(json({ errors: [{ message: 'busy' }] }, 409));
    const out = (await actions.guardar!(event({ 'was-keepDocumentAuthor': 'off', keepDocumentAuthor: 'on' }))) as {
      status: number;
      data: { message: string };
    };
    expect(out.status).toBe(409);
    expect(out.data.message).toBe('El documento se está procesando. Inténtalo en un momento.');
  });

  it.each([
    [403, 'No puedes cambiar esto.'],
    [404, 'No encontramos este documento.'],
    [400, 'No se pudo guardar.'],
  ])('%i is refused with a plain message', async (status, message) => {
    mocked.mockResolvedValue(json({}, status));
    const out = (await actions.guardar!(event({ 'was-keepDocumentAuthor': 'off', keepDocumentAuthor: 'on' }))) as {
      status: number;
      data: { message: string };
    };
    expect(out.status).toBe(status);
    expect(out.data.message).toBe(message);
  });

  it('a signed-out caller is refused without a call', async () => {
    const out = (await actions.guardar!(event({ keepDocumentAuthor: 'on' }, undefined, null))) as { status: number };
    expect(out.status).toBe(401);
    expect(mocked).not.toHaveBeenCalled();
  });
});
