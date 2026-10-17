// The opt-in TRIGRAM lexical leg of a hybrid retrieve, against a real Postgres
// with pg_trgm (migration 0005; no trigram index, by design).
//
// Claim under test: with `lexicalLeg: 'trigram'`, a chunk whose words are an
// INFLECTION of the query words ("contratos de obra pública" vs
// "contrataciones obras públicas") is found by the lexical leg, where the `tsvector` leg with the
// `simple` config finds nothing. RRF then lifts it above a chunk the dense leg
// alone prefers. `tsvector` stays the default, and `none` fuses dense alone.
//
// The dense embedder is injected and deterministic: the query vector equals
// the WRONG chunk's vector, so only the lexical leg can lift the right one.
//
// ⚠ NO `describe.skipIf` / `.skip` / `.only` here: the integration lane has no
// skip path, and `integration-database.test.ts` fails the unit suite if an
// integration file gates itself.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { RetrieveService } from "./retrieve.js";
import type { Embedder, LexicalLegChoice } from "./retrieve.js";

const ORG = "acme";
const PROJECT = "chat";
const CORPUS = "trgm-it";
const QUERY = "contrataciones obras públicas";
const RIGHT = "Los contratos de obra pública se adjudicaron en marzo.";
const WRONG = "Reunión vecinal sobre el alumbrado del parque.";
const OTHER = "El presupuesto municipal de salud creció.";

function hot(dim: number): number[] {
  const v = new Array(1024).fill(0);
  v[dim] = 1;
  return v;
}

const embedder = (async ({ model }: { model: string }) => ({
  embeddings: [hot(2)],
  model,
  usage: { inputTokens: 1, estimatedCostUsd: 0 },
})) as unknown as Embedder;

async function dbHandle() {
  const { db } = await import("../../db/client.js");
  return db;
}

async function seed() {
  const db = await dbHandle();
  const { chunks, corpora, documents } =
    await import("../../db/schema/index.js");
  const insertCorpus = async (org: string) =>
    (
      await db
        .insert(corpora)
        .values({ org, project: PROJECT, name: CORPUS })
        .returning({ id: corpora.id })
    )[0]!.id;

  const rows = async (
    org: string,
    corpusId: string,
    texts: Array<[string, number]>,
  ) => {
    for (const [i, [text, dim]] of texts.entries()) {
      const doc = (
        await db
          .insert(documents)
          .values({
            corpusId,
            org,
            project: PROJECT,
            externalId: `d${i}`,
            text,
          })
          .returning({ id: documents.id })
      )[0]!.id;
      await db.insert(chunks).values({
        documentId: doc,
        corpusId,
        org,
        project: PROJECT,
        ordinal: 0,
        text,
        embedding: hot(dim),
      });
    }
  };

  const mine = await insertCorpus(ORG);
  // RIGHT is orthogonal to the query vector; WRONG equals it.
  await rows(ORG, mine, [
    [RIGHT, 0],
    [WRONG, 2],
    [OTHER, 1],
  ]);
  // Another tenant holding the same text must never surface.
  const theirs = await insertCorpus("other-org");
  await rows("other-org", theirs, [[RIGHT, 2]]);
  // Populate the tsvector column the way ingest does (`simple` config).
  await db.execute(
    sql`UPDATE chunks SET text_search = to_tsvector('simple', text)`,
  );
}

async function run(lexicalLeg?: LexicalLegChoice) {
  const db = await dbHandle();
  const svc = new RetrieveService({
    db,
    embedder,
    ...(lexicalLeg ? { lexicalLeg } : {}),
  });
  return svc.retrieve(
    { corpus: CORPUS, query: QUERY, mode: "hybrid", topK: 3 },
    { org: ORG, project: PROJECT },
  );
}

describe("hybrid retrieve — trigram lexical leg (integration)", () => {
  afterAll(async () => {
    const { closeDb } = await import("../../db/client.js");
    await closeDb().catch(() => undefined);
  });

  beforeEach(async () => {
    const db = await dbHandle();
    await db.execute(
      sql`TRUNCATE TABLE chunks, documents, corpora RESTART IDENTITY CASCADE`,
    );
    await seed();
  });

  it("trigram finds the inflected chunk and RRF lifts it above the dense favourite", async () => {
    const out = await run("trigram");
    expect(out.legs).toEqual(["dense", "trigram"]);
    expect(out.chunks[0]!.text).toBe(RIGHT);
    expect(out.chunks[0]!.lexicalScore).toBeGreaterThan(0.3);
    expect(out.chunks[0]!.ranks).toMatchObject({ lexical: 1 });
    // Tenant fence: the other org's identical chunk never appears.
    expect(out.chunks.filter((c) => c.text === RIGHT)).toHaveLength(1);
  });

  it("the default leg is still tsvector: `simple` misses the inflection, dense wins", async () => {
    const out = await run();
    // tsvector `simple` matches whole words only: no chunk has
    // "contrataciones", "obras" or "públicas", so the lexical leg is empty.
    expect(out.legs).toEqual(["dense"]);
    expect(out.chunks[0]!.text).toBe(WRONG);
    // Positive control: the exact word reaches the tsvector leg, named `lexical`.
    const db = await dbHandle();
    const exact = await new RetrieveService({ db, embedder }).retrieve(
      { corpus: CORPUS, query: "contratos", mode: "hybrid", topK: 3 },
      { org: ORG, project: PROJECT },
    );
    expect(exact.legs).toEqual(["dense", "lexical"]);
  });

  it("none fuses the dense leg alone", async () => {
    const out = await run("none");
    expect(out.legs).toEqual(["dense"]);
    expect(out.chunks[0]!.text).toBe(WRONG);
    expect(out.chunks.every((c) => c.lexicalScore === undefined)).toBe(true);
  });

  it("a threshold above every score leaves the trigram leg empty (and does not throw)", async () => {
    const db = await dbHandle();
    const svc = new RetrieveService({
      db,
      embedder,
      lexicalLeg: "trigram",
      trigramThreshold: 1,
    });
    const out = await svc.retrieve(
      { corpus: CORPUS, query: QUERY, mode: "hybrid", topK: 3 },
      { org: ORG, project: PROJECT },
    );
    expect(out.legs).toEqual(["dense"]);
    expect(out.chunks[0]!.text).toBe(WRONG);
  });

  it("migration 0005 enables pg_trgm and builds no trigram index on chunks", async () => {
    const db = await dbHandle();
    const ext = await db.execute(
      sql`SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'`,
    );
    expect(ext).toHaveLength(1);
    const idx = await db.execute(
      sql`SELECT indexname FROM pg_indexes WHERE tablename = 'chunks' AND indexdef ILIKE '%gin_trgm_ops%'`,
    );
    expect(idx).toHaveLength(0);
  });
});
