// scripts/smoke-callback.ts — end-to-end smoke for the ingest-callback wire.
//
// What this script does (per rollout-plan §Sa, "Verification before reporting
// done" #6):
//   1. Spins up an in-process Fastify "echo" receiver on a random port that
//      captures every POST it receives (headers + raw body).
//   2. Boots the real ai-service (`buildServer()` + `startWorkers()`) in the
//      same process so the ingest worker runs the actual emit code path.
//   3. POSTs a small `/v1/ingest` batch with `callbackUrl` set to the echo
//      receiver. The MOCK_LLM stub fakes embeddings deterministically — no
//      OpenRouter spend.
//   4. Waits up to 30s for the echo receiver to capture N callbacks (N =
//      docs.length, one `ingest.completed` per doc).
//   5. For every captured callback, re-derives the HMAC over `${timestamp}.${rawBody}`
//      and asserts it matches the `X-AIService-Signature` header — i.e. the
//      receiver-side verify code path from `callback-contract.md` succeeds.
//   6. Tears down workers + echo server + DB + Redis, then exits with code 0
//      on success / 1 on any assertion failure.
//
// Prerequisites: `pnpm infra:up` at the repo root (Postgres + Redis on the compose
// ports). The script applies migrations idempotently before running.
//
// Why a standalone script instead of an integration test? The ingest-worker
// path is asynchronous + crosses process boundaries (BullMQ + the fastify
// receiver), and that combination doesn't sit well inside vitest's setup
// timing. Keeping this as a one-shot tsx script lets the kickoff prompt's
// "Verification before reporting done" use a single command and a clear exit
// code.
//
// Usage:
//   pnpm --filter @edc/ai-service exec tsx scripts/smoke-callback.ts
//
// Env (with sensible defaults so a plain run works against `pnpm infra:up`):
//   DATABASE_URL           postgres://ai_service:ai_service@localhost:45432/ai_service
//   REDIS_URL              redis://localhost:56379

import { createHmac, randomBytes } from 'node:crypto';

