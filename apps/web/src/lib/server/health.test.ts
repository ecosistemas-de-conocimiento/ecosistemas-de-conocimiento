import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `backendUrl()` reads `$env/dynamic/private`, which resolves once and cannot
// be mutated from a test. Mock the module instead — the same approach
// `routes/api/sessions/[id]/documents/server.test.ts` uses.
vi.mock('$lib/server/auth', () => ({
  backendUrl: () => 'http://backend.test:3002',
}));

import {
  PROBE_ERROR,
  __resetHealthStateForTests,
  getReadiness,
  sanitizeUpstreamChecks,
  type FetchLike,
} from './health';

/** A fetch stub returning a JSON body with the given HTTP status. */
function jsonFetch(status: number, body: unknown): FetchLike {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as FetchLike;
}

/** A fetch stub that rejects the way Node's undici does for transport errors. */
function throwingFetch(err: unknown): FetchLike {
  return vi.fn(async () => {
    throw err;
  }) as unknown as FetchLike;
}

function networkError(code: string): Error {
  const err = new TypeError('fetch failed');
  (err as unknown as { cause: { code: string } }).cause = { code };
  return err;
}

/** Move past the 5s cache so the next call performs a real probe. */
function expireCache() {
  vi.advanceTimersByTime(6_000);
}

