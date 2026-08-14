// Integration test for retiring a document without re-embedding it.
//
// The end-to-end property under test is the one that actually protects a
// compliance consumer: after a supersede call, a point-in-time retrieve stops
// returning the old document — and the embeddings were never touched, so doing
// the right thing costs nothing.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { fixtureEmbedder } from '../../eval/fixture-embedder.js';
import {
  DocumentNotFoundError,
  DocumentValidityService,
  InvalidValidityIntervalError,
} from './document-validity.js';
import { RetrieveService } from './retrieve.js';
import { processIngestJob } from '../../workers/ingest.worker.js';

const ORG = 'validity-org';
const PROJECT = 'validity-proj';
const CORPUS = 'validity-corpus';
const CTX = { org: ORG, project: PROJECT };

const SUPERSESSION = '2025-03-21T00:00:00Z';
const NOW = '2026-01-15T00:00:00Z';
const BEFORE = '2020-01-01T00:00:00Z';

async function getDb() {
  const { db } = await import('../../db/client.js');
  return db;
}

describe('DocumentValidityService (integration)', () => {
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

    const inserted = await db.execute(sql`
      INSERT INTO "corpora" ("org", "project", "name", "embedding_model", "text_search_config")
      VALUES (${ORG}, ${PROJECT}, ${CORPUS}, 'fixture/deterministic', 'english')
      RETURNING "id"::text AS id
    `);
    const rows = Array.isArray(inserted)
      ? inserted
      : ((inserted as { rows?: Record<string, unknown>[] }).rows ?? []);
    corpusId = String(rows[0]!['id']);

    for (const [externalId, text] of [
      ['doc-old', 'Section 16. The disclosure notice. The Northgate Review Board supervises.'],
      ['doc-new', 'Section 16. The disclosure notice. The Ridgeway Standards Office supervises.'],
    ] as const) {
      await processIngestJob(
        {
          id: `job-${externalId}`,
          data: {
            ingestId: '00000000-0000-4000-8000-0000000000ff',
            corpusId,
            org: ORG,
            project: PROJECT,
            externalId,
            text,
          },
        },
        { db, embedder: fixtureEmbedder },
      );
    }
  });

  it('retires a document so a point-in-time retrieve stops returning it', async () => {
    const db = await getDb();
    const retrieve = new RetrieveService({ db, embedder: fixtureEmbedder });

    // Before: both editions are unbounded, so both are eligible at any instant.
    const before = await retrieve.retrieve(
      { corpus: CORPUS, query: 'disclosure notice', topK: 10, asOf: NOW },
      CTX,
    );
    expect(before.chunks.some((c) => c.text.includes('Northgate Review Board'))).toBe(true);

    // Capture the embeddings so we can prove they survive untouched.
    const embeddingsBefore = await db.execute(sql`
      SELECT "id"::text AS id, md5("embedding"::text) AS h
        FROM "chunks" WHERE "corpus_id" = ${corpusId}::uuid ORDER BY "id"
    `);

    const svc = new DocumentValidityService({ db });
    const result = await svc.setValidity(
      { corpus: CORPUS, externalId: 'doc-old', validTo: SUPERSESSION },
      CTX,
    );
    expect(result.chunksUpdated).toBeGreaterThan(0);
    expect(result.validTo).toBe(new Date(SUPERSESSION).toISOString());

    // After: the retired edition is gone from a "now" query...
    const after = await retrieve.retrieve(
      { corpus: CORPUS, query: 'disclosure notice', topK: 10, asOf: NOW },
      CTX,
    );
    expect(after.chunks.some((c) => c.text.includes('Northgate Review Board'))).toBe(false);
    expect(after.chunks.some((c) => c.text.includes('Ridgeway Standards Office'))).toBe(true);

    // ...but still retrievable as of a date when it was in force. A filter
    // that just hid old things would pass the assertion above and fail here.
    const historical = await retrieve.retrieve(
      { corpus: CORPUS, query: 'disclosure notice', topK: 10, asOf: BEFORE },
      CTX,
    );
    expect(historical.chunks.some((c) => c.text.includes('Northgate Review Board'))).toBe(true);

    // ...and a query with NO asOf still sees everything — the parameter is
    // opt-in, so an existing consumer's behaviour is untouched.
    const unfiltered = await retrieve.retrieve(
      { corpus: CORPUS, query: 'disclosure notice', topK: 10 },
      CTX,
    );
    expect(unfiltered.chunks.some((c) => c.text.includes('Northgate Review Board'))).toBe(true);

    // The whole point: no re-embedding happened.
    const embeddingsAfter = await db.execute(sql`
      SELECT "id"::text AS id, md5("embedding"::text) AS h
        FROM "chunks" WHERE "corpus_id" = ${corpusId}::uuid ORDER BY "id"
    `);
    expect(JSON.stringify(embeddingsAfter)).toBe(JSON.stringify(embeddingsBefore));
  });

  it('un-retires a document when a bound is cleared with null', async () => {
    const db = await getDb();
    const svc = new DocumentValidityService({ db });
    const retrieve = new RetrieveService({ db, embedder: fixtureEmbedder });

    await svc.setValidity({ corpus: CORPUS, externalId: 'doc-old', validTo: SUPERSESSION }, CTX);
    const retired = await retrieve.retrieve(
      { corpus: CORPUS, query: 'disclosure notice', topK: 10, asOf: NOW },
      CTX,
    );
    expect(retired.chunks.some((c) => c.text.includes('Northgate Review Board'))).toBe(false);

    // `null` clears the bound; `undefined` would have left it alone. The two
    // have to be distinguishable or "undo" is inexpressible.
    const cleared = await svc.setValidity(
      { corpus: CORPUS, externalId: 'doc-old', validTo: null },
      CTX,
    );
    expect(cleared.validTo).toBeNull();
    const restored = await retrieve.retrieve(
      { corpus: CORPUS, query: 'disclosure notice', topK: 10, asOf: NOW },
      CTX,
    );
    expect(restored.chunks.some((c) => c.text.includes('Northgate Review Board'))).toBe(true);
  });

  it('leaves an unspecified bound untouched', async () => {
    const db = await getDb();
    const svc = new DocumentValidityService({ db });
    await svc.setValidity(
      { corpus: CORPUS, externalId: 'doc-old', validFrom: '2010-07-06T00:00:00Z' },
      CTX,
    );
    const second = await svc.setValidity(
      { corpus: CORPUS, externalId: 'doc-old', validTo: SUPERSESSION },
      CTX,
    );
    expect(second.validFrom).toBe(new Date('2010-07-06T00:00:00Z').toISOString());
    expect(second.validTo).toBe(new Date(SUPERSESSION).toISOString());
  });

  it('rejects an interval that would be empty against the STORED bound', async () => {
    const db = await getDb();
    const svc = new DocumentValidityService({ db });
    await svc.setValidity({ corpus: CORPUS, externalId: 'doc-old', validFrom: NOW }, CTX);
    // Only `validTo` is supplied, but combined with the stored `validFrom` it
    // makes an interval that matches no instant — which would render the
    // document permanently unretrievable, silently.
    await expect(
      svc.setValidity({ corpus: CORPUS, externalId: 'doc-old', validTo: BEFORE }, CTX),
    ).rejects.toBeInstanceOf(InvalidValidityIntervalError);
  });

  it('404s for an unknown document and for another tenant', async () => {
    const db = await getDb();
    const svc = new DocumentValidityService({ db });
    await expect(
      svc.setValidity({ corpus: CORPUS, externalId: 'nope', validTo: NOW }, CTX),
    ).rejects.toBeInstanceOf(DocumentNotFoundError);
    // Same corpus name, different tenant ⇒ indistinguishable from missing.
    await expect(
      svc.setValidity(
        { corpus: CORPUS, externalId: 'doc-old', validTo: NOW },
        { org: 'someone-else', project: PROJECT },
      ),
    ).rejects.toThrow();
  });
});
