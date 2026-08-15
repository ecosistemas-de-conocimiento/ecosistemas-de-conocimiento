import { describe, expect, it } from 'vitest';

import { useBuildServer } from '../test/server-harness.js';

// `server.js` is still imported lazily — env validation has to run against the
// test env — but ONCE per file, in `beforeAll`, rather than inside the first
// test body where its ~3 s of module transform ate vitest's 5 s per-test
// budget. See `src/test/server-harness.ts`.
const makeApp = useBuildServer();

describe('GET /health', () => {
  it('returns ok without touching dependencies', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', service: 'ai-service' });
    await app.close();
  });
});

describe('/v1 auth', () => {
  it('rejects requests without a bearer token', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/v1/' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('resolves a known API key to its {org, project}', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/',
      headers: { authorization: 'Bearer test-key' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ v1: true, org: 'test-org', project: 'test-project' });
    await app.close();
  });
});
