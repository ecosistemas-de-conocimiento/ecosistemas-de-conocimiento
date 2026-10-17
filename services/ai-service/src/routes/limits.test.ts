// Cross-cutting limits — rate limiting + request-body caps.
//
// These exercise the per-route configuration applied in `src/server.ts` and
// `src/routes/{generate,ingest}.ts`. The orchestrator/ingest service layers
// are mocked so the test only depends on Fastify's plugin behaviour.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock collaborators — must run before the dynamic buildServer import.
// ---------------------------------------------------------------------------

const enqueueGenerationMock = vi.fn();
const ingestBatchMock = vi.fn();
const getIngestStatusMock = vi.fn();

vi.mock('../services/generation/orchestrator.js', async () => {
  const actual = await vi.importActual<
    typeof import('../services/generation/orchestrator.js')
  >('../services/generation/orchestrator.js');
  return {
    ...actual,
    enqueueGeneration: (...args: unknown[]) => enqueueGenerationMock(...args),
  };
});

vi.mock('../services/rag/ingest.js', () => {
  class IngestService {
    ingestBatch(...args: unknown[]) {
      return ingestBatchMock(...args);
    }
    getIngestStatus(...args: unknown[]) {
      return getIngestStatusMock(...args);
    }
  }
  return { IngestService };
});

// (The `queue/queues.js` mock that used to sit here is gone: `buildServer()`
// now takes a Runtime, and the default test Runtime already hands back the
// in-memory queues this file needs. See `src/runtime.ts`.)

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => {
        const chain: Record<string, unknown> = {
          where: () => chain,
          orderBy: () => chain,
          limit: () => Promise.resolve([]),
          then: (resolve: (v: unknown[]) => void) => resolve([]),
        };
        return chain;
      },
    }),
  },
}));

const APP_TOKEN = 'test-key';

async function makeApp() {
  // Force a fresh module instance so each test starts with a clean
  // rate-limit bucket. `@fastify/rate-limit` keeps its in-memory store on the
  // Fastify instance, so a new buildServer() gives us an isolated counter.
  vi.resetModules();
  const { buildServer } = await import('../server.js');
  return buildServer();
}

beforeEach(() => {
  enqueueGenerationMock.mockReset();
  ingestBatchMock.mockReset();
  getIngestStatusMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe('rate limiting', () => {
  it('429s after 30 rapid POSTs to /v1/generate/sync from the same key', async () => {
    const app = await makeApp();

    // Resolve the sync handler past the LLM call: we don't care about the
    // response shape, only that the rate-limit gate fires before it.
    // The route mocks `resolveSpec` + `createOpenRouter` via the live modules
    // — to keep this test cheap, intercept at the model layer.
    const resolveSpecMod = await import('../services/registry/resolve.js');
    const routerMod = await import('../services/ai/router/openrouter.js');
    vi.spyOn(resolveSpecMod, 'resolveSpec').mockResolvedValue({
      promptTemplate: 'x',
      model: 'm',
      effortLevel: 'standard',
      effortProfile: {
        model: 'm',
        maxOutputTokens: 100,
        validationPasses: 1,
        multiSample: 1,
        temperature: 0,
        estimatedCostUsdPerCall: 0.001,
      },
      validators: [],
    } as unknown as Awaited<ReturnType<typeof resolveSpecMod.resolveSpec>>);
    vi.spyOn(routerMod, 'createOpenRouter').mockReturnValue({
      route: vi.fn().mockResolvedValue({
        content: 'ok',
        parsed: undefined,
        flags: [],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0 },
        model: 'm',
        provider: 'openrouter',
        traceId: 't',
        cached: false,
        durationMs: 1,
        effort: 'standard',
        effortProfileUsed: {
          model: 'm',
          maxOutputTokens: 100,
          validationPasses: 1,
          multiSample: 1,
          temperature: 0,
          estimatedCostUsdPerCall: 0,
        },
      }),
    } as unknown as ReturnType<typeof routerMod.createOpenRouter>);

    const payload = { unit: { unitKey: 'rate-1', input: { name: 'x' } } };
    const headers = { authorization: `Bearer ${APP_TOKEN}` };

    // First 30 requests should succeed (cap = 30/minute).
    for (let i = 0; i < 30; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/generate/sync',
        headers,
        payload,
      });
      expect(res.statusCode, `request ${i + 1}/30 should pass`).toBe(200);
    }

    // 31st request must 429 with the documented body shape.
    const blocked = await app.inject({
      method: 'POST',
      url: '/v1/generate/sync',
      headers,
      payload,
    });
    expect(blocked.statusCode).toBe(429);
    const body = blocked.json();
    expect(body.error).toBe('RateLimitExceeded');
    expect(body.message).toMatch(/Retry after \d+s/);
    expect(typeof body.retryAfterMs).toBe('number');
    expect(body.retryAfterMs).toBeGreaterThan(0);

    await app.close();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Body-size limits
// ---------------------------------------------------------------------------

describe('request body size limits', () => {
  it('413s a 2MB body on /v1/generate (1MB default cap)', async () => {
    const app = await makeApp();
    // Build a body whose serialised size comfortably exceeds 1 MiB but stays
    // under the 10 MiB ingest cap, so we know the rejection comes from the
    // route-level cap and not anything global beyond it.
    const bigString = 'x'.repeat(2 * 1024 * 1024);
    const payload = { units: [{ unitKey: 'u1', input: { blob: bigString } }] };

    const res = await app.inject({
      method: 'POST',
      url: '/v1/generate',
      headers: { authorization: `Bearer ${APP_TOKEN}` },
      payload,
    });
    expect(res.statusCode).toBe(413);
    expect(enqueueGenerationMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('accepts a 2MB body on /v1/ingest (10MB per-route cap)', async () => {
    const app = await makeApp();
    ingestBatchMock.mockResolvedValueOnce({ ingestId: 'ing-1', totalDocs: 3 });
    // ~2 MiB total. The Zod schema caps a single `text` field at 1 MB, so we
    // split across 3 docs of ~700 KB each. This sits above the 1 MiB default
    // body cap but below the 10 MiB ingest override, proving the per-route
    // bump is what's letting the request through.
    const chunk = 'a'.repeat(700 * 1024);
    const payload = {
      corpus: 'c1',
      documents: [
        { id: 'd1', text: chunk },
        { id: 'd2', text: chunk },
        { id: 'd3', text: chunk },
      ],
    };

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      headers: { authorization: `Bearer ${APP_TOKEN}` },
      payload,
    });
    // 202 on success per the route handler; the contract is "not 413".
    expect(res.statusCode).not.toBe(413);
    expect(res.statusCode).toBe(202);
    expect(ingestBatchMock).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
