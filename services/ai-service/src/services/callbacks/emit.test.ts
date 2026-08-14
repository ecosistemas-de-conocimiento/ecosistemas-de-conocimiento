// Unit tests for the callback emitter.
//
// Covers:
//   - HMAC signing byte-fidelity (the contract's #1 pitfall: sign the exact
//     bytes you'll send, never re-serialise).
//   - Retry schedule on 5xx / network errors (the contract's t+0 / +5s / +30s
//     / +2m / +10m / dead-letter).
//   - Terminal status transitions (2xx → delivered, 401 → auth_failed,
//     4xx other → failed, 5xx → pending until exhaust → dead_letter).

import { createHmac } from 'node:crypto';

import { drizzle } from 'drizzle-orm/postgres-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../../db/client.js';
import { callbackDeliveries } from '../../db/schema/index.js';
import { env, type ApiKeyEntry } from '../../config/env.js';
import { deriveApiKeyId } from '../../plugins/auth.js';
import {
  attemptDelivery,
  maybeMarkProgress,
  signBody,
  signEnvelope,
  __resetCallbackSecretCache,
  RETRY_SCHEDULE_MS,
  MAX_ATTEMPTS,
} from './emit.js';

// ---------------------------------------------------------------------------
// Shared callback-secret fixture.
//
// `attemptDelivery` re-derives the secret from `env.API_KEYS` on every attempt,
// so the delivery rows in these tests carry a real `apiKeyId` whose fingerprint
// resolves to `SECRET_V1` unless a test rotates it.
// ---------------------------------------------------------------------------

const RAW_KEY = 'callback-resign-test-key';
const TEST_API_KEY_ID = deriveApiKeyId(RAW_KEY);
const SECRET_V1 = 'v1-callback-secret-at-least-32-chars';
const SECRET_V2 = 'v2-callback-secret-at-least-32-chars';

function installCallbackSecret(secret: string | undefined): void {
  (env.API_KEYS as Record<string, ApiKeyEntry>)[RAW_KEY] = {
    org: 'test-org',
    project: 'test-project',
    role: 'app',
    ...(secret ? { callbackSecret: secret } : {}),
  };
  __resetCallbackSecretCache();
}

function removeCallbackKey(): void {
  delete (env.API_KEYS as Record<string, ApiKeyEntry>)[RAW_KEY];
  __resetCallbackSecretCache();
}

beforeEach(() => {
  installCallbackSecret(SECRET_V1);
});

afterEach(() => {
  removeCallbackKey();
  vi.useRealTimers();
});

describe('signEnvelope', () => {
  const secret = 'super-secret-32-chars-long-secret-x';
  const now = new Date('2026-05-18T03:25:00.000Z');

  it('signs the exact JSON.stringify bytes (byte-fidelity)', () => {
    const envelope = {
      event: 'unit.completed' as const,
      emittedAt: '2026-05-18T03:25:00Z',
      requestId: 'req-1',
      clientRequestId: null,
      unitKey: 'k',
      unitType: null,
      output: { text: 'hi', structured: null, flags: [] },
      costUsd: 0.001,
      durationMs: 100,
      modelUsed: 'anthropic/claude-3.5-haiku',
      traceId: 't',
      registryEntryId: null,
    };
    const signed = signEnvelope(envelope, secret, now);
    // The body MUST be the exact JSON.stringify of the envelope — anything else
    // would fail the receiver's HMAC verify.
    expect(signed.body).toBe(JSON.stringify(envelope));
    // The signature is HMAC-SHA256 over `${ts}.${body}` — recompute to verify.
    const expected = createHmac('sha256', secret)
      .update(`${signed.signedAtUnix}.${signed.body}`)
      .digest('hex');
    expect(signed.signature).toBe(expected);
    expect(signed.headers['X-AIService-Timestamp']).toBe(String(signed.signedAtUnix));
    expect(signed.headers['X-AIService-Signature']).toBe(expected);
    expect(signed.headers['X-AIService-Event']).toBe('unit.completed');
  });

  it('signedAtUnix is Math.floor(now / 1000)', () => {
    const signed = signEnvelope(
      { event: 'unit.failed' as const, emittedAt: 'x' },
      secret,
      new Date('2026-05-18T03:25:00.500Z'),
    );
    expect(signed.signedAtUnix).toBe(Math.floor(new Date('2026-05-18T03:25:00.500Z').getTime() / 1000));
  });

  it('a different envelope produces a different signature', () => {
    const s1 = signEnvelope({ event: 'unit.completed' as const, emittedAt: 'x' }, secret, now);
    const s2 = signEnvelope({ event: 'unit.completed' as const, emittedAt: 'y' }, secret, now);
    expect(s1.signature).not.toBe(s2.signature);
  });

  it('a different secret produces a different signature', () => {
    const s1 = signEnvelope({ event: 'unit.completed' as const, emittedAt: 'x' }, secret, now);
    const s2 = signEnvelope(
      { event: 'unit.completed' as const, emittedAt: 'x' },
      'another-32-char-secret-aaaaaaaaaaa',
      now,
    );
    expect(s1.signature).not.toBe(s2.signature);
  });
});

