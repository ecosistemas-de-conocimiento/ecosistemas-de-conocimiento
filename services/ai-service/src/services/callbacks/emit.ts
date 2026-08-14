// Callback emitter — the source-of-truth implementation for the HMAC-signed
// webhook contract at `plan/m3-webhook-signing-followup.md`.
//
// `enqueueCallback(envelope, { url, apiKeyId, source, sourceId, itemKey })`:
//   1. Looks up the per-consumer `callbackSecret` from `env.API_KEYS[apiKey]`.
//      The lookup is by `apiKeyId` (a SHA-256 fingerprint) — we walk the keys
//      and find the entry whose derived id matches. There aren't enough keys
//      to make this expensive; in the worst case we cache per process.
//   2. Computes the exact JSON bytes to send (`JSON.stringify(envelope)`) and
//      signs `${timestamp}.${body}` with HMAC-SHA256.
//   3. Persists a `callback_deliveries` row in `pending` status.
//   4. Fire-and-forget: kicks off the first POST asynchronously.
//   5. On 5xx / network: schedules retries per the contract backoff schedule
//      (t+0, +5s, +30s, +2m, +10m, then dead-letter).
//
// Critical correctness note (from the contract doc):
//   - Sign the EXACT bytes we send. We capture `body = JSON.stringify(...)`
//     once and use that string both for signing and as the request body. Do
//     NOT re-stringify, re-parse, or pass `envelope` to `fetch` (which would
//     re-stringify with potentially different key ordering / formatting).
//
// Re-signing per attempt:
//   The signature covers `${unixSeconds}.${body}`, and receivers enforce the
//   contract's ±300s replay window against that timestamp. The retry schedule
//   below spans ~12m35s from enqueue to the final attempt, so a signature
//   minted once at enqueue is GUARANTEED to be stale (and 401'd as a replay)
//   by attempts 4 and 5 — precisely the attempts that only exist because the
//   earlier ones failed. `attemptDelivery` therefore re-derives the secret and
//   re-signs with a FRESH timestamp before every POST, and persists the new
//   timestamp + signature on the row.
//
//   The BODY is never re-serialised: we re-sign the stored `row.body` string
//   verbatim, so the bytes on the wire are byte-identical across all attempts
//   and only the two header values change. This is wire-compatible with
//   receivers written against the original contract — same header names, same
//   signing string, same hex encoding.

import { createHmac } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';

import { db as defaultDb, type Db } from '../../db/client.js';
import { callbackDeliveries, ingestRequests } from '../../db/schema/index.js';
import { env } from '../../config/env.js';
import { deriveApiKeyId } from '../../plugins/auth.js';

// ---------------------------------------------------------------------------
// Event envelope types — mirror the contract doc §"Event shapes".
// ---------------------------------------------------------------------------

export type GenerateEvent =
  | 'unit.completed'
  | 'unit.failed'
  | 'request.completed'
  | 'request.failed'
  | 'request.cancelled';

export type IngestEvent =
  | 'ingest.completed'
  | 'ingest.failed'
  | 'ingest.progress';

export type CallbackEvent = GenerateEvent | IngestEvent;

export type CallbackSource = 'generate' | 'ingest';

/** Minimum shape — events carry the contract's per-shape payload as well. */
export interface BaseEnvelope {
  event: CallbackEvent;
  emittedAt: string; // ISO-8601
  [key: string]: unknown;
}

export interface EnqueueOptions {
  url: string;
  /** `req.auth.apiKeyId` — used to look up the per-consumer `callbackSecret`. */
  apiKeyId: string | null;
  source: CallbackSource;
  sourceId: string;
  /** `unitKey` (generate) or `docId` (ingest); null for batch events. */
  itemKey?: string | null;
  /** Scoping tags carried into `callback_deliveries`. */
  org: string;
  project?: string | null;
}

export interface EnqueueDeps {
  db?: Db;
  /**
   * Test seam: replace `fetch` with a recording / failing mock. Defaults to
   * the global `fetch` (Node 22+).
   */
  fetcher?: typeof fetch;
  /** Test seam: deterministic clock. */
  clock?: () => Date;
}

