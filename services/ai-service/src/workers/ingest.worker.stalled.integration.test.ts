// Stalled INGEST job double-execution test (real Postgres + real Redis + real
// BullMQ).
//
// ── The defect ─────────────────────────────────────────────────────────────
// BullMQ's worker holds a per-job lock and renews it on a timer. When the
// renewal misses — a blocked event loop, a paused container — the stalled
// checker moves the job back to `wait` and a SECOND worker runs it. On the
// ingest queue that meant the same document was chunked twice, EMBEDDED twice
// (a second real charge, a second `usage_logs` row) and, on the
// `externalId === null` path where there is no dedupe key at all, inserted as a
// SECOND `documents` row with a second complete set of chunks — the corpus then
// answering a retrieve with the same passage twice, with nothing downstream
// able to tell the copies apart.
//
// The dimension guard and the pre-insert sparse embed in the worker already
// stopped duplicates from a THROWN error. Neither helps here: this delivery
// does not fail, it succeeds twice.
//
// ── How the stall is reproduced deterministically ──────────────────────────
// SIGSTOP is not available to a test, but its effect is: the fake embedder
// BLOCKS THE EVENT LOOP synchronously on its first call. A blocked event loop
// cannot fire the lock-renewal timer, which is exactly the production failure.
// `lockDuration` / `stalledInterval` are patched down to milliseconds through
// `startIngestWorker({ runtime })` so one stall fits inside a test timeout.
//
// ── What is asserted ───────────────────────────────────────────────────────
//   1. exactly ONE `documents` row for the ingest (⇒ no duplicate document)
//   2. exactly ONE set of chunks
//   3. exactly ONE embedding charge (`usage_logs` row) and ONE embedder call
//   4. the `ingest_jobs` row is `completed` with `attempts` = 1
//   5. `ingest_requests.completed_docs` = 1
//
// ⚠ TWO workers on ONE queue is the whole point; do not "simplify" this to a
// single worker calling `processIngestJob` twice. The re-delivery has to come
// from BullMQ for the test to describe the real failure.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

import {
  chunks,
  corpora,
  documents,
  ingestJobs,
  ingestRequests,
  usageLogs,
} from '../db/schema/index.js';
import { INGEST_QUEUE_NAME, type IngestJobData } from '../queue/queues.js';
import { startIngestWorker } from './ingest.worker.js';
import type { Db } from '../db/client.js';
import type { callOpenRouterEmbedding } from '../services/ai/embeddings/openrouter.js';

const ORG = 'ingest-stalled-org';
const PROJECT = 'ingest-stalled-project';
const EMBED_DIM = 1024;

/** Lock window small enough that one blocked call outlives it. */
const LOCK_DURATION_MS = 700;
const STALLED_INTERVAL_MS = 300;
/** How long the first embedder call blocks the event loop. > 2 × lock window. */
const BLOCK_MS = 2_500;

/**
 * Embedder whose FIRST call blocks the event loop for `BLOCK_MS`. A busy-wait,
 * not a `setTimeout`: an await would let the lock-renewal timer run, which is
 * the opposite of the condition under test.
 */
function makeStallingEmbedder(): {
  embedder: typeof callOpenRouterEmbedding;
  callCount: () => number;
} {
  let calls = 0;
  const embedder = (async (opts: { model: string; input: string[] }) => {
    calls += 1;
    if (calls === 1) {
      const until = Date.now() + BLOCK_MS;
      // eslint-disable-next-line no-empty
      while (Date.now() < until) {}
    }
    return {
      embeddings: opts.input.map(() => Array.from({ length: EMBED_DIM }, () => 0.01)),
      usage: { inputTokens: 12, estimatedCostUsd: 0.000012 },
      model: opts.model,
    };
  }) as unknown as typeof callOpenRouterEmbedding;
  return { embedder, callCount: () => calls };
}