describe('retry schedule', () => {
  it('has 5 attempts at t+0/+5s/+30s/+2m/+10m', () => {
    expect(MAX_ATTEMPTS).toBe(5);
    expect(RETRY_SCHEDULE_MS).toEqual([0, 5_000, 30_000, 120_000, 600_000]);
  });
});

// ---------------------------------------------------------------------------
// attemptDelivery — terminal state transitions
// ---------------------------------------------------------------------------

interface FakeRow {
  id: string;
  status: 'pending' | 'delivered' | 'failed' | 'auth_failed' | 'dead_letter';
  attempt: number;
  url: string;
  apiKeyId: string | null;
  signedAtUnix: number;
  signature: string;
  body: string;
  event: string;
  nextAttemptAt: Date | null;
  responseStatus: number | null;
  responseBodyExcerpt: string | null;
  lastError: string | null;
  lastAttemptAt: Date | null;
}

function makeRow(over: Partial<FakeRow> = {}): FakeRow {
  return {
    id: 'd-1',
    status: 'pending',
    attempt: 0,
    url: 'http://localhost:1',
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
    ...over,
  };
}

function makeStubDb(row: FakeRow): {
  db: Db;
  updates: Array<Partial<FakeRow>>;
} {
  const updates: Array<Partial<FakeRow>> = [];
  const stub = {
    select() {
      return {
        from(_t: unknown) {
          return {
            where(_c: unknown) {
              return {
                limit: async () => [row],
              };
            },
          };
        },
      };
    },
    update(_t: unknown) {
      return {
        set(values: Partial<FakeRow>) {
          updates.push(values);
          // Mutate the in-memory row so a subsequent attemptDelivery sees fresh state.
          Object.assign(row, values);
          return {
            where: async () => undefined,
          };
        },
      };
    },
  };
  // Satisfy the lint by referencing the schema import we need at runtime.
  void callbackDeliveries;
  return { db: stub as unknown as Db, updates };
}

