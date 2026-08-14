// scripts/smoke.spec.ts — vitest wrapper around the shell smoke check.
//
// Why a duplicate of `scripts/smoke.sh`? Two reasons:
//   1. Some users prefer running smoke through the vitest harness (richer
//      reporter, easy to bolt into the same test runner already wired into
//      CI / IDEs).
//   2. The shell script is the source of truth for the cron + post-deploy
//      hook; this file mirrors its behaviour 1:1 so we can assert the same
//      contract from a TS context.
//
// Gating: the whole `describe` is skipped unless BOTH `AI_SERVICE_URL` and
// `AI_SERVICE_SMOKE_TOKEN` are present. That makes it safe to run as part of
// `pnpm test` in any environment that does not have live smoke credentials.
//
// ESM/strict-TS notes: we keep this file self-contained (no service imports)
// so the smoke isn't accidentally coupled to internal types that could change.
// Uses `fetch` from Node 22's global; no third-party HTTP client needed.

import { describe, expect, it } from 'vitest';

const URL_BASE = (process.env.AI_SERVICE_URL ?? '').replace(/\/$/, '');
const TOKEN = process.env.AI_SERVICE_SMOKE_TOKEN ?? '';
const ORG = process.env.AI_SERVICE_ORG ?? 'demo';
const SKIP = !URL_BASE || !TOKEN;

// Generous default — smoke runs against a real network, real LLM. Override
// via `VITEST_TEST_TIMEOUT` if your deploy is slow.
const SYNC_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Small typed helpers. Kept inline so this file has zero local deps.
// ---------------------------------------------------------------------------

interface FetchResult {
  status: number;
  body: unknown;
  raw: string;
}

async function call(method: string, path: string, init: RequestInit = {}): Promise<FetchResult> {
  const res = await fetch(`${URL_BASE}${path}`, { method, ...init });
  const raw = await res.text();
  let body: unknown = raw;
  try {
    body = JSON.parse(raw);
  } catch {
    // Some endpoints may not return JSON on error; keep the raw text.
  }
  return { status: res.status, body, raw };
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, ...extra };
}

// Tiny structural getter that doesn't pull in a JSON-path lib. Throws on
// missing keys so vitest surfaces a clean failure.
function pick(body: unknown, path: ReadonlyArray<string>): unknown {
  let cur: unknown = body;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') {
      throw new Error(`expected object at ${path.join('.')}, got ${typeof cur}`);
    }
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('live smoke', () => {
  it('step 1: GET /health returns ok', async () => {
    const r = await call('GET', '/health');
    expect(r.status).toBe(200);
    expect(pick(r.body, ['status'])).toBe('ok');
  });

  it('step 2: GET /health/ready reports database + redis healthy', async () => {
    const r = await call('GET', '/health/ready');
    expect(r.status).toBe(200);
    expect(pick(r.body, ['status'])).toBe('ok');
    expect(pick(r.body, ['checks', 'database', 'ok'])).toBe(true);
    expect(pick(r.body, ['checks', 'redis', 'ok'])).toBe(true);
  });

  it('step 3: GET /v1/ authed echoes org + project', async () => {
    const r = await call('GET', '/v1/', { headers: authHeaders() });
    expect(r.status).toBe(200);
    expect(typeof pick(r.body, ['org'])).toBe('string');
    expect(typeof pick(r.body, ['project'])).toBe('string');
    expect((pick(r.body, ['org']) as string).length).toBeGreaterThan(0);
  });

  it(
    'step 4: POST /v1/generate/sync returns text + cost + traceId',
    { timeout: SYNC_TIMEOUT_MS },
    async () => {
      const r = await call('POST', '/v1/generate/sync', {
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          unit: {
            unitKey: 'smoke-test',
            unitType: 'smoke',
            input: {},
            specOverride: {
              promptTemplate: 'Say hello in exactly three words.',
              model: 'deepseek/deepseek-chat-v3.1',
            },
          },
          effortLevel: 'quick',
        }),
      });
      expect(r.status).toBe(200);
      const text = pick(r.body, ['text']);
      expect(typeof text).toBe('string');
      expect((text as string).length).toBeGreaterThan(0);
      expect(typeof pick(r.body, ['modelUsed'])).toBe('string');
      expect(pick(r.body, ['provider'])).toBe('openrouter');
      const cost = pick(r.body, ['costUsd']);
      expect(typeof cost).toBe('number');
      expect(cost as number).toBeGreaterThanOrEqual(0);
      expect(typeof pick(r.body, ['traceId'])).toBe('string');
    },
  );

  it('step 5: GET /v1/budget/:org returns budget snapshot', async () => {
    const r = await call('GET', `/v1/budget/${ORG}`, { headers: authHeaders() });
    expect(r.status).toBe(200);
    expect(typeof pick(r.body, ['remainingUsd'])).toBe('number');
    expect(typeof pick(r.body, ['limitUsd'])).toBe('number');
    expect(typeof pick(r.body, ['spentUsd'])).toBe('number');
    expect(typeof pick(r.body, ['currency'])).toBe('string');
  });
});
