// PATCH /v1/corpora/:name — changing `language` must re-index the corpus's
// chunks, against a real Postgres.
//
// WHY THIS FILE EXISTS. `chunks.text_search` is NOT a generated column: the
// ingest worker fills it once, with `to_tsvector(<corpus config>::regconfig,
// text)`, at ingest time. `updateCorpus` used to write ONLY the corpus row's
// `text_search_config`. So a `simple → spanish` PATCH moved the QUERY side of
// the lexical leg and left the INDEX side where it was, and the two stopped
// agreeing:
//
//   stored index (built `simple`)   holds   the raw surface forms
//   query        (parsed `spanish`) yields  the stems
//
// Nothing throws. The lexical leg simply matches nothing, the dense leg carries
// the request alone, and retrieval quality drops silently. That is WORSE than
// the unstemmed state the PATCH was meant to fix: before the PATCH the exact
// surface form still matched.
//
// So every assertion here is on RETRIEVED ROWS — specifically on whether the
// lexical leg contributed (`lexicalScore` / `ranks.lexical` are present on a
// fused chunk only when that leg ranked it). A test that asserts the corpus row
// now says `'spanish'` passes in exactly the broken state and is worthless.
//
// The fixture is deliberately ORDINARY Spanish prose (ADR-0001: no consumer's
// subject matter in this repo). Spanish only because it is an inflected
// language with a Postgres snowball config — the property under test is
// "stemmed config ≠ stored surface forms", which holds for every non-`simple`
// regconfig.
//
// Wiring mirrors the eval harness: `buildHarness` drives the REAL
// `processIngestJob`, so the tsvector under test is the one production writes,
// and the embedder is the deterministic offline fixture (zero network, zero
// cost).

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import type { Db } from '../../db/client.js';
import { buildHarness, type Harness } from '../../eval/harness.js';
import { CorpusService } from './corpus-crud.js';

const ORG = 'lang-org';
const PROJECT = 'lang-project';
const CORPUS = 'lex-it';
const OTHER_CORPUS = 'lex-other-it';

// Carries ONLY the PLURAL of the two probe words, so an unstemmed index cannot
// match the singular query by accident:
//   simple  → 'documentos', 'canciones'   (raw surface forms)
//   spanish → 'document',   'cancion'     (stems; both numbers collapse here)
const DOC_TEXT =
  'Los documentos y las canciones que aquí se guardan pertenecen a las bibliotecas.';
const OTHER_TEXT = 'Los documentos y las canciones de otro corpus distinto.';

/** A marker present in the target chunk's text and in no other chunk. */
const TARGET_MARKER = 'bibliotecas';

/** Both docs a run ingests — one target chunk plus a topical decoy. */
const DOCS = [
  { externalId: 'target', title: 'Target', text: DOC_TEXT, metadata: {} },
  {
    externalId: 'decoy',
    title: 'Decoy',
    text: 'Este aviso trata de plazos, notificaciones y domicilios postales.',
    metadata: {},
  },
];

/**
 * Did the LEXICAL leg of a hybrid retrieve contribute the target chunk?
 * `lexicalScore` is set by `rrfFuse` only for rows the lexical leg returned;
 * the dense leg puts the chunk in the result either way, so presence of this
 * field — not presence of the chunk — is the signal.
 */
async function lexicalHit(
  h: Harness,
  query: string,
): Promise<{ hit: boolean; lexicalScore?: number; lexicalRank?: number }> {
  const out = await h.service.retrieve(
    { corpus: CORPUS, query, topK: 5, mode: 'hybrid' },
    { org: ORG, project: PROJECT },
  );
  const target = out.chunks.find((c) => c.text.includes(TARGET_MARKER));
  if (!target) return { hit: false };
  return {
    hit: target.lexicalScore !== undefined,
    ...(target.lexicalScore !== undefined ? { lexicalScore: target.lexicalScore } : {}),
    ...(target.ranks?.lexical !== undefined ? { lexicalRank: target.ranks.lexical } : {}),
  };
}

/** The stored tsvector for the target chunk, as text — the INDEX side. */
async function storedTsvector(db: Db, corpusId: string): Promise<string> {
  const rows = (await db.execute(sql`
    SELECT "text_search"::text AS ts
      FROM "chunks"
     WHERE "corpus_id" = ${corpusId}::uuid
       AND "text" LIKE ${'%' + TARGET_MARKER + '%'}
     LIMIT 1
  `)) as unknown as Array<{ ts: string | null }>;
  const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? []);
  return String((list[0] as { ts?: string | null } | undefined)?.ts ?? '');
}