describe('attemptDelivery', () => {
  it('200 → delivered, no retry scheduled', async () => {
    const row = makeRow();
    const { db, updates } = makeStubDb(row);
    const fetcher = vi.fn(async () => new Response('ok', { status: 200 }));
    await attemptDelivery('d-1', { db, fetcher: fetcher as unknown as typeof fetch, clock: () => new Date() });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(updates.at(-1)?.status).toBe('delivered');
    expect(updates.at(-1)?.nextAttemptAt).toBeNull();
  });

  it('401 → auth_failed, no retry', async () => {
    const row = makeRow();
    const { db, updates } = makeStubDb(row);
    const fetcher = vi.fn(async () => new Response('nope', { status: 401 }));
    await attemptDelivery('d-1', { db, fetcher: fetcher as unknown as typeof fetch, clock: () => new Date() });
    expect(updates.at(-1)?.status).toBe('auth_failed');
  });

  it('404 → failed (permanent), no retry', async () => {
    const row = makeRow();
    const { db, updates } = makeStubDb(row);
    const fetcher = vi.fn(async () => new Response('nope', { status: 404 }));
    await attemptDelivery('d-1', { db, fetcher: fetcher as unknown as typeof fetch, clock: () => new Date() });
    expect(updates.at(-1)?.status).toBe('failed');
  });

  it('5xx → pending with nextAttemptAt set; exhausted → dead_letter', async () => {
    // Use a row already at MAX_ATTEMPTS - 1 attempts so the next 5xx hops to dead_letter.
    const row = makeRow({ attempt: MAX_ATTEMPTS - 1 });
    const { db, updates } = makeStubDb(row);
    const fetcher = vi.fn(async () => new Response('boom', { status: 503 }));
    await attemptDelivery('d-1', { db, fetcher: fetcher as unknown as typeof fetch, clock: () => new Date() });
    expect(updates.at(-1)?.status).toBe('dead_letter');
  });

  it('network error → pending until exhaust → dead_letter', async () => {
    const row = makeRow({ attempt: MAX_ATTEMPTS - 1 });
    const { db, updates } = makeStubDb(row);
    const fetcher = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await attemptDelivery('d-1', { db, fetcher: fetcher as unknown as typeof fetch, clock: () => new Date() });
    expect(updates.at(-1)?.status).toBe('dead_letter');
    expect(updates.at(-1)?.lastError).toBe('ECONNREFUSED');
  });

  it('5xx mid-schedule → pending, schedules a follow-up at the right offset', async () => {
    const row = makeRow({ attempt: 0 });
    const { db, updates } = makeStubDb(row);
    const fetcher = vi.fn(async () => new Response('boom', { status: 502 }));
    const fixed = new Date('2026-05-18T03:25:00.000Z');
    await attemptDelivery('d-1', { db, fetcher: fetcher as unknown as typeof fetch, clock: () => fixed });
    expect(updates.at(-1)?.status).toBe('pending');
    const next = updates.at(-1)?.nextAttemptAt as Date;
    expect(next.getTime() - fixed.getTime()).toBe(RETRY_SCHEDULE_MS[1]); // +5s
  });
});

// ---------------------------------------------------------------------------
// Per-attempt re-signing (fix)
//
// The bug: the timestamp + signature were minted ONCE at enqueue and replayed
// on every retry. The retry schedule spans 0 + 5s + 30s + 2m + 10m = 12m35s,
// so attempts 4 and 5 arrived with a timestamp far outside the contract's
// ±300s replay window — a conforming receiver 401s them, and ai-service maps
// 401 to a permanent `auth_failed`. The payload was lost precisely in the case
// retries exist for.
//
// The fix: re-derive the secret and re-sign the STORED BODY BYTES with a fresh
// timestamp before every attempt.
// ---------------------------------------------------------------------------

/** The contract's receiver-side skew check, verbatim (contract doc §Verifying). */
const RECEIVER_SKEW_WINDOW_S = 300;

interface CapturedCall {
  ts: number;
  signature: string;
  body: string;
  event: string;
  /** Wall clock (ms) at the moment the request was made. */
  atMs: number;
}

function capturingFetcher(
  calls: CapturedCall[],
  respond: () => Response,
): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    calls.push({
      ts: Number(headers['X-AIService-Timestamp']),
      signature: headers['X-AIService-Signature']!,
      body: init.body as string,
      event: headers['X-AIService-Event']!,
      atMs: Date.now(),
    });
    return respond();
  }) as unknown as typeof fetch;
}

/** Receiver-side verification, mirroring the contract doc's snippet. */
function receiverAccepts(
  call: CapturedCall,
  secret: string,
  nowMs: number,
  windowS = RECEIVER_SKEW_WINDOW_S,
): boolean {
  if (!Number.isFinite(call.ts)) return false;
  const skew = Math.abs(Math.floor(nowMs / 1000) - call.ts);
  if (skew > windowS) return false;
  const expected = createHmac('sha256', secret)
    .update(`${call.ts}.${call.body}`)
    .digest('hex');
  return expected === call.signature;
}

