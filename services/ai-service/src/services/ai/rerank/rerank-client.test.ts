// Unit tests for the rerank HTTP client. `env` and `fetch` are both mocked so
// the test controls RERANK_URL, the provider, the credential and the wire
// response without a real network.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable env stand-in — callRerank reads `env.*` at call time.
// `vi.hoisted` so the object exists before the hoisted `vi.mock` factory runs.
const envMock = vi.hoisted(() => ({
  RERANK_URL: 'http://rerank.test/rerank' as string | undefined,
  RERANK_PROVIDER: 'rerank-api' as 'rerank-api' | 'deepinfra',
  RERANK_API_KEY: undefined as string | undefined,
}));

// The credential POLICY lives in `config/env.ts` (see the comment there on why
// it is not beside the adapters). Mocking it here rather than hand-writing
// `true`/`false` keeps this file testing the CLIENT's use of the rule, while
// `env-rerank-credential.test.ts` tests the rule itself.
//
// Same for the model allowlist: `rerankModelRefusal` is re-stated here with the
// one allowlisted DeepInfra model, and `env-rerank-credential.test.ts` tests the
// real constant.
const QWEN = 'Qwen/Qwen3-Reranker-0.6B';
vi.mock('../../../config/env.js', () => ({
  env: envMock,
  rerankProviderRequiresApiKey: (p: string) => p === 'deepinfra',
  rerankModelRefusal: (p: string, m: string) =>
    p === 'deepinfra' && m !== 'Qwen/Qwen3-Reranker-0.6B' ? `rerank model "${m}" is not in the DeepInfra allowlist` : undefined,
}));

import {
  callRerank,
  RerankCredentialMissingError,
  RerankEndpointError,
  RerankEmptyResultError,
  RerankHttpError,
  RerankNotConfiguredError,
} from './rerank-client.js';

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** The URL `callRerank` actually POSTed to for call `n` (default 0). */
function sentUrl(fetchMock: { mock: { calls: unknown[][] } }, n = 0): string {
  return fetchMock.mock.calls[n]![0] as string;
}

/** The headers `callRerank` actually put on the wire for call `n` (default 0). */
function sentHeaders(fetchMock: { mock: { calls: unknown[][] } }, n = 0): Record<string, string> {
  const init = fetchMock.mock.calls[n]![1] as { headers: Record<string, string> };
  return init.headers;
}

describe('callRerank', () => {
  beforeEach(() => {
    envMock.RERANK_URL = 'http://rerank.test/rerank';
    envMock.RERANK_PROVIDER = 'rerank-api';
    envMock.RERANK_API_KEY = undefined;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('POSTs the Cohere-style body and parses {index, relevance_score}', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: { body: string }) =>
      jsonResponse({
        model: 'baai/bge-reranker-v2-m3',
        results: [
          { index: 2, relevance_score: 0.98 },
          { index: 0, relevance_score: 0.4 },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await callRerank({
      model: 'baai/bge-reranker-v2-m3',
      query: 'section 47 duties',
      documents: ['a', 'b', 'c'],
      topN: 2,
    });

    expect(out.results).toEqual([
      { index: 2, relevanceScore: 0.98 },
      { index: 0, relevanceScore: 0.4 },
    ]);
    expect(out.model).toBe('baai/bge-reranker-v2-m3');
    expect(out.usage.estimatedCostUsd).toBe(0);

    // The wire body is the industry-standard shape: query, documents, top_n.
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://rerank.test/rerank');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      model: 'baai/bge-reranker-v2-m3',
      query: 'section 47 duties',
      documents: ['a', 'b', 'c'],
      top_n: 2,
    });
  });

  it('tolerates relevanceScore / score field aliases and drops malformed rows', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          results: [
            { index: 0, relevanceScore: 0.9 },
            { index: 1, score: 0.5 },
            { index: 2 }, // no score ⇒ dropped
          ],
        }),
      ),
    );
    const out = await callRerank({ model: 'm', query: 'q', documents: ['a', 'b', 'c'] });
    expect(out.results).toEqual([
      { index: 0, relevanceScore: 0.9 },
      { index: 1, relevanceScore: 0.5 },
    ]);
  });

  it('short-circuits with no fetch when documents is empty', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const out = await callRerank({ model: 'm', query: 'q', documents: [] });
    expect(out.results).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws RerankNotConfiguredError when RERANK_URL is unset', async () => {
    envMock.RERANK_URL = undefined;
    await expect(
      callRerank({ model: 'm', query: 'q', documents: ['a'] }),
    ).rejects.toBeInstanceOf(RerankNotConfiguredError);
  });

  it('throws RerankHttpError on a non-OK response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: { message: 'boom', code: 503 } }, { ok: false, status: 503 })),
    );
    await expect(
      callRerank({ model: 'm', query: 'q', documents: ['a'] }),
    ).rejects.toBeInstanceOf(RerankHttpError);
  });

  it('throws RerankHttpError on non-JSON body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '<html>gateway</html>',
    }) as unknown as Response));
    await expect(
      callRerank({ model: 'm', query: 'q', documents: ['a'] }),
    ).rejects.toBeInstanceOf(RerankHttpError);
  });

  it('treats a truthy `error` slot as a failure but `{ error: null }` as success', async () => {
    // Regression fence for the envelope check. Key PRESENCE would fail-safe a
    // perfectly good rerank into the fused order — invisibly, which is the one
    // failure mode this whole file is built to avoid.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: null, results: [{ index: 0, relevance_score: 0.7 }] })),
    );
    const out = await callRerank({ model: 'm', query: 'q', documents: ['a'] });
    expect(out.results).toEqual([{ index: 0, relevanceScore: 0.7 }]);
  });
});

