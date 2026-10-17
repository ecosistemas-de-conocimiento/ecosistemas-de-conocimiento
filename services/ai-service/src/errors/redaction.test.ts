// `expose = false` REDACTION, end to end through the real Fastify handler.
//
// ── Why this file exists ───────────────────────────────────────────────────
// `errors/base.ts` documents `expose = false` as the way a class carrying an
// upstream body snippet keeps that snippet off the wire, and
// `wire-golden.test.ts` proves `mapGenerateError` returns `undefined` for such
// a class. Both are true and NEITHER of them proves redaction: the route then
// RETHROWS, and what the caller actually receives is decided further down, by
// the /v1 error handler and — if that handler rethrows too — by Fastify.
//
// Fastify does NOT redact. `fastify/lib/error-handler.js` → `setErrorHeaders`
// reads `error.status` BEFORE `error.statusCode`, and every taxonomy class
// declares `status`; `fallbackErrorHandler` then serialises `error.message`
// and `error.code` onto the body. So a rethrown `expose = false` error was
// published with its real status AND its full message — the exact leak the
// flag exists to prevent.
//
// These assertions are therefore about the LAST hop, not the mapper: given a
// route that throws an `expose = false` class carrying a secret, what lands on
// the wire and what lands in pino.
//
// ⚠ SABOTAGE CHECK — the guard these tests protect is the `if (error.expose)`
// branch inside `v1.setErrorHandler` in `src/server.ts`. Widen it (make the
// expose arm unconditional, or restore the `throw error` in the else) and the
// first test below must go red. It did not go red before this file existed:
// all 1624 tests passed with the redaction removed.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { AiServiceError } from './base.js';

const resolveSpecMock = vi.fn();
const fetchContextMock = vi.fn();

vi.mock('../services/registry/resolve.js', async () => {
  const actual =
    await vi.importActual<typeof import('../services/registry/resolve.js')>(
      '../services/registry/resolve.js',
    );
  return { ...actual, resolveSpec: (...a: unknown[]) => resolveSpecMock(...a) };
});

vi.mock('../services/ai/router/openrouter.js', () => ({
  createOpenRouter: () => ({ route: vi.fn() }),
}));

vi.mock('../services/context/fetch.js', () => ({
  fetchContext: (...a: unknown[]) => fetchContextMock(...a),
}));

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => {
        const chain: Record<string, unknown> = {
          where: () => chain,
          orderBy: () => chain,
          limit: () => Promise.resolve([]),
          then: (r: (v: unknown[]) => void) => r([]),
        };
        return chain;
      },
    }),
  },
}));

const APP_TOKEN = 'redaction-app';

process.env['API_KEYS'] = JSON.stringify({
  [APP_TOKEN]: { org: 'acme', project: 'acme', role: 'app' },
});

// `vitest.config.ts` pins `LOG_LEVEL=silent` for every other suite. This file
// asserts on the LOG, so it has to turn one on — and it must happen before
// `env.ts` is first loaded, which is why `makeApp` imports dynamically.
process.env['LOG_LEVEL'] = 'info';

// ⚠ DYNAMIC for the same reason as `generate.provider-unavailable.test.ts`: a
// static import is hoisted above the `API_KEYS` assignment, `env.ts` snapshots
// the key table at load, and every request would then 401.
async function makeApp() {
  const { buildServer } = await import('../server.js');
  return buildServer();
}

/** The kind of string `expose = false` exists to keep off the wire. */
const SECRET = 'x-upstream-token=sk-live-DO-NOT-LEAK-9f3a';

/**
 * Stands in for `SparseEmbedNotConfiguredError` / `RerankNotConfiguredError`:
 * a 5xx-status taxonomy class whose message carries an upstream detail.
 */
class LeakyInternalError extends AiServiceError {
  readonly code = 'ERR_LEAKY_INTERNAL';
  readonly status = 503;
  override readonly expose = false;
  constructor() {
    super(`sparse embedder rejected the call: ${SECRET}`);
    this.name = 'LeakyInternalError';
  }
}

/**
 * Capture what pino actually wrote.
 *
 * The destination, not `process.stdout.write`: pino writes through SonicBoom
 * straight to fd 1, so a `process.stdout` spy captures nothing (verified). The
 * stream object is shared by every child logger, so grabbing it off the root
 * instance also catches `req.log`.
 */
