// Unit tests for /v1/ingest/*.
//
// The IngestService is mocked at the module boundary so this suite exercises
// only route wiring: Zod validation, auth-context plumbing, response shape
// (202 on POST, 200 on GET). The service's own behaviour is covered in
// ingest.worker.test.ts + the integration suite.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useBuildServer } from '../test/server-harness.js';

const ingestBatchMock = vi.fn();
const getIngestStatusMock = vi.fn();

vi.mock('../services/rag/ingest.js', () => ({
  IngestService: class {
    ingestBatch = (...args: unknown[]) => ingestBatchMock(...args);
    getIngestStatus = (...args: unknown[]) => getIngestStatusMock(...args);
  },
}));

vi.mock('../db/client.js', () => ({
  db: {},
}));

vi.mock('../queue/queues.js', async () => {
  const actual = await vi.importActual<typeof import('../queue/queues.js')>(
    '../queue/queues.js',
  );
  return {
    ...actual,
    getIngestQueue: () => ({ add: vi.fn(), addBulk: vi.fn() }),
  };
});

const APP_TOKEN = 'test-key';
const ORG = 'test-org';
const PROJECT = 'test-project';

// `server.js` is imported ONCE per file, in `beforeAll` — importing it inside
// the first test body cost that test ~3 s of module transform against vitest's
// 5 s per-test budget. See `src/test/server-harness.ts`.
const makeApp = useBuildServer();

beforeEach(() => {
  ingestBatchMock.mockReset();
  getIngestStatusMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /v1/ingest', () => {
  it('happy path → 202 with handle', async () => {
    const app = await makeApp();
    ingestBatchMock.mockResolvedValueOnce({
      ingestId: 'ing-1',
      corpusId: 'cor-1',
      totalDocs: 2,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      headers: { authorization: `Bearer ${APP_TOKEN}` },
      payload: {
        corpus: 'docs',
        documents: [
          { text: 'first doc' },
          { id: 'ext-2', text: 'second doc' },
        ],
      },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({
      ingestId: 'ing-1',
      corpusId: 'cor-1',
      totalDocs: 2,
    });
    expect(ingestBatchMock).toHaveBeenCalledTimes(1);
    const [, ctx] = ingestBatchMock.mock.calls[0]!;
    expect((ctx as { org: string; project: string }).org).toBe(ORG);
    expect((ctx as { org: string; project: string }).project).toBe(PROJECT);
    await app.close();
  });

  it('empty documents array → 400', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      headers: { authorization: `Bearer ${APP_TOKEN}` },
      payload: { corpus: 'docs', documents: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(ingestBatchMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('missing corpus name → 400', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      headers: { authorization: `Bearer ${APP_TOKEN}` },
      payload: { documents: [{ text: 'doc' }] },
    });
    expect(res.statusCode).toBe(400);
    expect(ingestBatchMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('document id exceeding 200 chars → 400', async () => {
    const app = await makeApp();
    const longId = 'x'.repeat(201);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      headers: { authorization: `Bearer ${APP_TOKEN}` },
      payload: {
        corpus: 'docs',
        documents: [{ id: longId, text: 'doc' }],
      },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects >100 documents in a single batch', async () => {
    const app = await makeApp();
    const docs = Array.from({ length: 101 }, (_, i) => ({ text: `doc ${i}` }));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      headers: { authorization: `Bearer ${APP_TOKEN}` },
      payload: { corpus: 'docs', documents: docs },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('GET /v1/ingest/:ingestId', () => {
  it('returns the status snapshot', async () => {
    const app = await makeApp();
    getIngestStatusMock.mockResolvedValueOnce({
      ingestId: 'ing-1',
      totalDocs: 3,
      completedDocs: 3,
      failedDocs: 0,
      status: 'completed',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/ingest/ing-1',
      headers: { authorization: `Bearer ${APP_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ingestId: 'ing-1',
      totalDocs: 3,
      completedDocs: 3,
      failedDocs: 0,
      status: 'completed',
    });
    expect(getIngestStatusMock).toHaveBeenCalledWith(
      'ing-1',
      expect.objectContaining({ org: ORG, project: PROJECT }),
    );
    await app.close();
  });
});
