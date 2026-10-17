// Corpus alias service — `POST /v1/corpus/:name/alias`.
//
// A cheap, re-embed-free rolling pointer (the `:latest` use-case). An alias is
// a `corpus_aliases` row mapping `(org, project, name)` → `target_corpus_id`;
// retrieval against the alias name substitutes the target corpus id, so the
// alias returns the target's chunks WITHOUT any re-embedding (contrast with the
// delete-then-reingest interim, which paid 2× embedding cost).
//
// Behaviour:
//   - Resolve the target corpus by `(org, project, target)` — a target in
//     another tenant is indistinguishable from a missing one (same no-info-leak
//     posture as DELETE / retrieve). Missing ⇒ `TargetCorpusNotFoundError`.
//   - Refuse a name that already names a real corpus in the same scope
//     (`AliasNameConflictError`) — alias names share the corpus namespace, so a
//     name can be a corpus OR an alias, never both.
//   - Create-or-repoint is an idempotent UPSERT on `(org, project, name)`:
//     the FIRST call creates the row, a later call with a different target is a
//     single-row atomic UPDATE of `target_corpus_id`. Both are cheap.
//   - Cross-tenant isolation: both the alias row and its target are scoped to
//     the caller's `(org, project)`.
//
// Target-delete semantics: the FK is `ON DELETE CASCADE`, so deleting the
// target corpus removes the alias row too. A retrieve via the now-gone alias
// then 404s (CORPUS_NOT_FOUND) — the honest "there is nothing here" answer.
// Re-aliasing recreates the pointer. (If a consumer wants the alias to survive
// a target swap, it repoints the alias at the NEW target BEFORE deleting the
// old one — the repoint is atomic, so retrieval never observes a gap.)

import { and, eq, sql } from 'drizzle-orm';

import type { Db } from '../../db/client.js';
import { NestedEnvelopeError } from '../../errors/base.js';
import { corpora, corpusAliases } from '../../db/schema/index.js';

export interface CorpusAliasServiceDeps {
  db: Db;
}

export interface CorpusAliasContext {
  org: string;
  project: string;
}

export interface CorpusAliasResult {
  /** The alias name. */
  alias: string;
  /** The corpus name the alias now resolves to. */
  target: string;
  /** The resolved target corpus id. */
  targetCorpusId: string;
  /** `true` when this call created the alias row, `false` when it repointed an existing one. */
  created: boolean;
}

/**
 * Thrown when the `target` corpus does not exist in the caller's scope. 404.
 *
 * ⚠ The MESSAGE is the wire message. `POST /v1/corpus/:name/alias` used to
 * catch this class and hand-build a SHORTER body, because `message` also named
 * `(org=…, project=…)` and the route did not want the caller's scope echoed
 * into a 404. The route no longer re-decides anything, so the shortening moved
 * HERE: the message is scope-free by construction and the scope survives as
 * fields for the log line. Byte-identical on the wire to what the route sent.
 */
export class TargetCorpusNotFoundError extends NestedEnvelopeError {
  readonly code = 'ERR_TARGET_CORPUS_NOT_FOUND';
  readonly status = 404;
  public readonly target: string;
  public readonly org: string;
  public readonly project: string;
  constructor(opts: { target: string; org: string; project: string }) {
    super(`target corpus '${opts.target}' not found`);
    this.name = 'TargetCorpusNotFoundError';
    this.target = opts.target;
    this.org = opts.org;
    this.project = opts.project;
  }
}

/**
 * Thrown when the alias name already names a real corpus in the same scope. 409.
 * Same scope-free-message rule as `TargetCorpusNotFoundError` above.
 */
export class AliasNameConflictError extends NestedEnvelopeError {
  readonly code = 'ERR_ALIAS_NAME_CONFLICT';
  readonly status = 409;
  public readonly aliasName: string;
  public readonly org: string;
  public readonly project: string;
  constructor(opts: { name: string; org: string; project: string }) {
    super(`'${opts.name}' already names a corpus; alias names cannot collide with corpora`);
    this.name = 'AliasNameConflictError';
    this.aliasName = opts.name;
    this.org = opts.org;
    this.project = opts.project;
  }
}

export class CorpusAliasService {
  constructor(private readonly deps: CorpusAliasServiceDeps) {}

  /**
   * Create or repoint the alias `(org, project, name)` → `target`.
   *
   * Atomic: the whole thing runs in one transaction; the upsert is a single
   * `INSERT … ON CONFLICT DO UPDATE`, so a concurrent repoint is serialised by
   * the unique index, never partially applied.
   */
  async setAlias(
    name: string,
    target: string,
    ctx: CorpusAliasContext,
  ): Promise<CorpusAliasResult> {
    return this.deps.db.transaction(async (tx) => {
      // 1. Resolve the target corpus in caller scope.
      const targetRows = await tx
        .select({ id: corpora.id })
        .from(corpora)
        .where(
          and(
            eq(corpora.org, ctx.org),
            eq(corpora.project, ctx.project),
            eq(corpora.name, target),
          ),
        )
        .limit(1);
      const targetRow = targetRows[0];
      if (!targetRow) {
        throw new TargetCorpusNotFoundError({
          target,
          org: ctx.org,
          project: ctx.project,
        });
      }

      // 2. Refuse a name that already names a real corpus in this scope —
      //    alias names share the corpus namespace.
      const nameClashRows = await tx
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
      if (nameClashRows[0]) {
        throw new AliasNameConflictError({ name, org: ctx.org, project: ctx.project });
      }

      // 3. Upsert the pointer. `created` is derived from whether the conflict
      //    path fired: `xmax = 0` on the returned row means a fresh INSERT.
      const upserted = await tx
        .insert(corpusAliases)
        .values({
          org: ctx.org,
          project: ctx.project,
          name,
          targetCorpusId: targetRow.id,
        })
        .onConflictDoUpdate({
          target: [corpusAliases.org, corpusAliases.project, corpusAliases.name],
          set: { targetCorpusId: targetRow.id, updatedAt: new Date() },
        })
        .returning({
          id: corpusAliases.id,
          created: sql<boolean>`(xmax = 0)`,
        });

      const row = upserted[0]!;
      return {
        alias: name,
        target,
        targetCorpusId: targetRow.id,
        created: row.created,
      };
    });
  }
}
