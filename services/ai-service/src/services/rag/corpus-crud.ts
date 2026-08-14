// Corpus control-plane service — the CRUD behind `POST/GET/PATCH /v1/corpora`.
//
// WHY THIS EXISTS. Before this, a corpus only ever came into being implicitly:
// the first `POST /v1/ingest` for an unknown name created it, and whatever that
// first write happened to carry (or not carry) decided its config forever. That
// caused a real bug — every corpus was silently `'simple'`/default because the
// config had no wire surface. This service is the explicit path:
//
//   - `createCorpus`  — declare a corpus + its full config BEFORE any data lands.
//   - `listCorpora`   — enumerate the caller's corpora (with doc/chunk counts).
//   - `getCorpus`     — introspect one (config + counts), resolving an alias to
//                       its target so a consumer can verify the contract.
//   - `updateCorpus`  — reconfigure without a destructive side-channel.
//
// Delete is intentionally NOT here: it reuses the existing `CorpusDeleteService`
// (chunks → documents → corpora cascade), so there is one delete primitive that
// the route + the future orphan-cleanup janitor both call.
//
// Auto-create-on-ingest is untouched — this is an ADDITIVE control surface.
//
// Multi-tenant scoping is identical to every other corpus lookup: the
// `(org, project)` comes from `req.auth`, NEVER the body. A corpus in another
// tenant is indistinguishable from a missing one.
//
// ADR-0001: nothing here interprets a consumer's domain — a corpus is an opaque
// named collection with embedding + chunking + lexical config the service owns
// mechanically.

import { and, eq, inArray, sql } from 'drizzle-orm';

import type { Db } from '../../db/client.js';
import { chunks, corpora, corpusAliases, documents } from '../../db/schema/index.js';
import { resolveCorpusEmbeddingDim } from './embedding-models.js';

export interface CorpusServiceDeps {
  db: Db;
}

/** The base `Db` or a transaction handle — both expose the query builder we use. */
type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export interface CorpusServiceContext {
  org: string;
  project: string;
}

/** Config a consumer supplies on create — every field optional except `name`. */
export interface CorpusCreateSpec {
  name: string;
  embeddingModel?: string;
  language?: string;
  chunkStrategy?: string;
  chunkSize?: number;
  chunkOverlap?: number;
  chunkConfig?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/** Patch on update — every field optional; the route rejects an empty patch. */
export interface CorpusUpdateSpec {
  embeddingModel?: string;
  language?: string;
  chunkStrategy?: string;
  chunkSize?: number;
  chunkOverlap?: number;
  chunkConfig?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/** Introspection view of a corpus — the wire shape for get/list/create/update. */
export interface CorpusIntrospection {
  name: string;
  embeddingModel: string;
  embeddingDim: number;
  /** Postgres text-search config name (regconfig) — the wire `language`. */
  language: string;
  chunkStrategy: string;
  chunkSize: number;
  chunkOverlap: number;
  chunkConfig: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  documentCount: number;
  chunkCount: number;
  createdAt: string;
  updatedAt: string | null;
  /**
   * Present ONLY when the queried name was an ALIAS: the config + counts above
   * are the TARGET corpus's, and `alias.target` is the target's name. Absent on
   * a real corpus (and on list, which never includes aliases).
   */
  alias?: { name: string; target: string };
}

/** Thrown by `createCorpus` when the name already names a corpus in scope. Route → 409. */
export class CorpusAlreadyExistsError extends Error {
  readonly corpusName: string;
  constructor(name: string) {
    super(`corpus '${name}' already exists`);
    this.name = 'CorpusAlreadyExistsError';
    this.corpusName = name;
  }
}

/** Thrown by `createCorpus` when the name already names an alias in scope. Route → 409. */
export class CorpusNameIsAliasError extends Error {
  readonly corpusName: string;
  constructor(name: string) {
    super(`'${name}' already names an alias; corpus names share the alias namespace`);
    this.name = 'CorpusNameIsAliasError';
    this.corpusName = name;
  }
}

/** Thrown by `updateCorpus` when no corpus matches in scope. Route → 404. */
export class CorpusNotFoundError extends Error {
  readonly corpusName: string;
  constructor(name: string) {
    super(`corpus '${name}' not found`);
    this.name = 'CorpusNotFoundError';
    this.corpusName = name;
  }
}

/**
 * Thrown when a PATCH tries to change `embeddingModel` on a corpus that already
 * has chunks. Re-embedding is out of scope (a separate, future hook); silently
 * changing the model would leave the corpus's vectors embedded with the OLD
 * model, so retrieval quality would degrade with no error. Route → 409.
 */
export class EmbeddingModelChangeNotAllowedError extends Error {
  readonly corpusName: string;
  constructor(name: string) {
    super(
      `cannot change embeddingModel on corpus '${name}': it already has embedded chunks. ` +
        `Changing the model would leave existing vectors embedded with the old model. ` +
        `Delete + re-ingest, or wait for the re-embed-on-model-change hook.`,
    );
    this.name = 'EmbeddingModelChangeNotAllowedError';
    this.corpusName = name;
  }
}

type CorpusRow = typeof corpora.$inferSelect;

export class CorpusService {
  constructor(private readonly deps: CorpusServiceDeps) {}

