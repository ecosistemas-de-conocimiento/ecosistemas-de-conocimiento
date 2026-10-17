// Unit tests for the idempotency helper. The drizzle `db` is replaced with a
// tiny stub whose `select().from(generationRequests).where(...).limit(1)` chain
// resolves to a single canned row (or none) — matching the pattern used in
// `src/services/registry/resolve.test.ts`. No live Postgres; the 24h window
// is traversed via the injected `clock`.
//
// 🔴 WHY THE STUB'S `where()` TAKES ITS ARGUMENT NOW.
// It used to read `where: () => chain` — no parameter at all — so the predicate
// `checkIdempotency` builds was discarded before the stub could look at it, and
// every case below agreed with any WHERE clause including none. This helper is
// where a replayed `clientRequestId` is matched to a PRIOR REQUEST: drop the
// org term and one tenant's `clientRequestId` starts colliding with another's,
// which surfaces either as a 409 nobody can explain or — worse — as a `replay`
// handing back a requestId that belongs to a different customer.
//
// Predicates now go through `WhereRecorder` (drizzle's own dialect, bound
// params kept), and the dedicated cases at the bottom assert on them.
//
// 🔴 …AND WHY BOTH TERMINALS SETTLE THROUGH `WhereRecorder.guard()`.
// Taking the argument closes the mutation that EMPTIES the predicate. It does
// nothing about the one that DELETES the `.where()` call, because this stub's
// `where` returns the chain itself: strip the call and
// `.from(generationRequests).limit(1)` is still a legal chain that still
// resolves to the canned row. Measured on this file at HEAD, with the whole
// `.where(and(eq(org), eq(clientRequestId)))` deleted from `idempotency.ts`:
// 10 of 14 cases stayed GREEN over what is a whole-table read, and the 4 that
// did fail named the wrong culprit — "no where() was recorded for
// 'generation_requests' at all — the stub was never reached, so this assertion
// would pass vacuously". The stub was reached on every single call; it was the
// PREDICATE that was gone. A reader following that message goes looking for a
// broken fixture instead of a dropped tenant filter.
//
// So both terminals now settle through `guard.settle()`, which records the
// never-filtered chain as `<NO PREDICATE>`. The same mutation now fails by its
// real name, and `expectNoUnfilteredQuery()` below stops being vacuous here.

import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../db/client.js';
import { generationRequests } from '../db/schema/index.js';
import { WhereRecorder } from '../test/where-recorder.js';

import {
  checkIdempotency,
  hashPayload,
  IdempotencyConflictError,
} from './idempotency.js';

// ---------------------------------------------------------------------------
// Stub db — single-table read surface only.
// ---------------------------------------------------------------------------

/** Every predicate the stubbed query built. Cleared in `beforeEach`. */
const wheres = new WhereRecorder();

function makeDb(row: Record<string, unknown> | null): Db {
  const build = (table: unknown) => {
    const result: unknown[] = table === generationRequests && row ? [row] : [];
    const name = table === generationRequests ? 'generation_requests' : 'unknown';
    // ONE guard per chain instance. A chain is what a single `from()` returns,
    // which here is exactly one query, so the guard's "was this chain ever
    // filtered?" question is asked once per query — which is the only scope at
    // which the answer means anything.
    const guard = wheres.guard(name);
    const chain: {
      where: (predicate: unknown) => typeof chain;
      limit: (n?: number) => Promise<unknown[]>;
      then: (resolve: (v: unknown[]) => void) => void;
    } = {
      // 🔴 TAKES its argument — see the header.
      where: (predicate: unknown) => {
        guard.where(predicate);
        return chain;
      },
      // 🔴 EVERY terminal settles through the guard — see the header. `limit`
      // is the one `checkIdempotency` actually calls; `then` is here because a
      // chain that loses its `.limit(1)` as well would otherwise be awaited as
      // a non-thenable and hand the caller back the stub object in silence.
      limit: async () => guard.settle(result),
      then: (resolve) => {
        Promise.resolve(guard.settle(result)).then(resolve);
      },
    };
    return chain;
  };
  return { select: () => ({ from: build }) } as unknown as Db;
}