/** Retry schedule from the contract doc §"Transport" (in milliseconds). */
export const RETRY_SCHEDULE_MS = [
  0, // attempt 1 — fire immediately
  5_000, // attempt 2 — +5s
  30_000, // attempt 3 — +30s
  120_000, // attempt 4 — +2m
  600_000, // attempt 5 — +10m
];

export const MAX_ATTEMPTS = RETRY_SCHEDULE_MS.length;

/** Truncate a response body to a reasonable excerpt — protects DB column size. */
const RESPONSE_BODY_EXCERPT_LIMIT = 1024;

// ---------------------------------------------------------------------------
// Secret lookup
// ---------------------------------------------------------------------------

/**
 * Walk `env.API_KEYS` and find the entry whose derived `apiKeyId` matches.
 * Returns `null` if no key matches (e.g. the key was rotated out after the
 * delivery row was created) — the caller records the delivery as
 * `auth_failed` and stops retrying.
 *
 * Cached per-process to amortise the cost of computing the SHA-256 fingerprint
 * across many concurrent callbacks. The cache is invalidated on process
 * restart, which is fine: env changes require a deploy.
 */
const apiKeyIdToSecret = new Map<string, string | null>();

export function resolveCallbackSecret(apiKeyId: string): string | null {
  const cached = apiKeyIdToSecret.get(apiKeyId);
  if (cached !== undefined) return cached;
  for (const [rawKey, entry] of Object.entries(env.API_KEYS)) {
    if (deriveApiKeyId(rawKey) === apiKeyId) {
      const secret = entry.callbackSecret ?? null;
      apiKeyIdToSecret.set(apiKeyId, secret);
      return secret;
    }
  }
  apiKeyIdToSecret.set(apiKeyId, null);
  return null;
}

