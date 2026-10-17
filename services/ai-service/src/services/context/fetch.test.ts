// Unit tests for `fetchContext` (M4).
//
// The retrieval service is injected via `retrieveService` so we never touch
// the real DB or the embedder here. The semantics under test:
//   - empty includeContext ⇒ {}
//   - inline retrieve ⇒ retrieves once per item; result is the array of chunk
//     texts keyed by corpus
//   - missing corpus (`CorpusNotFoundError`) ⇒ empty array, no throw
//   - named recipe resolves through `projectContextRules`
//   - named recipe with no project rule ⇒ empty array (no-op)

import { describe, expect, it, vi } from 'vitest';

import { fetchContext } from './fetch.js';
import { CorpusNotFoundError, type RetrieveService } from '../rag/retrieve.js';

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

  it('returns an empty array (no throw) when the corpus is missing', async () => {
    const retrieve = vi.fn().mockRejectedValueOnce(
      new CorpusNotFoundError({ corpus: 'docs', org: 'org', project: 'proj' }),
    );
    const out = await fetchContext({
      org: 'org',
      project: 'proj',
      includeContext: [{ corpus: 'docs', query: 'x' }],
      retrieveService: makeRetrieveService(retrieve),
    });
    expect(out).toEqual({ docs: [] });
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

  it('named recipe with no matching project rule is a no-op (empty array)', async () => {
    const retrieve = vi.fn();
    const out = await fetchContext({
      org: 'org',
      project: 'proj',
      includeContext: [{ name: 'missing-rule' }],
      projectContextRules: {},
      retrieveService: makeRetrieveService(retrieve),
    });
    expect(out).toEqual({ 'missing-rule': [] });
    expect(retrieve).not.toHaveBeenCalled();
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