describe('callRerank — the credential slot', () => {
  beforeEach(() => {
    envMock.RERANK_URL = 'http://rerank.test/rerank';
    envMock.RERANK_PROVIDER = 'rerank-api';
    envMock.RERANK_API_KEY = undefined;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('sends NO Authorization header when RERANK_API_KEY is unset', async () => {
    // The self-hosted sibling wants no credential. `Bearer undefined` would be
    // worse than absence — a strict server rejects it where nothing passes.
    const fetchMock = vi.fn(async () => jsonResponse({ results: [{ index: 0, relevance_score: 0.5 }] }));
    vi.stubGlobal('fetch', fetchMock);
    await callRerank({ model: 'm', query: 'q', documents: ['a'] });

    const headers = sentHeaders(fetchMock);
    expect(headers['Content-Type']).toBe('application/json');
    expect('Authorization' in headers).toBe(false);
  });

  it('sends `Authorization: Bearer <key>` when RERANK_API_KEY is set', async () => {
    envMock.RERANK_API_KEY = 'di-secret-token';
    const fetchMock = vi.fn(async () => jsonResponse({ results: [{ index: 0, relevance_score: 0.5 }] }));
    vi.stubGlobal('fetch', fetchMock);
    await callRerank({ model: 'm', query: 'q', documents: ['a'] });

    expect(sentHeaders(fetchMock)['Authorization']).toBe('Bearer di-secret-token');
  });

  it('trims the key, and treats a whitespace-only key as unset', async () => {
    // A `RERANK_API_KEY=" "` in a deploy panel is a typo, not a credential.
    // Sending `Bearer` with a blank token would turn a config typo into a 401
    // that fails safe and disappears.
    envMock.RERANK_API_KEY = '  padded-key  ';
    const fetchMock = vi.fn(async () => jsonResponse({ results: [{ index: 0, relevance_score: 0.5 }] }));
    vi.stubGlobal('fetch', fetchMock);
    await callRerank({ model: 'm', query: 'q', documents: ['a'] });
    expect(sentHeaders(fetchMock)['Authorization']).toBe('Bearer padded-key');

    envMock.RERANK_API_KEY = '   ';
    await callRerank({ model: 'm', query: 'q', documents: ['a'] });
    expect('Authorization' in sentHeaders(fetchMock, 1)).toBe(false);
  });

  it('🔴 REFUSES a hosted provider with no key, making ZERO network calls', async () => {
    // The point of the whole change. Without this, the call goes out bare, the
    // provider 401s, `applyRerank` swallows it into the fused order, and the
    // response is byte-identical to `rerank: false` minus `rerankScore`.
    envMock.RERANK_PROVIDER = 'deepinfra';
    envMock.RERANK_API_KEY = undefined;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      callRerank({ model: 'm', query: 'q', documents: ['a'] }),
    ).rejects.toBeInstanceOf(RerankCredentialMissingError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('🔴 refuses a hosted provider with no key even when documents is EMPTY', async () => {
    // Ordering fence: the credential check sits ABOVE the degenerate-input
    // short-circuit. A misconfigured deployment is broken whether or not this
    // particular query had candidates, and an empty pool must never be the
    // reason the misconfiguration goes unreported.
    envMock.RERANK_PROVIDER = 'deepinfra';
    envMock.RERANK_API_KEY = '';
    vi.stubGlobal('fetch', vi.fn());

    await expect(
      callRerank({ model: 'm', query: 'q', documents: [] }),
    ).rejects.toBeInstanceOf(RerankCredentialMissingError);
  });

  it('names the provider and both escape hatches in the refusal message', async () => {
    envMock.RERANK_PROVIDER = 'deepinfra';
    vi.stubGlobal('fetch', vi.fn());
    await expect(callRerank({ model: 'm', query: 'q', documents: ['a'] })).rejects.toThrow(
      /deepinfra.*RERANK_API_KEY/s,
    );
  });

  it('does NOT refuse `rerank-api` without a key — that value covers the local sibling', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [{ index: 0, relevance_score: 0.5 }] }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(callRerank({ model: 'm', query: 'q', documents: ['a'] })).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('callRerank — the DeepInfra adapter (worked example of a non-matching wire)', () => {
  beforeEach(() => {
    envMock.RERANK_URL = 'https://api.deepinfra.com';
    envMock.RERANK_PROVIDER = 'deepinfra';
    envMock.RERANK_API_KEY = 'di-token';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('sends {queries, documents} with the query repeated per document, and no top_n', async () => {
    // `queries` is PARALLEL to `documents` — one (query, document) pair per
    // position — not one query broadcast over them. MEASURED by
    // sending exactly this body to the live API: two repeated queries over two
    // documents returned two positional scores, 0.9994 for the relevant Spanish
    // passage and 0.0000029 for the irrelevant one.
    const fetchMock = vi.fn(async () => jsonResponse({ scores: [0.1, 0.2, 0.3] }));
    vi.stubGlobal('fetch', fetchMock);

    await callRerank({ model: QWEN, query: 'seguridad vial', documents: ['a', 'b', 'c'], topN: 2 });

    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, { body: string }];
    expect(url).toBe(`https://api.deepinfra.com/v1/inference/${QWEN}`);
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      queries: ['seguridad vial', 'seguridad vial', 'seguridad vial'],
      documents: ['a', 'b', 'c'],
    });
    // The Cohere fields must NOT leak into this provider's body.
    expect('top_n' in body).toBe(false);
    expect('query' in body).toBe(false);
    expect('model' in body).toBe(false);
  });

  it('carries the bearer credential', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ scores: [0.5] }));
    vi.stubGlobal('fetch', fetchMock);
    await callRerank({ model: QWEN, query: 'q', documents: ['a'] });
    expect(sentHeaders(fetchMock)['Authorization']).toBe('Bearer di-token');
  });

  it('maps POSITIONAL scores back to document indices', async () => {
    // There is no `index` field on this wire: `scores[i]` scores `documents[i]`.
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ scores: [0.11, 0.99, 0.55] })));
    const out = await callRerank({ model: QWEN, query: 'q', documents: ['a', 'b', 'c'] });
    expect(out.results).toEqual([
      { index: 0, relevanceScore: 0.11 },
      { index: 1, relevanceScore: 0.99 },
      { index: 2, relevanceScore: 0.55 },
    ]);
    // The client does NOT sort — ordering is the caller's job, same as Cohere.
    expect(out.results.map((r) => r.index)).toEqual([0, 1, 2]);
  });

  it('surfaces the reported per-call cost into the budget-facing usage field', async () => {
    // Unlike the self-hosted sibling, this backend is billable and reports what
    // the call cost. Hardcoding 0 here would under-report real spend.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ scores: [0.5], input_tokens: 42, inference_status: { cost: 0.0000123, status: 'succeeded' } }),
      ),
    );
    const out = await callRerank({ model: QWEN, query: 'q', documents: ['a'] });
    expect(out.usage.estimatedCostUsd).toBe(0.0000123);
  });

  it('reports 0 cost when the response carries no cost field', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ scores: [0.5] })));
    const out = await callRerank({ model: QWEN, query: 'q', documents: ['a'] });
    expect(out.usage.estimatedCostUsd).toBe(0);
  });

  it('🔴 throws on a scores/documents LENGTH MISMATCH rather than mis-attributing', async () => {
    // Positional scoring makes a short array unrecoverable — we cannot tell
    // WHICH documents the scores belong to. Taking the first N would silently
    // attach relevance to the wrong chunks, which is worse than no rerank.
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ scores: [0.9, 0.8] })));
    await expect(
      callRerank({ model: QWEN, query: 'q', documents: ['a', 'b', 'c'] }),
    ).rejects.toThrow(/2 scores for 3 documents/);
  });

  it('throws when `scores` is missing entirely', async () => {
    // A 200 the adapter cannot parse must fail loudly here; the fail-safe one
    // layer up turns it into the fused order plus a NAMED degradation.
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: [{ index: 0, relevance_score: 0.9 }] })));
    await expect(
      callRerank({ model: QWEN, query: 'q', documents: ['a'] }),
    ).rejects.toBeInstanceOf(RerankHttpError);
  });

  it('echoes the requested model id, since this wire carries none', async () => {
    // ⚠ The model lives in the URL PATH for this provider, so RERANK_MODEL and
    // the per-request `rerankModel` override are INERT here. The echo keeps the
    // field populated; it is not confirmation of what actually scored.
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ scores: [0.5] })));
    const out = await callRerank({ model: QWEN, query: 'q', documents: ['a'] });
    expect(out.model).toBe(QWEN);
  });
});

