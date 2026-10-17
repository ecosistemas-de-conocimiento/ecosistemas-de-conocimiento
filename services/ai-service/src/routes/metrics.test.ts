// Wire-level checks for `GET /metrics`.
//
// Three things are being pinned, and they fail in three different ways:
//   1. WHO CAN READ IT. The default is loopback-only, and the allowlist reads
//      the SOCKET peer — a request that merely CLAIMS to be loopback via
//      `X-Forwarded-For` must still be refused. `trustProxy: true` makes
//      `req.ip` that claim, so this is the difference between a control and a
//      decoration.
//   2. WHAT IT CONTAINS. Anything registered on the shared registry — the
//      route histogram, the BullMQ stall counter, and the LLM/budget counters
//      another lane adds in `src/metrics/llm.ts` — must appear with no wiring.
//   3. WHERE IT IS MOUNTED. Outside the /v1 rate limiter, so a scraper polling
//      every 15 s can never 429 a tenant.
//
// SABOTAGE (all measured):
//   delete the route from server.ts        → RED (404 everywhere)
//   drop `metricsAccess` from the handler  → RED (403/401 cases return 200)
//   allowlist `req.ip` instead of the peer → RED (the X-Forwarded-For case)
//   give the plugin its own prom client    → RED (registered counter missing)

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { client, registry } from '../metrics/registry.js';
import { V1_DEFAULT_RATE_LIMIT_MAX } from '../server-limits.js';
import { isLoopbackPeer } from './metrics.js';

async function makeApp() {
  // Imported lazily so env validation runs against the test env.
  const { buildServer } = await import('../server.js');
  return buildServer();
}

const TOKEN_VAR = 'METRICS_TOKEN';
let savedToken: string | undefined;

beforeEach(() => {
  savedToken = process.env[TOKEN_VAR];
  delete process.env[TOKEN_VAR];
});

afterEach(() => {
  if (savedToken === undefined) delete process.env[TOKEN_VAR];
  else process.env[TOKEN_VAR] = savedToken;
});

describe('isLoopbackPeer', () => {
  it('accepts only the loopback forms node actually reports', () => {
    for (const ok of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.53']) {
      expect(isLoopbackPeer(ok), ok).toBe(true);
    }
    // 🔴 RFC1918 IS NOT ALLOWED, DELIBERATELY. Behind Traefik on a Coolify
    // docker network the peer of EVERY internet request is a private address,
    // so a private-range allowlist would read like a firewall and admit the
    // whole internet. See the header of `routes/metrics.ts`.
    for (const no of ['10.0.0.5', '172.17.0.1', '192.168.1.9', '::ffff:10.0.0.5', '', undefined]) {
      expect(isLoopbackPeer(no), String(no)).toBe(false);
    }
  });
});

