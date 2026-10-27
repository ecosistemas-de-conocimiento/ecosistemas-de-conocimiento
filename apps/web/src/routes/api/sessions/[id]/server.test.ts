import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/auth', () => ({ backendFetch: vi.fn() }));

import { PATCH } from './+server';
import { backendFetch } from '$lib/server/auth';

const mockedBackendFetch = backendFetch as unknown as ReturnType<typeof vi.fn>;

describe('PATCH /api/sessions/[id]', () => {
  it('🔴 drops `kind`: Generales/Resonancias is fixed at create', async () => {
    mockedBackendFetch.mockResolvedValue(new Response(JSON.stringify({ doc: { id: 5 } }), { status: 200 }));
    await PATCH({
      locals: { user: { id: 1 }, token: 'tok' },
      params: { id: '5' },
      request: new Request('http://web.test/api/sessions/5', {
        method: 'PATCH',
        body: JSON.stringify({ title: 'Nuevo', kind: 'resonancias' }),
      }),
    } as unknown as Parameters<typeof PATCH>[0]);
    const sent = JSON.parse(String((mockedBackendFetch.mock.calls[0]![2] as RequestInit).body));
    expect(sent).toEqual({ title: 'Nuevo' });
  });
});
