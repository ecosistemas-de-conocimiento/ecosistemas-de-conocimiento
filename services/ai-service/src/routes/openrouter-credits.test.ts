// HTTP tests for GET /v1/openrouter/credits.
//
// Rewrites `API_KEYS` to include an admin token before importing the server
// (env.ts reads `process.env` at module load time). The global `fetch` is
// stubbed per-test to simulate the upstream OpenRouter responses.

// IMPORTANT: rewrite env BEFORE any import that pulls `config/env.ts`. ESM
// hoists static imports above top-level statements, so `process.env`
// mutations belong inside `vi.hoisted` to run first. The cache reset and the
// server module are loaded via dynamic import inside the test bodies.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useBuildServer } from '../test/server-harness.js';

const APP_TOKEN = 'cr-test-app';
const ADMIN_TOKEN = 'cr-test-admin';

vi.hoisted(() => {
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
  process.env.API_KEYS = JSON.stringify({
    'cr-test-app': { org: 'demo', project: 'demo', role: 'app' },
    'cr-test-admin': { org: 'demo', project: 'demo', role: 'admin' },
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// `server.js` is imported ONCE per file, in `beforeAll` — importing it inside
// the first test body cost that test ~3 s of module transform against vitest's
// 5 s per-test budget. See `src/test/server-harness.ts`.
const makeApp = useBuildServer();

beforeEach(async () => {
  const mod = await import('../services/ai/openrouter-credits.js');
  mod.__resetOpenRouterCreditsCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /v1/openrouter/credits', () => {
  it('returns 403 for an app-role token', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/openrouter/credits',
      headers: { authorization: `Bearer ${APP_TOKEN}` },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('returns 200 with the stable shape for an admin-role token', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, { data: { total_credits: 50, total_usage: 12 } }),
    );
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/openrouter/credits',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalCredits).toBe(50);
    expect(body.totalUsage).toBe(12);
    expect(body.remainingCredits).toBe(38);
    expect(typeof body.updatedAt).toBe('string');
    await app.close();
  });

  it('returns 503 when OpenRouter responds with 500', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(500, { error: { message: 'upstream down' } }),
    );
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/openrouter/credits',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('openrouter_unreachable');
    await app.close();
  });
});