describe('GET /metrics access control, METRICS_TOKEN unset', () => {
  it('serves a prometheus body to a loopback peer, with no bearer token', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.body).toContain('# HELP');
    await app.close();
  });

  it('refuses a non-loopback peer with 403', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
      remoteAddress: '10.0.0.5',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'forbidden' });
    await app.close();
  });

  it('is NOT fooled by an X-Forwarded-For claiming to be loopback', async () => {
    // 🔴 THE LOAD-BEARING CASE. The server runs `trustProxy: true`, so `req.ip`
    // is the leftmost X-Forwarded-For entry — written by the caller. An
    // allowlist on `req.ip` would hand /metrics to anyone who can type a
    // header. The handler reads `req.socket.remoteAddress` for exactly this.
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
      remoteAddress: '10.0.0.5',
      headers: { 'x-forwarded-for': '127.0.0.1' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe('GET /metrics access control, METRICS_TOKEN set', () => {
  it('requires the bearer token even from loopback, and accepts it from anywhere', async () => {
    process.env[TOKEN_VAR] = 'scrape-me-please-0123456789';
    const app = await makeApp();

    // Loopback no longer opens the door: configuring a token means the token
    // IS the rule, so a compromised sidecar on the same box is not a bypass.
    const bare = await app.inject({ method: 'GET', url: '/metrics' });
    expect(bare.statusCode).toBe(401);
    expect(bare.headers['www-authenticate']).toContain('Bearer');

    const wrong = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer nope' },
    });
    expect(wrong.statusCode).toBe(401);

    // ...and a remote scraper WITH the token is served.
    const ok = await app.inject({
      method: 'GET',
      url: '/metrics',
      remoteAddress: '10.0.0.5',
      headers: { authorization: 'Bearer scrape-me-please-0123456789' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('# HELP');

    await app.close();
  });

  it('treats a blank METRICS_TOKEN as unset', async () => {
    // Coolify hands a declared-but-empty variable through as ''. If '' counted
    // as a token, `Authorization: Bearer ` would be the credential.
    process.env[TOKEN_VAR] = '   ';
    const app = await makeApp();
    const loopback = await app.inject({ method: 'GET', url: '/metrics' });
    expect(loopback.statusCode).toBe(200);
    const remote = await app.inject({
      method: 'GET',
      url: '/metrics',
      remoteAddress: '10.0.0.5',
      headers: { authorization: 'Bearer ' },
    });
    expect(remote.statusCode).toBe(403);
    await app.close();
  });
});

describe('what the scrape contains', () => {
  it('exposes any counter registered on the shared registry, with no wiring', async () => {
    // 🔴 THIS IS THE CONTRACT WITH `src/metrics/llm.ts` (another lane): declare
    // a metric on the registry that `src/metrics/registry.ts` exports and it
    // appears here. Nothing registers it with the route; there is one registry.
    const name = `ai_test_counter_${Date.now()}`;
    const counter = new client.Counter({
      name,
      help: 'probe counter for the metrics route test',
      labelNames: ['kind'] as const,
      registers: [registry],
    });
    counter.inc({ kind: 'probe' }, 3);

    try {
      const app = await makeApp();
      const res = await app.inject({ method: 'GET', url: '/metrics' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(`${name}{kind="probe"} 3`);
      await app.close();
    } finally {
      registry.removeSingleMetric(name);
    }
  });

  it('counts the BullMQ stall the worker lifecycle logger reports', async () => {
    const { attachWorkerLifecycleLogging } = await import('../queue/queues.js');

    // 🔴 A DELTA, NOT AN ABSOLUTE. `registry` is process-wide and shared by
    // every file in the run, so `… 1` is an assertion about test ORDER as much
    // as about the counter: anything that stalls this queue label first, now or
    // later, turns it red without a defect. Read before, read after, assert the
    // difference — that holds whatever ran already.
    const stalls = async (app: Awaited<ReturnType<typeof makeApp>>): Promise<number> => {
      const res = await app.inject({ method: 'GET', url: '/metrics' });
      const line = res.body
        .split('\n')
        .find((l) => l.startsWith('ai_bullmq_stalled_total{queue="metrics-test-queue"}'));
      // Absent = zero: prom-client emits no line for a label set never touched.
      return line ? Number(line.split(' ').at(-1)) : 0;
    };

    // A minimal `on`-only stand-in for a BullMQ Worker, which is all
    // `attachWorkerLifecycleLogging` takes.
    const handlers = new Map<string, (...args: unknown[]) => void>();
    attachWorkerLifecycleLogging(
      {
        on(event: string, listener: (...args: unknown[]) => void) {
          handlers.set(event, listener);
          return undefined;
        },
      } as never,
      'metrics-test-queue',
    );
    const app = await makeApp();
    try {
      const before = await stalls(app);
      handlers.get('stalled')?.('job-1', 'active');
      expect(await stalls(app), 'the stall listener did not move the counter').toBe(before + 1);
    } finally {
      await app.close();
    }
  });

  it('times real routes but not the scrape itself', async () => {
    const app = await makeApp();
    // Drive one authenticated route so the histogram has something in it...
    await app.inject({ method: 'GET', url: '/v1/', headers: { authorization: 'Bearer test-key' } });
    await app.inject({ method: 'GET', url: '/metrics' });

    const res = await app.inject({ method: 'GET', url: '/metrics' });
    // ANTI-VACUITY: route metrics are actually being collected...
    expect(res.body).toContain('http_request_duration_seconds');
    expect(res.body).toMatch(/http_request_duration_seconds_count\{[^}]*route="\/v1\/"/);
    // ...and the scrape is not timing itself. Left in, it is the most frequent
    // request on a quiet box and dominates any latency read off this metric.
    expect(res.body).not.toContain('route="/metrics"');
    await app.close();
  });
});

describe('where /metrics is mounted', () => {
  it('answers past the /v1 cap — a scraper cannot spend a tenant bucket', async () => {
    const app = await makeApp();

    const overCap = V1_DEFAULT_RATE_LIMIT_MAX + 50;
    for (let i = 0; i < overCap; i += 1) {
      const res = await app.inject({ method: 'GET', url: '/metrics' });
      expect(res.statusCode, `scrape ${i + 1}`).toBe(200);
    }

    // Contrast, so the loop above is a real gate and not an inert limiter:
    // the same instance DOES cap an authenticated /v1 route.
    const auth = { authorization: 'Bearer test-key' };
    let capped = false;
    for (let i = 0; i < overCap; i += 1) {
      const res = await app.inject({ method: 'GET', url: '/v1/', headers: auth });
      if (res.statusCode === 429) {
        capped = true;
        break;
      }
    }
    expect(capped, '/v1 should be rate limited').toBe(true);

    const after = await app.inject({ method: 'GET', url: '/metrics' });
    expect(after.statusCode).toBe(200);

    await app.close();
  });
});
