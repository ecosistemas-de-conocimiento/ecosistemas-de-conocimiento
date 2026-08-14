// Unit tests for the sparse (bge-m3 learned-lexical) embedding client and the
// pgvector sparsevec literal builder. `env` and `fetch` are both mocked so the
// test controls SPARSE_EMBED_URL and the wire response without a real network.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable env stand-in — callSparseEmbed reads `env.SPARSE_EMBED_URL` at call time.
const envMock = vi.hoisted(() => ({
  SPARSE_EMBED_URL: 'http://bge-m3.test/embed' as string | undefined,
}));
vi.mock('../../../config/env.js', () => ({ env: envMock }));

import {
  callSparseEmbed,
  SparseEmbedHttpError,
  SparseEmbedNotConfiguredError,
  toSparsevecLiteral,
} from './sparse-embed.js';

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('toSparsevecLiteral', () => {
  const DIM = 250002;

  it('shifts 0-based token ids to 1-based, sorts ascending, formats {i:v}/dim', () => {
    const lit = toSparsevecLiteral({ indices: [100, 5, 250001], values: [0.12, 0.31, 0.04] }, DIM);
    // token id t → sparsevec index t+1; ascending by index.
    expect(lit).toBe('{6:0.31,101:0.12,250002:0.04}/250002');
  });

  it('drops zero weights and out-of-range ids', () => {
    const lit = toSparsevecLiteral(
      { indices: [5, 9, 250002, -1], values: [0.5, 0, 0.9, 0.9] },
      DIM,
    );
    // id 9 weight 0 dropped; id 250002 (== dim, out of [0,dim)) dropped; id -1 dropped.
    expect(lit).toBe('{6:0.5}/250002');
  });

  it('collapses duplicate ids, last weight wins', () => {
    const lit = toSparsevecLiteral({ indices: [5, 5], values: [0.1, 0.9] }, DIM);
    expect(lit).toBe('{6:0.9}/250002');
  });

  it('renders an all-zero / empty vector as {}/dim', () => {
    expect(toSparsevecLiteral({ indices: [], values: [] }, DIM)).toBe('{}/250002');
    expect(toSparsevecLiteral({ indices: [1, 2], values: [0, 0] }, DIM)).toBe('{}/250002');
  });
});

describe('callSparseEmbed', () => {
  beforeEach(() => {
    envMock.SPARSE_EMBED_URL = 'http://bge-m3.test/embed';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('POSTs {model, input[]} and parses {dense, sparse}', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: { body: string }) =>
      jsonResponse({
        model: 'baai/bge-m3',
        dense: [[0.1, 0.2]],
        sparse: [{ indices: [5, 7], values: [0.9, 0.3] }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await callSparseEmbed({ model: 'baai/bge-m3', input: 'section 16' });
    expect(out.dense).toEqual([[0.1, 0.2]]);
    expect(out.sparse).toEqual([{ indices: [5, 7], values: [0.9, 0.3] }]);
    expect(out.model).toBe('baai/bge-m3');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://bge-m3.test/embed');
    const body = JSON.parse(init.body);
    // A single string input is normalised to an array on the wire.
    expect(body).toEqual({ model: 'baai/bge-m3', input: ['section 16'] });
  });

  it('throws SparseEmbedNotConfiguredError when SPARSE_EMBED_URL is unset', async () => {
    envMock.SPARSE_EMBED_URL = undefined;
    await expect(
      callSparseEmbed({ model: 'baai/bge-m3', input: 'x' }),
    ).rejects.toBeInstanceOf(SparseEmbedNotConfiguredError);
  });

  it('short-circuits an empty input array without a network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const out = await callSparseEmbed({ model: 'baai/bge-m3', input: [] });
    expect(out).toEqual({ model: 'baai/bge-m3', dense: [], sparse: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws SparseEmbedHttpError on a non-OK response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: { message: 'boom' } }, { ok: false, status: 500 })),
    );
    await expect(
      callSparseEmbed({ model: 'baai/bge-m3', input: 'x' }),
    ).rejects.toBeInstanceOf(SparseEmbedHttpError);
  });

  it('tolerates missing dense/sparse arrays (defaults to empty)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ model: 'baai/bge-m3' })));
    const out = await callSparseEmbed({ model: 'baai/bge-m3', input: 'x' });
    expect(out.dense).toEqual([]);
    expect(out.sparse).toEqual([]);
  });
});
