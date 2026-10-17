import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/auth', () => ({
  backendUrl: () => 'http://backend.test',
  backendFetch: vi.fn(),
}));

import { backendFetch } from '$lib/server/auth';
import { fetchLenguaIndex } from './lenguas';

const mockedBackendFetch = backendFetch as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockedBackendFetch.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('fetchLenguaIndex', () => {
  it('asks the backend route for ONE ecosistema, as the caller', async () => {
    mockedBackendFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ lenguas: [{ lengua: 'mixe', documentos: 1 }], documentos: [{ id: 3, lengua: 'mixe' }] }),
        { status: 200 },
      ),
    );
    const result = await fetchLenguaIndex('tok', '7');
    expect(mockedBackendFetch).toHaveBeenCalledWith('tok', '/api/lenguas?organization=7', { method: 'GET' });
    expect(result).toEqual({
      ok: true,
      index: { lenguas: [{ lengua: 'mixe', documentos: 1 }], byDocument: { '3': 'mixe' } },
    });
  });

  it('reports a failed read as not-ok, never as "no languages"', async () => {
    mockedBackendFetch.mockResolvedValue(new Response('{}', { status: 500 }));
    expect((await fetchLenguaIndex('tok', '7')).ok).toBe(false);
    mockedBackendFetch.mockRejectedValue(new Error('down'));
    expect((await fetchLenguaIndex('tok', '7')).ok).toBe(false);
  });
});
