// Idempotency helper for /v1/generate.
//
// Pre-INSERT decision: given an incoming `(org, clientRequestId)` and a
// pre-computed `payloadHash`, look up `generation_requests` and decide whether
// the orchestrator should treat the call as new, return the cached handle
// (replay), or refuse with a 409 (conflict).
//
// The hash MUST be computed over the request body MINUS transport-level
// fields — drop `requestedBy` and `callbackUrl`. Same units + same effort
// knobs ≡ same generation request; who's asking and where to webhook are not
// semantic to the result. The orchestrator is responsible for that canonical
// projection; this helper is only fed the already-prepared hash so the
// "what's in the hash" rule lives in exactly one place upstream.
//
// 24h window: the unique partial index on `(org, client_request_id)` is NOT
// time-scoped, so the orchestrator handles staleness explicitly. If we find a
// row older than `windowMs`, we return `{ kind: 'new' }` and let the
// orchestrator DELETE-then-INSERT inside a transaction (see m3-step5 plan §B
// step 2). This helper never mutates rows itself.

import { createHash } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import safeStringify from 'safe-stable-stringify';

import type { Db } from '../db/client.js';
import { generationRequests } from '../db/schema/index.js';

/** SHA-256 hex of a JSON-stable serialisation of `payload`. */
export function hashPayload(payload: unknown): string {
  // `safe-stable-stringify` sorts object keys recursively, so logically-equal
  // bodies with different key insertion order hash identically. Returns
  // `undefined` for `undefined` input — coerce to empty string for stability.
  const s = safeStringify(payload) ?? '';
  return createHash('sha256').update(s).digest('hex');
}

/** Existing-request handle returned on replay. */
export interface IdempotencyReplayHandle {
  requestId: string;
  channel: string;
  totalJobs: number;
  estimatedCostUsd: number;
}

/** Discriminated decision the orchestrator switches on. */
export type IdempotencyDecision =
  | { kind: 'new' }
  | { kind: 'replay'; existing: IdempotencyReplayHandle }
  | { kind: 'conflict'; existingRequestId: string };

/** Thrown by the orchestrator when `checkIdempotency` returns `conflict`. */
export class IdempotencyConflictError extends Error {
  readonly code = 'ERR_IDEMPOTENCY_CONFLICT' as const;
  readonly existingRequestId: string;
  constructor(existingRequestId: string, message?: string) {
    super(message ?? `clientRequestId already used with a different payload (request ${existingRequestId})`);
    this.name = 'IdempotencyConflictError';
    this.existingRequestId = existingRequestId;
  }
}

export interface CheckIdempotencyArgs {
  org: string;
  clientRequestId: string;
  payloadHash: string;
  /** Defaults to 24h. */
  windowMs?: number;
  /** Test seam; defaults to `() => new Date()`. */
  clock?: () => Date;
}

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Query `generation_requests` for the prior row matching `(org,
 * clientRequestId)` (the partial unique index makes this a single-row probe).
 * - No row → `{ kind: 'new' }`.
 * - Row older than `windowMs` → `{ kind: 'new' }` (stale; orchestrator deletes).
 * - Same hash within window → `{ kind: 'replay', existing }`.
 * - Different hash within window → `{ kind: 'conflict', existingRequestId }`.
 */
export async function checkIdempotency(
  db: Db,
  args: CheckIdempotencyArgs,
): Promise<IdempotencyDecision> {
  const windowMs = args.windowMs ?? DEFAULT_WINDOW_MS;
  const clock = args.clock ?? (() => new Date());

  const rows = await db
    .select()
    .from(generationRequests)
    .where(
      and(
        eq(generationRequests.org, args.org),
        eq(generationRequests.clientRequestId, args.clientRequestId),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return { kind: 'new' };

  const createdAtMs = row.createdAt instanceof Date ? row.createdAt.getTime() : new Date(row.createdAt as unknown as string).getTime();
  const ageMs = clock().getTime() - createdAtMs;
  if (ageMs > windowMs) return { kind: 'new' };

  const meta = (row.metadata ?? {}) as { payloadHash?: unknown };
  const storedHash = typeof meta.payloadHash === 'string' ? meta.payloadHash : null;

  if (storedHash === args.payloadHash) {
    return {
      kind: 'replay',
      existing: {
        requestId: row.id,
        channel: `request:${row.id}:generations`,
        totalJobs: row.totalJobs,
        estimatedCostUsd: Number(row.estimatedCostUsd),
      },
    };
  }

  return { kind: 'conflict', existingRequestId: row.id };
}
