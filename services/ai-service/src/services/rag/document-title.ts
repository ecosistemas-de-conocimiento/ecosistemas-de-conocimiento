// Rename ingested documents without re-ingesting them.
//
// WHY THIS ENDPOINT EXISTS
// ------------------------
// A document's display title is written twice at ingest: on the document row
// (`documents.title`, plus `metadata.title` when the consumer put one there)
// and onto every chunk's `metadata` — the copy `/v1/retrieve` returns, and so
// the one a consumer shows next to a retrieved chunk. A consumer that decides
// later that a title must change (a correction, or a title that should never
// have been shown) has, without this, one way to fix it: re-POST the full
// text to `/v1/ingest`, which re-chunks and RE-EMBEDS the whole document to
// change one string — and sends the text to the embedding provider again.
//
// The update touches `documents.title`, `documents.metadata.title` and every
// owned chunk's `metadata.title`, in one transaction. It never touches `text`,
// `embedding`, `sparse_embedding` or `text_search`: the title is not part of
// the embedded text (the worker embeds chunk text only), so nothing derived
// from the text goes stale.
//
// `metadata.title` is written only where `metadata` is a JSON object already:
// a document ingested without metadata keeps NULL, it does not grow one.
//
// BATCHED, IDEMPOTENT, WITH A DRY RUN. One call renames up to
// `DOCUMENT_TITLES_MAX` documents of one corpus, because a consumer fixing a
// corpus would otherwise spend one request per document against the per-key
// rate limit. Only values that differ are written, and each result says
// whether its document `changed`; `dryRun` answers the same without writing.
// A missing external id is reported in `notFound`, not a 404: one stale id
// must not fail the other renames in the batch.
//
// Admin only (route preHandler): renaming what a shared corpus shows is a
// lifecycle op, like the alias repoint. Scoped to `(org, project)` all the
// same — a corpus in another tenant reads as missing.

import { and, eq, sql } from 'drizzle-orm';

import type { Db } from '../../db/client.js';
import { CorpusNotFoundError } from './errors.js';
import { corpora, corpusAliases } from '../../db/schema/index.js';

export const DOCUMENT_TITLES_MAX = 200;

export interface DocumentTitleServiceOptions {
  db: Db;
}

export interface SetTitlesCtx {
  org: string;
  project: string;
}

export interface SetTitlesInput {
  corpus: string;
  documents: Array<{ externalId: string; title: string }>;
  /** Report what would change; write nothing. */
  dryRun?: boolean;
}

export interface SetTitleResult {
  externalId: string;
  documentId: string;
  /** Something about this document's title differed (and, unless `dryRun`, was rewritten). */
  changed: boolean;
  /** Chunks whose `metadata.title` differed. Chunks with non-object metadata are never counted. */
  chunksChanged: number;
}

export interface SetTitlesResult {
  dryRun: boolean;
  documents: SetTitleResult[];
  /** External ids not found in the corpus. */
  notFound: string[];
}

export { CorpusNotFoundError };

export class DocumentTitleService {
  private readonly db: Db;

  constructor(opts: DocumentTitleServiceOptions) {
    this.db = opts.db;
  }

  async setTitles(input: SetTitlesInput, ctx: SetTitlesCtx): Promise<SetTitlesResult> {
    const corpusId = await this.resolveCorpusId(input.corpus, ctx);
    if (!corpusId) throw new CorpusNotFoundError({ corpus: input.corpus });
    const dryRun = input.dryRun === true;

    return this.db.transaction(async (tx) => {
      const documents: SetTitleResult[] = [];
      const notFound: string[] = [];
      for (const { externalId, title } of input.documents) {
        // One read answers "does it differ" for the row and its chunks. The
        // title is a bound param everywhere: never interpolated into SQL text.
        const found = rowsOf(
          await tx.execute(sql`
            SELECT d."id"::text AS id,
                   (d."title" IS DISTINCT FROM ${title}
                     OR (jsonb_typeof(d."metadata") = 'object'
                         AND d."metadata"->>'title' IS DISTINCT FROM ${title})) AS doc_differs,
                   (SELECT count(*)::int FROM "chunks" c
                     WHERE c."document_id" = d."id"
                       AND jsonb_typeof(c."metadata") = 'object'
                       AND c."metadata"->>'title' IS DISTINCT FROM ${title}) AS chunks_differ
              FROM "documents" d
             WHERE d."corpus_id" = ${corpusId}::uuid
               AND d."external_id" = ${externalId}
               AND d."org" = ${ctx.org}
               AND d."project" = ${ctx.project}
             LIMIT 1
          `),
        )[0];
        if (!found) {
          notFound.push(externalId);
          continue;
        }
        const documentId = String(found['id']);
        const chunksChanged = Number(found['chunks_differ'] ?? 0);
        const changed = found['doc_differs'] === true || chunksChanged > 0;
        if (changed && !dryRun) {
          await tx.execute(sql`
            UPDATE "documents"
               SET "title" = ${title},
                   "metadata" = CASE
                     WHEN jsonb_typeof("metadata") = 'object'
                       THEN jsonb_set("metadata", '{title}', to_jsonb(${title}::text))
                     ELSE "metadata"
                   END,
                   "updated_at" = now()
             WHERE "id" = ${documentId}::uuid
          `);
          await tx.execute(sql`
            UPDATE "chunks"
               SET "metadata" = jsonb_set("metadata", '{title}', to_jsonb(${title}::text))
             WHERE "document_id" = ${documentId}::uuid
               AND jsonb_typeof("metadata") = 'object'
               AND "metadata"->>'title' IS DISTINCT FROM ${title}
          `);
        }
        documents.push({ externalId, documentId, changed, chunksChanged });
      }
      return { dryRun, documents, notFound };
    });
  }

  /** Corpus name → id, honouring aliases; same resolution as `DocumentValidityService`. */
  private async resolveCorpusId(name: string, ctx: SetTitlesCtx): Promise<string | null> {
    const direct = await this.db
      .select({ id: corpora.id })
      .from(corpora)
      .where(
        and(eq(corpora.org, ctx.org), eq(corpora.project, ctx.project), eq(corpora.name, name)),
      )
      .limit(1);
    if (direct[0]) return direct[0].id;

    const alias = await this.db
      .select({ targetCorpusId: corpusAliases.targetCorpusId })
      .from(corpusAliases)
      .where(
        and(
          eq(corpusAliases.org, ctx.org),
          eq(corpusAliases.project, ctx.project),
          eq(corpusAliases.name, name),
        ),
      )
      .limit(1);
    return alias[0]?.targetCorpusId ?? null;
  }
}

function rowsOf(out: unknown): Record<string, unknown>[] {
  return Array.isArray(out) ? out : ((out as { rows?: Record<string, unknown>[] }).rows ?? []);
}
