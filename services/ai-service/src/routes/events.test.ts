// Unit tests for /v1/events/:channel.
//
// SSE testing pattern (Fastify hijack + app.inject): use `payloadAsStream` to
// receive a Node stream, read raw chunks until we see the expected `data: `
// line, then close the stream. Cross-tenant subscribe is rejected with 403
// BEFORE the hijack, so the response is a normal JSON body — no SSE bytes.
//
// 🔴 WHY THE STUB'S `where()` TAKES ITS ARGUMENT NOW.
// The ownership check is the ONLY thing standing between a caller and another
// tenant's live event stream, and it is one WHERE clause. This mock used to
// declare `where: () => chain` — a function taking NO parameter — so that
// clause was discarded at the door and the "rejects cross-tenant channel"
// test below proved nothing about it: it emulated the cross-tenant case by
// emptying `dbState.rows` by hand, which is exactly as true with the tenant
// predicate deleted as with it present. Drop
// `eq(generationRequests.org, req.auth.org)` from `events.ts` and any caller
// who learns a request UUID subscribes to that request's events, forever,
// under a green suite.
//
// `where()` now records its argument through `WhereRecorder`, so the tests can
// assert the predicate carries the tenant COLUMNS and the caller's VALUES —
// and, crucially, that it is scoped to (org, project) and not merely to the
// request id. A mock still cannot prove isolation; the real proof lives in
// `src/routes/tenant-isolation.integration.test.ts`.
//
// 🔴 …AND THE TERMINALS RUN THROUGH `WhereRecorder.guard()`, BECAUSE RECORDING
// THE ARGUMENT STILL MISSES THE CALL THAT ISN'T MADE.
// Recording a predicate only fires when production CALLS `where()`. Delete the
// whole `.where(...)` from `events.ts` and the route runs
// `select().from(generationRequests).limit(1)` — legal drizzle, a whole-table
// read, and in the old stub it reached nothing at all: `limit` sat on the same
// object as `where`, so it happily resolved `dbState.rows`. The three
// assertions below did go red, but on `expectScopedTo`'s vacuity check, whose
// message says "the stub was never reached" — a description of a DIFFERENT
// bug, pointing a reader at the mock instead of at the deleted filter.
// One `guard` per `from()` now settles every terminal, so the deleted call is
// recorded as `<NO PREDICATE>`, named for what it is, and `expectNoUnfilteredQuery()`
// below stops being vacuous over this chain.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { IncomingMessage } from 'node:http';

import { WhereRecorder } from '../test/where-recorder.js';

// ---------------------------------------------------------------------------
// DB mock — the events route does a single `select().from().where().limit(1)`
// existence + ownership check on `generation_requests`. We seed `rows` per
// test.
// ---------------------------------------------------------------------------

const dbState = {
  rows: [] as Record<string, unknown>[],
};

/** Every predicate the route hands to `where()`, keyed by SQL table name. */
const wheres = new WhereRecorder();

