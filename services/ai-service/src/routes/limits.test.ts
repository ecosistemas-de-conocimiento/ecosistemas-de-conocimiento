// Cross-cutting limits — rate limiting + request-body caps.
//
// These exercise the per-route configuration applied in `src/server.ts` and
// `src/routes/{generate,ingest}.ts`. The orchestrator/ingest service layers
// are mocked so the test only depends on Fastify's plugin behaviour.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { V1_DEFAULT_RATE_LIMIT_MAX } from '../server-limits.js';
import { warmServerModule } from '../test/server-harness.js';

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

vi.mock('../queue/queues.js', () => ({
  getIngestQueue: () => ({}),
}));

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
// A SECOND, distinct consumer. `vitest.config.ts` only ships one key, and the
// bucketing tests below need two so "different keys" is a real condition and
// not a relabelled single key. Stubbed at module scope so it is in place
// before `makeApp()`'s `vi.resetModules()` re-evaluates `config/env.ts`.
const OTHER_TOKEN = 'other-test-key';
vi.stubEnv(
  'API_KEYS',
  JSON.stringify({
    [APP_TOKEN]: { org: 'test-org', project: 'test-project' },
    [OTHER_TOKEN]: { org: 'other-org', project: 'other-project' },
  }),
);

// This file cannot share one server import the way its siblings do — see
// `makeApp()` — so instead the expensive transform is WARMED in `beforeAll`.
// Later re-imports then only re-evaluate, which keeps the ~3 s module-graph
// cost off the per-test clock and its 5 s timeout.
// See `src/test/server-harness.ts`.
warmServerModule();

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
// Which bucket? — per-IP vs per-API-key
// ---------------------------------------------------------------------------
//
// 🔴 These assert BEHAVIOUR, never config. The broken version of `server.ts`
// declared `keyGenerator: (req) => req.auth?.apiKeyId ?? req.ip` and passed
// every config-shaped test, while the key was in fact ALWAYS `req.ip`:
// `@fastify/rate-limit` hooks in at `onRequest` by default and `requireAuth`
// is a `preHandler`, so `req.auth` did not exist yet.
//
// The only way to tell the two apart from outside is to vary the API key and
// the source IP INDEPENDENTLY and watch the status codes.
//
// `app.inject({ remoteAddress })` sets the socket address, and `buildServer()`
// runs with `trustProxy: true` and no `x-forwarded-for` here, so `req.ip` is
// exactly what we pass.

/** GET /v1/ — the authenticated ping. No route override, so the /v1 default cap applies. */
function ping(
  app: Awaited<ReturnType<typeof makeApp>>,
  opts: { token?: string; ip: string },
) {
  return app.inject({
    method: 'GET',
    url: '/v1/',
    remoteAddress: opts.ip,
    ...(opts.token ? { headers: { authorization: `Bearer ${opts.token}` } } : {}),
  });
}

/**
 * How many distinct source IPs one key's allowance is spread over. 100/25 = 4
 * requests per IP — nowhere near the 100/min per-IP ceiling, so anything
 * refused AFTER this ran was refused by the per-KEY bucket and by nothing else.
 * That separation is the whole point; do not collapse it to a single IP.
 */
const SPREAD_IPS = 25;
const spreadIp = (i: number) => `10.0.0.${(i % SPREAD_IPS) + 1}`;

/** Burn one key's entire per-minute allowance, scattered across `SPREAD_IPS` addresses. */
async function spendWholeAllowanceAcrossManyIps(
  app: Awaited<ReturnType<typeof makeApp>>,
  token: string,
) {
  for (let i = 0; i < V1_DEFAULT_RATE_LIMIT_MAX; i++) {
    const res = await ping(app, { token, ip: spreadIp(i) });
    expect(res.statusCode, `warm-up ${i + 1} from ${spreadIp(i)} should pass`).toBe(200);
  }
}

describe('rate limiting is bucketed per API key, not only per IP', () => {
  it('counts one API key across every source IP it arrives from', async () => {
    const app = await makeApp();
    // 100 requests, 4 per IP. No IP is anywhere near its own ceiling.
    await spendWholeAllowanceAcrossManyIps(app, APP_TOKEN);

    // Same key, from an address that has served only 4 requests. If the bucket
    // were keyed by IP this sails through; keyed by API key it is the 101st.
    const blocked = await ping(app, { token: APP_TOKEN, ip: spreadIp(0) });
    expect(blocked.statusCode).toBe(429);

    // The 429 body shape is part of ai-service's published contract — other
    // products parse `retryAfterMs`. It must survive on the new bucket too.
    const body = blocked.json();
    expect(body.error).toBe('RateLimitExceeded');
    expect(body.message).toMatch(/Retry after \d+s/);
    expect(body.retryAfterMs).toBeGreaterThan(0);

    await app.close();
  });

  it('does not let one exhausted key refuse a different key on the same IP', async () => {
    const app = await makeApp();
    await spendWholeAllowanceAcrossManyIps(app, APP_TOKEN);

    // Both of the next two requests come from THE SAME address. One is refused
    // and the other served — which is only possible if they are counted in
    // different buckets.
    const sharedIp = spreadIp(0);
    const exhausted = await ping(app, { token: APP_TOKEN, ip: sharedIp });
    const neighbour = await ping(app, { token: OTHER_TOKEN, ip: sharedIp });

    expect(exhausted.statusCode, 'the key that spent its allowance').toBe(429);
    expect(neighbour.statusCode, 'a different key from the same IP').toBe(200);

    await app.close();
  });

  it('still refuses an unauthenticated flood from one IP, before auth runs', async () => {
    const app = await makeApp();
    const ip = '198.51.100.7';

    // Every one of these is rejected by `requireAuth` — and still counted.
    // That is what makes the pre-auth bucket a credential-guessing ceiling.
    for (let i = 0; i < V1_DEFAULT_RATE_LIMIT_MAX; i++) {
      const res = await ping(app, { ip });
      expect(res.statusCode, `unauthenticated attempt ${i + 1}`).toBe(401);
    }

    const blocked = await ping(app, { ip });
    expect(blocked.statusCode, 'the flood is cut off by rate limiting, not by auth').toBe(429);
    expect(blocked.json().error).toBe('RateLimitExceeded');

    await app.close();
  });

  it('keeps the per-IP ceiling where it was — a fresh key on a flooded IP is still refused', async () => {
    // The counterweight to the test above it: splitting the bucket did NOT
    // raise how much traffic one address may send. Two keys sharing an egress
    // IP still share the per-IP ceiling; per-key fairness only bites once they
    // do not. Guards against anyone "fixing" fairness by loosening this.
    const app = await makeApp();
    const ip = '198.51.100.9';

    for (let i = 0; i < V1_DEFAULT_RATE_LIMIT_MAX; i++) {
      const res = await ping(app, { token: APP_TOKEN, ip });
      expect(res.statusCode, `request ${i + 1} from ${ip}`).toBe(200);
    }

    const neighbour = await ping(app, { token: OTHER_TOKEN, ip });
    expect(neighbour.statusCode).toBe(429);

    await app.close();
  });
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
