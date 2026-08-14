// Route-layer tests for /v1/tenant/*.
//
// The service is mocked (it has its own suite); what matters here is the wiring:
// who may call what, and — the invariant that must never regress — that
// `{org, project}` come from the bearer token and can NEVER be supplied,
// widened or spoofed through the request body.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// One tenant, two roles + a second tenant to prove scope isolation.
process.env.API_KEYS = JSON.stringify({
  'app-token': { org: 'test-org', project: 'test-project', role: 'app' },
  'admin-token': { org: 'test-org', project: 'test-project', role: 'admin' },
  'other-admin': { org: 'other-org', project: 'other-project', role: 'admin' },
});

const getTenantReadinessMock = vi.fn();
const provisionTenantMock = vi.fn();

vi.mock('../services/tenant/provision.js', () => ({
  getTenantReadiness: (...args: unknown[]) => getTenantReadinessMock(...args),
  provisionTenant: (...args: unknown[]) => provisionTenantMock(...args),
}));

vi.mock('../db/client.js', () => ({ db: { __stub: true } }));

async function makeApp() {
  const { buildServer } = await import('../server.js');
  return buildServer();
}

beforeEach(() => {
  getTenantReadinessMock.mockReset();
  provisionTenantMock.mockReset();
  getTenantReadinessMock.mockResolvedValue({
    org: 'test-org',
    project: 'test-project',
    ready: false,
    checks: [],
  });
  provisionTenantMock.mockResolvedValue({
    org: 'test-org',
    project: 'test-project',
    items: [],
    manualSteps: [{ item: 'api-key', message: 'API_KEYS …' }],
    readiness: { org: 'test-org', project: 'test-project', ready: false, checks: [] },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('GET /v1/tenant/readiness', () => {
  it('is callable by an app-role consumer — self-diagnosis is the point', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/tenant/readiness',
      headers: { authorization: 'Bearer app-token' },
    });
    expect(res.statusCode).toBe(200);
    expect(getTenantReadinessMock).toHaveBeenCalledTimes(1);
    expect(getTenantReadinessMock.mock.calls[0]![1]).toEqual({
      org: 'test-org',
      project: 'test-project',
      role: 'app',
      unitType: undefined,
    });
    await app.close();
  });

  it('passes the unitType query through for a precise check', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/tenant/readiness?unitType=extract-postits',
      headers: { authorization: 'Bearer app-token' },
    });
    expect(res.statusCode).toBe(200);
    expect(getTenantReadinessMock.mock.calls[0]![1].unitType).toBe('extract-postits');
    await app.close();
  });

  it('scopes to the CALLING key, not to anything requested', async () => {
    const app = await makeApp();
    await app.inject({
      method: 'GET',
      url: '/v1/tenant/readiness?org=test-org&project=test-project',
      headers: { authorization: 'Bearer other-admin' },
    });
    expect(getTenantReadinessMock.mock.calls[0]![1]).toMatchObject({
      org: 'other-org',
      project: 'other-project',
    });
    await app.close();
  });

  it('401s without a bearer token', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/v1/tenant/readiness' });
    expect(res.statusCode).toBe(401);
    expect(getTenantReadinessMock).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('POST /v1/tenant/provision', () => {
  it('provisions for the admin key own scope and returns the manual step', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tenant/provision',
      headers: { authorization: 'Bearer admin-token' },
      payload: {
        budget: { limitUsd: 25 },
        unitTypes: [{ unitType: 'summary', version: '1', promptTemplate: 'Do {{x}}' }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().manualSteps).toHaveLength(1);
    const [, ctx, input] = provisionTenantMock.mock.calls[0]!;
    expect(ctx).toEqual({
      org: 'test-org',
      project: 'test-project',
      role: 'admin',
      actorKeyId: expect.any(String),
    });
    expect(input.budget).toEqual({ limitUsd: 25, refill: false });
    expect(input.unitTypes[0].activate).toBe(true);
    await app.close();
  });

  it('403s for an app-role key', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tenant/provision',
      headers: { authorization: 'Bearer app-token' },
      payload: { budget: { limitUsd: 25 } },
    });
    expect(res.statusCode).toBe(403);
    expect(provisionTenantMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('REJECTS an org/project in the body rather than honouring it', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tenant/provision',
      headers: { authorization: 'Bearer admin-token' },
      payload: { org: 'victim-org', project: 'victim-project', budget: { limitUsd: 1 } },
    });
    // The schema is `.strict()`, so smuggling a tenant in the body is a 400 —
    // never a silent write into someone else's scope.
    expect(res.statusCode).toBe(400);
    expect(provisionTenantMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('accepts an empty body (readiness-only probe)', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tenant/provision',
      headers: { authorization: 'Bearer admin-token' },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('400s on a malformed unitTypes entry', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tenant/provision',
      headers: { authorization: 'Bearer admin-token' },
      payload: { unitTypes: [{ unitType: 'summary' }] },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('401s without a bearer token', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tenant/provision',
      payload: { budget: { limitUsd: 25 } },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
