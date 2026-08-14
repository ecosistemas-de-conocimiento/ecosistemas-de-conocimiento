// Unit tests for the idempotency helper. The drizzle `db` is replaced with a
// tiny stub whose `select().from(generationRequests).where(...).limit(1)` chain
// resolves to a single canned row (or none) — matching the pattern used in
// `src/services/registry/resolve.test.ts`. No live Postgres; the 24h window
// is traversed via the injected `clock`.

import { describe, expect, it } from 'vitest';

import type { Db } from '../db/client.js';
import { generationRequests } from '../db/schema/index.js';

import {
  checkIdempotency,
  hashPayload,
  IdempotencyConflictError,
} from './idempotency.js';

// ---------------------------------------------------------------------------
// Stub db — single-table read surface only.
// ---------------------------------------------------------------------------

function makeDb(row: Record<string, unknown> | null): Db {
  const build = (table: unknown) => {
    const result: unknown[] = table === generationRequests && row ? [row] : [];
    const chain = {
      where: () => chain,
      limit: () => Promise.resolve(result),
    };
    return chain;
  };
  return { select: () => ({ from: build }) } as unknown as Db;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG = 'test-org';
const CLIENT_ID = 'client-req-abc';
const REQ_ID = '11111111-2222-3333-4444-555555555555';

function makeRow(over: Record<string, unknown> = {}) {
  return {
    id: REQ_ID,
    org: ORG,
    project: 'p',
    clientRequestId: CLIENT_ID,
    status: 'completed',
    totalJobs: 3,
    completedJobs: 3,
    failedJobs: 0,
    estimatedCostUsd: '0.125',
    actualCostUsd: '0.110',
    metadata: { payloadHash: 'hash-original' },
    createdAt: new Date('2026-05-14T12:00:00Z'),
    ...over,
  };
}

const NOW_WITHIN = new Date('2026-05-14T18:00:00Z'); // +6h
const NOW_BEYOND = new Date('2026-05-15T13:00:00Z'); // +25h

// ---------------------------------------------------------------------------
// hashPayload — determinism
// ---------------------------------------------------------------------------

describe('hashPayload', () => {
  it('returns the same hex for logically-equal bodies with shuffled key order', () => {
    const a = { units: [{ unitKey: 'u1', input: { x: 1, y: 2 } }], effortLevel: 'standard' };
    const b = { effortLevel: 'standard', units: [{ input: { y: 2, x: 1 }, unitKey: 'u1' }] };
    expect(hashPayload(a)).toBe(hashPayload(b));
  });

  it('differs when a semantic field changes', () => {
    const a = { units: [{ unitKey: 'u1' }], effortLevel: 'standard' };
    const b = { units: [{ unitKey: 'u1' }], effortLevel: 'deep' };
    expect(hashPayload(a)).not.toBe(hashPayload(b));
  });

  it('produces 64-char SHA-256 hex', () => {
    expect(hashPayload({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// checkIdempotency — the four branches
// ---------------------------------------------------------------------------

describe('checkIdempotency', () => {
  it('returns { kind: "new" } when no prior row exists', async () => {
    const db = makeDb(null);
    const decision = await checkIdempotency(db, {
      org: ORG,
      clientRequestId: CLIENT_ID,
      payloadHash: 'hash-original',
      clock: () => NOW_WITHIN,
    });
    expect(decision).toEqual({ kind: 'new' });
  });

  it('returns { kind: "replay" } for same body within 24h', async () => {
    const db = makeDb(makeRow());
    const decision = await checkIdempotency(db, {
      org: ORG,
      clientRequestId: CLIENT_ID,
      payloadHash: 'hash-original',
      clock: () => NOW_WITHIN,
    });
    expect(decision).toEqual({
      kind: 'replay',
      existing: {
        requestId: REQ_ID,
        channel: `request:${REQ_ID}:generations`,
        totalJobs: 3,
        estimatedCostUsd: 0.125,
      },
    });
  });

  it('returns { kind: "conflict" } for different body within 24h', async () => {
    const db = makeDb(makeRow());
    const decision = await checkIdempotency(db, {
      org: ORG,
      clientRequestId: CLIENT_ID,
      payloadHash: 'hash-other',
      clock: () => NOW_WITHIN,
    });
    expect(decision).toEqual({ kind: 'conflict', existingRequestId: REQ_ID });
  });

  it('returns { kind: "new" } when the prior row is older than the window', async () => {
    const db = makeDb(makeRow());
    const decision = await checkIdempotency(db, {
      org: ORG,
      clientRequestId: CLIENT_ID,
      payloadHash: 'hash-original',
      clock: () => NOW_BEYOND,
    });
    expect(decision).toEqual({ kind: 'new' });
  });

  it('treats an exactly-windowMs-old row as still within window (boundary)', async () => {
    const row = makeRow({ createdAt: new Date(NOW_WITHIN.getTime() - 24 * 60 * 60 * 1000) });
    const db = makeDb(row);
    const decision = await checkIdempotency(db, {
      org: ORG,
      clientRequestId: CLIENT_ID,
      payloadHash: 'hash-original',
      clock: () => NOW_WITHIN,
    });
    expect(decision.kind).toBe('replay');
  });

  it('honours a custom windowMs', async () => {
    const row = makeRow({ createdAt: new Date(NOW_WITHIN.getTime() - 60 * 1000) });
    const db = makeDb(row);
    const decision = await checkIdempotency(db, {
      org: ORG,
      clientRequestId: CLIENT_ID,
      payloadHash: 'hash-original',
      windowMs: 30 * 1000,
      clock: () => NOW_WITHIN,
    });
    expect(decision.kind).toBe('new');
  });

  it('treats a row with missing metadata.payloadHash as a conflict (defensive)', async () => {
    const db = makeDb(makeRow({ metadata: null }));
    const decision = await checkIdempotency(db, {
      org: ORG,
      clientRequestId: CLIENT_ID,
      payloadHash: 'hash-original',
      clock: () => NOW_WITHIN,
    });
    expect(decision).toEqual({ kind: 'conflict', existingRequestId: REQ_ID });
  });
});

// ---------------------------------------------------------------------------
// IdempotencyConflictError — shape
// ---------------------------------------------------------------------------

describe('IdempotencyConflictError', () => {
  it('carries the code and existing requestId', () => {
    const err = new IdempotencyConflictError(REQ_ID);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('ERR_IDEMPOTENCY_CONFLICT');
    expect(err.existingRequestId).toBe(REQ_ID);
    expect(err.name).toBe('IdempotencyConflictError');
  });
});
