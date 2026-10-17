// Mutation tests for the prototype-chain auth bypass fix (audit finding
// [HIGH] auth bypass, commit "sec(auth-proto-bypass)").
//
// The defect: `env.API_KEYS` is a plain object, so `env.API_KEYS[token]`
// resolves prototype-chain names — `Authorization: Bearer __proto__` (or
// `constructor`, `toString`, ...) returned a truthy `Object.prototype` member,
// passed the `!entry` check, and minted an auth context with UNDEFINED
// org/project. That was an unauthenticated bypass into every /v1 route.
//
// These tests assert the OBSERVABLE effect on the authenticated echo route
// (`GET /v1/` returns `{ v1, org, project }`): a prototype-name token must
// never reach the handler, and must never mint a scope. Reintroducing the
// defect (bare `env.API_KEYS[token]` lookup with only a `!entry` check) turns
// every prototype-name case below into a 200 with `org: undefined` → RED.

import { describe, expect, it } from 'vitest';

async function makeApp() {
  const { buildServer } = await import('../server.js');
  return buildServer();
}

describe('requireAuth — prototype-chain bearer tokens', () => {
  it('rejects `Bearer __proto__` with 401 and mints no auth scope', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/',
      headers: { authorization: 'Bearer __proto__' },
    });
    expect(res.statusCode).toBe(401);
    const body = res.json() as Record<string, unknown>;
    expect(body.error).toBe('unauthorized');
    // The observable bypass effect was `{ v1: true, org: undefined, ... }` —
    // assert the handler was never reached, not just the status code.
    expect(body).not.toHaveProperty('v1');
    expect(body).not.toHaveProperty('org');
    await app.close();
  });

  it('rejects `Bearer constructor` with 401 and mints no auth scope', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/',
      headers: { authorization: 'Bearer constructor' },
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as Record<string, unknown>).error).toBe('unauthorized');
    expect(res.json()).not.toHaveProperty('v1');
    await app.close();
  });

  it('generic invariant: EVERY Object.prototype property name is rejected', async () => {
    // Prefer the invariant over named cases: whatever the runtime exposes on
    // Object.prototype (toString, hasOwnProperty, __proto__, __defineGetter__,
    // ...) must fail auth identically to a random unknown key.
    const app = await makeApp();
    const names = Object.getOwnPropertyNames(Object.prototype);
    expect(names.length).toBeGreaterThan(0); // sanity: the loop is not empty
    for (const name of names) {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/',
        headers: { authorization: `Bearer ${name}` },
      });
      expect(res.statusCode, `token '${name}' must be rejected`).toBe(401);
      expect(res.json(), `token '${name}' must not reach the handler`).not.toHaveProperty('v1');
    }
    await app.close();
  });

  it('control: a configured key still authenticates with its real scope', async () => {
    // Guards against over-rejection: the fix must not break legitimate keys.
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
