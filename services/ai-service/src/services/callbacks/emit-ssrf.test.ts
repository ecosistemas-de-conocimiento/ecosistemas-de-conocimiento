// Delivery-time SSRF enforcement in `attemptDelivery` (audit finding [HIGH]
// SSRF, commits "sec(ssrf-callback)").
//
// The guard must re-validate the target URL immediately before EVERY fetch —
// this covers URLs sourced from `project_configs.callback_url` and catches a
// row that was enqueued before the guard existed (or a DNS answer that changed
// since enqueue). The observable effects asserted here:
//   1. the fetcher is NEVER invoked for a blocked URL, and
//   2. the row is marked terminally 'failed' (no retry budget burned on it).
//
// Mutation check: remove the `assertSafeCallbackUrl` call from
// `attemptDelivery` → the fetcher fires at the internal address and the row
// goes 'delivered' → RED.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../../db/client.js';
import { env, type ApiKeyEntry } from '../../config/env.js';
import { deriveApiKeyId } from '../../plugins/auth.js';
import { attemptDelivery, __resetCallbackSecretCache } from './emit.js';

// --- Callback-secret fixture (same pattern as emit.test.ts) -------------- //

const RAW_KEY = 'emit-ssrf-test-key';
const TEST_API_KEY_ID = deriveApiKeyId(RAW_KEY);
const SECRET = 'ssrf-test-callback-secret-32-chars-x';

beforeEach(() => {
  (env.API_KEYS as Record<string, ApiKeyEntry>)[RAW_KEY] = {
    org: 'test-org',
    project: 'test-project',
    role: 'app',
    callbackSecret: SECRET,
  };
  __resetCallbackSecretCache();
});

afterEach(() => {
  delete (env.API_KEYS as Record<string, ApiKeyEntry>)[RAW_KEY];
  (env as { CALLBACK_ALLOW_PRIVATE: boolean }).CALLBACK_ALLOW_PRIVATE = false;
  __resetCallbackSecretCache();
  vi.clearAllMocks();
});

// --- Minimal delivery-row + db stub (mirrors emit.test.ts) ---------------- //

type FakeRow = Record<string, unknown>;

function makeRow(url: string): FakeRow {
  return {
    id: 'd-ssrf-1',
    status: 'pending',
    attempt: 0,
    url,
    apiKeyId: TEST_API_KEY_ID,
    signedAtUnix: 1_700_000_000,
    signature: 'deadbeef',
    body: '{"event":"unit.completed","emittedAt":"x"}',
    event: 'unit.completed',
    nextAttemptAt: new Date(),
    responseStatus: null,
    responseBodyExcerpt: null,
    lastError: null,
    lastAttemptAt: null,
  };
}

function makeStubDb(row: FakeRow): { db: Db; updates: Array<Partial<FakeRow>> } {
  const updates: Array<Partial<FakeRow>> = [];
  const stub = {
    select() {
      return {
        from() {
          return { where: () => ({ limit: async () => [row] }) };
        },
      };
    },
    update() {
      return {
        set(values: Partial<FakeRow>) {
          updates.push(values);
          Object.assign(row, values);
          return { where: async () => undefined };
        },
      };
    },
  };
  return { db: stub as unknown as Db, updates };
}

async function attempt(url: string) {
  const row = makeRow(url);
  const { db, updates } = makeStubDb(row);
  const fetcher = vi.fn(async () => new Response('ok', { status: 200 }));
  await attemptDelivery('d-ssrf-1', {
    db,
    fetcher: fetcher as unknown as typeof fetch,
    clock: () => new Date(),
  });
  return { fetcher, updates };
}

describe('attemptDelivery — SSRF guard runs before every fetch', () => {
  it('metadata endpoint: no fetch, row terminally failed', async () => {
    const { fetcher, updates } = await attempt('http://169.254.169.254/latest/meta-data/');
    expect(fetcher).not.toHaveBeenCalled();
    expect(updates.at(-1)?.status).toBe('failed');
    expect(updates.at(-1)?.nextAttemptAt).toBeNull(); // no retry budget burned
    expect(updates.at(-1)?.lastError).toBe('callback url blocked (ssrf guard)');
  });

  it('loopback: no fetch, row terminally failed', async () => {
    const { fetcher, updates } = await attempt('http://127.0.0.1:8080/cb');
    expect(fetcher).not.toHaveBeenCalled();
    expect(updates.at(-1)?.status).toBe('failed');
  });

  it('private range via IPv4-mapped IPv6: no fetch, row terminally failed', async () => {
    // The mapped-bypass case the IPv6-group parser fix closes: reverting that
    // parser lets `::ffff:c0a8:7` (192.168.0.7) through → fetch fires → RED.
    const { fetcher, updates } = await attempt('http://[::ffff:192.168.0.7]/cb');
    expect(fetcher).not.toHaveBeenCalled();
    expect(updates.at(-1)?.status).toBe('failed');
  });

  it('control: a public target is fetched and delivered', async () => {
    const { fetcher, updates } = await attempt('http://203.0.113.9:1/cb');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(updates.at(-1)?.status).toBe('delivered');
  });

  it('CALLBACK_ALLOW_PRIVATE=1: a docker-network target is delivered again', async () => {
    // The local stack addresses consumers by service name on a bridge network,
    // so every delivery target lands in 172.16/12. Without the switch the whole
    // local async surface dead-letters.
    (env as { CALLBACK_ALLOW_PRIVATE: boolean }).CALLBACK_ALLOW_PRIVATE = true;
    const { fetcher, updates } = await attempt('http://172.18.0.4:3003/cb');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(updates.at(-1)?.status).toBe('delivered');
  });

  it('CALLBACK_ALLOW_PRIVATE=1 still blocks the metadata endpoint', async () => {
    (env as { CALLBACK_ALLOW_PRIVATE: boolean }).CALLBACK_ALLOW_PRIVATE = true;
    const { fetcher, updates } = await attempt('http://169.254.169.254/latest/meta-data/');
    expect(fetcher).not.toHaveBeenCalled();
    expect(updates.at(-1)?.status).toBe('failed');
  });
});
