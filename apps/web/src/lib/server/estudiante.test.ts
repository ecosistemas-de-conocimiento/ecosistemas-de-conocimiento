import { beforeEach, describe, expect, it, vi } from 'vitest';

const backendFetch = vi.fn();
vi.mock('$lib/server/auth', () => ({ backendFetch: (...a: unknown[]) => backendFetch(...a) }));

import { fetchScopeDocumentIds, fetchStudentAccess, NO_ACCESS, parseAlcance } from './estudiante';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

beforeEach(() => backendFetch.mockReset());

describe('fetchStudentAccess', () => {
  it('studentView off (404) or no ecosistema → nothing', async () => {
    backendFetch.mockResolvedValue(json(404, { errors: [{ message: 'No disponible.' }] }));
    expect(await fetchStudentAccess('t', '8')).toEqual(NO_ACCESS);
    expect(await fetchStudentAccess('t', null)).toEqual(NO_ACCESS);
  });
  it('only literal true counts', async () => {
    backendFetch.mockResolvedValue(json(200, { student: true, teacher: 'yes', admin: 1 }));
    expect(await fetchStudentAccess('t', '8')).toEqual({ student: true, teacher: false, admin: false });
  });
});

describe('fetchScopeDocumentIds', () => {
  it('🔴 any failure is null (the caller then retrieves nothing)', async () => {
    backendFetch.mockResolvedValue(json(404, {}));
    expect(await fetchScopeDocumentIds('t', '8', 'mios')).toBeNull();
    backendFetch.mockResolvedValue(json(200, { documentIds: 'x' }));
    expect(await fetchScopeDocumentIds('t', '8', 'mios')).toBeNull();
    backendFetch.mockResolvedValue(new Response('not json', { status: 200 }));
    expect(await fetchScopeDocumentIds('t', '8', 'mios')).toBeNull();
  });
  it('ids as strings', async () => {
    backendFetch.mockResolvedValue(json(200, { documentIds: [3, 4] }));
    expect(await fetchScopeDocumentIds('t', '8', 'companeros')).toEqual(new Set(['3', '4']));
    expect(backendFetch.mock.calls[0]![1]).toBe('/api/estudiante/alcance?organization=8&alcance=companeros');
  });
});

describe('parseAlcance', () => {
  it('two values, nothing else', () => {
    expect(parseAlcance('mios')).toBe('mios');
    expect(parseAlcance('companeros')).toBe('companeros');
    expect(parseAlcance('todo')).toBeNull();
    expect(parseAlcance(undefined)).toBeNull();
  });
});