describe('🔴 callRerank — the SILENTLY-EMPTY result, the failure a credential slot does not cover', () => {
  // A 401 at least has a status. This one does not: 200, valid JSON, no error
  // envelope, and `{results: []}` on the way out. `RetrieveService` then
  // backfills all of `topK` from the fused order and the response is
  // byte-identical to `rerank: false` minus `rerankScore`.
  //
  // MEASURED before the guard: the wire-mismatch case below returned
  // `{results: [], model: 'm', usage: {estimatedCostUsd: 0}}` as a SUCCESS.
  beforeEach(() => {
    envMock.RERANK_URL = 'http://rerank.test/rerank';
    envMock.RERANK_PROVIDER = 'rerank-api';
    envMock.RERANK_API_KEY = undefined;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('throws when a 200 carries an EMPTY results array for a non-empty pool', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: [] })));
    await expect(
      callRerank({ model: 'm', query: 'q', documents: ['a', 'b'] }),
    ).rejects.toBeInstanceOf(RerankEmptyResultError);
  });

  it('🔴 throws when `rerank-api` is pointed at a DEEPINFRA wire — the misconfiguration', async () => {
    // The exact shape of getting RERANK_PROVIDER wrong. Before the guard this
    // was reported as a successful rerank that had nothing to say.
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ scores: [0.9, 0.1] })));
    await expect(
      callRerank({ model: 'm', query: 'q', documents: ['a', 'b'] }),
    ).rejects.toBeInstanceOf(RerankEmptyResultError);
  });

  it('throws when every row is malformed — total junk is a mismatch, not a fussy backend', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ results: [{ index: 0 }, { relevance_score: 0.5 }] })),
    );
    await expect(
      callRerank({ model: 'm', query: 'q', documents: ['a', 'b'] }),
    ).rejects.toBeInstanceOf(RerankEmptyResultError);
  });

  it('names the provider and the pool size, and carries a body snippet', async () => {
    // The message has to point at RERANK_PROVIDER, because that is the knob
    // that is wrong. "rerank returned nothing" would send someone to the vendor.
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ scores: [0.9, 0.1] })));
    const err = await callRerank({ model: 'm', query: 'q', documents: ['a', 'b'] }).catch((e) => e);
    expect(err).toBeInstanceOf(RerankEmptyResultError);
    expect(err.provider).toBe('rerank-api');
    expect(err.poolSize).toBe(2);
    expect(err.message).toMatch(/RERANK_PROVIDER/);
    expect(err.bodySnippet).toContain('scores');
  });

  it('does NOT throw on a PARTIAL parse — dropping some malformed rows is still tolerated', async () => {
    // The fence on the fence. Real backends do emit the odd unusable row, and
    // turning that into a total rerank failure would trade a silent bug for a
    // loud regression.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ results: [{ index: 0, relevance_score: 0.9 }, { index: 1 }] })),
    );
    const out = await callRerank({ model: 'm', query: 'q', documents: ['a', 'b'] });
    expect(out.results).toEqual([{ index: 0, relevanceScore: 0.9 }]);
  });

  it('does NOT throw when the pool itself was empty — that is degenerate input, not a mismatch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const out = await callRerank({ model: 'm', query: 'q', documents: [] });
    expect(out.results).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('🔴 throws when `deepinfra` is pointed at a COHERE wire — the mismatch in reverse', async () => {
    envMock.RERANK_PROVIDER = 'deepinfra';
    envMock.RERANK_API_KEY = 'di-token';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ results: [{ index: 0, relevance_score: 0.9 }] })),
    );
    // The DeepInfra adapter refuses at parse time (no `scores`), so this lands
    // as RerankHttpError rather than the empty-result guard. Both are loud; the
    // point is that NEITHER direction of the mismatch returns a fake success.
    await expect(
      callRerank({ model: QWEN, query: 'q', documents: ['a'] }),
    ).rejects.toThrow(/no .scores. array/);
  });
});

