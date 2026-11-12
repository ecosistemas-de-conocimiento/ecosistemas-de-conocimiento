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
//      (t+0, +5s, +30s, +2m, +10m, +30m, +2h, then dead-letter).
//   6. Every terminal transition goes through `reportDeliveryTransition`:
//      one counter increment, plus an ERROR line for the dead-letter set.
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
//   below spans ~2h43m from enqueue to the final attempt, so a signature
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
import { CodedEnvelopeError } from '../../errors/base.js';
import { rootLogger, type ComponentLogger } from '../../logger.js';
import {
  DLQ_STATUSES,
  recordCallbackTransition,
  type CallbackDeliveryStatus,
} from '../../metrics/callbacks.js';
import { deriveApiKeyId } from '../../plugins/auth.js';
import { assertSafeCallbackUrl } from './url-guard.js';

/** A Db handle or an open transaction on it — the outbox insert takes either. */
export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Default logger for this module. `component` makes delivery lines filterable
 * in Coolify; a caller-injected logger (tests) wins.
 */
const emitLog: ComponentLogger = rootLogger.child({ component: 'callback-emit' });

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
  /** Defaults to the module's `rootLogger` child. Never optional to USE. */
  logger?: ComponentLogger;
}

/**
 * Retry schedule from the contract doc §"Transport" (in milliseconds).
 *
 * Seven attempts, ~2h42m35s from the first to the last (sum of the delays,
 * inferred by arithmetic). The +30m and +2h tail is plan decision D2=B
 * (PLAN-live-ingest §5): the old five-attempt window of 12m35s was
 * shorter than an ordinary consumer deploy or outage, so a receiver that was
 * down for a quarter hour lost every callback for good. Receivers' 120 s claim
 * lease is unaffected — each attempt is still one POST.
 */
