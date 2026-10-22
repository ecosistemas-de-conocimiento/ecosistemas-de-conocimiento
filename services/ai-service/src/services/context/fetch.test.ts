// Unit tests for `fetchContext` (M4).
//
// The retrieval service is injected via `retrieveService` so we never touch
// the real DB or the embedder here. The semantics under test:
//   - empty includeContext ⇒ {}
//   - inline retrieve ⇒ retrieves once per item; result is the array of chunk
//     texts keyed by corpus
//   - missing corpus (`CorpusNotFoundError`) ⇒ THROWS (404), no ungrounded 200
//   - named recipe resolves through `projectContextRules`, or through
//     `project_configs` when the caller passes none
//   - named recipe with no project rule ⇒ THROWS `SpecResolutionError` (400)
//   - the retrieve knobs (mode, rerank, filter, asOf) reach the retrieve
//   - `retrievalTrace` carries the chunk ids that grounded the prompt

import { describe, expect, it, vi } from 'vitest';

import { fetchContext, fetchContextWithTrace } from './fetch.js';
import { CorpusNotFoundError, type RetrieveService } from '../rag/retrieve.js';
import { SpecResolutionError } from '../registry/resolve.js';

// ⚠ Typed as the real method, not `ReturnType<typeof vi.fn>`. Under vitest 5 a
// bare `vi.fn` is `Mock<Procedure | Constructable>`, which no longer satisfies
// `Pick<RetrieveService, 'retrieve'>` — 5 x TS2322. Naming the actual signature
// is both the fix and the stronger check: a mock with the wrong shape now fails
// at compile time instead of being accepted as any callable.
function makeRetrieveService(impl: RetrieveService['retrieve']) {
  return { retrieve: impl };
}

