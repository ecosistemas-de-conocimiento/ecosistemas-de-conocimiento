// Set a document's temporal validity without re-ingesting it.
//
// WHY THIS ENDPOINT EXISTS
// ------------------------
// Supersession is almost always discovered AFTER ingest: a new version of a
// document arrives, and the old one needs to stop being retrievable as current.
// Without this operation the only way to close out the old version would be to
// re-POST its full text to `/v1/ingest` with `validTo` set — which re-chunks
// and RE-EMBEDS an entire document purely to write two timestamps. On a large
// corpus that is an absurd amount of money and latency for a metadata update,
// and the cost is exactly what would tempt a consumer to skip the step and
// leave superseded content retrievable. The cheap path is the safe path.
//
// The update touches the document row and every chunk it owns, in one
// transaction, and never touches embeddings.
//
// Project-agnostic (ADR-0001): the service assigns no meaning to the interval.
// A consumer decides what supersession means in its domain and when to call
// this.

import { and, eq, sql } from 'drizzle-orm';

import type { Db } from '../../db/client.js';
import { CodedEnvelopeError, NestedEnvelopeError } from '../../errors/base.js';
import { CorpusNotFoundError } from './errors.js';
import { corpora, corpusAliases, documents } from '../../db/schema/index.js';

export interface DocumentValidityServiceOptions {
  db: Db;
}

export interface SetValidityCtx {
  org: string;
  project: string;
}

export interface SetValidityInput {
  corpus: string;
  externalId: string;
  /**
   * `undefined` = leave the existing bound untouched; `null` = clear it back
   * to unbounded. The two are genuinely different operations and collapsing
   * them would make "un-retire this document" impossible to express.
   */
  validFrom?: string | null;
  validTo?: string | null;
}

export interface SetValidityResult {
  documentId: string;
  chunksUpdated: number;
  validFrom: string | null;
  validTo: string | null;
}

export class DocumentNotFoundError extends NestedEnvelopeError {
  readonly code = 'ERR_DOCUMENT_NOT_FOUND';
  readonly status = 404;
  constructor(opts: { corpus: string; externalId: string }) {
    super(`document '${opts.externalId}' not found in corpus '${opts.corpus}'`);
    this.name = 'DocumentNotFoundError';
  }
}

export { CorpusNotFoundError };

export class InvalidValidityIntervalError extends CodedEnvelopeError {
  readonly code = 'ERR_INVALID_VALIDITY_INTERVAL';
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'InvalidValidityIntervalError';
  }
}

export class DocumentValidityService {
  private readonly db: Db;

  constructor(opts: DocumentValidityServiceOptions) {
    this.db = opts.db;
  }

  async setValidity(
    input: SetValidityInput,
    ctx: SetValidityCtx,
  ): Promise<SetValidityResult> {
    const corpusId = await this.resolveCorpusId(input.corpus, ctx);
    if (!corpusId) throw new CorpusNotFoundError({ corpus: input.corpus });

    const docRows = await this.db
      .select({
        id: documents.id,
        validFrom: documents.validFrom,
        validTo: documents.validTo,
      })
      .from(documents)
      .where(
        and(
          eq(documents.corpusId, corpusId),
          eq(documents.externalId, input.externalId),
          eq(documents.org, ctx.org),
          eq(documents.project, ctx.project),
        ),
      )
      .limit(1);
    const doc = docRows[0];
    if (!doc) {
      throw new DocumentNotFoundError({
        corpus: input.corpus,
        externalId: input.externalId,
      });
    }

    // Resolve the target interval: `undefined` keeps the stored value.
    const nextFrom =
      input.validFrom === undefined ? doc.validFrom : parseBound(input.validFrom, 'validFrom');
    const nextTo =
      input.validTo === undefined ? doc.validTo : parseBound(input.validTo, 'validTo');

    // Validate the RESULTING interval, not just the supplied fields — a
    // request that only sets `validTo` can still produce an inverted interval
    // against the stored `validFrom`, and that must be rejected rather than
    // written (an inverted interval matches no instant at all, which would
    // silently make the document permanently unretrievable).
    if (nextFrom && nextTo && nextFrom.getTime() >= nextTo.getTime()) {
      throw new InvalidValidityIntervalError(
        `resulting interval is empty: validFrom (${nextFrom.toISOString()}) ` +
          `must be strictly before validTo (${nextTo.toISOString()})`,
      );
    }

    const chunksUpdated = await this.db.transaction(async (tx) => {
      await tx
        .update(documents)
        .set({ validFrom: nextFrom, validTo: nextTo, updatedAt: new Date() })
        .where(eq(documents.id, doc.id));
      const res = await tx.execute(sql`
        UPDATE "chunks"
           SET "valid_from" = ${nextFrom ? nextFrom.toISOString() : null}::timestamptz,
               "valid_to"   = ${nextTo ? nextTo.toISOString() : null}::timestamptz
         WHERE "document_id" = ${doc.id}::uuid
      `);
      return countFromExecute(res);
    });

    return {
      documentId: doc.id,
      chunksUpdated,
      validFrom: nextFrom ? nextFrom.toISOString() : null,
      validTo: nextTo ? nextTo.toISOString() : null,
    };
  }

  /**
   * Corpus name → id, honouring aliases (same resolution order as retrieve: a
   * real corpus wins, then an alias). Scoped to `(org, project)`, so a corpus
   * belonging to another tenant is indistinguishable from a missing one.
   */
  private async resolveCorpusId(name: string, ctx: SetValidityCtx): Promise<string | null> {
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

function parseBound(v: string | null, field: string): Date | null {
  if (v === null) return null;
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) {
    throw new InvalidValidityIntervalError(`${field} is not a valid ISO-8601 datetime: '${v}'`);
  }
  return new Date(ms);
}

/** postgres-js returns an array with a `count` property on write statements. */
function countFromExecute(out: unknown): number {
  if (out && typeof out === 'object' && 'count' in out) {
    const c = (out as { count?: unknown }).count;
    if (typeof c === 'number') return c;
  }
  if (Array.isArray(out)) return out.length;
  return 0;
}