describe('ingest worker — a stalled job is not ingested twice (integration)', () => {
  let db: Db;

  beforeAll(async () => {
    ({ db } = await import('../db/client.js'));
  });

  afterAll(async () => {
    const { closeDb } = await import('../db/client.js');
    await closeDb().catch(() => undefined);
  });

  it('a stalled re-delivery produces ONE document, ONE set of chunks and ONE embedding charge', async () => {
    const corpusInsert = await db
      .insert(corpora)
      .values({
        org: ORG,
        project: PROJECT,
        name: 'stalled-corpus',
        embeddingModel: 'mock/embed',
        embeddingDim: EMBED_DIM,
      })
      .returning({ id: corpora.id });
    const corpusId = corpusInsert[0]!.id;

    const reqInsert = await db
      .insert(ingestRequests)
      .values({
        org: ORG,
        project: PROJECT,
        corpus: 'stalled-corpus',
        corpusId,
        status: 'queued',
        totalDocs: 1,
        startedAt: new Date(),
      })
      .returning({ id: ingestRequests.id });
    const ingestId = reqInsert[0]!.id;

    // `externalId: null` — the path with NO dedupe key, where a second run
    // inserts a second document rather than updating the first.
    const jobRowInsert = await db
      .insert(ingestJobs)
      .values({ org: ORG, project: PROJECT, ingestId, externalId: null, status: 'queued' })
      .returning({ id: ingestJobs.id });
    const jobRowId = jobRowInsert[0]!.id;

    const { embedder, callCount } = makeStallingEmbedder();
    const runtime = {
      lockDuration: LOCK_DURATION_MS,
      stalledInterval: STALLED_INTERVAL_MS,
      maxStalledCount: 1,
    };

    // A real BullMQ queue and the real connection the workers are handed. A
    // test Runtime hands back an in-memory mock queue under NODE_ENV=test,
    // which would never reach a worker.
    const redis = new Redis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });
    const queue = new Queue(INGEST_QUEUE_NAME, { connection: redis });

    // TWO workers on ONE queue. W1 takes the job and blocks; the stalled
    // checker re-delivers it and W2 picks it up while W1 is still inside its
    // (blocked) processor.
    const w1 = await startIngestWorker({ connection: redis, db, embedder, runtime, concurrency: 1 });
    const w2 = await startIngestWorker({ connection: redis, db, embedder, runtime, concurrency: 1 });

    try {
      const data: IngestJobData = {
        ingestId,
        jobId: jobRowId,
        corpusId,
        org: ORG,
        project: PROJECT,
        externalId: null,
        text: 'The quick brown fox jumps over the lazy dog. '.repeat(20),
      };
      await queue.add(`${INGEST_QUEUE_NAME}:${ORG}`, data, {
        attempts: 1,
        removeOnComplete: false,
        removeOnFail: false,
      });

      // Wait for the job row to settle, then give the stalled re-delivery a
      // further window to land whatever it was going to land.
      const deadline = Date.now() + 20_000;
      let status = 'queued';
      while (Date.now() < deadline) {
        const rows = await db
          .select({ status: ingestJobs.status })
          .from(ingestJobs)
          .where(eq(ingestJobs.id, jobRowId))
          .limit(1);
        status = String(rows[0]?.status);
        if (status === 'completed' || status === 'failed') break;
        await new Promise((r) => setTimeout(r, 200));
      }
      await new Promise((r) => setTimeout(r, 2_000));

      // 1. ONE document. Asserted first: on the null-externalId path a second
      // run inserts, it does not update, so two rows here IS the duplicate.
      const docRows = await db
        .select({ id: documents.id })
        .from(documents)
        .where(eq(documents.ingestId, ingestId));
      expect(docRows).toHaveLength(1);

      // 2. ONE set of chunks, all belonging to that one document.
      const chunkRows = await db
        .select({ id: chunks.id, documentId: chunks.documentId })
        .from(chunks)
        .where(eq(chunks.documentId, docRows[0]!.id));
      expect(chunkRows.length).toBeGreaterThan(0);
      const allChunks = await db
        .select({ id: chunks.id })
        .from(chunks)
        .where(eq(chunks.corpusId, corpusId));
      expect(allChunks).toHaveLength(chunkRows.length);

      // 3. ONE embedding charge, and the model really was called once.
      expect(callCount()).toBe(1);
      const usageRows = await db
        .select({ id: usageLogs.id })
        .from(usageLogs)
        .where(eq(usageLogs.org, ORG));
      expect(usageRows).toHaveLength(1);

      // 4. Claimed exactly once, settled once.
      const finalJob = await db
        .select({ status: ingestJobs.status, attempts: ingestJobs.attempts })
        .from(ingestJobs)
        .where(eq(ingestJobs.id, jobRowId))
        .limit(1);
      expect(finalJob[0]!.status).toBe('completed');
      expect(finalJob[0]!.attempts).toBe(1);

      // 5. The batch counter moved once — a double-run overshot it.
      const finalReq = await db
        .select({
          completedDocs: ingestRequests.completedDocs,
          failedDocs: ingestRequests.failedDocs,
          status: ingestRequests.status,
        })
        .from(ingestRequests)
        .where(eq(ingestRequests.id, ingestId))
        .limit(1);
      expect(finalReq[0]!.completedDocs).toBe(1);
      expect(finalReq[0]!.failedDocs).toBe(0);
      expect(finalReq[0]!.status).toBe('completed');
    } finally {
      await queue.close().catch(() => undefined);
      await redis.quit().catch(() => undefined);
      await w1.stop().catch(() => undefined);
      await w2.stop().catch(() => undefined);
    }
  }, 60_000);

  /**
   * The claim's other half, on real Postgres: a delivery whose row is already
   * settled must do NOTHING — not re-embed, not insert.
   */
  it('a delivery whose job row is already `completed` does no work at all', async () => {
    const corpusInsert = await db
      .insert(corpora)
      .values({
        org: ORG,
        project: PROJECT,
        name: 'late-writer-corpus',
        embeddingModel: 'mock/embed',
        embeddingDim: EMBED_DIM,
      })
      .returning({ id: corpora.id });
    const corpusId = corpusInsert[0]!.id;

    const reqInsert = await db
      .insert(ingestRequests)
      .values({
        org: ORG,
        project: PROJECT,
        corpus: 'late-writer-corpus',
        corpusId,
        status: 'completed',
        totalDocs: 1,
        completedDocs: 1,
        startedAt: new Date(),
      })
      .returning({ id: ingestRequests.id });
    const ingestId = reqInsert[0]!.id;

    const jobRowInsert = await db
      .insert(ingestJobs)
      .values({
        org: ORG,
        project: PROJECT,
        ingestId,
        status: 'completed',
        attempts: 1,
        finishedAt: new Date(),
      })
      .returning({ id: ingestJobs.id });
    const jobRowId = jobRowInsert[0]!.id;

    const { embedder, callCount } = makeStallingEmbedder();
    const { processIngestJob } = await import('./ingest.worker.js');
    await processIngestJob(
      {
        id: 'late-1',
        data: {
          ingestId,
          jobId: jobRowId,
          corpusId,
          org: ORG,
          project: PROJECT,
          externalId: null,
          text: 'should never be embedded',
        },
      },
      { db, embedder },
    );

    expect(callCount()).toBe(0);
    const docRows = await db
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.ingestId, ingestId));
    expect(docRows).toHaveLength(0);
    const finalReq = await db
      .select({ completedDocs: ingestRequests.completedDocs })
      .from(ingestRequests)
      .where(eq(ingestRequests.id, ingestId))
      .limit(1);
    expect(finalReq[0]!.completedDocs).toBe(1);
  });
});
