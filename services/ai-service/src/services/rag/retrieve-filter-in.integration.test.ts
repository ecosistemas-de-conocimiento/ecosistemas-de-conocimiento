// Integration test for the `$in` metadata-filter operator and the per-corpus
// `corpusFilters` on /v1/retrieve/multi, against a real Postgres.
//
// The scenario is the consumer's: a chat retrieves from a SHARED corpus plus a
// per-user DRAFTS corpus, and from drafts it may only see the documents attached
// to this conversation (`metadata.docId` in an allowed set).
//
// What makes each mode's assertion meaningful: every draft chunk has the SAME
// dense vector as the query and contains the query word, so with no filter
// EVERY leg (dense, tsvector lexical, learned-sparse) returns every draft chunk.
// The baseline asserts that, and asserts the legs that contributed, so a leg
// that silently ignored the filter would leak a disallowed chunk into the fused
// result here. Filtering must happen inside each leg's SQL, before ranking.
//
// Wiring mirrors retrieve.integration.test.ts: TEST_* DB rebound by
// integration-setup.ts, RAG tables wiped per test, embedders injected and
// deterministic (zero network). Injecting a sparse embedder forces the sparse
// leg on in place of the tsvector leg — that is how "hybrid + sparse" is reached.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { RetrieveService, type Embedder } from './retrieve.js';
import { RetrieveMultiService } from './retrieve-multi.js';
import type { SparseEmbedder } from '../ai/embeddings/sparse-embed.js';
import type { LLMRouter } from '../ai/router/types.js';

const ORG = 'acme';
const PROJECT = 'chat';
const CTX = { org: ORG, project: PROJECT };
const SPARSE_DIM = 250002; // must match chunks.sparse_embedding sparsevec(N)

function hot(dim: number): number[] {
  const v = new Array(1024).fill(0);
  v[dim] = 1;
  return v;
}

const embedder: Embedder = (async ({ model }: { model: string }) => ({
  embeddings: [hot(0)],
  model,
  usage: { inputTokens: 1, estimatedCostUsd: 0 },
})) as unknown as Embedder;

const sparseEmbedder: SparseEmbedder = async ({ model }) => ({
  model,
  dense: [],
  sparse: [{ indices: [10], values: [1] }],
});

/** Draft chunks: docId → metadata. `n` has no metadata at all. */
const DRAFTS: Array<{ text: string; metadata: Record<string, unknown> | null }> = [
  { text: 'budget draft twelve', metadata: { docId: '12', kind: 'draft' } },
  { text: 'budget draft thirtyfour', metadata: { docId: '34', kind: 'draft' } },
  { text: 'budget draft fiftysix', metadata: { docId: '56', kind: 'draft' } },
  { text: 'budget draft numeric', metadata: { docId: 78, kind: 'draft' } },
  { text: 'budget draft nometa', metadata: null },
];
const SHARED = [
  { text: 'budget shared alpha', metadata: { docId: 'S1' } },
  { text: 'budget shared beta', metadata: null },
];
const ALL_DRAFTS = DRAFTS.map((d) => d.text).sort();

type Mode = 'dense' | 'hybrid' | 'hybrid+sparse' | 'hybrid+trigram';
const MODES: Mode[] = ['dense', 'hybrid', 'hybrid+sparse', 'hybrid+trigram'];

/** The legs a full (unfiltered) response must report per mode. */
const EXPECTED_LEGS: Record<Mode, string[]> = {
  dense: ['dense'],
  hybrid: ['dense', 'lexical'],
  'hybrid+sparse': ['dense', 'sparse'],
  'hybrid+trigram': ['dense', 'trigram'],
};

function serviceFor(mode: Mode, db: never) {
  return new RetrieveService({
    db,
    embedder,
    ...(mode === 'hybrid+sparse' ? { sparseEmbedder } : {}),
    // The opt-in pg_trgm leg (`HYBRID_LEXICAL_LEG=trigram`). Pinned here rather
    // than read from env so this mode runs whatever the test env sets.
    ...(mode === 'hybrid+trigram' ? { lexicalLeg: 'trigram' as const } : {}),
  });
}
const wireMode = (mode: Mode) => (mode === 'dense' ? 'dense' : 'hybrid');