export const RETRY_SCHEDULE_MS = [
  0, // attempt 1 — fire immediately
  5_000, // attempt 2 — +5s
  30_000, // attempt 3 — +30s
  120_000, // attempt 4 — +2m
  600_000, // attempt 5 — +10m
  1_800_000, // attempt 6 — +30m
  7_200_000, // attempt 7 — +2h
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
 * 400 at REQUEST time: the caller sent a `callbackUrl` but its API key has no
 * `callbackSecret`, so every callback would be recorded `auth_failed` and the
 * consumer would never hear back (plan finding A2, decision D4=A).
 *
 * Before this, the request was accepted with 202, the boot check only warned,
 * and the loss was visible only in `callback_deliveries`. Refusing up front is
 * the one place the caller is still listening.
 */
export class CallbackSecretMissingError extends CodedEnvelopeError {
  readonly code = 'ERR_CALLBACK_SECRET_MISSING';
  readonly status = 400;
  override name = 'CallbackSecretMissingError';
  constructor() {
    super(
      'callbackUrl was sent, but this API key has no callbackSecret configured in ai-service, ' +
        'so callbacks could not be signed. Configure a 32+-char callbackSecret for the key, ' +
        'or omit callbackUrl and poll GET /v1/ingest/:ingestId.',
    );
  }
}

/**
 * Throw `CallbackSecretMissingError` unless `apiKeyId` resolves to a key with
 * a `callbackSecret`. Call it before persisting any request that carries a
 * `callbackUrl`.
 */
export function assertCallbackSecretFor(apiKeyId: string | null | undefined): void {
  if (!apiKeyId || !resolveCallbackSecret(apiKeyId)) {
    throw new CallbackSecretMissingError();
  }
}

/** The columns a transition report needs; a subset of the delivery row. */
interface TransitionSubject {
  id: string;
  org: string;
  project: string | null;
  source: string;
  sourceId: string;
  itemKey: string | null;
  event: string;
}

/**
 * Count a delivery row entering a terminal status, and log an ERROR when that
 * status is one of the dead-letter set (`dead_letter`, `failed`,
 * `auth_failed`): the consumer was NOT told about this event.
 *
 * Every terminal write in this module and in the sweeper goes through here, so
 * the metric and the log cannot drift from the rows (plan §2.3).
 */
export function reportDeliveryTransition(
  log: ComponentLogger,
  row: TransitionSubject,
  status: CallbackDeliveryStatus,
  info: { attempt: number; responseStatus?: number | null; lastError?: string | null },
): void {
  recordCallbackTransition(status, row.event, row.project);
  if (!DLQ_STATUSES.includes(status)) return;
  log.error(
    {
      deliveryId: row.id,
      org: row.org,
      project: row.project,
      source: row.source,
      sourceId: row.sourceId,
      itemKey: row.itemKey,
      event: row.event,
      attempt: info.attempt,
      responseStatus: info.responseStatus ?? null,
      lastError: info.lastError ?? null,
      status,
    },
    `callback delivery ${status}: consumer was NOT notified (replay via POST /v1/admin/callbacks/:id/replay)`,
  );
}

export interface InsertedDelivery {
  deliveryId: string;
  status: 'pending' | 'auth_failed';
}

/**
 * Persist a `callback_deliveries` row WITHOUT sending anything.
 *
 * This is the transactional-outbox half of `enqueueCallback`: pass the open
 * transaction that writes the event's source rows (the ingest worker passes
 * the document transaction), so the delivery row exists if and only if the
 * document does. Then call `kickDelivery` for each returned `pending` id AFTER
 * the transaction commits. A crash between commit and kick leaves a `pending`
 * row with `next_attempt_at = now`, which the sweeper recovers.
 *
 * Throws when the insert fails — the caller's transaction must roll back
 * (plan finding A7: the old fire-and-forget insert lost the row with only a
 * `console.warn`).
 *
 * On signing failure (no secret found), the row is still inserted in
 * `auth_failed` status so the operator has an audit trail; the caller reports
 * that transition after commit via the returned status.
 */
export async function insertCallbackDelivery(
  envelope: BaseEnvelope,
  opts: EnqueueOptions,
  deps: { db: DbOrTx; clock?: () => Date },
): Promise<InsertedDelivery> {
  const db = deps.db;
  const clock = deps.clock ?? (() => new Date());

  const secret = opts.apiKeyId ? resolveCallbackSecret(opts.apiKeyId) : null;
  if (!secret) {
    // No apiKeyId captured at enqueue (legacy row), or the key has no secret.
    // Request-time validation (`assertCallbackSecretFor`) makes this rare;
    // a key rotated out between request and completion still lands here.
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
        lastError: opts.apiKeyId
          ? 'no callbackSecret configured for this apiKeyId'
          : 'no apiKeyId captured at enqueue time',
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

  return { deliveryId: row[0]!.id, status: 'pending' };
}

/**
 * Post-commit half of the outbox: report an `auth_failed` insert, or start the
 * first attempt of a `pending` one. Never throws and never awaits the POST —
 * a terminal transition must not block on a slow receiver.
 */
export function kickDelivery(
  inserted: InsertedDelivery,
  envelope: BaseEnvelope,
  opts: EnqueueOptions,
  deps: EnqueueDeps = {},
): void {
  const log = deps.logger ?? emitLog;
  if (inserted.status === 'auth_failed') {
    reportDeliveryTransition(
      log,
      {
        id: inserted.deliveryId,
        org: opts.org,
        project: opts.project ?? null,
        source: opts.source,
        sourceId: opts.sourceId,
        itemKey: opts.itemKey ?? null,
        event: envelope.event,
      },
      'auth_failed',
      {
        attempt: 0,
        lastError: opts.apiKeyId
          ? 'no callbackSecret configured for this apiKeyId'
          : 'no apiKeyId captured at enqueue time',
      },
    );
    return;
  }
  const db = deps.db ?? defaultDb;
  const fetcher = deps.fetcher ?? fetch;
  const clock = deps.clock ?? (() => new Date());
  const deliveryId = inserted.deliveryId;
  setImmediate(() => {
    void attemptDelivery(deliveryId, { db, fetcher, clock, logger: log }).catch((err) => {
      // The row stays `pending` with `next_attempt_at` in the past, so the
      // sweeper re-claims it after its grace period. ERROR, not warn: this is
      // a delivery that did not happen when it should have.
      log.error(
        { deliveryId, err },
        'callback emit: initial attempt threw; the sweeper will retry it',
      );
    });
  });
}

/**
 * Persist a `callback_deliveries` row and kick off the first delivery
 * attempt. The returned promise resolves once the row is inserted; the POST
 * happens asynchronously. Rejects when the insert fails — callers must not
 * swallow that (see `insertCallbackDelivery`).
 *
 * Callers that write the event's source rows in a transaction should use
 * `insertCallbackDelivery` inside it plus `kickDelivery` after commit instead.
 */
export async function enqueueCallback(
  envelope: BaseEnvelope,
  opts: EnqueueOptions,
  deps: EnqueueDeps = {},
): Promise<InsertedDelivery> {
  const db = deps.db ?? defaultDb;
  const inserted = await insertCallbackDelivery(envelope, opts, {
    db,
    ...(deps.clock ? { clock: deps.clock } : {}),
  });
  kickDelivery(inserted, envelope, opts, { ...deps, db });
  return inserted;
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
    logger?: ComponentLogger;
  },
): Promise<void> {
  const db = deps.db ?? defaultDb;
  const fetcher = deps.fetcher;
  const clock = deps.clock;
  const log = deps.logger ?? emitLog;

  // Load current row state. Another worker may have advanced it; treat the
  // row's `attempt` as the canonical source.
  const rows = await db
    .select()
    .from(callbackDeliveries)
    .where(eq(callbackDeliveries.id, deliveryId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    log.warn({ deliveryId }, 'callback emit: delivery row missing; attempt aborted');
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
      const lastError = row.apiKeyId
        ? `no callbackSecret configured for apiKeyId ${row.apiKeyId} at attempt time (rotated out?)`
        : 'no apiKeyId on delivery row; cannot re-sign this attempt';
      await db
        .update(callbackDeliveries)
        .set({
          status: 'auth_failed',
          nextAttemptAt: null,
          lastError,
          updatedAt: failedAt,
        })
        .where(eq(callbackDeliveries.id, deliveryId));
      reportDeliveryTransition(log, row, 'auth_failed', { attempt: row.attempt, lastError });
      return;
    }
    const signed = signBody(row.body, secret, clock());
    sentAtUnix = signed.signedAtUnix;
    sentSignature = signed.signature;
    resigned = true;
  }

  // SSRF guard (audit finding [HIGH] SSRF): re-validate the target URL
  // immediately before EVERY attempt — this also covers URLs sourced from
  // `project_configs.callback_url` and catches DNS rebinding between enqueue
  // and delivery. A blocked URL is a permanent failure, not a retry.
  try {
    await assertSafeCallbackUrl(row.url);
  } catch {
    const blockedAt = clock();
    await db
      .update(callbackDeliveries)
      .set({
        status: 'failed',
        nextAttemptAt: null,
        lastError: 'callback url blocked (ssrf guard)',
        updatedAt: blockedAt,
      })
      .where(eq(callbackDeliveries.id, deliveryId));
    reportDeliveryTransition(log, row, 'failed', {
      attempt: row.attempt,
      lastError: 'callback url blocked (ssrf guard)',
    });
    return;
  }

  let response: Response | null = null;
  let networkError: Error | null = null;
  try {
    response = await fetcher(row.url, {
      method: 'POST',
      // Never follow redirects: a public 200-range host 302ing to an internal
      // address would bypass the pre-fetch SSRF guard above. A redirect
      // response surfaces as a fetch error -> normal retry/dead-letter path.
      redirect: 'error',
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

  if (nextStatus !== 'pending') {
    reportDeliveryTransition(log, row, nextStatus, {
      attempt: nextAttempt,
      responseStatus,
      lastError,
    });
  }

  // Schedule the next attempt if applicable.
  if (nextStatus === 'pending' && nextAttemptAt) {
    const delayMs = Math.max(0, nextAttemptAt.getTime() - now.getTime());
    setTimeout(() => {
      void attemptDelivery(deliveryId, deps).catch((err) => {
        log.error(
          {
            deliveryId,
            attempt: nextAttempt + 1,
            err,
          },
          'callback emit: scheduled attempt threw; the sweeper will retry it',
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
  db: DbOrTx,
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