beforeEach(() => {
  vi.useFakeTimers();
  __resetHealthStateForTests();
  // The module logs full errors to console.error by design; keep test output
  // readable while still asserting on it where it matters.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('getReadiness — healthy backend', () => {
  it('reports ok/200-shape and surfaces the backend checks as upstream', async () => {
    const fetchImpl = jsonFetch(200, {
      status: 'ok',
      checks: { database: { status: 'ok', ms: 3 }, storage: { status: 'ok', ms: 8 } },
    });

    const report = await getReadiness(fetchImpl);

    expect(report.status).toBe('ok');
    expect(report.service).toBe('chat');
    expect(report.checks.backend.status).toBe('ok');
    // A healthy probe carries no error and no failure count.
    expect(report.checks.backend.error).toBeUndefined();
    expect(report.checks.backend.consecutiveFailures).toBeUndefined();
    expect(report.upstream).toEqual({
      database: { status: 'ok', ms: 3 },
      storage: { status: 'ok', ms: 8 },
    });
  });

  it('probes the backend READINESS route, never its liveness constant', async () => {
    // Rule 4b: a dependency's own liveness route is not evidence it works.
    const fetchImpl = jsonFetch(200, { status: 'ok', checks: {} });
    await getReadiness(fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://backend.test:3002/api/health/ready',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('gives the probe an abort signal so readiness cannot hang', async () => {
    const fetchImpl = jsonFetch(200, { status: 'ok', checks: {} });
    await getReadiness(fetchImpl);

    const init = (fetchImpl as unknown as { mock: { calls: [string, { signal: AbortSignal }][] } })
      .mock.calls[0]?.[1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('Rule 1 — two states only, no degraded', () => {
  it('never emits a status other than ok or down', async () => {
    const fetchImpl = jsonFetch(503, {
      status: 'down',
      checks: { database: { status: 'down', ms: 900 } },
    });

    await getReadiness(fetchImpl);
    expireCache();
    const report = await getReadiness(fetchImpl);

    expect(report.status).toBe('down');
    expect(JSON.stringify(report)).not.toContain('degraded');
  });

  it('marks us down when the backend is 200 but reports a check down', async () => {
    // Belt and braces: a contract-compliant backend pairs down with 503, but
    // we must not depend on it having done so.
    const fetchImpl = jsonFetch(200, {
      status: 'ok',
      checks: { 'ai-service': { status: 'down', ms: 12 } },
    });

    await getReadiness(fetchImpl);
    expireCache();
    const report = await getReadiness(fetchImpl);

    expect(report.status).toBe('down');
    expect(report.checks.backend.error).toBe(PROBE_ERROR.UPSTREAM_DOWN);
  });
});

describe('🔴 redaction — the body carries a closed vocabulary only', () => {
  it('never echoes an upstream error string into our body', async () => {
    // The exact class of leak this guards against: Postgres emits this via the
    // backend's own health body, and this route is UNAUTHENTICATED.
    const secret = 'password authentication failed for user "chat"';
    const fetchImpl = jsonFetch(503, {
      status: 'down',
      checks: { database: { status: 'down', ms: 900, error: secret } },
    });

    await getReadiness(fetchImpl);
    expireCache();
    const report = await getReadiness(fetchImpl);

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('password');
    // The check NAME survives, so a monitor still learns which dep broke.
    expect(report.upstream?.database).toEqual({
      status: 'down',
      ms: 900,
      error: PROBE_ERROR.UPSTREAM_REPORTED_ERROR,
    });
  });

  it('never echoes a thrown exception message into our body', async () => {
    const secret = 'connect ECONNREFUSED 10.0.0.5:3002 postgres://user:hunter2@db';
    const fetchImpl = throwingFetch(new Error(secret));

    await getReadiness(fetchImpl);
    expireCache();
    const report = await getReadiness(fetchImpl);

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('10.0.0.5');
    expect(report.checks.backend.error).toBe(PROBE_ERROR.UNREACHABLE);
  });

  it('logs the error server-side even though it redacts the body', async () => {
    const err = new Error('probe detail');
    const fetchImpl = throwingFetch(err);

    await getReadiness(fetchImpl);

    // Its log-safe form (P-07): type, code, and the message only when safe.
    expect(console.error).toHaveBeenCalledWith(
      '[health] the backend readiness probe failed',
      'Error: probe detail',
    );
  });
});

describe('error classification — closed token set', () => {
  const cases: [string, unknown, string][] = [
    ['timeout', Object.assign(new Error('aborted'), { name: 'TimeoutError' }), PROBE_ERROR.TIMEOUT],
    ['abort', Object.assign(new Error('aborted'), { name: 'AbortError' }), PROBE_ERROR.TIMEOUT],
    ['ETIMEDOUT', networkError('ETIMEDOUT'), PROBE_ERROR.TIMEOUT],
    ['ECONNREFUSED', networkError('ECONNREFUSED'), PROBE_ERROR.REFUSED],
    ['ENOTFOUND', networkError('ENOTFOUND'), PROBE_ERROR.DNS],
    ['ECONNRESET', networkError('ECONNRESET'), PROBE_ERROR.RESET],
    ['unknown code', networkError('ESOMETHINGNEW'), PROBE_ERROR.UNREACHABLE],
  ];

  for (const [label, err, expected] of cases) {
    it(`maps ${label} to "${expected}"`, async () => {
      const fetchImpl = throwingFetch(err);
      await getReadiness(fetchImpl);
      expireCache();
      const report = await getReadiness(fetchImpl);
      expect(report.checks.backend.error).toBe(expected);
    });
  }

  it('reports an HTTP status as http_<code>', async () => {
    // This is today's real case: the backend has no /api/health/ready yet.
    const fetchImpl = jsonFetch(404, {});
    await getReadiness(fetchImpl);
    expireCache();
    const report = await getReadiness(fetchImpl);
    expect(report.checks.backend.error).toBe('http_404');
  });

  it('reports a non-JSON 200 as bad_response', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('<!doctype html><h1>hi</h1>', { status: 200 }),
    ) as unknown as FetchLike;
    await getReadiness(fetchImpl);
    expireCache();
    const report = await getReadiness(fetchImpl);
    expect(report.checks.backend.error).toBe(PROBE_ERROR.BAD_RESPONSE);
  });
});

describe('Rule 4c — down only after 2 consecutive failures', () => {
  it('stays ok on the first failure but reports the error and the count', async () => {
    const fetchImpl = throwingFetch(networkError('ECONNREFUSED'));

    const report = await getReadiness(fetchImpl);

    // The deliberate "visible lying window": not yet down, but not silent.
    expect(report.status).toBe('ok');
    expect(report.checks.backend.status).toBe('ok');
    expect(report.checks.backend.error).toBe(PROBE_ERROR.REFUSED);
    expect(report.checks.backend.consecutiveFailures).toBe(1);
  });

  it('flips to down on the second consecutive failure', async () => {
    const fetchImpl = throwingFetch(networkError('ECONNREFUSED'));

    await getReadiness(fetchImpl);
    expireCache();
    const report = await getReadiness(fetchImpl);

    expect(report.status).toBe('down');
    expect(report.checks.backend.consecutiveFailures).toBe(2);
  });

  it('resets the counter on a success, so a blip cannot accumulate', async () => {
    const failing = throwingFetch(networkError('ECONNREFUSED'));
    const healthy = jsonFetch(200, { status: 'ok', checks: {} });

    await getReadiness(failing); // 1st failure
    expireCache();
    await getReadiness(healthy); // recovers → counter resets
    expireCache();
    const report = await getReadiness(failing); // failure again, but the 1st

    expect(report.status).toBe('ok');
    expect(report.checks.backend.consecutiveFailures).toBe(1);
  });
});

describe('Rule 4c / Rule 5 — caching keeps probes cheap', () => {
  it('serves a cached report inside the 5s window without re-probing', async () => {
    const fetchImpl = jsonFetch(200, { status: 'ok', checks: {} });

    await getReadiness(fetchImpl);
    vi.advanceTimersByTime(1_000);
    await getReadiness(fetchImpl);
    vi.advanceTimersByTime(1_000);
    await getReadiness(fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('re-probes once the cache expires', async () => {
    const fetchImpl = jsonFetch(200, { status: 'ok', checks: {} });

    await getReadiness(fetchImpl);
    expireCache();
    await getReadiness(fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('collapses concurrent cache misses into one probe', async () => {
    // Without this, a burst of probes at one outage instant would jump the
    // consecutive-failure counter straight past the two-strike tolerance.
    const fetchImpl = throwingFetch(networkError('ECONNREFUSED'));

    const [a, b, c] = await Promise.all([
      getReadiness(fetchImpl),
      getReadiness(fetchImpl),
      getReadiness(fetchImpl),
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(a.checks.backend.consecutiveFailures).toBe(1);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });
});

describe('sanitizeUpstreamChecks', () => {
  it('coerces any non-ok status to down — Rule 1 fails closed', () => {
    // `degraded` is the state Rule 1 abolished; an upstream still emitting it
    // must read as down here, never as ok.
    const out = sanitizeUpstreamChecks({
      a: { status: 'degraded' },
      b: { status: 'ok' },
      c: {},
    });
    expect(out).toEqual({
      a: { status: 'down' },
      b: { status: 'ok' },
      c: { status: 'down' },
    });
  });

  it('drops non-identifier check names and non-numeric ms', () => {
    const out = sanitizeUpstreamChecks({
      'db; DROP TABLE users': { status: 'ok' },
      '<script>': { status: 'ok' },
      database: { status: 'ok', ms: 'not-a-number' },
    });
    expect(out).toEqual({ database: { status: 'ok' } });
  });

  it('caps how many upstream checks it will echo', () => {
    const raw: Record<string, unknown> = {};
    for (let i = 0; i < 50; i += 1) raw[`check${i}`] = { status: 'ok' };
    expect(Object.keys(sanitizeUpstreamChecks(raw)).length).toBe(20);
  });

  it('returns an empty object for junk input', () => {
    expect(sanitizeUpstreamChecks(null)).toEqual({});
    expect(sanitizeUpstreamChecks('nope')).toEqual({});
    expect(sanitizeUpstreamChecks([{ status: 'ok' }])).toEqual({});
  });
});
