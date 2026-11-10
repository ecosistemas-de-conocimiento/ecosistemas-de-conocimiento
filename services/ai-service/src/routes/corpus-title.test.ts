// Unit tests for PATCH /v1/corpus/:name/titles.
//
// `DocumentTitleService.setTitles` is mocked so the route layer is exercised in
// isolation: admin-only gate, body validation, (org, project) from req.auth.
// The SQL — and the "no vector byte changes" property — is covered against a
// real database in `services/rag/document-title.integration.test.ts`.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { useBuildServer } from '../test/server-harness.js';

const setTitleMock = vi.fn();

vi.mock('../services/rag/document-title.js', async () => {
  const actual = await vi.importActual<typeof import('../services/rag/document-title.js')>(
    '../services/rag/document-title.js',
  );
  return {
    ...actual,
    DocumentTitleService: class {
      setTitles = (...args: unknown[]) => setTitleMock(...args);
    },
  };
});

vi.mock('../db/client.js', () => ({ db: {} }));

vi.hoisted(() => {
  process.env.API_KEYS = JSON.stringify({
    'app-key': { org: 'acme', project: 'chat', role: 'app' },
    'admin-key': { org: 'acme', project: 'chat', role: 'admin' },
  });
});

const makeApp = useBuildServer();

afterEach(() => {
  vi.clearAllMocks();
});

const URL_A = '/v1/corpus/my-corpus/titles';
const BODY = { documents: [{ externalId: 'doc-1', title: 'Neutral' }], dryRun: true };

describe('PATCH /v1/corpus/:name/titles', () => {
  it('admin key: updates and scopes to the key (org, project)', async () => {
    const result = {
      dryRun: true,
      documents: [
        {
          externalId: 'doc-1',
          documentId: '00000000-0000-4000-8000-000000000001',
          changed: true,
          chunksChanged: 3,
        },
      ],
      notFound: [],
    };
    setTitleMock.mockResolvedValueOnce(result);
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH',
      url: URL_A,
      headers: { authorization: 'Bearer admin-key' },
      payload: BODY,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(result);
    expect(setTitleMock).toHaveBeenCalledWith(
      { corpus: 'my-corpus', ...BODY },
      { org: 'acme', project: 'chat' },
    );
    await app.close();
  });

  it('app-role key: 403, service never called', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH',
      url: URL_A,
      headers: { authorization: 'Bearer app-key' },
      payload: BODY,
    });
    expect(res.statusCode).toBe(403);
    expect(setTitleMock).not.toHaveBeenCalled();
    await app.close();
  });

  const many = Array.from({ length: 201 }, (_, i) => ({ externalId: `d${i}`, title: 't' }));
  it.each([
    ['no documents', {}],
    ['empty batch', { documents: [] }],
    ['empty title', { documents: [{ externalId: 'a', title: '' }] }],
    ['unknown key', { documents: [{ externalId: 'a', title: 't', text: 'y' }] }],
    ['duplicate id', { documents: [{ externalId: 'a', title: 't' }, { externalId: 'a', title: 'u' }] }],
    ['over 200', { documents: many }],
  ])('rejects %s with 400', async (_label, payload) => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH',
      url: URL_A,
      headers: { authorization: 'Bearer admin-key' },
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(setTitleMock).not.toHaveBeenCalled();
    await app.close();
  });
});