describe('fetchContext (M4)', () => {
  it('returns an empty object when no includeContext is provided', async () => {
    const out = await fetchContext({ org: 'org', project: 'proj' });
    expect(out).toEqual({});
  });

  it('returns an empty object on an empty includeContext list', async () => {
    const out = await fetchContext({
      org: 'org',
      project: 'proj',
      includeContext: [],
    });
    expect(out).toEqual({});
  });

  it('calls retrieve for inline items and keys the result by corpus', async () => {
    const retrieve = vi
      .fn()
      .mockResolvedValueOnce({
        chunks: [
          { chunkId: 'c1', documentId: 'd1', ordinal: 0, text: 'alpha', score: 0.9 },
          { chunkId: 'c2', documentId: 'd1', ordinal: 1, text: 'beta', score: 0.8 },
        ],
      })
      .mockResolvedValueOnce({
        chunks: [
          { chunkId: 'c3', documentId: 'd2', ordinal: 0, text: 'gamma', score: 0.7 },
        ],
      });
    const out = await fetchContext({
      org: 'org',
      project: 'proj',
      includeContext: [
        { corpus: 'docs', query: 'how do I X?' },
        { corpus: 'specs', query: 'list constraints', topK: 5, mmr: 0.6 },
      ],
      retrieveService: makeRetrieveService(retrieve),
    });
    expect(out).toEqual({ docs: ['alpha', 'beta'], specs: ['gamma'] });
    expect(retrieve).toHaveBeenCalledTimes(2);
    expect(retrieve).toHaveBeenNthCalledWith(
      1,
      { corpus: 'docs', query: 'how do I X?' },
      { org: 'org', project: 'proj' },
    );
    expect(retrieve).toHaveBeenNthCalledWith(
      2,
      { corpus: 'specs', query: 'list constraints', topK: 5, mmr: 0.6 },
      { org: 'org', project: 'proj' },
    );
  });

  it('a missing corpus THROWS CorpusNotFoundError (404) — no ungrounded empty context', async () => {
    const retrieve = vi.fn().mockRejectedValueOnce(
      new CorpusNotFoundError({ corpus: 'docs', org: 'org', project: 'proj' }),
    );
    const err = await fetchContext({
      org: 'org',
      project: 'proj',
      includeContext: [{ corpus: 'docs', query: 'x' }],
      retrieveService: makeRetrieveService(retrieve),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CorpusNotFoundError);
    expect((err as CorpusNotFoundError).status).toBe(404);
  });

  it('resolves a named recipe through project_configs.contextRules', async () => {
    const retrieve = vi.fn().mockResolvedValueOnce({
      chunks: [
        { chunkId: 'cA', documentId: 'dA', ordinal: 0, text: 'style guide line 1', score: 0.95 },
      ],
    });
    const out = await fetchContext({
      org: 'org',
      project: 'proj',
      includeContext: [{ name: 'style' }],
      projectContextRules: {
        style: { corpus: 'guidelines', query: 'tone of voice', topK: 3 },
      },
      retrieveService: makeRetrieveService(retrieve),
    });
    expect(out).toEqual({ style: ['style guide line 1'] });
    expect(retrieve).toHaveBeenCalledWith(
      { corpus: 'guidelines', query: 'tone of voice', topK: 3 },
      { org: 'org', project: 'proj' },
    );
  });

  it('named recipe with no matching project rule THROWS a typed 400', async () => {
    const retrieve = vi.fn();
    const err = await fetchContext({
      org: 'org',
      project: 'proj',
      includeContext: [{ name: 'missing-rule' }],
      projectContextRules: {},
      retrieveService: makeRetrieveService(retrieve),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpecResolutionError);
    expect((err as SpecResolutionError).status).toBe(400);
    expect((err as SpecResolutionError).cause).toBe('unknown context recipe');
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('an unknown recipe in the LAST item fails before any retrieve is paid for', async () => {
    const retrieve = vi.fn();
    await expect(
      fetchContext({
        org: 'org',
        project: 'proj',
        includeContext: [{ corpus: 'docs', query: 'x' }, { name: 'nope' }],
        projectContextRules: {},
        retrieveService: makeRetrieveService(retrieve),
      }),
    ).rejects.toBeInstanceOf(SpecResolutionError);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('a malformed recipe (no query) is a typed 400, not a silent skip', async () => {
    const retrieve = vi.fn();
    await expect(
      fetchContext({
        org: 'org',
        project: 'proj',
        includeContext: [{ name: 'bad' }],
        projectContextRules: { bad: { corpus: 'g' } },
        retrieveService: makeRetrieveService(retrieve),
      }),
    ).rejects.toBeInstanceOf(SpecResolutionError);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('reads contextRules from project_configs when the caller passes none', async () => {
    const retrieve = vi.fn().mockResolvedValueOnce({ chunks: [], legs: ['dense'] });
    const limit = vi.fn(async () => [{ contextRules: { style: { corpus: 'g', query: 'tone' } } }]);
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit }) }) }),
    } as unknown as import('../../db/client.js').Db;
    const out = await fetchContext({
      org: 'org',
      project: 'proj',
      includeContext: [{ name: 'style' }],
      db,
      retrieveService: makeRetrieveService(retrieve),
    });
    expect(out).toEqual({ style: [] });
    expect(limit).toHaveBeenCalledTimes(1);
    expect(retrieve).toHaveBeenCalledWith({ corpus: 'g', query: 'tone' }, { org: 'org', project: 'proj' });
  });

  it('forwards mode, rerank, filter and asOf from inline items and recipes', async () => {
    const retrieve = vi.fn().mockResolvedValue({ chunks: [], legs: ['dense'] });
    const knobs = {
      mode: 'hybrid' as const,
      rerank: true,
      filter: { docId: { $in: ['1', '2'] } },
      asOf: '2026-01-01T00:00:00Z',
    };
    await fetchContext({
      org: 'org',
      project: 'proj',
      includeContext: [{ corpus: 'docs', query: 'x', ...knobs }, { name: 'r' }],
      projectContextRules: { r: { corpus: 'g', query: 'y', ...knobs } },
      retrieveService: makeRetrieveService(retrieve),
    });
    expect(retrieve).toHaveBeenNthCalledWith(1, { corpus: 'docs', query: 'x', ...knobs }, expect.anything());
    expect(retrieve).toHaveBeenNthCalledWith(2, { corpus: 'g', query: 'y', ...knobs }, expect.anything());
  });

  it('returns a retrievalTrace with chunk ids, legs and warnings per item', async () => {
    const warning = { code: 'RERANK_DEGRADED' as const, reason: 'timeout', message: 'm' };
    const retrieve = vi.fn().mockResolvedValueOnce({
      chunks: [
        { chunkId: 'c1', documentId: 'd1', ordinal: 0, text: 'alpha', score: 0.9 },
        { chunkId: 'c2', documentId: 'd1', ordinal: 1, text: 'beta', score: 0.8 },
      ],
      legs: ['dense', 'lexical'],
      warnings: [warning],
    });
    const out = await fetchContextWithTrace({
      org: 'org',
      project: 'proj',
      includeContext: [{ corpus: 'docs', query: 'x', rerank: true }],
      retrieveService: makeRetrieveService(retrieve),
    });
    expect(out.context).toEqual({ docs: ['alpha', 'beta'] });
    expect(out.retrievalTrace).toEqual([
      { key: 'docs', corpus: 'docs', chunkIds: ['c1', 'c2'], legs: ['dense', 'lexical'], warnings: [warning] },
    ]);
  });

  it('handles a mix of inline and named items', async () => {
    const retrieve = vi
      .fn()
      .mockResolvedValueOnce({
        chunks: [{ chunkId: 'c1', documentId: 'd1', ordinal: 0, text: 'd-text', score: 0.9 }],
      })
      .mockResolvedValueOnce({
        chunks: [{ chunkId: 'c2', documentId: 'd2', ordinal: 0, text: 's-text', score: 0.8 }],
      });
    const out = await fetchContext({
      org: 'org',
      project: 'proj',
      includeContext: [{ corpus: 'docs', query: 'x' }, { name: 'style' }],
      projectContextRules: { style: { corpus: 'g', query: 'tone' } },
      retrieveService: makeRetrieveService(retrieve),
    });
    expect(Object.keys(out).sort()).toEqual(['docs', 'style']);
    expect(out.docs).toEqual(['d-text']);
    expect(out.style).toEqual(['s-text']);
  });
});