/** Drive the whole retry schedule by advancing fake timers attempt by attempt. */
async function runFullRetrySchedule(): Promise<void> {
  for (const delay of RETRY_SCHEDULE_MS.slice(1)) {
    await vi.advanceTimersByTimeAsync(delay);
  }
}

describe('signBody', () => {
  it('signs the string it is given, verbatim — no parse, no re-serialise', () => {
    // Deliberately awkward bytes: key order that JSON.parse/stringify would
    // reorder (numeric-looking keys sort first), plus a unicode escape.
    const body = '{"b":1,"2":"two","1":"one","a":"\\u00e1"}';
    const signed = signBody(body, SECRET_V1, new Date('2026-07-27T00:00:00Z'));
    expect(signed.body).toBe(body);
    expect(signed.body).not.toBe(JSON.stringify(JSON.parse(body)));
    expect(signed.signature).toBe(
      createHmac('sha256', SECRET_V1).update(`${signed.signedAtUnix}.${body}`).digest('hex'),
    );
  });

  it('same body + same secret at a later timestamp → different signature', () => {
    const body = '{"event":"unit.completed"}';
    const a = signBody(body, SECRET_V1, new Date('2026-07-27T00:00:00Z'));
    const b = signBody(body, SECRET_V1, new Date('2026-07-27T00:10:00Z'));
    expect(b.signedAtUnix).toBeGreaterThan(a.signedAtUnix);
    expect(b.signature).not.toBe(a.signature);
  });

  it('signEnvelope is signBody over JSON.stringify(envelope)', () => {
    const envelope = { event: 'unit.completed' as const, emittedAt: 'x', n: 1 };
    const now = new Date('2026-07-27T00:00:00Z');
    expect(signEnvelope(envelope, SECRET_V1, now).signature).toBe(
      signBody(JSON.stringify(envelope), SECRET_V1, now).signature,
    );
  });
});