  /**
   * Create a corpus with an explicit config. Validates model↔dimension up front
   * (throws `EmbeddingDimensionMismatchError` → 400 at the route). Refuses a
   * name that already names a corpus (`CorpusAlreadyExistsError`) or an alias
   * (`CorpusNameIsAliasError`) in the same scope — corpus and alias names share
   * one namespace per `(org, project)`.
   */
  async createCorpus(
    spec: CorpusCreateSpec,
    ctx: CorpusServiceContext,
    defaults: { embeddingModel: string; embeddingDim: number },
  ): Promise<CorpusIntrospection> {
    const model = spec.embeddingModel ?? defaults.embeddingModel;
    // Throws EmbeddingDimensionMismatchError for a known model whose dim can't
    // fit the live vector column — surfaced as a 400 at the route.
    const embeddingDim = resolveCorpusEmbeddingDim(model, defaults.embeddingDim);

    return this.deps.db.transaction(async (tx) => {
      const clashCorpus = await tx
        .select({ id: corpora.id })
        .from(corpora)
        .where(
          and(
            eq(corpora.org, ctx.org),
            eq(corpora.project, ctx.project),
            eq(corpora.name, spec.name),
          ),
        )
        .limit(1);
      if (clashCorpus[0]) throw new CorpusAlreadyExistsError(spec.name);

      const clashAlias = await tx
        .select({ id: corpusAliases.id })
        .from(corpusAliases)
        .where(
          and(
            eq(corpusAliases.org, ctx.org),
            eq(corpusAliases.project, ctx.project),
            eq(corpusAliases.name, spec.name),
          ),
        )
        .limit(1);
      if (clashAlias[0]) throw new CorpusNameIsAliasError(spec.name);

      const inserted = await tx
        .insert(corpora)
        .values({
          org: ctx.org,
          project: ctx.project,
          name: spec.name,
          embeddingModel: model,
          embeddingDim,
          ...(spec.chunkStrategy !== undefined ? { chunkStrategy: spec.chunkStrategy } : {}),
          ...(spec.chunkSize !== undefined ? { chunkSize: spec.chunkSize } : {}),
          ...(spec.chunkOverlap !== undefined ? { chunkOverlap: spec.chunkOverlap } : {}),
          ...(spec.chunkConfig !== undefined ? { chunkConfig: spec.chunkConfig } : {}),
          ...(spec.metadata !== undefined ? { metadata: spec.metadata } : {}),
          ...(spec.language !== undefined ? { textSearchConfig: spec.language } : {}),
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error(`failed to create corpus '${spec.name}'`);
      // A freshly created corpus has zero documents/chunks.
      return introspectionFromRow(row, { documentCount: 0, chunkCount: 0 });
    });
  }

  /**
   * List the caller's corpora with doc/chunk counts. Aliases are NOT included —
   * a list of real, configurable corpora is what dashboards and the control
   * plane want; alias resolution is a per-name `getCorpus` concern.
   */
  async listCorpora(ctx: CorpusServiceContext): Promise<CorpusIntrospection[]> {
    const rows = await this.deps.db
      .select()
      .from(corpora)
      .where(and(eq(corpora.org, ctx.org), eq(corpora.project, ctx.project)))
      .orderBy(corpora.name);
    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);
    const counts = await this.countsForCorpora(ids);
    return rows.map((row) =>
      introspectionFromRow(row, counts.get(row.id) ?? { documentCount: 0, chunkCount: 0 }),
    );
  }

  /**
   * Introspect a single corpus by name, with counts. If `name` is not a corpus
   * but IS an alias in scope, resolves the alias to its target and returns the
   * target's introspection tagged with `alias`. Returns `null` when neither a
   * corpus nor an alias matches (route → 404).
   */
  async getCorpus(name: string, ctx: CorpusServiceContext): Promise<CorpusIntrospection | null> {
    const direct = await this.findCorpus(name, ctx);
    if (direct) {
      const counts = await this.countsForCorpora([direct.id]);
      return introspectionFromRow(
        direct,
        counts.get(direct.id) ?? { documentCount: 0, chunkCount: 0 },
      );
    }

    // Not a corpus — is it an alias? Resolve to the target for introspection.
    const aliasRows = await this.deps.db
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
    const aliasRow = aliasRows[0];
    if (!aliasRow) return null;

    const targetRows = await this.deps.db
      .select()
      .from(corpora)
      .where(eq(corpora.id, aliasRow.targetCorpusId))
      .limit(1);
    const target = targetRows[0];
    // A dangling alias (target gone) should be impossible thanks to the FK
    // cascade, but treat it as not-found rather than throwing.
    if (!target) return null;
    const counts = await this.countsForCorpora([target.id]);
    const view = introspectionFromRow(
      target,
      counts.get(target.id) ?? { documentCount: 0, chunkCount: 0 },
    );
    view.alias = { name, target: target.name };
    return view;
  }

  /**
   * Reconfigure a corpus. Only the fields present in `patch` change; the rest
   * are left as stored. `embeddingModel` may change ONLY while the corpus is
   * still empty (no chunks) — otherwise `EmbeddingModelChangeNotAllowedError`,
   * because re-embedding existing vectors is out of scope. Changing `language`
   * affects how NEW chunks are lexically indexed; already-ingested chunks keep
   * their existing tsvector until re-ingested (dense retrieval is unaffected).
   * Throws `CorpusNotFoundError` when no corpus matches (route → 404).
   */
  async updateCorpus(
    name: string,
    patch: CorpusUpdateSpec,
    ctx: CorpusServiceContext,
    defaults: { embeddingDim: number },
  ): Promise<CorpusIntrospection> {
    return this.deps.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(corpora)
        .where(
          and(eq(corpora.org, ctx.org), eq(corpora.project, ctx.project), eq(corpora.name, name)),
        )
        .limit(1);
      const row = rows[0];
      if (!row) throw new CorpusNotFoundError(name);

      const set: Partial<CorpusRow> = { updatedAt: new Date() };

      if (patch.embeddingModel !== undefined && patch.embeddingModel !== row.embeddingModel) {
        // Guard: refuse a model change once the corpus holds embedded chunks.
        const chunkCount = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(chunks)
          .where(eq(chunks.corpusId, row.id));
        if ((chunkCount[0]?.n ?? 0) > 0) {
          throw new EmbeddingModelChangeNotAllowedError(name);
        }
        // Empty corpus — safe to re-stamp model + revalidate dimension.
        set.embeddingModel = patch.embeddingModel;
        set.embeddingDim = resolveCorpusEmbeddingDim(patch.embeddingModel, defaults.embeddingDim);
      }
      if (patch.language !== undefined) set.textSearchConfig = patch.language;
      if (patch.chunkStrategy !== undefined) set.chunkStrategy = patch.chunkStrategy;
      if (patch.chunkSize !== undefined) set.chunkSize = patch.chunkSize;
      if (patch.chunkOverlap !== undefined) set.chunkOverlap = patch.chunkOverlap;
      if (patch.chunkConfig !== undefined) set.chunkConfig = patch.chunkConfig;
      if (patch.metadata !== undefined) set.metadata = patch.metadata;

      const updated = await tx
        .update(corpora)
        .set(set)
        .where(eq(corpora.id, row.id))
        .returning();
      const newRow = updated[0]!;
      const counts = await this.countsForCorpora([newRow.id], tx);
      return introspectionFromRow(
        newRow,
        counts.get(newRow.id) ?? { documentCount: 0, chunkCount: 0 },
      );
    });
  }

