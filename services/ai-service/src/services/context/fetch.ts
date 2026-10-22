// Context-fetch coordinator for `includeContext` on generation requests.
//
// Walks `includeContext` and returns, for each item, an array of chunk text
// strings under a per-item key. The caller merges this map into
// `input.__context` so prompt templates can reference `{{__context.<key>}}`.
//
// Each `includeContext` entry is one of two shapes (`src/contract/context.ts`):
//   - Inline: `{ corpus, query, topK?, mmr?, mode?, rerank?, filter?, asOf? }`
//     — call retrieve directly.
//   - Named:  `{ name }` — look up `project_configs.contextRules[name]` (a
//     JSON blob shaped like the inline recipe), then call retrieve.
//
// 🔴 FAILS LOUDLY (AIS-3; supersedes m3-m4 "Decision §1: missing corpus is
// non-fatal"). A missing corpus used to return `[]` and the generation went
// ahead UNGROUNDED with HTTP 200 — a grounded feature answering from nothing
// and looking normal. Now:
//   - missing corpus  → `CorpusNotFoundError` (404, nested envelope)
//   - unknown recipe  → `SpecResolutionError`, cause `unknown context recipe`
//                       (400, an existing typed class the client resolves)
//   - over budget     → the budget classes (402), via the metered retrieve
// No ungrounded 200 on any of them.

import { and, eq } from 'drizzle-orm';

import type { Db } from '../../db/client.js';
import { db as defaultDb } from '../../db/client.js';
import { projectConfigs } from '../../db/schema/index.js';
import { BudgetEnforcer } from '../budget/enforcer.js';
import { SpecResolutionError } from '../registry/resolve.js';
import { RetrieveService, type Embedder, type RetrieveLogger } from '../rag/retrieve.js';
import type { RetrievalBudget } from '../rag/retrieval-meter.js';
import { inlineContextItemSchema, type IncludeContextItem } from '../../contract/context.js';
import type { RetrievalLeg, RetrievalWarning, RetrieveRequest } from '../rag/types.js';
export type { IncludeContextItem } from '../../contract/context.js';

export interface FetchContextArgs {
  org: string;
  project: string;
  includeContext?: IncludeContextItem[];
  /**
   * Raw `project_configs.contextRules` jsonb — opaque to the service at the
   * SQL level, interpreted here as a map of `name → inline recipe` so
   * named-recipe items can be resolved. Absent ⇒ read from `project_configs`
   * for `(org, project)`, and only when a named item is present.
   *
   * ⚠ No caller ever passed this before the read was added here, so every
   * named item resolved to `[]` — silently, which is how it went unnoticed.
   */
  projectContextRules?: unknown;
  /**
   * Logger handed to the `RetrieveService` this function builds. Without it the
   * generate-with-RAG path clamps over-bound stored chunks SILENTLY: the warn
   * that makes such a row visible is emitted inside `RetrieveService.retrieve`,
   * so a service constructed without a logger swallows it. Optional because the
   * non-HTTP call sites (eval, tests) legitimately have none.
   */
  logger?: RetrieveLogger;
  /** Injection points for tests. The defaults route through the real RAG stack. */
  retrieveService?: Pick<RetrieveService, 'retrieve'>;
  db?: Db;
  embedder?: Embedder;
  /** Budget for the default service. Defaults to a `BudgetEnforcer` over `db`. */
  budget?: RetrievalBudget;
}

/**
 * What one `includeContext` item retrieved — the ids a consumer needs to cite
 * or audit the grounding, plus the same degradation signals `/v1/retrieve`
 * returns. Never carries chunk text (that is what the prompt got).
 */
export interface RetrievalTraceEntry {
  /** The `__context` key the chunks were rendered under. */
  key: string;
  /** The corpus actually queried (a named recipe resolves to one). */
  corpus: string;
  /** In rank order, exactly the chunks whose text reached the prompt. */
  chunkIds: string[];
  legs: RetrievalLeg[];
  warnings?: RetrievalWarning[];
}

export interface FetchContextResult {
  context: Record<string, string[]>;
  retrievalTrace: RetrievalTraceEntry[];
}

function keyFor(item: IncludeContextItem, idx: number): string {
  if ('name' in item) return item.name;
  return item.corpus || `item_${idx}`;
}