beforeEach(() => {
  wheres.reset();
});

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
    // Replay is the branch that hands a caller a requestId, so the row it read
    // had to be found under the caller's own org.
    // EVERY query, not just one of them: `checkIdempotency` issues a single
    // read of this table and there is no legitimately unscoped read of it
    // anywhere in the module, so a second, org-less probe appearing here would
    // be the bug — and `expectScopedTo` would have waved it through.
    wheres.expectEveryQueryScopedTo('generation_requests', { org: ORG });
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

// ---------------------------------------------------------------------------
// Tenant scope of the probe
// ---------------------------------------------------------------------------
//
// 🔴 ORG-ONLY, AND THAT IS THE SPECIFICATION — DO NOT "FIX" IT TO org+project.
// The partial unique index this probe is built around is
//
//   drizzle/0000_baseline.sql:336
//   CREATE UNIQUE INDEX "generation_requests_client_request_idx"
//     ON "generation_requests" ("org","client_request_id")
//     WHERE "client_request_id" is not null;
//
// `project` is NOT in that index, so a `clientRequestId` is unique per ORG, and
// the same key sent by two projects of one org is deliberately the SAME logical
// request. Adding `eq(generationRequests.project, …)` here would let a single
// key insert twice and then blow up on the unique index at INSERT time instead
// of returning a clean replay. Every other tenant-scoped query in this service
// is org+project; this one is the documented exception.
//
// Which is exactly why it needs its own assertion: "org only" and "no tenant
// filter at all" look identical to a stub that discards the predicate.

describe('checkIdempotency — tenant scope', () => {
  it('🔴 scopes the probe to (org, clientRequestId) — org, not the key alone', async () => {
    await checkIdempotency(makeDb(makeRow()), {
      org: ORG,
      clientRequestId: CLIENT_ID,
      payloadHash: 'hash-original',
      clock: () => NOW_WITHIN,
    });

    const probes = wheres.for('generation_requests');
    expect(probes).toHaveLength(1);
    const probe = probes[0]!;
    // Column by column, so a dropped org term is its own named failure.
    expect(probe.sql).toContain('"generation_requests"."org" =');
    expect(probe.sql).toContain('"generation_requests"."client_request_id" =');
    // …and the values are the CALLER's, in that order.
    expect(probe.params).toEqual([ORG, CLIENT_ID]);
    // The exception is deliberate, so state it as an assertion rather than only
    // in prose: `project` must NOT appear. See the block comment above.
    expect(probe.sql).not.toContain('"project"');
    wheres.expectNoUnfilteredQuery();
  });

  it('🔴 binds the CALLER org, not the org stamped on the row that comes back', async () => {
    // The stub returns a row owned by ORG regardless of who asks — the shape of
    // a cross-tenant read. If the probe ever filtered on the row instead of on
    // its arguments, only this case would see it.
    await checkIdempotency(makeDb(makeRow()), {
      org: 'other-org',
      clientRequestId: CLIENT_ID,
      payloadHash: 'hash-original',
      clock: () => NOW_WITHIN,
    });

    wheres.expectEveryQueryScopedTo('generation_requests', { org: 'other-org' });
  });

  it('🔴 still filters when there is no prior row (the { kind: "new" } path)', async () => {
    // The miss path is the one an attacker probes hardest: a bare SELECT that
    // happens to return nothing today is still a full-table read tomorrow.
    const decision = await checkIdempotency(makeDb(null), {
      org: ORG,
      clientRequestId: CLIENT_ID,
      payloadHash: 'hash-original',
      clock: () => NOW_WITHIN,
    });
    expect(decision).toEqual({ kind: 'new' });
    wheres.expectEveryQueryScopedTo('generation_requests', { org: ORG });
    // Now a real gate rather than a restatement: the chain's terminals settle
    // through `guard`, so a deleted `.where()` reaches this list as
    // `<NO PREDICATE>` instead of leaving it empty.
    wheres.expectNoUnfilteredQuery();
  });
});
