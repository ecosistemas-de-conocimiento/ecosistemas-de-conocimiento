// Context-fetch coordinator — M4.
//
// Walks `includeContext` and returns, for each item, an array of chunk text
// strings under a per-item key. The orchestrator merges this map into
// `input.__context` so prompt templates can reference `{{__context.<key>}}`.
//
// Each `includeContext` entry is one of two shapes (`src/services/context/types.ts`):
//   - Inline: `{ corpus, query, topK?, mmr? }` — call retrieve directly.
//   - Named:  `{ name }` — look up `project_configs.contextRules[name]` (a
//     JSON blob shaped like the inline recipe), then call retrieve.
//
// Decision §1: M4 retrieval gets a real call-site HERE. Corpora that don't
// exist yet (M3-era flows that don't have the corpus ingested) return an
// empty array under that key — DO NOT throw. The orchestrator stays
// non-fatal on missing context; the consumer can re-issue once ingest lands.

import type { Db } from '../../db/client.js';
import { db as defaultDb } from '../../db/client.js';
import {
  CorpusNotFoundError,
  RetrieveService,
  type Embedder,
} from '../rag/retrieve.js';
import type { IncludeContextItem } from './types.js';
import type { RetrieveRequest } from '../rag/types.js';
export type { IncludeContextItem } from './types.js';

export interface FetchContextArgs {
  org: string;
  project: string;
  includeContext?: IncludeContextItem[];
  /**
   * Raw `project_configs.contextRules` jsonb — opaque to the service at the
   * SQL level, interpreted here as a map of `name → { corpus, query, topK?,
   * mmr? }` so named-recipe items can be resolved.
   */
  projectContextRules?: unknown;
  /** Injection points for tests. The defaults route through the real RAG stack. */
  retrieveService?: Pick<RetrieveService, 'retrieve'>;
  db?: Db;
  embedder?: Embedder;
}

function keyFor(item: IncludeContextItem, idx: number): string {
  if ('name' in item) return item.name;
  return item.corpus || `item_${idx}`;
}

/**
 * Try to resolve a named recipe out of the project's `contextRules` blob.
 * Returns the inline-shaped recipe or `null` when the name has no entry.
 * `contextRules` is opaque consumer data, so we only accept entries that
 * actually look like a retrieve recipe (`corpus` + `query` strings present).
 */
function resolveNamedRecipe(
  name: string,
  contextRules: unknown,
): RetrieveRequest | null {
  if (!contextRules || typeof contextRules !== 'object') return null;
  const rules = contextRules as Record<string, unknown>;
  const entry = rules[name];
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  if (typeof e['corpus'] !== 'string' || typeof e['query'] !== 'string') return null;
  const out: RetrieveRequest = {
    corpus: e['corpus'],
    query: e['query'],
  };
  if (typeof e['topK'] === 'number') out.topK = e['topK'];
  if (typeof e['mmr'] === 'number') out.mmr = e['mmr'];
  return out;
}

export async function fetchContext(
  args: FetchContextArgs,
): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  const items = args.includeContext ?? [];
  if (items.length === 0) return out;

  const service: Pick<RetrieveService, 'retrieve'> =
    args.retrieveService ??
    new RetrieveService({
      db: args.db ?? defaultDb,
      ...(args.embedder ? { embedder: args.embedder } : {}),
    });

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const key = keyFor(item, i);

    let recipe: RetrieveRequest | null = null;
    if ('name' in item) {
      recipe = resolveNamedRecipe(item.name, args.projectContextRules);
    } else {
      recipe = {
        corpus: item.corpus,
        query: item.query,
        ...(item.topK !== undefined ? { topK: item.topK } : {}),
        ...(item.mmr !== undefined ? { mmr: item.mmr } : {}),
      };
    }

    if (!recipe) {
      // Named recipe that the project didn't define ⇒ no-op (empty array).
      // Matches the "M3-era code paths" graceful-empty contract.
      out[key] = [];
      continue;
    }

    try {
      const result = await service.retrieve(recipe, {
        org: args.org,
        project: args.project,
      });
      out[key] = result.chunks.map((c) => c.text);
    } catch (err) {
      if (err instanceof CorpusNotFoundError) {
        // Decision §1: missing corpus is non-fatal — return empty array.
        out[key] = [];
        continue;
      }
      throw err;
    }
  }

  return out;
}
