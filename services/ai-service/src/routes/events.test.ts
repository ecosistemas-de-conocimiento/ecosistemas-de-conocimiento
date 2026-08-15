// Unit tests for /v1/events/:channel.
//
// SSE testing pattern (Fastify hijack + app.inject): use `payloadAsStream` to
// receive a Node stream, read raw chunks until we see the expected `data: `
// line, then close the stream. Cross-tenant subscribe is rejected with 403
// BEFORE the hijack, so the response is a normal JSON body — no SSE bytes.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage } from 'node:http';

// ---------------------------------------------------------------------------
// DB mock — the events route does a single `select().from().where().limit(1)`
// existence + ownership check on `generation_requests`. We seed `rows` per
// test.
// ---------------------------------------------------------------------------

const dbState = {
  rows: [] as Record<string, unknown>[],
};

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => {
        const chain: Record<string, unknown> = {
          where: () => chain,
          limit: () => Promise.resolve(dbState.rows),
        };
        return chain;
      },
    }),
  },
}));

// Force the event bus to a fresh instance per test.
import {
  resetEventBusForTests,
  getEventBus,
} from '../services/events/bus.js';

import { useBuildServer } from '../test/server-harness.js';

const APP_TOKEN = 'test-key';
const ORG = 'test-org';
const PROJECT = 'test-project';
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  resetEventBusForTests();
  dbState.rows = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

// `server.js` is imported ONCE per file, in `beforeAll` — importing it inside
// the first test body cost that test ~3 s of module transform against vitest's
// 5 s per-test budget. See `src/test/server-harness.ts`.
const makeApp = useBuildServer();

/**
 * Read chunks from the SSE stream until `predicate` returns true on the
 * accumulated buffer, then resolve with the buffer. Rejects on timeout.
 */
async function readUntil(
  stream: IncomingMessage,
  predicate: (buf: string) => boolean,
  timeoutMs = 1500,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk: Buffer | string): void => {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (predicate(buf)) {
        stream.removeListener('data', onData);
        clearTimeout(timer);
        resolve(buf);
      }
    };
    const timer = setTimeout(() => {
      stream.removeListener('data', onData);
      reject(new Error(`SSE read timeout — buffer so far: ${JSON.stringify(buf)}`));
    }, timeoutMs);
    stream.on('data', onData);
    stream.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /v1/events/:channel', () => {
  it('subscribes to a caller-owned channel and forwards matching bus events', async () => {
    const app = await makeApp();
    dbState.rows = [{ id: REQUEST_ID }];
    const channel = `request:${REQUEST_ID}:generations`;

    const injectPromise = app.inject({
      method: 'GET',
      url: `/v1/events/${channel}`,
      headers: { authorization: `Bearer ${APP_TOKEN}` },
      payloadAsStream: true,
    });

    const res = await injectPromise;
    expect(res.statusCode).toBe(200);
    const stream = res.stream() as unknown as IncomingMessage;

    // First chunk is the initial `: ok\n\n` comment ping. Emit an event on the
    // bus and wait for it to land on the SSE stream as a `data:` line.
    setImmediate(() => {
      getEventBus().emit({
        type: 'generation.job.completed',
        requestId: REQUEST_ID,
        jobId: 'job-1',
        unitKey: 'u1',
        org: ORG,
        project: PROJECT,
        flags: [],
        costUsd: 0.001,
      });
    });

    const buf = await readUntil(stream, (b) => b.includes('"generation.job.completed"'));
    expect(buf).toContain(`"requestId":"${REQUEST_ID}"`);
    expect(buf).toContain('"unitKey":"u1"');

    stream.destroy();
    await app.close();
  });

  it('rejects cross-tenant channel with 403 and no SSE bytes', async () => {
    const app = await makeApp();
    // The mocked select returns the rows we set; emulate cross-tenant by
    // leaving rows empty (the SELECT predicate would have filtered it out).
    dbState.rows = [];
    const channel = `request:${REQUEST_ID}:generations`;

    const res = await app.inject({
      method: 'GET',
      url: `/v1/events/${channel}`,
      headers: { authorization: `Bearer ${APP_TOKEN}` },
    });
    expect(res.statusCode).toBe(403);
    // The body is a normal JSON error (sensible), NOT an SSE stream.
    expect(res.headers['content-type']).toMatch(/application\/json/);
    await app.close();
  });

  it('rejects malformed channel with 400', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/events/not-a-real-channel',
      headers: { authorization: `Bearer ${APP_TOKEN}` },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