describe('attemptDelivery — per-attempt re-signing', () => {
  const START = new Date('2026-07-27T00:00:00.000Z');
  const BODY = '{"event":"unit.completed","emittedAt":"2026-07-27T00:00:00Z","requestId":"req-1"}';
  /** 0 + 5s + 30s + 2m + 10m — the wall-clock offset of each attempt. */
  const ATTEMPT_OFFSETS_MS = [0, 5_000, 35_000, 155_000, 755_000];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });

  it('every one of the 5 attempts carries a fresh, valid signature', async () => {
    const row = makeRow({
      body: BODY,
      // Stamped at enqueue, as the emitter does.
      signedAtUnix: Math.floor(START.getTime() / 1000),
      signature: signBody(BODY, SECRET_V1, START).signature,
    });
    const { db } = makeStubDb(row);
    const calls: CapturedCall[] = [];
    const fetcher = capturingFetcher(calls, () => new Response('boom', { status: 503 }));

    await attemptDelivery('d-1', { db, fetcher, clock: () => new Date() });
    await runFullRetrySchedule();

    expect(calls).toHaveLength(MAX_ATTEMPTS);
    // Attempts land on the contract's schedule.
    expect(calls.map((c) => c.atMs - START.getTime())).toEqual(ATTEMPT_OFFSETS_MS);

    for (const [i, call] of calls.entries()) {
      // Signature verifies against the exact bytes + the timestamp sent.
      expect(
        createHmac('sha256', SECRET_V1).update(`${call.ts}.${call.body}`).digest('hex'),
        `attempt ${i + 1} signature`,
      ).toBe(call.signature);
      // Timestamp is this attempt's clock, not the enqueue clock.
      expect(call.ts, `attempt ${i + 1} timestamp`).toBe(Math.floor(call.atMs / 1000));
    }
    // Timestamps strictly advance across the schedule.
    for (let i = 1; i < calls.length; i += 1) {
      expect(calls[i]!.ts).toBeGreaterThan(calls[i - 1]!.ts);
    }
  });

  it('a receiver enforcing the documented 300s window accepts every attempt, including the last', async () => {
    const row = makeRow({ body: BODY });
    const { db } = makeStubDb(row);
    const calls: CapturedCall[] = [];
    const fetcher = capturingFetcher(calls, () => new Response('boom', { status: 503 }));

    await attemptDelivery('d-1', { db, fetcher, clock: () => new Date() });
    await runFullRetrySchedule();

    for (const [i, call] of calls.entries()) {
      expect(
        receiverAccepts(call, SECRET_V1, call.atMs),
        `attempt ${i + 1} rejected by a strict 300s receiver`,
      ).toBe(true);
    }

    // Regression guard: the final attempt is >300s after enqueue, so the OLD
    // behaviour (enqueue-time stamp replayed) would have been rejected here.
    const final = calls.at(-1)!;
    expect(final.atMs - START.getTime()).toBeGreaterThan(RECEIVER_SKEW_WINDOW_S * 1000);
    const enqueueStampedCall: CapturedCall = {
      ...final,
      ts: Math.floor(START.getTime() / 1000),
      signature: signBody(BODY, SECRET_V1, START).signature,
    };
    expect(receiverAccepts(enqueueStampedCall, SECRET_V1, final.atMs)).toBe(false);
  });

  it('the body bytes are byte-identical across all attempts', async () => {
    const row = makeRow({ body: BODY });
    const { db } = makeStubDb(row);
    const calls: CapturedCall[] = [];
    const fetcher = capturingFetcher(calls, () => new Response('boom', { status: 503 }));

    await attemptDelivery('d-1', { db, fetcher, clock: () => new Date() });
    await runFullRetrySchedule();

    for (const call of calls) {
      expect(call.body).toBe(BODY);
      expect(call.event).toBe(row.event);
    }
    expect(new Set(calls.map((c) => c.body)).size).toBe(1);
    // Only the two signature headers vary.
    expect(new Set(calls.map((c) => c.ts)).size).toBe(MAX_ATTEMPTS);
    expect(new Set(calls.map((c) => c.signature)).size).toBe(MAX_ATTEMPTS);
  });

  it('persists the fresh timestamp + signature on the row for each attempt', async () => {
    const row = makeRow({ body: BODY });
    const { db, updates } = makeStubDb(row);
    const calls: CapturedCall[] = [];
    const fetcher = capturingFetcher(calls, () => new Response('boom', { status: 503 }));

    await attemptDelivery('d-1', { db, fetcher, clock: () => new Date() });
    await runFullRetrySchedule();

    // One update per attempt, each recording exactly what went on the wire.
    const attemptUpdates = updates.filter((u) => u.signedAtUnix !== undefined);
    expect(attemptUpdates).toHaveLength(MAX_ATTEMPTS);
    for (const [i, update] of attemptUpdates.entries()) {
      expect(update.signedAtUnix).toBe(calls[i]!.ts);
      expect(update.signature).toBe(calls[i]!.signature);
      expect(update.body).toBeUndefined(); // body is never rewritten
    }
    // Final state reflects the last attempt.
    expect(row.signedAtUnix).toBe(calls.at(-1)!.ts);
    expect(row.signature).toBe(calls.at(-1)!.signature);
    expect(row.body).toBe(BODY);
    expect(updates.at(-1)?.status).toBe('dead_letter');
  });

  it('a secret rotated between attempts is picked up — later attempts sign with the NEW secret', async () => {
    const row = makeRow({ body: BODY });
    const { db } = makeStubDb(row);
    const calls: CapturedCall[] = [];
    const fetcher = capturingFetcher(calls, () => new Response('boom', { status: 503 }));

    await attemptDelivery('d-1', { db, fetcher, clock: () => new Date() });
    expect(calls).toHaveLength(1);

    // Operator rotates the consumer's callbackSecret mid-retry.
    installCallbackSecret(SECRET_V2);
    await runFullRetrySchedule();

    expect(calls).toHaveLength(MAX_ATTEMPTS);
    expect(receiverAccepts(calls[0]!, SECRET_V1, calls[0]!.atMs)).toBe(true);
    for (const call of calls.slice(1)) {
      expect(receiverAccepts(call, SECRET_V2, call.atMs)).toBe(true);
      expect(receiverAccepts(call, SECRET_V1, call.atMs)).toBe(false);
    }
  });

  it('a secret removed mid-retry → auth_failed with a precise reason, and no doomed request', async () => {
    const row = makeRow({ body: BODY });
    const { db, updates } = makeStubDb(row);
    const calls: CapturedCall[] = [];
    const fetcher = capturingFetcher(calls, () => new Response('boom', { status: 503 }));

    await attemptDelivery('d-1', { db, fetcher, clock: () => new Date() });
    expect(calls).toHaveLength(1);

    // The consumer's key is dropped from API_KEYS entirely.
    removeCallbackKey();
    await runFullRetrySchedule();

    expect(calls).toHaveLength(1); // no further requests sent
    expect(updates.at(-1)?.status).toBe('auth_failed');
    expect(updates.at(-1)?.lastError).toMatch(/no callbackSecret configured/);
    // The failed attempt is not counted as a delivery attempt.
    expect(updates.at(-1)?.attempt).toBeUndefined();
    expect(row.attempt).toBe(1);
  });

  it('a row with no apiKeyId cannot be re-signed → auth_failed, nothing sent', async () => {
    const row = makeRow({ body: BODY, apiKeyId: null });
    const { db, updates } = makeStubDb(row);
    const calls: CapturedCall[] = [];
    const fetcher = capturingFetcher(calls, () => new Response('ok', { status: 200 }));

    await attemptDelivery('d-1', { db, fetcher, clock: () => new Date() });

    expect(calls).toHaveLength(0);
    expect(updates.at(-1)?.status).toBe('auth_failed');
    expect(updates.at(-1)?.lastError).toMatch(/no apiKeyId/);
  });

  it('preserveSignature sends the stored timestamp + signature untouched (admin replay, resign:false)', async () => {
    const stored = signBody(BODY, SECRET_V1, new Date('2026-07-26T00:00:00Z'));
    const row = makeRow({
      body: BODY,
      signedAtUnix: stored.signedAtUnix,
      signature: stored.signature,
    });
    const { db, updates } = makeStubDb(row);
    const calls: CapturedCall[] = [];
    const fetcher = capturingFetcher(calls, () => new Response('ok', { status: 200 }));

    await attemptDelivery('d-1', {
      db,
      fetcher,
      clock: () => new Date(),
      preserveSignature: true,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.ts).toBe(stored.signedAtUnix);
    expect(calls[0]!.signature).toBe(stored.signature);
    // Nothing re-persisted for the signature columns.
    expect(updates.at(-1)?.signedAtUnix).toBeUndefined();
    expect(updates.at(-1)?.signature).toBeUndefined();
    expect(updates.at(-1)?.status).toBe('delivered');
  });

  it('a 200 on the first attempt still gets a fresh signature (no stale header on the happy path)', async () => {
    const row = makeRow({
      body: BODY,
      signedAtUnix: 1_700_000_000, // an ancient stamp
      signature: 'deadbeef',
    });
    const { db, updates } = makeStubDb(row);
    const calls: CapturedCall[] = [];
    const fetcher = capturingFetcher(calls, () => new Response('ok', { status: 200 }));

    await attemptDelivery('d-1', { db, fetcher, clock: () => new Date() });

    expect(calls[0]!.ts).toBe(Math.floor(START.getTime() / 1000));
    expect(receiverAccepts(calls[0]!, SECRET_V1, START.getTime())).toBe(true);
    expect(updates.at(-1)?.status).toBe('delivered');
    expect(updates.at(-1)?.signature).toBe(calls[0]!.signature);
  });
});