describe('corpus language PATCH re-indexes chunks (integration)', () => {
  let db: Db;
  let svc: CorpusService;

  afterAll(async () => {
    const { closeDb } = await import('../../db/client.js');
    await closeDb().catch(() => undefined);
  });

  beforeEach(async () => {
    ({ db } = await import('../../db/client.js'));
    await db.execute(sql`TRUNCATE TABLE chunks, documents, corpora RESTART IDENTITY CASCADE`);
    svc = new CorpusService({ db });
  });

  async function seed(textSearchConfig: string, corpus = CORPUS): Promise<Harness> {
    return buildHarness({
      db,
      org: ORG,
      project: PROJECT,
      corpus,
      docs: DOCS,
      textSearchConfig,
      chunkSize: 128,
      chunkOverlap: 16,
    });
  }

  function patch(language: string, corpus = CORPUS) {
    return svc.updateCorpus(
      corpus,
      { language },
      { org: ORG, project: PROJECT },
      { embeddingDim: 1024 },
    );
  }

  // ── The state deployments are actually in ──────────────────────────────────
  it("baseline 'simple': the exact surface form matches, the singular does not", async () => {
    const h = await seed('simple');

    // Control — the lexical leg is WIRED and working; it just cannot stem.
    expect(await lexicalHit(h, 'documentos')).toMatchObject({ hit: true });

    // The gap this whole exercise is about: singular ≠ plural without stemming.
    expect(await lexicalHit(h, 'documento')).toMatchObject({ hit: false });
  });

  // ── The PATCH trap ──────────────────────────────────────────────────────
  it('PATCH simple → spanish keeps the lexical leg alive (no silent desync)', async () => {
    const h = await seed('simple');

    // Precondition: the index was built unstemmed.
    expect(await storedTsvector(db, h.corpusId)).toContain("'documentos'");
    expect(await lexicalHit(h, 'documentos')).toMatchObject({ hit: true });

    const updated = await patch('spanish');
    expect(updated.language).toBe('spanish');

    // The INDEX must have moved with the config. Before the fix this still
    // held the surface forms while the query side had switched to the stems.
    const ts = await storedTsvector(db, h.corpusId);
    expect(ts).toContain("'document'");
    expect(ts).toContain("'cancion'");
    expect(ts).not.toContain("'documentos'");

    // REGRESSION GUARD: the query that worked BEFORE the PATCH must still work
    // after it. This is the assertion that fails on the desync — the plural
    // parses to its stem under spanish and finds nothing in an unstemmed index.
    expect(await lexicalHit(h, 'documentos')).toMatchObject({ hit: true });

    // THE PAYOFF: the singular now matches the plural in the text.
    expect(await lexicalHit(h, 'documento')).toMatchObject({ hit: true });

    // Same for the accented probe word.
    expect(await lexicalHit(h, 'canción')).toMatchObject({ hit: true });
  });

  it('PATCH spanish → simple re-indexes back (the reverse direction)', async () => {
    const h = await seed('spanish');
    expect(await storedTsvector(db, h.corpusId)).toContain("'document'");

    await patch('simple');

    const ts = await storedTsvector(db, h.corpusId);
    expect(ts).toContain("'documentos'");
    expect(ts).not.toContain("'document':");
    // Exact surface form matches again; the stemmed singular no longer does.
    expect(await lexicalHit(h, 'documentos')).toMatchObject({ hit: true });
    expect(await lexicalHit(h, 'documento')).toMatchObject({ hit: false });
  });

  // ── The re-index must be NARROW ─────────────────────────────────────────
  it('a no-op PATCH (same language) does not rewrite chunks', async () => {
    const h = await seed('spanish');

    // Stamp a sentinel over the real tsvector. If the PATCH rewrites chunks it
    // will be gone; if it correctly skips the rewrite it survives verbatim.
    await db.execute(sql`
      UPDATE "chunks"
         SET "text_search" = to_tsvector('simple'::regconfig, 'zzsentinelzz')
       WHERE "corpus_id" = ${h.corpusId}::uuid
    `);

    await patch('spanish');
    expect(await storedTsvector(db, h.corpusId)).toBe("'zzsentinelzz':1");
  });

  it('a PATCH that omits language does not rewrite chunks', async () => {
    const h = await seed('spanish');
    await db.execute(sql`
      UPDATE "chunks"
         SET "text_search" = to_tsvector('simple'::regconfig, 'zzsentinelzz')
       WHERE "corpus_id" = ${h.corpusId}::uuid
    `);

    await svc.updateCorpus(
      CORPUS,
      { metadata: { touched: true } },
      { org: ORG, project: PROJECT },
      { embeddingDim: 1024 },
    );
    expect(await storedTsvector(db, h.corpusId)).toBe("'zzsentinelzz':1");
  });

  it('the re-index is scoped to the patched corpus only', async () => {
    const h = await seed('simple');
    const other = await buildHarness({
      db,
      org: ORG,
      project: PROJECT,
      corpus: OTHER_CORPUS,
      docs: [{ externalId: 'other', title: 'Other', text: OTHER_TEXT, metadata: {} }],
      textSearchConfig: 'simple',
      chunkSize: 128,
      chunkOverlap: 16,
    });

    await patch('spanish');

    expect(await storedTsvector(db, h.corpusId)).toContain("'document'");
    // The sibling corpus is untouched — still the unstemmed index it was
    // ingested with, and still configured `simple`.
    const otherRows = (await db.execute(sql`
      SELECT "text_search"::text AS ts FROM "chunks"
       WHERE "corpus_id" = ${other.corpusId}::uuid LIMIT 1
    `)) as unknown as Array<{ ts: string }>;
    expect(String(otherRows[0]?.ts ?? '')).toContain("'documentos'");
  });

  // ── Whitelist gate ──────────────────────────────────────────────────────
  it('rejects a language outside the regconfig whitelist without writing', async () => {
    const h = await seed('simple');
    // `'es'` is an ISO code, not a regconfig — `'es'::regconfig` THROWS. The
    // Zod schema rejects it at the route; this is the service-level gate for
    // any non-wire caller, and it must refuse BEFORE touching the DB.
    await expect(patch('es')).rejects.toThrow(/text-search config/i);

    const rows = (await db.execute(sql`
      SELECT "text_search_config" AS cfg FROM "corpora" WHERE "id" = ${h.corpusId}::uuid
    `)) as unknown as Array<{ cfg: string }>;
    const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? []);
    expect((list[0] as { cfg: string }).cfg).toBe('simple');
    expect(await storedTsvector(db, h.corpusId)).toContain("'documentos'");
  });
});