import Fastify, { type FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Env rebind — MUST happen before any ai-service module loads `config/env.ts`.
// ---------------------------------------------------------------------------

process.env.DATABASE_URL ??=
  'postgres://ai_service:ai_service@localhost:45432/ai_service';
process.env.REDIS_URL ??= 'redis://localhost:56379';
process.env.NODE_ENV = 'development';
process.env.LOG_LEVEL ??= 'warn';
process.env.MOCK_LLM = '1';

// A fresh, in-memory API key for this smoke. The 64-hex-char secret matches
// the contract recommendation.
const SMOKE_API_KEY = `smoke-callback-${randomBytes(8).toString('hex')}`;
const SMOKE_CALLBACK_SECRET = randomBytes(32).toString('hex'); // 64 hex chars

process.env.API_KEYS = JSON.stringify({
  [SMOKE_API_KEY]: {
    org: 'smoke-org',
    project: 'smoke-project',
    role: 'admin',
    callbackSecret: SMOKE_CALLBACK_SECRET,
  },
});

// ---------------------------------------------------------------------------
// Captured callback shape
// ---------------------------------------------------------------------------

interface CapturedCallback {
  receivedAt: number;
  headers: Record<string, string>;
  rawBody: string;
  parsedBody: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Echo receiver — a Fastify server that captures every POST it gets.
// ---------------------------------------------------------------------------

async function startEchoReceiver(): Promise<{
  url: string;
  captured: CapturedCallback[];
  stop: () => Promise<void>;
}> {
  const captured: CapturedCallback[] = [];
  const app = Fastify({ logger: false });

  // We need the EXACT bytes the sender signed — Fastify's default JSON parser
  // re-serialises, so we install a raw-body content-type parser that hands
  // back the bytes verbatim.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      done(null, body);
    },
  );

  app.post('/callback', async (req, reply) => {
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      // Leave parsed empty; the smoke assertions inspect rawBody anyway.
    }
    captured.push({
      receivedAt: Date.now(),
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [
          k.toLowerCase(),
          Array.isArray(v) ? v[0] ?? '' : String(v ?? ''),
        ]),
      ),
      rawBody,
      parsedBody: parsed,
    });
    return reply.code(200).send({ ok: true });
  });

  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  return {
    url: `${address}/callback`,
    captured,
    stop: async () => {
      await app.close().catch(() => undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// HMAC verify helper — mirrors what a contract-compliant receiver does.
// ---------------------------------------------------------------------------

function verifySignature(
  rawBody: string,
  timestampHeader: string,
  signatureHeader: string,
  secret: string,
): { ok: boolean; reason: string } {
  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) return { ok: false, reason: 'bad-timestamp' };
  const skew = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (skew > 300) return { ok: false, reason: 'stale-timestamp' };

  const message = `${timestampHeader}.${rawBody}`;
  const expected = createHmac('sha256', secret).update(message).digest('hex');
  if (expected.length !== signatureHeader.length) {
    return { ok: false, reason: 'length-mismatch' };
  }
  // Manual constant-time compare to avoid Buffer typing on a deferred-tooling
  // codepath. The signature is hex-only; length check above guards.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  }
  return diff === 0 ? { ok: true, reason: 'match' } : { ok: false, reason: 'signature-mismatch' };
}

// ---------------------------------------------------------------------------
// Mock embedder — stays self-contained, matches the
// `callOpenRouterEmbedding` signature shape so the worker accepts it.
// ---------------------------------------------------------------------------

function makeMockEmbedder() {
  return async ({ model, input }: { model: string; input: string | string[] }) => {
    const items = Array.isArray(input) ? input : [input];
    // 1536-dim 0-filled vectors. The ingest worker writes these into chunks
    // and the embedding column type is `vector(1536)`.
    const embeddings = items.map(() => new Array(1536).fill(0));
    return {
      embeddings,
      model,
      usage: { inputTokens: items.length * 4, estimatedCostUsd: 0 },
    };
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const failures: string[] = [];

  // Apply migrations idempotently so a fresh `pnpm infra:up` works.
  console.log('[smoke-callback] applying migrations…');
  const postgres = (await import('postgres')).default;
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const { migrate } = await import('drizzle-orm/postgres-js/migrator');
  const client = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const dbm = drizzle(client);
    await migrate(dbm, { migrationsFolder: './drizzle' });
  } finally {
    await client.end({ timeout: 5 }).catch(() => undefined);
  }

  console.log('[smoke-callback] starting echo receiver…');
  const echo = await startEchoReceiver();

  console.log('[smoke-callback] booting ai-service in-process…');
  const { buildServer } = await import('../src/server.js');
  const { startWorkers } = await import('../src/workers/index.js');
  const app = await buildServer();
  await app.ready();
  const aiServiceAddress = await app.listen({ port: 0, host: '127.0.0.1' });
  const workers = await startWorkers({ embedder: makeMockEmbedder() as never });

  const DOCS = [
    { id: 'smoke-doc-1', text: 'alpha smoke document for callback' },
    { id: 'smoke-doc-2', text: 'beta smoke document for callback' },
  ];
  const CORPUS = `smoke-callback-${Date.now()}`;

  try {
    console.log(`[smoke-callback] POST /v1/ingest → ai-service @ ${aiServiceAddress}`);
    const ingestRes = await fetch(`${aiServiceAddress}/v1/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SMOKE_API_KEY}`,
      },
      body: JSON.stringify({
        corpus: CORPUS,
        documents: DOCS,
        callbackUrl: echo.url,
      }),
    });
    const ingestBody = (await ingestRes.json()) as { ingestId?: string };
    if (ingestRes.status !== 202 || !ingestBody.ingestId) {
      throw new Error(
        `expected 202 from /v1/ingest, got ${ingestRes.status}: ${JSON.stringify(ingestBody)}`,
      );
    }
    console.log(`[smoke-callback] ingest enqueued: ingestId=${ingestBody.ingestId}`);

    // Wait up to 30s for N callbacks (one per doc).
    const deadline = Date.now() + 30_000;
    while (echo.captured.length < DOCS.length && Date.now() < deadline) {
      await sleep(250);
    }

    if (echo.captured.length < DOCS.length) {
      failures.push(
        `expected ${DOCS.length} callbacks within 30s, got ${echo.captured.length}`,
      );
    } else {
      console.log(`[smoke-callback] captured ${echo.captured.length} callback(s)`);
    }

    // Verify each captured callback.
    for (const cb of echo.captured) {
      const ts = cb.headers['x-aiservice-timestamp'];
      const sig = cb.headers['x-aiservice-signature'];
      const evt = cb.headers['x-aiservice-event'];
      if (!ts || !sig || !evt) {
        failures.push(
          `missing required header on callback: ts=${!!ts} sig=${!!sig} evt=${!!evt}`,
        );
        continue;
      }
      if (evt !== 'ingest.completed') {
        failures.push(`expected event=ingest.completed, got event=${evt}`);
      }
      const verify = verifySignature(cb.rawBody, ts, sig, SMOKE_CALLBACK_SECRET);
      if (!verify.ok) {
        failures.push(`signature verify failed: reason=${verify.reason} body=${cb.rawBody}`);
      }
      // Sanity: the body carries the ingest event shape.
      if (cb.parsedBody.event !== 'ingest.completed') {
        failures.push(
          `body.event mismatch: expected ingest.completed, got ${String(cb.parsedBody.event)}`,
        );
      }
      if (typeof cb.parsedBody.docId !== 'string') {
        failures.push(`body.docId missing or non-string: ${JSON.stringify(cb.parsedBody.docId)}`);
      }
    }
  } finally {
    console.log('[smoke-callback] tearing down…');
    await workers.stop().catch(() => undefined);
    await app.close().catch(() => undefined);
    await echo.stop().catch(() => undefined);
    const { closeDb } = await import('../src/db/client.js');
    const { closeRedis } = await import('../src/queue/connection.js');
    await Promise.allSettled([closeDb(), closeRedis()]);
  }

  if (failures.length > 0) {
    console.error('[smoke-callback] FAILED:');
    for (const f of failures) {
      console.error(`  - ${f}`);
    }
    process.exit(1);
  }
  console.log('[smoke-callback] OK');
  process.exit(0);
}

main().catch((err) => {
  console.error('[smoke-callback] fatal:', err);
  process.exit(1);
});

// Suppress an unused-import lint when this script is loaded by the TypeScript
// compiler (the symbol is referenced only inside the receiver type def).
export type _SmokeReceiverApp = FastifyInstance;