  // -------------------------------------------------------------------------

  private async findCorpus(
    name: string,
    ctx: CorpusServiceContext,
  ): Promise<CorpusRow | undefined> {
    const rows = await this.deps.db
      .select()
      .from(corpora)
      .where(
        and(eq(corpora.org, ctx.org), eq(corpora.project, ctx.project), eq(corpora.name, name)),
      )
      .limit(1);
    return rows[0];
  }

  /**
   * Doc + chunk counts per corpus id, in two grouped queries (each index-backed
   * on `corpus_id`) — cheap, and avoids a docs×chunks cross-join. Returns a map
   * keyed by corpus id; ids with no rows are simply absent.
   */
  private async countsForCorpora(
    ids: string[],
    db: DbOrTx = this.deps.db,
  ): Promise<Map<string, { documentCount: number; chunkCount: number }>> {
    const out = new Map<string, { documentCount: number; chunkCount: number }>();
    if (ids.length === 0) return out;

    const docRows = await db
      .select({ corpusId: documents.corpusId, n: sql<number>`count(*)::int` })
      .from(documents)
      .where(inArray(documents.corpusId, ids))
      .groupBy(documents.corpusId);
    for (const r of docRows) {
      out.set(r.corpusId, { documentCount: r.n, chunkCount: 0 });
    }

    const chunkRows = await db
      .select({ corpusId: chunks.corpusId, n: sql<number>`count(*)::int` })
      .from(chunks)
      .where(inArray(chunks.corpusId, ids))
      .groupBy(chunks.corpusId);
    for (const r of chunkRows) {
      const existing = out.get(r.corpusId) ?? { documentCount: 0, chunkCount: 0 };
      existing.chunkCount = r.n;
      out.set(r.corpusId, existing);
    }
    return out;
  }
}

/** Map a `corpora` row + counts into the wire introspection shape. */
function introspectionFromRow(
  row: CorpusRow,
  counts: { documentCount: number; chunkCount: number },
): CorpusIntrospection {
  return {
    name: row.name,
    embeddingModel: row.embeddingModel,
    embeddingDim: row.embeddingDim,
    language: row.textSearchConfig,
    chunkStrategy: row.chunkStrategy,
    chunkSize: row.chunkSize,
    chunkOverlap: row.chunkOverlap,
    chunkConfig: (row.chunkConfig as Record<string, unknown> | null) ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    documentCount: counts.documentCount,
    chunkCount: counts.chunkCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
  };
}