// ---------------------------------------------------------------------------
// maybeMarkProgress — Date-bind regression (the bull:ingest retry-churn bug)
// ---------------------------------------------------------------------------
//
// The progress-throttle UPDATE used to interpolate `now` (a `Date`) into a raw
// `sql`...`` template:
//   sql`UPDATE ingest_requests SET last_progress_emitted_at = ${now} ...`
// drizzle has no column type in scope for a raw-template interpolation, so it
// handed that raw `Date` straight to postgres.js as a bind parameter, and
// postgres.js threw at Bind time:
//   TypeError [ERR_INVALID_ARG_TYPE]: ... Received an instance of Date
// The throttle fires POST-commit inside the ingest worker, so this failed the
// whole ingest job AFTER its document was already written, driving it into the
// BullMQ retry churn — and because the failing UPDATE never persisted
// `last_progress_emitted_at`, the 30s throttle stayed permanently tripped and
// every subsequent doc in the batch threw too.
//
// These tests wire the REAL `maybeMarkProgress` through a REAL drizzle instance
// over a fake postgres-js client that records the exact bind params drizzle
// hands the driver, and assert none is a raw `Date`. Routing the write through
// the typed `timestamptz` column applies drizzle's `Date -> toISOString()`
// mapper, so the param is a string. With the old raw `sql` template it would be
// a `Date` and this test fails.

