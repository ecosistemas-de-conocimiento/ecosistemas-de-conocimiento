// Document delete service — `DELETE /v1/corpus/:name/documents/:externalId`.
//
// Why this lives alongside `corpus-delete.ts` (not folded into it):
//   - It mirrors the corpus-delete shape exactly (lookup → cascade → counts)
//     but operates one tier down: a single `documents` row + its `chunks`,
//     leaving the `corpora` row and sibling documents intact.
//   - Consumers that re-version a source document get free chunk replacement
//     via the ingest worker's externalId dedupe; this endpoint covers the
//     OTHER lifecycle event — a document being *removed* entirely (a prototype
//     document-delete flow) — which re-ingest can never express.
//
// Behaviour:
//   - Resolve `(org, project, name)` to a `corpora` row (same scoped lookup
//     retrieve/ingest/corpus-delete use). Missing → `notFound: 'corpus'`.
//   - Resolve `(corpusId, externalId)` to a `documents` row. The
//     `(corpus_id, external_id)` unique index guarantees at most one. Missing
//     → `notFound: 'document'`.
//   - Delete the document's `chunks`, then the `documents` row, in a single
//     transaction so a partial delete is never observable. The `corpora` row
//     is untouched.
//   - Return per-tier counts for ops audit, matching corpus-delete's contract.

import { and, eq } from 'drizzle-orm';

import type { Db } from '../../db/client.js';
import { chunks, corpora, documents } from '../../db/schema/index.js';

export interface DocumentDeleteServiceDeps {
  db: Db;
}

export interface DocumentDeleteContext {
  org: string;
  project: string;
}

export interface DocumentDeleteCounts {
  chunks: number;
  documents: number;
}

export interface DocumentDeleteResult {
  /**
   * `null` on success. Otherwise names the tier that was missing so the route
   * layer can return a precise 404 (`CORPUS_NOT_FOUND` vs `DOCUMENT_NOT_FOUND`).
   */
  notFound: 'corpus' | 'document' | null;
  deleted: DocumentDeleteCounts;
}

export class DocumentDeleteService {
  constructor(private readonly deps: DocumentDeleteServiceDeps) {}

  /**
   * Delete a single document (by consumer-supplied `externalId`) and its
   * `chunks` within the `(org, project, name)` corpus. Atomic in one
   * transaction. Leaves the corpus and all other documents intact.
   */
  async deleteDocument(
    corpusName: string,
    externalId: string,
    ctx: DocumentDeleteContext,
  ): Promise<DocumentDeleteResult> {
    return this.deps.db.transaction(async (tx) => {
      const corpusRows = await tx
        .select({ id: corpora.id })
        .from(corpora)
        .where(
          and(
            eq(corpora.org, ctx.org),
            eq(corpora.project, ctx.project),
            eq(corpora.name, corpusName),
          ),
        )
        .limit(1);
      const corpusRow = corpusRows[0];
      if (!corpusRow) {
        return { notFound: 'corpus', deleted: { chunks: 0, documents: 0 } };
      }

      const docRows = await tx
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.corpusId, corpusRow.id),
            eq(documents.externalId, externalId),
          ),
        )
        .limit(1);
      const docRow = docRows[0];
      if (!docRow) {
        return { notFound: 'document', deleted: { chunks: 0, documents: 0 } };
      }

      const deletedChunks = await tx
        .delete(chunks)
        .where(eq(chunks.documentId, docRow.id))
        .returning({ id: chunks.id });

      const deletedDocuments = await tx
        .delete(documents)
        .where(eq(documents.id, docRow.id))
        .returning({ id: documents.id });

      return {
        notFound: null,
        deleted: {
          chunks: deletedChunks.length,
          documents: deletedDocuments.length,
        },
      };
    });
  }
}
