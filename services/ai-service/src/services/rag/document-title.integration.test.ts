// Integration test for renaming documents without re-embedding them.
//
// The property under test: after the call, the document row, its metadata and
// every chunk's `metadata.title` carry the new title, retrieve returns it — and
// chunk text, dense vectors and the lexical index are byte-for-byte what they
// were. The other keys of `metadata` survive. A dry run writes nothing, and a
// second run changes nothing.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { fixtureEmbedder } from '../../eval/fixture-embedder.js';
import { CorpusNotFoundError } from './errors.js';
import { DocumentTitleService } from './document-title.js';
import { RetrieveService } from './retrieve.js';
import { processIngestJob } from '../../workers/ingest.worker.js';

const ORG = 'title-org';
const PROJECT = 'title-proj';
const CORPUS = 'title-corpus';
const CTX = { org: ORG, project: PROJECT };

async function getDb() {
  const { db } = await import('../../db/client.js');
  return db;
}

function rowsOf(out: unknown): Record<string, unknown>[] {
  return Array.isArray(out) ? out : ((out as { rows?: Record<string, unknown>[] }).rows ?? []);
}

describe('DocumentTitleService (integration)', () => {
  let corpusId: string;

  afterAll(async () => {
    const { closeDb } = await import('../../db/client.js');
    await closeDb().catch(() => undefined);
  });

  beforeEach(async () => {
    const db = await getDb();
    await db.execute(sql`DELETE FROM "chunks" WHERE "org" = ${ORG}`);
    await db.execute(sql`DELETE FROM "documents" WHERE "org" = ${ORG}`);
    await db.execute(sql`DELETE FROM "corpora" WHERE "org" = ${ORG}`);
    await db.execute(sql`
      INSERT INTO "budget_state" ("org", "limit_usd", "remaining_usd")
      VALUES (${ORG}, 100, 100)
      ON CONFLICT ("org") DO UPDATE SET "limit_usd" = 100, "remaining_usd" = 100
    `);
    const inserted = await db.execute(sql`
      INSERT INTO "corpora" ("org", "project", "name", "embedding_model", "text_search_config")
      VALUES (${ORG}, ${PROJECT}, ${CORPUS}, 'fixture/deterministic', 'english')
      RETURNING "id"::text AS id
    `);
    corpusId = String(rowsOf(inserted)[0]!['id']);

    // Small chunk size so the document splits into several chunks.
    await db.execute(sql`UPDATE "corpora" SET "chunk_size" = 200, "chunk_overlap" = 0 WHERE "id" = ${corpusId}::uuid`);
    const text = Array.from(
      { length: 60 },
      (_, i) => `Paragraph ${i}. The disclosure notice is reviewed by the standards office every quarter.`,
    ).join('\n\n');
    for (const [externalId, metadata] of [
      ['doc-a', { title: 'Old title A', ref: 'a-1' }],
      ['doc-b', { title: 'Old title B', ref: 'b-1' }],
    ] as const) {
      await processIngestJob(
        {
          id: `job-${externalId}`,
          data: {
            ingestId: '00000000-0000-4000-8000-0000000000fe',
            corpusId,
            org: ORG,
            project: PROJECT,
            externalId,
            text,
            title: metadata.title,
            metadata: { ...metadata },
          },
        },
        { db, embedder: fixtureEmbedder },
      );
    }
  });

  const snapshot = async () => {
    const db = await getDb();
    return JSON.stringify(
      rowsOf(
        await db.execute(sql`
          SELECT "id"::text AS id, "text", "embedding"::text AS e, "text_search"::text AS ts,
                 "sparse_embedding"::text AS sp, "ordinal", "tokens"
            FROM "chunks" WHERE "corpus_id" = ${corpusId}::uuid ORDER BY "id"
        `),
      ),
    );
  };

  const docA = async () => {
    const db = await getDb();
    return rowsOf(
      await db.execute(sql`
        SELECT "title", "metadata" FROM "documents"
         WHERE "corpus_id" = ${corpusId}::uuid AND "external_id" = 'doc-a'
      `),
    )[0]!;
  };

  it('rewrites title and metadata.title everywhere, and leaves text and vectors untouched', async () => {
    const db = await getDb();
    const svc = new DocumentTitleService({ db });
    const before = await snapshot();
    expect(before).toContain('"e":"[');

    const result = await svc.setTitles(
      { corpus: CORPUS, documents: [{ externalId: 'doc-a', title: 'New title' }, { externalId: 'gone', title: 'x' }] },
      CTX,
    );
    expect(result.dryRun).toBe(false);
    expect(result.notFound).toEqual(['gone']);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]!.changed).toBe(true);
    const chunksChanged = result.documents[0]!.chunksChanged;
    expect(chunksChanged).toBeGreaterThan(1);

    const doc = await docA();
    expect(doc['title']).toBe('New title');
    expect(doc['metadata']).toEqual({ title: 'New title', ref: 'a-1' });

    const chunkMeta = rowsOf(
      await db.execute(sql`
        SELECT d."external_id" AS ext, c."metadata" AS m FROM "chunks" c
          JOIN "documents" d ON d."id" = c."document_id"
         WHERE c."corpus_id" = ${corpusId}::uuid
      `),
    );
    const a = chunkMeta.filter((r) => r['ext'] === 'doc-a');
    expect(a.length).toBe(chunksChanged);
    for (const r of a) {
      expect((r['m'] as Record<string, unknown>)['title']).toBe('New title');
      expect((r['m'] as Record<string, unknown>)['ref']).toBe('a-1');
    }
    // The sibling document is untouched.
    for (const r of chunkMeta.filter((x) => x['ext'] === 'doc-b')) {
      expect((r['m'] as Record<string, unknown>)['title']).toBe('Old title B');
    }

    // The point: chunk text, dense vector bytes, lexical index unchanged.
    expect(await snapshot()).toBe(before);

    // And retrieve hands the new title back.
    const got = await new RetrieveService({ db, embedder: fixtureEmbedder }).retrieve(
      { corpus: CORPUS, query: 'disclosure notice', topK: 50 },
      CTX,
    );
    const titles = new Set(got.chunks.map((c) => (c.metadata as Record<string, unknown>)['title']));
    expect(titles.has('New title')).toBe(true);
    expect(titles.has('Old title A')).toBe(false);

    // Idempotent: the same call again changes nothing.
    const again = await svc.setTitles(
      { corpus: CORPUS, documents: [{ externalId: 'doc-a', title: 'New title' }] },
      CTX,
    );
    expect(again.documents[0]).toMatchObject({ changed: false, chunksChanged: 0 });
  });

  it('dryRun reports what would change and writes nothing', async () => {
    const db = await getDb();
    const res = await new DocumentTitleService({ db }).setTitles(
      {
        corpus: CORPUS,
        documents: [
          { externalId: 'doc-a', title: 'New title' },
          { externalId: 'doc-b', title: 'Old title B' },
        ],
        dryRun: true,
      },
      CTX,
    );
    expect(res.dryRun).toBe(true);
    expect(res.documents.map((d) => [d.externalId, d.changed])).toEqual([
      ['doc-a', true],
      ['doc-b', false],
    ]);
    expect(res.documents[0]!.chunksChanged).toBeGreaterThan(1);
    expect((await docA())['title']).toBe('Old title A');
  });

  it('is scoped: another project and a missing corpus are not found', async () => {
    const db = await getDb();
    const svc = new DocumentTitleService({ db });
    const documents = [{ externalId: 'doc-a', title: 'x' }];
    await expect(
      svc.setTitles({ corpus: CORPUS, documents }, { org: ORG, project: 'other' }),
    ).rejects.toBeInstanceOf(CorpusNotFoundError);
    await expect(svc.setTitles({ corpus: 'nope', documents }, CTX)).rejects.toBeInstanceOf(
      CorpusNotFoundError,
    );
    expect((await docA())['title']).toBe('Old title A');
  });
});