interface DriverCall {
  query: string;
  params: unknown[];
}

function makeCapturingDb(): { db: Db; calls: DriverCall[] } {
  const calls: DriverCall[] = [];
  // drizzle-orm/postgres-js only ever reaches the driver through
  // `client.unsafe(query, params)` (see drizzle's PostgresJsPreparedQuery), and
  // `construct()` mutates `client.options.{parsers,serializers}` at wiring time —
  // so that's the whole surface the fake needs.
  const client = {
    options: { parsers: {} as Record<string, unknown>, serializers: {} as Record<string, unknown> },
    unsafe(query: string, params: unknown[] = []) {
      calls.push({ query, params });
      const rows: unknown[] = /^\s*select/i.test(query)
        ? [{ last_progress_emitted_at: null, last_progress_docs: 0 }]
        : [];
      const p = Promise.resolve(rows) as Promise<unknown[]> & { values: () => Promise<unknown[]> };
      p.values = () => Promise.resolve(rows);
      return p;
    },
  };
  const db = drizzle(client as never) as unknown as Db;
  return { db, calls };
}

describe('maybeMarkProgress — Date-bind regression', () => {
  const INGEST_ID = '11111111-1111-1111-1111-111111111111';

  it('never hands the driver a raw Date param on the progress UPDATE', async () => {
    const { db, calls } = makeCapturingDb();
    const now = new Date('2026-08-04T10:00:00.000Z');

    // totalDocs > 5, docsSinceLast = 10 - 0 >= 10 → the throttle fires the UPDATE.
    const fired = await maybeMarkProgress(db, INGEST_ID, 10, 10, now);
    expect(fired).toBe(true);

    // The write actually happened, against ingest_requests.
    const updateCall = calls.find((c) => /update\b/i.test(c.query));
    expect(updateCall, 'expected an UPDATE on ingest_requests').toBeDefined();
    expect(updateCall!.query.toLowerCase()).toContain('ingest_requests');

    // Core regression assertion: NO bind param handed to the driver — on any
    // statement — is a raw Date. The old code leaked `now` as a Date here.
    for (const c of calls) {
      for (const p of c.params) {
        expect(
          p instanceof Date,
          `raw Date reached the driver as a bind param in: ${c.query}`,
        ).toBe(false);
      }
    }

    // The timestamp went out as the ISO string produced by the timestamptz
    // column mapper, and the doc count is bound as a number.
    expect(updateCall!.params).toContain('2026-08-04T10:00:00.000Z');
    expect(updateCall!.params).toContain(10);
  });

  it('does not touch the DB for small batches (<= 5 docs)', async () => {
    const { db, calls } = makeCapturingDb();
    const fired = await maybeMarkProgress(db, INGEST_ID, 5, 5, new Date());
    expect(fired).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
