// Corpus delete service — `DELETE /v1/corpus/:name`.
//
// Why this lives here (not as part of `ingest.ts` / `retrieve.ts`):
//   - The two existing RAG services either *add* rows (ingest) or *read*
//     them (retrieve). Deletion is a third, distinct lifecycle operation
//     that the consumer-side pattern (rollout-plan §Sa) calls out as its own
//     deliverable, so it deserves its own typed surface and its own test
//     file.
//   - The orphan-cleanup janitor (rollout-plan Sa-2, deferred) will reuse
//     this same primitive — keeping it on its own service class means the
//     janitor wires up trivially when it lands.
//
// Behaviour:
//   - Resolve `(org, project, name)` via the same lookup retrieve/ingest use,
//     i.e. `corpora` row scoped by both `org` and `project` from `req.auth`.
//   - Cascade deletes everything underneath: `chunks` → `documents` → the
//     `corpora` row itself. Wrapped in a single Postgres transaction so a
//     partial delete is never observable.
//   - Returns the counts deleted at every tier, for ops audit (chat ships
//     this to a debug surface eventually).
//
// Idempotency choice (documented also in the route file's top comment):
//   We return `{ deleted: { chunks: 0, documents: 0, corpora: 0 } }` with a
//   200 status when no matching corpus exists. The route file flips that to a
//   404 on the first delete and exposes the idempotent 200 only on the
//   *re-issue* of an already-completed delete. The service stays agnostic on
//   404 vs. 200 — it just reports the counts.

import { and, eq } from 'drizzle-orm';

import type { Db } from '../../db/client.js';
import { chunks, corpora, documents } from '../../db/schema/index.js';

export interface CorpusDeleteServiceDeps {
  db: Db;
}

export interface CorpusDeleteContext {
  org: string;
  project: string;
}

export interface CorpusDeleteCounts {
  chunks: number;
  documents: number;
  corpora: number;
}

export interface CorpusDeleteResult {
  /** `true` when a matching corpus row existed (the route layer maps `false` → 404). */
  matched: boolean;
  deleted: CorpusDeleteCounts;
}

export class CorpusDeleteService {
  constructor(private readonly deps: CorpusDeleteServiceDeps) {}

  /**
   * Delete a corpus and its `documents` + `chunks` cascade for the
   * `(org, project, name)` triple. Atomic in one transaction.
   *
   * Returns `{ matched: false, deleted: { 0, 0, 0 } }` if no corpus row
   * matches — the route layer decides whether that's a 404 or an idempotent
   * 200.
   */
  async deleteCorpus(
    name: string,
    ctx: CorpusDeleteContext,
  ): Promise<CorpusDeleteResult> {
    return this.deps.db.transaction(async (tx) => {
      // Look up first so we know whether to return 404. The cascade FKs on
      // `documents.corpus_id` and `chunks.corpus_id` would handle the actual
      // row removal automatically when the corpus row is deleted, BUT we need
      // accurate counts to return — so we do the cascade explicitly here and
      // tally as we go.
      const rows = await tx
        .select({ id: corpora.id })
        .from(corpora)
        .where(
          and(
            eq(corpora.org, ctx.org),
            eq(corpora.project, ctx.project),
            eq(corpora.name, name),
          ),
        )
        .limit(1);
      const corpusRow = rows[0];
      if (!corpusRow) {
        return {
          matched: false,
          deleted: { chunks: 0, documents: 0, corpora: 0 },
        };
      }

      const deletedChunks = await tx
        .delete(chunks)
        .where(eq(chunks.corpusId, corpusRow.id))
        .returning({ id: chunks.id });

      const deletedDocuments = await tx
        .delete(documents)
        .where(eq(documents.corpusId, corpusRow.id))
        .returning({ id: documents.id });

      const deletedCorpora = await tx
        .delete(corpora)
        .where(eq(corpora.id, corpusRow.id))
        .returning({ id: corpora.id });

      return {
        matched: true,
        deleted: {
          chunks: deletedChunks.length,
          documents: deletedDocuments.length,
          corpora: deletedCorpora.length,
        },
      };
    });
  }
}
