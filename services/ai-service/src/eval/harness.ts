// Eval harness wiring: build a corpus, ingest the fixtures through the REAL
// ingest path, and hand back a `RetrieveService` plus the id mapping the
// runner needs.
//
// It drives `processIngestJob` — the actual BullMQ worker body — rather than
// re-implementing chunk/embed/insert. That matters: a harness that inserts
// chunks its own way measures the harness, not the service. Going through the
// worker means the eval exercises the structural chunker, the chunk-metadata
// merge, the validity denormalisation and the tsvector build exactly as
// production does.
//
// The embedder is injected (`fixtureEmbedder`), so a full run makes ZERO
// network calls and costs nothing.

import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { corpora, documents } from '../db/schema/index.js';
import type { Reranker } from '../services/ai/rerank/rerank-client.js';
import { RetrieveService, type Embedder } from '../services/rag/retrieve.js';
import { processIngestJob } from '../workers/ingest.worker.js';
import { fixtureEmbedder } from './fixture-embedder.js';
import type { FixtureDoc } from './types.js';

export interface HarnessOptions {
  db: Db;
  org: string;
  project: string;
  /** Corpus name to create. */
  corpus: string;
  /**
   * The documents to ingest. REQUIRED and unopinionated: the harness is
   * machinery and never reaches for a particular fixture set, so a caller can
   * point it at any corpus content without this module learning about it.
   */
  docs: FixtureDoc[];
  /** `recursive-char` (the historical default) or `structural`. */
  chunkStrategy?: string;
  /**
   * `corpora.chunk_config` — strategy options, supplied by the CALLER. For the
   * structural strategy this is the `{ sections, subSections?, … }` shape the
   * corpus owner would store on its own corpus row; the service ships no
   * document-format presets of its own.
   */
  chunkConfig?: Record<string, unknown> | null;
  chunkSize?: number;
  chunkOverlap?: number;
  /**
   * Postgres text search configuration for the lexical leg. REQUIRED: it
   * depends on the language of `docs`, which only the caller knows.
   */
  textSearchConfig: string;
  /**
   * Embedder used for BOTH ingest and the returned service's query embedding —
   * they MUST match. Defaults to the offline `fixtureEmbedder` (zero network,
   * zero cost, CI-safe). A GATED real-embedder run injects `realEmbedder` here.
   */
  embedder?: Embedder;
  /**
   * The `corpora.embedding_model` stamped on the corpus. Must name the model
   * `embedder` actually uses so the query is embedded consistently with the
   * index. Defaults to `'fixture/deterministic'` (the fixture embedder). A real
   * run passes the real model id (e.g. `baai/bge-m3`).
   */
  embeddingModel?: string;
  /**
   * Optional cross-encoder reranker injected into the returned service. Passing
   * one FORCES rerank availability (bypasses the `RERANK_ENABLED`/`RERANK_URL`
   * env gate), so a config with `rerank: true` exercises the rerank rung
   * offline. Absent ⇒ the service has no reranker and `rerank` requests no-op.
   */
  reranker?: Reranker;
}

export interface Harness {
  service: RetrieveService;
  corpusId: string;
  /** `documents.id` (uuid) → `documents.external_id`. */
  resolveDocId: (documentId: string) => string | undefined;
  chunkCount: number;
}

/** Drop every corpus/document/chunk in scope so a run starts from a known state. */
export async function resetEvalCorpus(db: Db, org: string, project: string): Promise<void> {
  await db.execute(sql`
    DELETE FROM "chunks" WHERE "org" = ${org} AND "project" = ${project}
  `);
  await db.execute(sql`
    DELETE FROM "documents" WHERE "org" = ${org} AND "project" = ${project}
  `);
  await db.execute(sql`
    DELETE FROM "corpora" WHERE "org" = ${org} AND "project" = ${project}
  `);
}

export async function buildHarness(opts: HarnessOptions): Promise<Harness> {
  const {
    db,
    org,
    project,
    corpus,
    docs,
    textSearchConfig,
    chunkStrategy = 'recursive-char',
    chunkConfig = null,
    chunkSize = 800,
    chunkOverlap = 100,
    embedder = fixtureEmbedder,
    embeddingModel = 'fixture/deterministic',
    reranker,
  } = opts;

  const inserted = await db
    .insert(corpora)
    .values({
      org,
      project,
      name: corpus,
      embeddingModel,
      embeddingDim: 1024,
      chunkStrategy,
      chunkConfig,
      chunkSize,
      chunkOverlap,
      textSearchConfig,
    })
    .returning({ id: corpora.id });
  const corpusId = inserted[0]!.id;

  // One ingest job per fixture doc, through the real worker.
  const ingestId = randomUUID();
  for (const doc of docs) {
    await processIngestJob(
      {
        id: `eval-${doc.externalId}`,
        data: {
          ingestId,
          corpusId,
          org,
          project,
          externalId: doc.externalId,
          text: doc.text,
          title: doc.title,
          metadata: doc.metadata,
          ...(doc.validFrom !== undefined ? { validFrom: doc.validFrom } : {}),
          ...(doc.validTo !== undefined ? { validTo: doc.validTo } : {}),
        },
      },
      { db, embedder },
    );
  }

  const docRows = await db
    .select({ id: documents.id, externalId: documents.externalId })
    .from(documents)
    .where(eq(documents.corpusId, corpusId));
  const idMap = new Map<string, string>();
  for (const r of docRows) if (r.externalId) idMap.set(r.id, r.externalId);

  const countRows = await db.execute(sql`
    SELECT count(*)::int AS n FROM "chunks" WHERE "corpus_id" = ${corpusId}::uuid
  `);
  const chunkCount = Number(
    (Array.isArray(countRows) ? countRows[0] : (countRows as { rows?: unknown[] }).rows?.[0])?.[
      'n' as never
    ] ?? 0,
  );

  return {
    service: new RetrieveService({
      db,
      embedder,
      ...(reranker !== undefined ? { reranker } : {}),
    }),
    corpusId,
    resolveDocId: (documentId: string) => idMap.get(documentId),
    chunkCount,
  };
}