function captureLogs(app: { log: unknown }): { lines: Record<string, unknown>[]; stop: () => void } {
  const log = app.log as Record<symbol, unknown>;
  const streamSym = Object.getOwnPropertySymbols(log).find((s) => s.description === 'pino.stream');
  if (!streamSym) throw new Error('pino stream symbol not found on the fastify logger');
  const stream = log[streamSym] as { write: (chunk: string) => unknown };
  const original = stream.write.bind(stream);
  const lines: Record<string, unknown>[] = [];
  stream.write = (chunk: string) => {
    for (const raw of String(chunk).split('\n')) {
      if (!raw.trim()) continue;
      try {
        lines.push(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        /* not our JSON line */
      }
    }
    return true;
  };
  return { lines, stop: () => void (stream.write = original) };
}

async function postSync(
  app: Awaited<ReturnType<typeof makeApp>>,
  payload: unknown = { unit: { unitKey: 'u-1', input: { name: 'Alice' } } },
) {
  return app.inject({
    method: 'POST',
    url: '/v1/generate/sync',
    headers: { authorization: `Bearer ${APP_TOKEN}` },
    payload: payload as Record<string, unknown>,
  });
}

beforeEach(() => {
  resolveSpecMock.mockReset();
  fetchContextMock.mockReset();
  fetchContextMock.mockResolvedValue({});
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('expose = false is redacted by the /v1 error handler', () => {
  it('answers a generic 500 and keeps the secret out of the body', async () => {
    resolveSpecMock.mockRejectedValue(new LeakyInternalError());
    const app = await makeApp();
    const cap = captureLogs(app);
    try {
      const res = await postSync(app);

      // NOT 503: the class's own status must not reach the status line either,
      // or the caller can still fingerprint which internal component failed.
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({
        statusCode: 500,
        error: 'Internal Server Error',
        message: 'internal error',
      });
      // The whole body, not just the parsed message — headers-adjacent fields
      // like `code` were part of the leak.
      expect(res.payload).not.toContain(SECRET);
      expect(res.payload).not.toContain('ERR_LEAKY_INTERNAL');
      expect(res.payload).not.toContain('sparse embedder');
    } finally {
      cap.stop();
      await app.close();
    }

    // …and the operator still gets everything, at error level.
    const errorLines = cap.lines.filter((l) => l['level'] === 50);
    const leaked = errorLines.filter((l) => JSON.stringify(l).includes(SECRET));
    expect(leaked.length).toBeGreaterThan(0);
    const handled = cap.lines.find((l) => l['errorCode'] === 'ERR_LEAKY_INTERNAL');
    expect(handled).toBeDefined();
    expect(handled?.['level']).toBe(50);
    expect(handled?.['org']).toBe('acme');
    expect(handled?.['project']).toBe('acme');
  });

  it('an exposed class is untouched — the redaction arm is not a blanket 500', async () => {
    const { BudgetExceeded } = await import('../services/budget/errors.js');
    resolveSpecMock.mockRejectedValue(new BudgetExceeded('acme', 1.5, 0.25));
    const app = await makeApp();
    // Captured only to keep this file's `LOG_LEVEL=info` off the suite output.
    const cap = captureLogs(app);
    try {
      const res = await postSync(app);
      expect(res.statusCode).toBe(402);
      expect(res.json()).toMatchObject({ error: 'BudgetExceeded', org: 'acme' });
    } finally {
      cap.stop();
      await app.close();
    }
  });
});

describe('log level matches the status', () => {
  it("a caller's own 400 is not logged at error level", async () => {
    const app = await makeApp();
    const cap = captureLogs(app);
    try {
      // Fails `generateSyncRequestSchema`, so the route answers
      // `reply.badRequest(...)` — which `reply.send`s an Error and therefore
      // still passes through the /v1 error handler.
      const res = await postSync(app, { nope: true });
      expect(res.statusCode).toBe(400);
    } finally {
      cap.stop();
      await app.close();
    }
    expect(cap.lines.filter((l) => l['level'] === 50)).toEqual([]);
    expect(
      cap.lines.some((l) => l['msg'] === 'unhandled error on /v1' && l['level'] === 30),
    ).toBe(true);
  });

  it('an unknown 500 still logs at error level', async () => {
    resolveSpecMock.mockRejectedValue(new Error('db password rejected'));
    const app = await makeApp();
    const cap = captureLogs(app);
    try {
      const res = await postSync(app);
      expect(res.statusCode).toBe(500);
    } finally {
      cap.stop();
      await app.close();
    }
    expect(
      cap.lines.some((l) => l['msg'] === 'unhandled error on /v1' && l['level'] === 50),
    ).toBe(true);
  });
});