describe('retrieve metadata filter `$in` (integration)', () => {
  afterAll(async () => {
    const { closeDb } = await import('../../db/client.js');
    await closeDb().catch(() => undefined);
  });

  beforeEach(async () => {
    const { db } = await import('../../db/client.js');
    await db.execute(sql`TRUNCATE TABLE chunks, documents, corpora RESTART IDENTITY CASCADE`);
    await seed('drafts', DRAFTS);
    await seed('shared', SHARED);
  });

  async function seed(
    name: string,
    rows: Array<{ text: string; metadata: Record<string, unknown> | null }>,
  ) {
    const { db } = await import('../../db/client.js');
    const { chunks, corpora, documents } = await import('../../db/schema/index.js');
    const corpusId = (
      await db.insert(corpora).values({ org: ORG, project: PROJECT, name }).returning({ id: corpora.id })
    )[0]!.id;
    const docs = await db
      .insert(documents)
      .values(rows.map((r) => ({ corpusId, org: ORG, project: PROJECT, externalId: r.text, text: r.text })))
      .returning({ id: documents.id, externalId: documents.externalId });
    await db.insert(chunks).values(
      rows.map((r) => ({
        documentId: docs.find((d) => d.externalId === r.text)!.id,
        corpusId,
        org: ORG,
        project: PROJECT,
        ordinal: 0,
        text: r.text,
        embedding: hot(0),
        metadata: r.metadata,
      })),
    );
    // What the ingest worker writes after insert: the tsvector and the sparse vector.
    await db.execute(sql`
      UPDATE "chunks" SET
        "text_search" = to_tsvector('simple'::regconfig, "text"),
        "sparse_embedding" = ${`{11:0.25}/${SPARSE_DIM}`}::sparsevec
      WHERE "corpus_id" = ${corpusId}::uuid
    `);
  }

  for (const mode of MODES) {
    describe(`mode: ${mode}`, () => {
      it('baseline: no filter returns every draft chunk, through every leg', async () => {
        const { db } = await import('../../db/client.js');
        const out = await serviceFor(mode, db as never).retrieve(
          { corpus: 'drafts', query: 'budget', mode: wireMode(mode) },
          CTX,
        );
        expect(out.chunks.map((c) => c.text).sort()).toEqual(ALL_DRAFTS);
        expect([...(out.legs ?? [])].sort()).toEqual(EXPECTED_LEGS[mode]);
        if (mode !== 'dense') {
          // Every chunk was found by the lexical/sparse leg too, so that leg
          // alone could have leaked any of them.
          expect(out.chunks.every((c) => c.lexicalScore !== undefined)).toBe(true);
        }
      });

      it('$in returns ONLY the allowed docIds', async () => {
        const { db } = await import('../../db/client.js');
        const out = await serviceFor(mode, db as never).retrieve(
          {
            corpus: 'drafts',
            query: 'budget',
            mode: wireMode(mode),
            filter: { docId: { $in: ['12', '34'] } },
          },
          CTX,
        );
        expect(out.chunks.map((c) => c.text).sort()).toEqual([
          'budget draft thirtyfour',
          'budget draft twelve',
        ]);
      });

      it('asOf excludes a superseded chunk on every leg', async () => {
        const { db } = await import('../../db/client.js');
        // Every leg returns every draft chunk unfiltered (baseline above), so a
        // leg that skipped the validity predicate would carry the expired chunk
        // into the fused result on its own.
        await db.execute(sql`
          UPDATE "chunks" SET "valid_to" = '2020-01-01T00:00:00Z'::timestamptz
          WHERE "text" = 'budget draft twelve'
        `);
        const out = await serviceFor(mode, db as never).retrieve(
          { corpus: 'drafts', query: 'budget', mode: wireMode(mode), asOf: '2026-01-01T00:00:00Z' },
          CTX,
        );
        expect(out.chunks.map((c) => c.text).sort()).toEqual(
          ALL_DRAFTS.filter((t) => t !== 'budget draft twelve'),
        );
        expect([...(out.legs ?? [])].sort()).toEqual(EXPECTED_LEGS[mode]);
      });

      it('$in is type-sensitive like jsonb: number 78 matches 78, string "78" does not', async () => {
        const { db } = await import('../../db/client.js');
        const svc = serviceFor(mode, db as never);
        const asNumber = await svc.retrieve(
          { corpus: 'drafts', query: 'budget', mode: wireMode(mode), filter: { docId: { $in: [78] } } },
          CTX,
        );
        expect(asNumber.chunks.map((c) => c.text)).toEqual(['budget draft numeric']);
        const asString = await svc.retrieve(
          { corpus: 'drafts', query: 'budget', mode: wireMode(mode), filter: { docId: { $in: ['78'] } } },
          CTX,
        );
        expect(asString.chunks).toEqual([]);
      });

      it('$in ANDs with plain containment keys', async () => {
        const { db } = await import('../../db/client.js');
        const svc = serviceFor(mode, db as never);
        const hit = await svc.retrieve(
          {
            corpus: 'drafts',
            query: 'budget',
            mode: wireMode(mode),
            filter: { kind: 'draft', docId: { $in: ['56', 'missing'] } },
          },
          CTX,
        );
        expect(hit.chunks.map((c) => c.text)).toEqual(['budget draft fiftysix']);
        const miss = await svc.retrieve(
          {
            corpus: 'drafts',
            query: 'budget',
            mode: wireMode(mode),
            filter: { kind: 'final', docId: { $in: ['56'] } },
          },
          CTX,
        );
        expect(miss.chunks).toEqual([]);
      });

      it('multi: corpusFilters restricts drafts and leaves shared unfiltered, in one fused call', async () => {
        const { db } = await import('../../db/client.js');
        const multi = new RetrieveMultiService({
          db: db as never,
          retrieveService: serviceFor(mode, db as never),
          router: { route: async () => { throw new Error('no rewrite expected'); } } as unknown as LLMRouter,
        });
        const out = await multi.retrieveMulti(
          {
            corpora: ['shared', 'drafts'],
            query: 'budget',
            mode: wireMode(mode),
            topK: 10,
            limit: 20,
            corpusFilters: { drafts: { docId: { $in: ['12', '34'] } } },
          },
          CTX,
        );
        const byCorpus = (name: string) =>
          out.chunks.filter((c) => c.corpus === name).map((c) => c.text).sort();
        expect(byCorpus('drafts')).toEqual(['budget draft thirtyfour', 'budget draft twelve']);
        expect(byCorpus('shared')).toEqual(['budget shared alpha', 'budget shared beta']);
      });
    });
  }
});
