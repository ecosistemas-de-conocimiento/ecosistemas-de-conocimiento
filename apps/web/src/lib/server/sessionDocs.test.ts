/**
 * `fetchSessionDocs` — and the one distinction the whole draft filter rests on:
 * "this conversation has no documents" is NOT the same as "we could not find
 * out". The first drops every draft chunk correctly; the second must stop the
 * draft leg from running at all.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/auth', () => ({
  backendUrl: () => 'http://backend.test',
  backendFetch: vi.fn(),
}));

import { backendFetch } from '$lib/server/auth';
import { fetchSessionDocs, sessionDocumentIdSet, sessionDocumentsQuery } from './sessionDocs';

const mockedBackendFetch = backendFetch as unknown as ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  mockedBackendFetch.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('sessionDocumentsQuery', () => {
  // ⚠ ONE place, on purpose — `documents.session` is a `hasMany` relationship,
  // and if `[equals]` ever stops matching "contains this id" the fix is here.
  it('asks Payload for this session’s documents, unpaged and shallow', () => {
    const q = sessionDocumentsQuery('42');
    expect(q).toContain('/api/documents?');
    expect(decodeURIComponent(q)).toContain('where[session][equals]=42');
    expect(q).toContain('limit=500');
    expect(q).toContain('depth=0');
    expect(q).toContain('sort=createdAt');
  });

  it('encodes a session id that is not a plain number', () => {
    expect(sessionDocumentsQuery('a b&c')).toContain('a+b%26c');
  });
});

describe('fetchSessionDocs', () => {
  it('reads the document list', async () => {
    mockedBackendFetch.mockResolvedValue(
      jsonResponse({ docs: [{ id: 10, name: 'Informe' }, { id: '11', name: 'Acta' }] }),
    );

    const res = await fetchSessionDocs('tok', '42');

    expect(res.ok).toBe(true);
    expect(res.docs.map((d) => d.id)).toEqual([10, '11']);
  });

  it('reports an EMPTY conversation as a successful read', async () => {
    mockedBackendFetch.mockResolvedValue(jsonResponse({ docs: [] }));

    const res = await fetchSessionDocs('tok', '42');

    expect(res).toEqual({ docs: [], ok: true });
  });

  it.each([401, 403, 404, 500])('reports HTTP %i as unknown, not as empty', async (status) => {
    mockedBackendFetch.mockResolvedValue(jsonResponse({ errors: [] }, status));

    expect(await fetchSessionDocs('tok', '42')).toEqual({ docs: [], ok: false });
    expect(console.error).toHaveBeenCalled();
  });

  it('reports a thrown fetch as unknown', async () => {
    mockedBackendFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await fetchSessionDocs('tok', '42')).toEqual({ docs: [], ok: false });
  });

  it('reports an unreadable body as unknown', async () => {
    mockedBackendFetch.mockResolvedValue(
      new Response('not json', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    expect(await fetchSessionDocs('tok', '42')).toEqual({ docs: [], ok: false });
  });

  it('reports a body with no docs array as unknown', async () => {
    mockedBackendFetch.mockResolvedValue(jsonResponse({ totalDocs: 3 }));
    expect(await fetchSessionDocs('tok', '42')).toEqual({ docs: [], ok: false });
  });

  it('skips malformed rows rather than failing the whole read', async () => {
    mockedBackendFetch.mockResolvedValue(
      jsonResponse({ docs: [null, 'nope', { name: 'sin id' }, { id: 10, name: 'Informe' }] }),
    );

    const res = await fetchSessionDocs('tok', '42');

    expect(res.ok).toBe(true);
    expect(res.docs).toHaveLength(1);
  });

  it('does not call the backend at all without a session id', async () => {
    expect(await fetchSessionDocs('tok', '')).toEqual({ docs: [], ok: false });
    expect(mockedBackendFetch).not.toHaveBeenCalled();
  });
});

describe('sessionDocumentIdSet', () => {
  it('is a set of string ids for a successful read', () => {
    const ids = sessionDocumentIdSet({ ok: true, docs: [{ id: 10, name: 'a' }, { id: '11', name: 'b' }] });
    expect(ids && [...ids].sort()).toEqual(['10', '11']);
  });

  it('is an EMPTY SET for a conversation with no documents', () => {
    expect(sessionDocumentIdSet({ ok: true, docs: [] })?.size).toBe(0);
  });

  // 🔴 The distinction the draft leg fails closed on.
  it('is NULL when the list could not be read', () => {
    expect(sessionDocumentIdSet({ ok: false, docs: [] })).toBeNull();
  });
});
