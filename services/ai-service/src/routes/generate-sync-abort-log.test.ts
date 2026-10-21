// POST /v1/generate/sync — a client disconnect leaves ONE structured log line.
//
// ── Why this file exists ───────────────────────────────────────────────────
// Before it, a /sync call the client hung up on answered 499 into a dead
// socket and logged nothing of its own, so from the service side it looked
// like a silent hang. Measured: ai-client's 30 s clamp
// aborted a sync call at 29 979 ms, the partial was billed, and nothing here
// said so. The line carries what an operator needs: status, request id,
// elapsed, tokens so far, cost settled.
//
// ⚠ A REAL SOCKET, not `app.inject()`: inject has no TCP connection to drop,
// so the disconnect under test has no representation in it (see
// generate-stream-abort.integration.test.ts). The router is mocked; it waits
// for the abort and throws the same partial-carrying `AbortError` the
// streaming adapter throws.

import http from 'node:http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const resolveSpecMock = vi.fn();
const createOpenRouterMock = vi.fn();

vi.mock('../services/registry/resolve.js', async () => {
  const actual = await vi.importActual<typeof import('../services/registry/resolve.js')>(
    '../services/registry/resolve.js',
  );
  return { ...actual, resolveSpec: (...a: unknown[]) => resolveSpecMock(...a) };
});
vi.mock('../services/ai/router/openrouter.js', () => ({
  createOpenRouter: () => createOpenRouterMock(),
}));
vi.mock('../services/context/fetch.js', () => ({
  fetchContext: async () => ({}),
  fetchContextWithTrace: async () => ({ context: {}, retrievalTrace: [] }),
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

const APP_TOKEN = 'sync-abort-log-app';
process.env['API_KEYS'] = JSON.stringify({
  [APP_TOKEN]: { org: 'acme', project: 'acme', role: 'app' },
});

const PARTIAL = {
  contentText: 'half an ans',
  finishReason: 'aborted',
  model: 'mock/model',
  rawId: 'gen-cut',
  usage: { promptTokens: 120, completionTokens: 37, costUsd: 0.000189, costSource: 'pricing-table' },
};

let app: FastifyInstance | undefined;
/**
 * Resolves with the abort line's arguments. Awaited with no timeout window of
 * its own: the condition is forced (the socket is destroyed), so the only
 * bound is the test timeout. A `waitFor` window flaked under suite load.
 */
let abortLine: Promise<unknown[]>;
/** EVERY "client disconnected" warn this app logged, in order. */
let abortLines: unknown[][];
/**
 * Resolves once the handler has SENT its reply (`onSend`), plus one macrotask.
 * Not `onResponse`: Fastify never runs it for a socket that is already gone.
 * The 499 path logs and then sends, so by now a duplicate line from the same
 * handler is already in `abortLines`.
 */
let responded: Promise<void>;
/** Resolves on the server-side response's `close` (also after a normal finish). */
let rawClosed: Promise<void>;

beforeEach(async () => {
  resolveSpecMock.mockResolvedValue({
    promptTemplate: 'Hello {{name}}!',
    model: 'mock/model',
    effortLevel: 'standard',
    effortProfile: {
      model: 'mock/model',
      maxOutputTokens: 800,
      validationPasses: 1,
      multiSample: 1,
      temperature: 0.4,
      estimatedCostUsdPerCall: 0.001,
    },
    validators: [],
  });
});

/**
 * Build and listen INSIDE the test, not in `beforeEach`: a cold `buildServer()`
 * under full-suite load outran vitest's 10 s hook timeout (which
 * `--testTimeout` does not raise). Sibling route tests build in-test too.
 */
async function startApp(): Promise<FastifyInstance> {
  const { buildServer } = await import('../server.js');
  const a = await buildServer();
  // Spy on THIS request's logger: `req.log` is a per-request pino child.
  let seen!: (args: unknown[]) => void;
  abortLine = new Promise((r) => (seen = r));
  abortLines = [];
  let done!: () => void;
  responded = new Promise((r) => (done = r));
  let closed!: () => void;
  rawClosed = new Promise((r) => (closed = r));
  a.addHook('onRequest', async (req, reply) => {
    reply.raw.once('close', () => setImmediate(closed));
    const original = req.log.warn.bind(req.log);
    req.log.warn = ((...args: unknown[]) => {
      if (typeof args[1] === 'string' && args[1].includes('client disconnected')) {
        abortLines.push(args);
        seen(args);
      }
      return (original as (...a: unknown[]) => void)(...args);
    }) as typeof req.log.warn;
  });
  a.addHook('onSend', async () => {
    setImmediate(done);
  });
  await a.listen({ port: 0, host: '127.0.0.1' });
  app = a;
  return a;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.clearAllMocks();
});

/** POST /sync over a real socket, then destroy it once the router is running. */
function postThenHangUp(a: FastifyInstance, routerEntered: Promise<void>): void {
  const port = (a.server.address() as { port: number }).port;
  const req = http.request({
    host: '127.0.0.1',
    port,
    method: 'POST',
    path: '/v1/generate/sync',
    headers: { authorization: `Bearer ${APP_TOKEN}`, 'content-type': 'application/json' },
  });
  req.on('error', () => {});
  req.end(JSON.stringify({ unit: { unitKey: 'u-1', input: { name: 'Alice' } } }));
  void routerEntered.then(() => req.destroy());
}

describe('POST /v1/generate/sync — client disconnect is logged', () => {
  it('logs status 499, request id, elapsed, tokens so far and cost settled', async () => {
    let entered!: () => void;
    const routerEntered = new Promise<void>((r) => (entered = r));
    createOpenRouterMock.mockReturnValue({
      route: vi.fn(
        (args: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            args.signal.addEventListener('abort', () => {
              reject(Object.assign(new Error('OpenRouter stream aborted'), { name: 'AbortError', partial: PARTIAL }));
            });
            entered();
          }),
      ),
    });

    postThenHangUp(await startApp(), routerEntered);
    const [fields, message] = (await abortLine) as [Record<string, unknown>, string];
    expect(message).toMatch(/client disconnected/);
    expect(fields).toMatchObject({
      event: 'generate.sync.client_abort',
      statusCode: 499,
      reachedProvider: true,
      inputTokens: 120,
      outputTokens: 37,
      costSettledUsd: 0.000189,
      costSource: 'pricing-table',
    });
    expect(fields['requestId']).toEqual(expect.any(String));
    expect(String(fields['requestId']).length).toBeGreaterThan(0);
    expect(fields['elapsedMs']).toBeGreaterThanOrEqual(0);
    // ONE line per disconnect: wait until the handler has fully finished, so a
    // second line from any later path (error hook, a retry of the send) would
    // already be in the list.
    await responded;
    expect(abortLines).toHaveLength(1);
  });

  it('says so with zeros when the abort lands before the provider was called', async () => {
    let entered!: () => void;
    const routerEntered = new Promise<void>((r) => (entered = r));
    createOpenRouterMock.mockReturnValue({
      route: vi.fn(
        (args: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            args.signal.addEventListener('abort', () => {
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            });
            entered();
          }),
      ),
    });

    postThenHangUp(await startApp(), routerEntered);
    const [fields] = await abortLine;
    await responded;
    expect(abortLines).toHaveLength(1);
    expect(fields).toMatchObject({
      statusCode: 499,
      reachedProvider: false,
      inputTokens: 0,
      outputTokens: 0,
      costSettledUsd: 0,
    });
  });

  it('logs NOTHING when the call completes normally', async () => {
    createOpenRouterMock.mockReturnValue({
      route: vi.fn(async () => ({
        content: 'a full answer',
        model: 'mock/model',
        provider: 'openrouter',
        usage: { estimatedCostUsd: 0.0002 },
        traceId: 'trace-ok',
      })),
    });

    const a = await startApp();
    const port = (a.server.address() as { port: number }).port;
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/v1/generate/sync',
          headers: { authorization: `Bearer ${APP_TOKEN}`, 'content-type': 'application/json' },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify({ unit: { unitKey: 'u-1', input: { name: 'Alice' } } }));
    });
    // Also past `close`: a line hung on the response's close event (the
    // disconnect detector's own trigger) would fire there, after the body.
    await Promise.all([responded, rawClosed]);
    expect(status).toBe(200);
    expect(abortLines).toHaveLength(0);
  });
});
