// A pooler FATAL during a database outage must not kill the process.
//
// ── The bug (SECURITY_OPEN §49.2, measured on dev 2026-10-17/18) ────────────
// With Postgres down behind PgBouncer, PgBouncer still completes the CLIENT
// login itself, then fails the first query with
// `FATAL 08P01 server login has been failing`. postgres.js's first query on a
// new connection is its own fire-and-forget array-types query
// (`fetchArrayTypes`, started from `ReadyForQuery` with no handler), so the
// FATAL became an unhandled rejection and node exited. The container
// restarted twice in an 18 s outage. Fix: `fetch_types: false` in
// `src/db/client.ts`.
//
// ── How this test forces it, with no timing windows ─────────────────────────
// `FakePooler` is a TCP proxy in front of the real test Postgres. `up` pipes
// bytes through untouched. `down` cuts every open connection (what a Postgres
// restart does) and answers each NEW connection the way PgBouncer does in
// that state: AuthenticationOk, BackendKeyData, ReadyForQuery, and then, on
// the first query message, the FATAL plus a close. No Docker image, no
// `server_login_retry` clock: the FATAL arrives on every login, every time.
//
// The app under test is the real one: `buildServer()` and the shared pool in
// `src/db/client.ts`, whose `DATABASE_URL` is rewritten to the proxy before
// anything imports `env.ts`.
//
// ⚠ SABOTAGE CHECK, done 2026-10-18: with `fetch_types: false` removed from
// `POOL_SAFETY` in `src/db/client.ts`, this file goes red. vitest reports the
// unhandled `PostgresError: server login has been failing` and the test
// fails; in a real node process that rejection is the exit.

import net from 'node:net';

import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const FATAL_MESSAGE =
  'server login has been failing, cached error: connect failed (server_login_retry)';

/** One backend message: a type byte, then an int32 length that counts itself. */
function message(type: string, body: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.write(type, 0, 'latin1');
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
}

function int32s(...xs: number[]): Buffer {
  const b = Buffer.alloc(xs.length * 4);
  xs.forEach((x, i) => b.writeInt32BE(x, i * 4));
  return b;
}

/** ErrorResponse: (field byte, cstring)* then a 0 terminator. */
function errorResponse(fields: Record<string, string>): Buffer {
  const parts = Object.entries(fields).map(([k, v]) => Buffer.from(`${k}${v}\0`, 'utf8'));
  return message('E', Buffer.concat([...parts, Buffer.from([0])]));
}

const LOGIN_OK = Buffer.concat([
  message('R', int32s(0)), // AuthenticationOk
  message('K', int32s(1, 2)), // BackendKeyData
  message('Z', Buffer.from('I', 'latin1')), // ReadyForQuery, idle
]);

const LOGIN_FAILING_FATAL = errorResponse({
  S: 'FATAL',
  V: 'FATAL',
  C: '08P01',
  M: FATAL_MESSAGE,
});

class FakePooler {
  mode: 'up' | 'down' = 'up';
  /** Logins answered in `down` mode, i.e. how many times the FATAL was served. */
  refusedLogins = 0;
  private readonly open = new Set<net.Socket>();
  private readonly server: net.Server;

  constructor(
    private readonly upstreamHost: string,
    private readonly upstreamPort: number,
  ) {
    this.server = net.createServer((client) => this.accept(client));
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return (this.server.address() as net.AddressInfo).port;
  }

  /** Postgres goes away: every live connection is cut, new ones get the FATAL. */
  down(): void {
    this.mode = 'down';
    for (const s of this.open) s.destroy();
    this.open.clear();
  }

  up(): void {
    this.mode = 'up';
  }