/**
 * The retrieve request an inline item (or a resolved recipe) stands for.
 * `topK` is clamped only by the retrieve service's own default.
 */
function toRetrieveRequest(item: Exclude<IncludeContextItem, { name: string }>): RetrieveRequest {
  return {
    corpus: item.corpus,
    query: item.query,
    ...(item.topK !== undefined ? { topK: item.topK } : {}),
    ...(item.mmr !== undefined ? { mmr: item.mmr } : {}),
    ...(item.mode !== undefined ? { mode: item.mode } : {}),
    ...(item.rerank !== undefined ? { rerank: item.rerank } : {}),
    ...(item.filter !== undefined ? { filter: item.filter } : {}),
    ...(item.asOf !== undefined ? { asOf: item.asOf } : {}),
  };
}

/**
 * Resolve a named recipe out of the project's `contextRules` blob, validated
 * with the same schema as an inline item. Unknown keys are ignored (the blob
 * is consumer data); a missing or malformed entry throws.
 */
function resolveNamedRecipe(name: string, contextRules: unknown): RetrieveRequest {
  const rules =
    contextRules && typeof contextRules === 'object'
      ? (contextRules as Record<string, unknown>)
      : {};
  const entry = Object.hasOwn(rules, name) ? rules[name] : undefined;
  if (entry === undefined) {
    throw new SpecResolutionError({
      cause: 'unknown context recipe',
      message: `includeContext: no context recipe named '${name}' in this project's contextRules`,
    });
  }
  const parsed = inlineContextItemSchema.strip().safeParse(entry);
  if (!parsed.success) {
    throw new SpecResolutionError({
      cause: 'unknown context recipe',
      message:
        `includeContext: context recipe '${name}' is not a valid retrieve recipe: ` +
        parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
    });
  }
  return toRetrieveRequest(parsed.data);
}

/** The project's `contextRules` blob, or `undefined` when it has no config row. */
async function loadContextRules(db: Db, org: string, project: string): Promise<unknown> {
  const rows = await db
    .select({ contextRules: projectConfigs.contextRules })
    .from(projectConfigs)
    .where(and(eq(projectConfigs.org, org), eq(projectConfigs.project, project)))
    .limit(1);
  return rows[0]?.contextRules ?? undefined;
}

/**
 * Resolve every `includeContext` item and retrieve it. Throws on a missing
 * corpus, an unknown recipe or a budget refusal — see the file header.
 */
export async function fetchContextWithTrace(args: FetchContextArgs): Promise<FetchContextResult> {
  const context: Record<string, string[]> = {};
  const retrievalTrace: RetrievalTraceEntry[] = [];
  const items = args.includeContext ?? [];
  if (items.length === 0) return { context, retrievalTrace };

  const db = args.db ?? defaultDb;
  const service: Pick<RetrieveService, 'retrieve'> =
    args.retrieveService ??
    new RetrieveService({
      db,
      budget: args.budget ?? new BudgetEnforcer(db),
      ...(args.embedder ? { embedder: args.embedder } : {}),
      ...(args.logger ? { logger: args.logger } : {}),
    });

  const contextRules =
    args.projectContextRules !== undefined || !items.some((item) => 'name' in item)
      ? args.projectContextRules
      : await loadContextRules(db, args.org, args.project);

  // Resolve every recipe BEFORE the first retrieve: an unknown recipe in the
  // last item must not cost the embeds of the items before it.
  const requests = items.map((item, i) => ({
    key: keyFor(item, i),
    recipe: 'name' in item ? resolveNamedRecipe(item.name, contextRules) : toRetrieveRequest(item),
  }));

  for (const { key, recipe } of requests) {
    const result = await service.retrieve(recipe, {
      org: args.org,
      project: args.project,
    });
    context[key] = result.chunks.map((c) => c.text);
    retrievalTrace.push({
      key,
      corpus: recipe.corpus,
      chunkIds: result.chunks.map((c) => c.chunkId),
      legs: result.legs,
      ...(result.warnings && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    });
  }

  return { context, retrievalTrace };
}

/** The `__context` map only. Same failure behaviour as `fetchContextWithTrace`. */
export async function fetchContext(args: FetchContextArgs): Promise<Record<string, string[]>> {
  return (await fetchContextWithTrace(args)).context;
}