/** Test-only: clear the secret cache so a test can re-mutate `env.API_KEYS`. */
export function __resetCallbackSecretCache(): void {
  apiKeyIdToSecret.clear();
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

export interface SignedRequest {
  body: string;
  signedAtUnix: number;
  signature: string;
  headers: Record<string, string>;
}

export interface SignedBody {
  /** Echoed back verbatim — the exact bytes that were signed. */
  body: string;
  signedAtUnix: number;
  signature: string;
}

/**
 * Sign an already-serialised body per the contract scheme: HMAC-SHA256 over
 * `${timestamp}.${body}`.
 *
 * This is the primitive: it takes the body as a STRING and never parses or
 * re-serialises it, which is what keeps the bytes on the wire identical to the
 * bytes that were signed. Every re-sign path (retries, admin replay) must go
 * through here rather than round-tripping the envelope through
 * `JSON.parse`/`JSON.stringify`.
 */
export function signBody(
  body: string,
  secret: string,
  now: Date = new Date(),
): SignedBody {
  const signedAtUnix = Math.floor(now.getTime() / 1000);
  const message = `${signedAtUnix}.${body}`;
  const signature = createHmac('sha256', secret).update(message).digest('hex');
  return { body, signedAtUnix, signature };
}

/**
 * Sign an envelope per the contract scheme: serialise once, then sign those
 * exact bytes.
 *
 * Exported so the test suite can verify byte-fidelity end-to-end.
 */
export function signEnvelope(
  envelope: BaseEnvelope,
  secret: string,
  now: Date = new Date(),
): SignedRequest {
  const { body, signedAtUnix, signature } = signBody(
    JSON.stringify(envelope),
    secret,
    now,
  );
  return {
    body,
    signedAtUnix,
    signature,
    headers: {
      'Content-Type': 'application/json',
      'X-AIService-Timestamp': String(signedAtUnix),
      'X-AIService-Signature': signature,
      'X-AIService-Event': envelope.event,
    },
  };
}

// ---------------------------------------------------------------------------
// Public entry: enqueueCallback
// ---------------------------------------------------------------------------

/**
 * Persist a `callback_deliveries` row and kick off the first delivery
 * attempt. Fire-and-forget — the returned promise resolves once the row is
 * inserted; the actual POST happens asynchronously.
 *
 * On signing failure (no secret found), the row is still inserted in
 * `auth_failed` status so the operator has an audit trail.
 */
export async function enqueueCallback(
  envelope: BaseEnvelope,
  opts: EnqueueOptions,
  deps: EnqueueDeps = {},
): Promise<{ deliveryId: string; status: 'pending' | 'auth_failed' }> {
  const db = deps.db ?? defaultDb;
  const fetcher = deps.fetcher ?? fetch;
  const clock = deps.clock ?? (() => new Date());

  // Resolve secret first — if missing, record `auth_failed` and bail.
  if (!opts.apiKeyId) {
    // No apiKeyId captured at enqueue (e.g. legacy row pre-migration). Record
    // a permanent `auth_failed` row so the operator can replay manually after
    // setting up the consumer's secret + apiKeyId.
    const row = await db
      .insert(callbackDeliveries)
      .values({
        org: opts.org,
        project: opts.project ?? null,
        source: opts.source,
        sourceId: opts.sourceId,
        itemKey: opts.itemKey ?? null,
        event: envelope.event,
        url: opts.url,
        apiKeyId: null,
        body: JSON.stringify(envelope),
        signedAtUnix: Math.floor(clock().getTime() / 1000),
        signature: '',
        status: 'auth_failed',
        attempt: 0,
        nextAttemptAt: null,
        lastError: 'no apiKeyId captured at enqueue time',
        updatedAt: clock(),
      })
      .returning({ id: callbackDeliveries.id });
    return { deliveryId: row[0]!.id, status: 'auth_failed' };
  }

  const secret = resolveCallbackSecret(opts.apiKeyId);
  if (!secret) {
    const row = await db
      .insert(callbackDeliveries)
      .values({
        org: opts.org,
        project: opts.project ?? null,
        source: opts.source,
        sourceId: opts.sourceId,
        itemKey: opts.itemKey ?? null,
        event: envelope.event,
        url: opts.url,
        apiKeyId: opts.apiKeyId,
        body: JSON.stringify(envelope),
        signedAtUnix: Math.floor(clock().getTime() / 1000),
        signature: '',
        status: 'auth_failed',
        attempt: 0,
        nextAttemptAt: null,
        lastError: 'no callbackSecret configured for this apiKeyId',
        updatedAt: clock(),
      })
      .returning({ id: callbackDeliveries.id });
    return { deliveryId: row[0]!.id, status: 'auth_failed' };
  }

  const signed = signEnvelope(envelope, secret, clock());

  const row = await db
    .insert(callbackDeliveries)
    .values({
      org: opts.org,
      project: opts.project ?? null,
      source: opts.source,
      sourceId: opts.sourceId,
      itemKey: opts.itemKey ?? null,
      event: envelope.event,
      url: opts.url,
      apiKeyId: opts.apiKeyId,
      body: signed.body,
      signedAtUnix: signed.signedAtUnix,
      signature: signed.signature,
      status: 'pending',
      attempt: 0,
      nextAttemptAt: clock(),
      updatedAt: clock(),
    })
    .returning({ id: callbackDeliveries.id });

  const deliveryId = row[0]!.id;

  // Kick off the first attempt asynchronously. We never `await` the POST in
  // the caller path — the terminal transition must not block on a slow
  // receiver. The scheduler keeps the retry loop alive in the background.
  setImmediate(() => {
    void attemptDelivery(deliveryId, { db, fetcher, clock }).catch((err) => {
      // Best-effort log; the row's `last_error` already captures the message.
      console.warn(
        `callback emit: deliveryId=${deliveryId} initial attempt scheduling failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  });

  return { deliveryId, status: 'pending' };
}

// ---------------------------------------------------------------------------
// Attempt loop
// ---------------------------------------------------------------------------

/**
 * Perform one delivery attempt for a `callback_deliveries` row. On 5xx /
 * network error, schedule the next attempt via `setTimeout` until the
 * retry schedule is exhausted, then mark dead-letter.
 *
 * Every attempt is signed FRESH: the stored `row.body` bytes are re-signed
 * with the current clock and the currently-configured `callbackSecret`, and
 * the new `signedAtUnix` / `signature` are persisted on the row. Without this
 * the later retries carry an enqueue-time timestamp that is well outside the
 * receiver's ±300s replay window (see the module header).
 *
 * `deps.preserveSignature` opts out and sends the stored timestamp +
 * signature verbatim. Only the admin replay endpoint's `resign: false` mode
 * uses it (for exercising a receiver's dedupe / stale-timestamp handling) —
 * the normal retry loop always re-signs.
 */
export async function attemptDelivery(
  deliveryId: string,
  deps: Required<Pick<EnqueueDeps, 'fetcher' | 'clock'>> & {
    db?: Db;
    preserveSignature?: boolean;
  },
): Promise<void> {
  const db = deps.db ?? defaultDb;
  const fetcher = deps.fetcher;
  const clock = deps.clock;

  // Load current row state. Another worker may have advanced it; treat the
  // row's `attempt` as the canonical source.
  const rows = await db
    .select()
    .from(callbackDeliveries)
    .where(eq(callbackDeliveries.id, deliveryId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    console.warn(`callback emit: deliveryId=${deliveryId} missing; aborted`);
    return;
  }
  if (
    row.status === 'delivered' ||
    row.status === 'dead_letter' ||
    row.status === 'auth_failed' ||
    row.status === 'failed'
  ) {
    return;
  }

  const nextAttempt = row.attempt + 1;

  // -------------------------------------------------------------------------
  // Re-sign this attempt with a fresh timestamp.
  //
  // `row.body` is used VERBATIM — never re-parsed or re-serialised — so the
  // wire bytes stay byte-identical across attempts and only the timestamp +
  // signature headers change.
  // -------------------------------------------------------------------------
  let sentAtUnix = row.signedAtUnix;
  let sentSignature = row.signature;
  let resigned = false;

  if (deps.preserveSignature !== true) {
    const secret = row.apiKeyId ? resolveCallbackSecret(row.apiKeyId) : null;
    if (!secret) {
      // The key was rotated out (or never had a `callbackSecret`) between
      // enqueue and this attempt. Re-signing is impossible and the stored
      // signature was minted with a secret the receiver no longer holds — so
      // sending it would just burn a request for a guaranteed 401. Record the
      // permanent auth failure with a precise reason instead; an operator can
      // restore the secret and re-fire via
      // `POST /v1/admin/callbacks/:id/replay`, which re-signs.
      const failedAt = clock();
      await db
        .update(callbackDeliveries)
        .set({
          status: 'auth_failed',
          nextAttemptAt: null,
          lastError: row.apiKeyId
            ? `no callbackSecret configured for apiKeyId ${row.apiKeyId} at attempt time (rotated out?)`
            : 'no apiKeyId on delivery row; cannot re-sign this attempt',
          updatedAt: failedAt,
        })
        .where(eq(callbackDeliveries.id, deliveryId));
      return;
    }
    const signed = signBody(row.body, secret, clock());
    sentAtUnix = signed.signedAtUnix;
    sentSignature = signed.signature;
    resigned = true;
  }

  let response: Response | null = null;
  let networkError: Error | null = null;
  try {
    response = await fetcher(row.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Force a fresh TCP connection per delivery. undici's default
        // keep-alive pool reused sockets across deliveries and the
        // receiver side (Next 15 behind a reverse proxy) raised
        // ERR_HTTP_SOCKET_ASSIGNED uncaught exceptions on the second
        // and subsequent reuse — Next returned a default 200 with an
        // empty body and the route handler never ran. Connection: close
        // makes undici tear the socket down after each response, which
        // unblocks the receiver until the underlying Node/Next/Traefik
        // interaction is properly diagnosed.
        Connection: 'close',
        'X-AIService-Timestamp': String(sentAtUnix),
        'X-AIService-Signature': sentSignature,
        'X-AIService-Event': row.event,
      },
      body: row.body,
    });
  } catch (err) {
    networkError = err instanceof Error ? err : new Error(String(err));
  }

  const now = clock();
  type DeliveryStatus =
    | 'pending'
    | 'delivered'
    | 'failed'
    | 'auth_failed'
    | 'dead_letter';
  let nextStatus: DeliveryStatus = row.status;
  let nextAttemptAt: Date | null = null;
  let responseStatus: number | null = null;
  let responseBodyExcerpt: string | null = null;
  let lastError: string | null = null;

  if (response) {
    responseStatus = response.status;
    const text = await response.text().catch(() => '');
    responseBodyExcerpt = text.slice(0, RESPONSE_BODY_EXCERPT_LIMIT);

    if (response.status >= 200 && response.status < 300) {
      nextStatus = 'delivered';
    } else if (response.status === 401) {
      // Auth misconfig — stop retrying, alert via status.
      nextStatus = 'auth_failed';
    } else if (response.status >= 400 && response.status < 500) {
      // Permanent client rejection (other than 401).
      nextStatus = 'failed';
    } else {
      // 5xx — schedule retry.
      if (nextAttempt >= MAX_ATTEMPTS) {
        nextStatus = 'dead_letter';
      } else {
        nextStatus = 'pending';
        nextAttemptAt = new Date(now.getTime() + RETRY_SCHEDULE_MS[nextAttempt]!);
      }
    }
  } else if (networkError) {
    lastError = networkError.message;
    if (nextAttempt >= MAX_ATTEMPTS) {
      nextStatus = 'dead_letter';
    } else {
      nextStatus = 'pending';
      nextAttemptAt = new Date(now.getTime() + RETRY_SCHEDULE_MS[nextAttempt]!);
    }
  }

  await db
    .update(callbackDeliveries)
    .set({
      status: nextStatus,
      attempt: nextAttempt,
      nextAttemptAt,
      responseStatus,
      responseBodyExcerpt,
      lastError,
      lastAttemptAt: now,
      updatedAt: now,
      // Persist what we actually put on the wire this attempt, so the row is
      // an accurate record of the last delivery and so a later admin replay
      // that opts out of re-signing resends a coherent (ts, signature) pair.
      ...(resigned ? { signedAtUnix: sentAtUnix, signature: sentSignature } : {}),
    })
    .where(eq(callbackDeliveries.id, deliveryId));

  // Schedule the next attempt if applicable.
  if (nextStatus === 'pending' && nextAttemptAt) {
    const delayMs = Math.max(0, nextAttemptAt.getTime() - now.getTime());
    setTimeout(() => {
      void attemptDelivery(deliveryId, deps).catch((err) => {
        console.warn(
          `callback emit: deliveryId=${deliveryId} attempt ${nextAttempt + 1} scheduling failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, delayMs).unref?.();
  }
}

// ---------------------------------------------------------------------------
// Replay (admin endpoint helper)
// ---------------------------------------------------------------------------

/**
 * Reset a delivery row to `pending` and re-run a single attempt. Used by the
 * admin `POST /v1/admin/callbacks/:deliveryId/replay` endpoint.
 *
 * The body bytes are always preserved verbatim.
 *
 * `resign=true` (the route's default) regenerates the signature with the
 * current timestamp + the current callbackSecret, and the retry loop keeps
 * re-signing every subsequent attempt.
 *
 * `resign=false` sends the stored timestamp + signature untouched — only
 * useful for exercising a receiver's dedupe / stale-timestamp handling, since
 * the stored timestamp is almost certainly outside the receiver's ±300s
 * window by replay time.
 */
export async function replayDelivery(
  deliveryId: string,
  opts: { resign?: boolean } = {},
  deps: EnqueueDeps = {},
): Promise<{ ok: true; status: string } | { ok: false; reason: string }> {
  const db = deps.db ?? defaultDb;
  const fetcher = deps.fetcher ?? fetch;
  const clock = deps.clock ?? (() => new Date());

  const rows = await db
    .select()
    .from(callbackDeliveries)
    .where(eq(callbackDeliveries.id, deliveryId))
    .limit(1);
  const row = rows[0];
  if (!row) return { ok: false, reason: 'not-found' };

  // The body is NEVER re-serialised — `signBody` takes the stored bytes as-is.
  const body = row.body;
  let signedAtUnix = row.signedAtUnix;
  let signature = row.signature;
  if (opts.resign) {
    if (!row.apiKeyId) return { ok: false, reason: 'no-api-key-on-row' };
    const secret = resolveCallbackSecret(row.apiKeyId);
    if (!secret) return { ok: false, reason: 'no-secret-for-api-key' };
    const signed = signBody(body, secret, clock());
    signedAtUnix = signed.signedAtUnix;
    signature = signed.signature;
  }

  const now = clock();
  await db
    .update(callbackDeliveries)
    .set({
      status: 'pending',
      attempt: 0,
      nextAttemptAt: now,
      body,
      signedAtUnix,
      signature,
      lastError: null,
      responseStatus: null,
      responseBodyExcerpt: null,
      updatedAt: now,
    })
    .where(eq(callbackDeliveries.id, row.id));

  // Drive a single attempt synchronously so the caller knows the immediate
  // outcome. Subsequent retries (if 5xx / network) schedule themselves.
  //
  // `resign: false` means "send exactly what's stored", so the attempt loop
  // must not re-sign it either.
  await attemptDelivery(deliveryId, {
    db,
    fetcher,
    clock,
    preserveSignature: opts.resign !== true,
  });

  const after = await db
    .select({ status: callbackDeliveries.status })
    .from(callbackDeliveries)
    .where(eq(callbackDeliveries.id, deliveryId))
    .limit(1);
  return { ok: true, status: after[0]?.status ?? 'unknown' };
}

/**
 * Atomic-ish counter helper for the ingest-progress throttle (every 10 docs
 * OR 30s, whichever first). Exposed here so the worker can do the bookkeeping
 * without re-implementing the SQL.
 */
export async function maybeMarkProgress(
  db: Db,
  ingestRequestId: string,
  totalDocs: number,
  completedDocs: number,
  now: Date,
): Promise<boolean> {
  if (totalDocs <= 5) return false; // contract: only for batches > 5 docs
  // Read current bookkeeping.
  const rows = await db.execute<{
    last_progress_emitted_at: Date | null;
    last_progress_docs: number;
  }>(
    sql`SELECT last_progress_emitted_at, last_progress_docs FROM ingest_requests WHERE id = ${ingestRequestId} LIMIT 1`,
  );
  const r = (rows as unknown as Array<{ last_progress_emitted_at: Date | null; last_progress_docs: number }>)[0];
  if (!r) return false;
  const docsSinceLast = completedDocs - r.last_progress_docs;
  const msSinceLast = r.last_progress_emitted_at
    ? now.getTime() - new Date(r.last_progress_emitted_at).getTime()
    : Number.POSITIVE_INFINITY;
  if (docsSinceLast >= 10 || msSinceLast >= 30_000) {
    // Typed drizzle UPDATE — deliberately NOT a raw `sql` template. Interpolating
    // a `Date` into `sql`... ${now} ...`` hands postgres.js an untyped bind
    // parameter: there is no column type in scope to trigger drizzle's
    // Date→ISO-string mapper, so the raw `Date` reaches postgres.js's Bind step
    // and throws `ERR_INVALID_ARG_TYPE: ... Received an instance of Date`. That
    // throw fired POST-commit (the document row was already written) and failed
    // the whole ingest job, sending it into the BullMQ retry churn — and because
    // the failing UPDATE never persisted `last_progress_emitted_at`, the 30s
    // throttle stayed permanently tripped, so every subsequent doc in the batch
    // threw too. Routing the write through the typed columns
    // (`lastProgressEmittedAt` is a `timestamptz`) applies the column mapper, so
    // a JS `Date` is serialised correctly. See the regression test.
    await db
      .update(ingestRequests)
      .set({ lastProgressEmittedAt: now, lastProgressDocs: completedDocs })
      .where(eq(ingestRequests.id, ingestRequestId));
    return true;
  }
  return false;
}