  async close(): Promise<void> {
    for (const s of this.open) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private accept(client: net.Socket): void {
    this.open.add(client);
    client.on('close', () => this.open.delete(client));
    client.on('error', () => undefined);
    if (this.mode === 'up') {
      const upstream = net.connect(this.upstreamPort, this.upstreamHost);
      this.open.add(upstream);
      upstream.on('close', () => {
        this.open.delete(upstream);
        client.destroy();
      });
      upstream.on('error', () => undefined);
      client.on('close', () => upstream.destroy());
      client.pipe(upstream);
      upstream.pipe(client);
      return;
    }
    // `down`: the first packet is the StartupMessage (postgres.js sends no
    // SSLRequest with `ssl` unset). Every later packet is a query.
    let loggedIn = false;
    client.on('data', () => {
      if (!loggedIn) {
        loggedIn = true;
        this.refusedLogins++;
        client.write(LOGIN_OK);
        return;
      }
      client.end(LOGIN_FAILING_FATAL);
    });
  }
}

// ── Env, rewritten BEFORE `env.ts` loads ────────────────────────────────────
// `integration-setup.ts` has already pointed DATABASE_URL at the test DB.
const KEY = 'app-pooler-fatal';
const realUrl = new URL(process.env.DATABASE_URL!);
const pooler = new FakePooler(realUrl.hostname, Number(realUrl.port || 5432));
const proxyUrl = new URL(realUrl.href);
proxyUrl.hostname = '127.0.0.1';
proxyUrl.port = String(await pooler.listen());
process.env.DATABASE_URL = proxyUrl.href;
process.env.API_KEYS = JSON.stringify({
  [KEY]: { org: 'pooler', project: 'fatal', role: 'app' },
});

// Collected by OUR listener so the assertion names the failure. vitest's own
// handler also sees these and fails the run; either one is enough.
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

/** Let node run its unhandled-rejection pass (it runs after each macrotask). */
async function drainRejections(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe('a pooler FATAL during a database outage', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.on('unhandledRejection', onUnhandled);
    const { buildServer } = await import('../server.js');
    app = await buildServer();
    await app.ready();
  });

  afterEach(() => {
    pooler.up();
  });

  afterAll(async () => {
    await app?.close();
    process.off('unhandledRejection', onUnhandled);
    // The shared pool must not hold a socket to the proxy we are closing.
    const { closeDb } = await import('./client.js');
    await closeDb();
    await pooler.close();
  });

  const ready = () => app.inject({ method: 'GET', url: '/health/ready' });
  const listCorpora = () =>
    app.inject({
      method: 'GET',
      url: '/v1/corpora',
      headers: { authorization: `Bearer ${KEY}` },
    });

  it('rejects the in-flight query as a 503, keeps the process alive, and recovers', async () => {
    // Baseline through the proxy: the pool is warm and healthy.
    expect((await ready()).statusCode).toBe(200);
    expect((await listCorpora()).statusCode).toBe(200);

    pooler.down();

    // Every request during the outage gets a clean 503. The first few may hit
    // pool connections that `down()` just cut (CONNECTION_CLOSED); once those
    // are gone the pool opens new connections, and each new one gets the
    // pooler FATAL. Keep asking until the FATAL path has been exercised: a
    // bounded COUNT, not a clock. The pool holds at most 10 connections.
    for (let i = 0; i < 25 && pooler.refusedLogins < 3; i++) {
      const res = await ready();
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ checks: { database: { ok: false } } });
    }
    expect(pooler.refusedLogins).toBeGreaterThanOrEqual(3);

    // The /v1 handler maps the same failure to a 503 with a generic body.
    const v1 = await listCorpora();
    expect(v1.statusCode).toBe(503);
    expect(v1.headers['retry-after']).toBe('1');
    expect(v1.json()).toEqual({
      statusCode: 503,
      error: 'Service Unavailable',
      message: 'database unavailable',
    });

    await drainRejections();
    expect(unhandled).toEqual([]);

    // Postgres is back: the same process serves again without a restart.
    pooler.up();
    expect((await ready()).statusCode).toBe(200);
    expect((await listCorpora()).statusCode).toBe(200);

    await drainRejections();
    expect(unhandled).toEqual([]);
  });
});