// ---------------------------------------------------------------------------
// 🔴 EGRESS SEAM 4 — the PII scrub. Companion to `src/services/ai/pii-egress.test.ts`,
// which owns the other three seams; this one lives here because the env mock
// above is what lets `callRerank` reach `fetch` at all.
//
// WHY IT MATTERS MORE THAN THE OTHER THREE: a rerank ships the whole candidate
// POOL. `RERANK_POOL_CAP` in `src/services/rag/retrieve.ts` is 50, against a
// generation prompt's handful of messages — so this is the seam with the most
// raw corpus text on it, pointed by default at a third party chosen for cost.
//
// Every fixture is SYNTHETIC (ADR-0001 keeps real identifiers out of this repo).
// ---------------------------------------------------------------------------

describe('🔴 callRerank — the PII egress scrub (seam 4)', () => {
  beforeEach(() => {
    envMock.RERANK_URL = 'http://rerank.test/rerank';
    envMock.RERANK_PROVIDER = 'rerank-api';
    envMock.RERANK_API_KEY = undefined;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('no candidate passage and no query reaches fetch unminimised (rerank-api wire)', async () => {
    const { PROBE_CURP, SYNTHETIC_EMAIL, SYNTHETIC_RFC_FISICA } = await import('../pii/fixtures.js');
    const fetchMock = vi.fn(async (_url: string, _init: { body: string }) =>
      jsonResponse({ results: [{ index: 0, relevance_score: 0.9 }] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await callRerank({
      model: 'baai/bge-reranker-v2-m3',
      query: `expediente de ${SYNTHETIC_EMAIL}`,
      documents: [
        `El solicitante con CURP ${PROBE_CURP} presento su tramite.`,
        `La empresa con RFC ${SYNTHETIC_RFC_FISICA} quedo registrada.`,
      ],
    });

    const init = fetchMock.mock.calls[0]![1] as { body: string };
    const sent = init.body;

    // Positive control FIRST: non-personal prose must survive. Without this the
    // assertions below would pass against an empty body and prove nothing.
    expect(sent).toContain('presento su tramite');
    expect(sent).toContain('quedo registrada');
    expect(sent).toContain('expediente de');

    expect(sent).not.toContain(PROBE_CURP);
    expect(sent).not.toContain(SYNTHETIC_RFC_FISICA);
    expect(sent).not.toContain(SYNTHETIC_EMAIL);
    expect(sent).toContain('[CURP]');
    expect(sent).toContain('[RFC]');
    expect(sent).toContain('[EMAIL]');
  });

  it('scrubs the DeepInfra wire too — a second provider must not reopen the hole', async () => {
    // The adapter seam exists so a new vendor cannot fork how failures are
    // reported. The same argument applies to egress: the scrub sits in the
    // shared transport, ABOVE the adapter, so adding a provider cannot bypass
    // it. This test is what makes that structural claim checkable.
    const { PROBE_CURP } = await import('../pii/fixtures.js');
    envMock.RERANK_PROVIDER = 'deepinfra';
    envMock.RERANK_URL = 'https://api.deepinfra.test';
    envMock.RERANK_API_KEY = 'k';
    const fetchMock = vi.fn(async (_url: string, _init: { body: string }) =>
      jsonResponse({ scores: [0.9] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await callRerank({
      model: 'Qwen/Qwen3-Reranker-0.6B',
      query: `quien es ${PROBE_CURP}`,
      documents: [`Acta con CURP ${PROBE_CURP}.`],
    });

    const init = fetchMock.mock.calls[0]![1] as { body: string };
    expect(init.body).toContain('Acta con');
    expect(init.body).not.toContain(PROBE_CURP);
    // `queries` is parallel to `documents` on this wire — BOTH must be scrubbed,
    // and the repeated query is built from the scrubbed text, not the raw one.
    expect(JSON.parse(init.body)).toMatchObject({
      queries: ['quien es [CURP]'],
      // The literal word `CURP` is prose and survives; only the identifier goes.
      documents: ['Acta con CURP [CURP].'],
    });
  });

  it('🔴 does NOT scrub `model` — it is a URL path segment under DeepInfra', async () => {
    // A detector rewriting a model id would compose `/v1/inference/<mangled>`,
    // DeepInfra would 404, and this file's fail-safe would swallow that into the
    // fused order — a dead rerank wearing a 200. `model` is a configured
    // identifier, never user text, so it is deliberately outside the scrub.
    envMock.RERANK_PROVIDER = 'deepinfra';
    envMock.RERANK_URL = 'https://api.deepinfra.test';
    envMock.RERANK_API_KEY = 'k';
    const fetchMock = vi.fn(async (_url: string, _init: { body: string }) =>
      jsonResponse({ scores: [0.5] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await callRerank({
      model: 'Qwen/Qwen3-Reranker-0.6B',
      query: 'q',
      documents: ['d'],
    });

    expect(sentUrl(fetchMock)).toBe('https://api.deepinfra.test/v1/inference/Qwen/Qwen3-Reranker-0.6B');
  });

  it('leaves the caller-owned documents array untouched, so real text still reaches the user', async () => {
    // 🔴 THE INDEX/CONTENT INVARIANT. `RetrieveService` maps rerank results back
    // onto its OWN pool by index and returns those chunks to the caller. If the
    // scrub mutated the caller's array, the user would read `[CURP]` back in
    // their own documents — a scrub is an egress control, not a redaction of
    // what we serve.
    const { PROBE_CURP } = await import('../pii/fixtures.js');
    const fetchMock = vi.fn(async (_url: string, _init: { body: string }) =>
      jsonResponse({ results: [{ index: 1, relevance_score: 0.9 }] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const documents = [`uno ${PROBE_CURP}`, `dos ${PROBE_CURP}`];
    const out = await callRerank({ model: 'm', query: `q ${PROBE_CURP}`, documents });

    expect(documents).toEqual([`uno ${PROBE_CURP}`, `dos ${PROBE_CURP}`]);
    // Same length, same order ⇒ the returned index still addresses the caller's
    // array. A scrub that dropped or reordered entries would mis-attribute
    // relevance to the wrong chunk, silently.
    expect(out.results).toEqual([{ index: 1, relevanceScore: 0.9 }]);
  });

  it('🔴 REFUSES to reach fetch with a payload it could not scrub', async () => {
    // Fail CLOSED at the seam. One layer up, `RetrieveService.applyRerank`
    // catches this and degrades to the fused order with reason `error` — the
    // ruled disposition for the rerank rung. What must never happen is the raw
    // pool going out because the minimiser had a bad day.
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      callRerank({
        model: 'm',
        query: 'q',
        // Ill-typed on purpose: what an upstream shape looks like after an `as`
        // cast. A `Date` is a value the minimiser's walker cannot enter.
        documents: ['ok', new Date() as unknown as string],
      }),
    ).rejects.toMatchObject({ code: 'ERR_PII_MINIMISATION_FAILED' });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('scrubs BEFORE the credential refusal cannot mask it — an unconfigured deployment still refuses first', async () => {
    // Ordering control. The credential check stays above the scrub, so a
    // missing key is still reported as a missing key rather than surfacing as a
    // PII error — two different deployment defects with two different fixes.
    envMock.RERANK_PROVIDER = 'deepinfra';
    envMock.RERANK_API_KEY = undefined;
    const fetchMock = vi.fn(async () => jsonResponse({ scores: [1] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      callRerank({ model: 'm', query: 'q', documents: [new Date() as unknown as string] }),
    ).rejects.toBeInstanceOf(RerankCredentialMissingError);
  });
});

describe('🔴 RERANK_MODEL stays live under DeepInfra — the model is composed, not pinned in the URL', () => {
  // DeepInfra carries the model as a PATH segment. Pinning the whole URL in env
  // would make RERANK_MODEL and the per-request `rerankModel` override dead
  // letters under this provider — the deployed URL would decide the model and a
  // caller asking for another would be ignored silently. Composing keeps one
  // model knob meaning the same thing on every provider.
  beforeEach(() => {
    envMock.RERANK_URL = 'https://api.deepinfra.com';
    envMock.RERANK_PROVIDER = 'deepinfra';
    envMock.RERANK_API_KEY = 'di-token';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('composes {base}/v1/inference/{model} from RERANK_MODEL', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ scores: [0.5] }));
    vi.stubGlobal('fetch', fetchMock);
    await callRerank({ model: 'Qwen/Qwen3-Reranker-0.6B', query: 'q', documents: ['a'] });
    expect(sentUrl(fetchMock)).toBe(
      'https://api.deepinfra.com/v1/inference/Qwen/Qwen3-Reranker-0.6B',
    );
  });

  it('🔴 REFUSES a per-request model outside the allowlist, with ZERO network calls', async () => {
    // Item 10.3: a Google/Anthropic model proxied by DeepInfra voids its
    // no-training/no-sharing terms, and under this provider the model is a URL
    // PATH segment — so the refusal must land before the scrub and before
    // `buildUrl`, never as a 404 the fail-safe would swallow.
    const fetchMock = vi.fn(async () => jsonResponse({ scores: [0.5] }));
    vi.stubGlobal('fetch', fetchMock);
    for (const model of ['google/gemini-2.5-flash', 'anthropic/claude-x', '../../v1/openai/chat']) {
      const err = await callRerank({ model, query: 'q', documents: ['a'] }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RerankEndpointError);
      expect((err as Error).message).toMatch(/allowlist/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a disallowed model even for an EMPTY pool — config, not traffic, is wrong', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await expect(
      callRerank({ model: 'google/gemini-2.5-flash', query: 'q', documents: [] }),
    ).rejects.toBeInstanceOf(RerankEndpointError);
  });

  it('tolerates a trailing slash on the base without doubling it', async () => {
    envMock.RERANK_URL = 'https://api.deepinfra.com/';
    const fetchMock = vi.fn(async () => jsonResponse({ scores: [0.5] }));
    vi.stubGlobal('fetch', fetchMock);
    await callRerank({ model: QWEN, query: 'q', documents: ['a'] });
    expect(sentUrl(fetchMock)).toBe(`https://api.deepinfra.com/v1/inference/${QWEN}`);
  });

  it('🔴 REFUSES a full inference URL rather than appending to it and 404ing', async () => {
    // The mistake my own earlier docs invited. Appending would produce
    // .../v1/inference/X/v1/inference/Y — a 404 the fail-safe swallows.
    envMock.RERANK_URL = 'https://api.deepinfra.com/v1/inference/Qwen/Qwen3-Reranker-0.6B';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      callRerank({ model: QWEN, query: 'q', documents: ['a'] }),
    ).rejects.toThrow(/API BASE/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves the `rerank-api` URL strictly verbatim — the long-standing contract', async () => {
    // Composition must not leak to the provider whose model travels in the body.
    envMock.RERANK_PROVIDER = 'rerank-api';
    envMock.RERANK_URL = 'http://localhost:58000/rerank';
    const fetchMock = vi.fn(async () => jsonResponse({ results: [{ index: 0, relevance_score: 1 }] }));
    vi.stubGlobal('fetch', fetchMock);
    await callRerank({ model: 'anything', query: 'q', documents: ['a'] });
    expect(sentUrl(fetchMock)).toBe('http://localhost:58000/rerank');
  });
});

// ---------------------------------------------------------------------------
// Item 0 part 1 — the scrub REPORTS. A working minimiser and a bypassed one
// return the same 200, so `egress` on the result and the two PII counters are
// the only outside evidence the seam scrubbed (rerank-pii-egress handoff §5.1).
// ---------------------------------------------------------------------------

describe('callRerank — egress report and PII counters', () => {
  beforeEach(() => {
    envMock.RERANK_URL = 'https://api.deepinfra.com';
    envMock.RERANK_PROVIDER = 'deepinfra';
    envMock.RERANK_API_KEY = 'di-token';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** One sample off the DEFAULT registry, as a delta — see `metrics/llm.test.ts`. */
  async function sample(name: string, labels: Record<string, string>): Promise<number> {
    const { register } = await import('@prometheus-io/client');
    const metrics = await register.getMetricsAsJSON();
    const m = metrics.find((x) => x.name === name);
    if (!m) return 0;
    const hit = (m.values as Array<{ value: number; labels: Record<string, unknown> }>).find((v) =>
      Object.entries(labels).every(([k, val]) => String(v.labels[k]) === val),
    );
    return hit?.value ?? 0;
  }

  it('returns `egress` with redaction counts by kind — counts, never text', async () => {
    const { PROBE_CURP, SYNTHETIC_EMAIL } = await import('../pii/fixtures.js');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ scores: [0.9, 0.1] })));

    const out = await callRerank({
      model: QWEN,
      query: `quien es ${PROBE_CURP}`,
      documents: [`CURP ${PROBE_CURP}`, `correo ${SYNTHETIC_EMAIL}`],
    });

    // Query + first document each carry the CURP; the second document the email.
    expect(out.egress).toBeDefined();
    expect(out.egress!.counts.curp).toBe(2);
    expect(out.egress!.counts.email).toBe(1);
    expect(out.egress!.redactions).toBe(3);
    expect(JSON.stringify(out.egress)).not.toContain(PROBE_CURP);
  });

  it('reports `egress` with ZERO redactions on a clean payload — scrubbed, found nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ scores: [0.5] })));
    const out = await callRerank({ model: QWEN, query: 'q', documents: ['texto limpio'] });
    expect(out.egress).toEqual({ redactions: 0, counts: expect.objectContaining({ curp: 0 }) });
  });

  it('carries no `egress` on the empty-pool shortcut — nothing went on the wire', async () => {
    const out = await callRerank({ model: QWEN, query: 'q', documents: [] });
    expect(out.egress).toBeUndefined();
  });

  it('🔴 bumps ai_pii_egress_scrubbed_total{seam=rerank} and ai_pii_redactions_total per kind', async () => {
    const { PROBE_CURP } = await import('../pii/fixtures.js');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ scores: [0.9] })));

    const scrubbedBefore = await sample('ai_pii_egress_scrubbed_total', { seam: 'rerank' });
    const curpBefore = await sample('ai_pii_redactions_total', { seam: 'rerank', kind: 'curp' });

    await callRerank({ model: QWEN, query: 'q', documents: [`CURP ${PROBE_CURP}`] });

    expect((await sample('ai_pii_egress_scrubbed_total', { seam: 'rerank' })) - scrubbedBefore).toBe(1);
    expect((await sample('ai_pii_redactions_total', { seam: 'rerank', kind: 'curp' })) - curpBefore).toBe(1);
  });

  it('does NOT count a call refused before the wire (disallowed model)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const before = await sample('ai_pii_egress_scrubbed_total', { seam: 'rerank' });
    await expect(
      callRerank({ model: 'google/gemini-2.5-flash', query: 'q', documents: ['a'] }),
    ).rejects.toBeInstanceOf(RerankEndpointError);
    expect((await sample('ai_pii_egress_scrubbed_total', { seam: 'rerank' })) - before).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