vi.mock('../db/client.js', async () => {
  // Imported inside the factory so the table can be identified by IDENTITY
  // rather than by sniffing a drizzle-internal symbol — a recorded predicate
  // can then never be attributed to the wrong table.
  const { generationRequests } = await import('../db/schema/index.js');
  return {
    db: {
      select: () => ({
        from: (table: unknown) => {
          const name = table === generationRequests ? 'generation_requests' : 'unknown';
          // ONE guard per chain instance — per `from()`. It is what turns a
          // DELETED `.where()` into a recorded `<NO PREDICATE>` instead of a
          // silent whole-table read; see the header.
          const guard = wheres.guard(name);
          const chain: Record<string, unknown> = {
            // 🔴 TAKES its argument. See the header for what the parameterless
            // version could not see.
            where: (predicate: unknown) => {
              guard.where(predicate);
              return chain;
            },
            // Every terminal settles through the guard. `limit` is the one the
            // route uses today; `then` is here because a real drizzle builder
            // IS thenable, so a future `await db.select().from(t)` with no
            // filter must land somewhere that records it rather than handing
            // the route this stub object back.
            limit: () => guard.settle(Promise.resolve(dbState.rows)),
            then: (resolve: (v: unknown[]) => void, reject?: (e: unknown) => void) =>
              Promise.resolve(guard.settle(dbState.rows)).then(resolve, reject),
          };
          return chain;
        },
      }),
    },
  };
});

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
  wheres.reset();
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

    // The subscription was granted by a real predicate, not by the stub's
    // willingness to hand back a row.
    wheres.expectScopedTo('generation_requests', { org: ORG, project: PROJECT });

    stream.destroy();
    await app.close();
  });

  it('sets x-request-id on the hijacked SSE response', async () => {
    // 🔴 THE `onRequest` HOOK IN `server.ts` DOES NOT REACH THIS ROUTE.
    // `reply.header(...)` is only written by Fastify's serializer and
    // `reply.hijack()` bypasses it, so this endpoint answered with no
    // correlation id at all — on the one transport where a consumer most needs
    // one, because a stream that dies mid-flight leaves nothing else to quote.
    // The 403 path above is NOT hijacked and did carry the header the whole
    // time, which is why the gap survived: the failing case looked fine.
    //
    // SABOTAGE (measured): delete the `reply.raw.setHeader('x-request-id', …)`
    // line from `routes/events.ts` and this goes RED on `undefined`.
    const app = await makeApp();
    dbState.rows = [{ id: REQUEST_ID }];

    const res = await app.inject({
      method: 'GET',
      url: `/v1/events/request:${REQUEST_ID}:generations`,
      headers: { authorization: `Bearer ${APP_TOKEN}` },
      payloadAsStream: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['x-request-id'], 'hijacked SSE response carried no x-request-id')
      .toBeTruthy();

    (res.stream() as unknown as IncomingMessage).destroy();
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
    // …and the emptied `rows` above is only a FAITHFUL emulation of the
    // cross-tenant case if the query really filters on the tenant. It does:
    wheres.expectScopedTo('generation_requests', { org: ORG, project: PROJECT });
    await app.close();
  });

  it('🔴 the ownership check is scoped to (org, project) — not merely to the request id', async () => {
    // The dedicated statement of the contract. An id-only predicate would let
    // any caller who learns a request UUID open that request's live event
    // stream: `generation_requests.id` is a global UUID, so it identifies a row
    // without identifying a tenant. The check must be BOTH — id AND org AND
    // project — which is why this asserts the columns individually rather than
    // just "the query filtered on something".
    //
    // MUTATION TO CATCH: delete `eq(generationRequests.org, req.auth.org)`
    // (events.ts:40) or `eq(generationRequests.project, req.auth.project)`
    // (events.ts:41). Either leaves a well-formed `and(...)` that the old
    // parameterless stub swallowed whole; here the recorded SQL loses a column
    // and the bound params no longer match, so this goes red.
    const app = await makeApp();
    dbState.rows = [];
    const res = await app.inject({
      method: 'GET',
      url: `/v1/events/request:${REQUEST_ID}:generations`,
      headers: { authorization: `Bearer ${APP_TOKEN}` },
    });
    expect(res.statusCode).toBe(403);

    wheres.expectScopedTo('generation_requests', { org: ORG, project: PROJECT });
    wheres.expectNoUnfilteredQuery();

    const recorded = wheres.for('generation_requests');
    expect(recorded).toHaveLength(1);
    // Column by column, so dropping any ONE of the three is a distinct failure
    // rather than a single opaque "the SQL changed".
    expect(recorded[0]!.sql).toContain('"generation_requests"."id" =');
    expect(recorded[0]!.sql).toContain('"generation_requests"."org" =');
    expect(recorded[0]!.sql).toContain('"generation_requests"."project" =');
    // …and the VALUES are the channel's id plus the CALLER's scope, in that
    // order — a predicate naming the right columns while binding the wrong
    // values would satisfy the three checks above.
    expect(recorded[0]!.params).toEqual([REQUEST_ID, ORG, PROJECT]);
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

// ---------------------------------------------------------------------------
// Connection lifetime over a REAL socket.
//
// The cleanup listener must hang off the connection (`reply.raw`), not the
// request stream (`req.raw`): the request stream's `'close'` reports the body
// being consumed, not the client hanging up. `/v1/route` answered 499 to every
// call for that reason (ai-reality-audit §3 item 1); these tests pin
// the SSE route to the same rule. `app.inject()` has no TCP connection, so it
// can show neither a false early close nor a real hang-up.
// ---------------------------------------------------------------------------

describe('GET /v1/events/:channel — connection lifetime over a real socket', () => {
  const channel = `request:${REQUEST_ID}:generations`;

  async function open(): Promise<{
    app: Awaited<ReturnType<typeof makeApp>>;
    req: http.ClientRequest;
    res: IncomingMessage;
  }> {
    const app = await makeApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    if (!addr || typeof addr === 'string') throw new Error('no ephemeral port');
    let req!: http.ClientRequest;
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      req = http.request(
        {
          host: '127.0.0.1',
          port: addr.port,
          path: `/v1/events/${channel}`,
          method: 'GET',
          headers: { authorization: `Bearer ${APP_TOKEN}` },
        },
        resolve,
      );
      req.on('error', reject);
      req.end();
    });
    return { app, req, res };
  }

  async function waitFor(cond: () => boolean, ms = 2_000): Promise<void> {
    const t0 = Date.now();
    while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
  }

  it('keeps the subscription alive while the client stays connected', async () => {
    dbState.rows = [{ id: REQUEST_ID }];
    const { app, req, res } = await open();
    try {
      expect(res.statusCode).toBe(200);
      await readUntil(res, (b) => b.includes(': ok'));
      // Give any premature `'close'` time to land before the event is sent.
      await new Promise((r) => setTimeout(r, 200));
      expect(getEventBus().listenerCount()).toBe(1);
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
      const buf = await readUntil(res, (b) => b.includes('"generation.job.completed"'));
      expect(buf).toContain(`"requestId":"${REQUEST_ID}"`);
    } finally {
      req.destroy();
      await app.close();
    }
  });

  it('unsubscribes from the bus when the client hangs up', async () => {
    dbState.rows = [{ id: REQUEST_ID }];
    const { app, req, res } = await open();
    try {
      await readUntil(res, (b) => b.includes(': ok'));
      expect(getEventBus().listenerCount()).toBe(1);
      req.destroy();
      await waitFor(() => getEventBus().listenerCount() === 0);
      expect(getEventBus().listenerCount()).toBe(0);
    } finally {
      await app.close();
    }
  });
});
