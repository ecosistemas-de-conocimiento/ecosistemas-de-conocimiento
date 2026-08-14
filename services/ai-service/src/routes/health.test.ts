import { describe, expect, it } from 'vitest';

describe('GET /health', () => {
  it('returns ok without touching dependencies', async () => {
    // Imported lazily so env validation runs against the test env.
    const { buildServer } = await import('../server.js');
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', service: 'ai-service' });
    await app.close();
  });
});

describe('/v1 auth', () => {
  it('rejects requests without a bearer token', async () => {
    const { buildServer } = await import('../server.js');
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/v1/' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('resolves a known API key to its {org, project}', async () => {
    const { buildServer } = await import('../server.js');
    const app = await buildServer();
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
