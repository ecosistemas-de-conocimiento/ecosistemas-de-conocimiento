// In-memory response cache for the router. Keyed by a stable SHA-256 hash of
// (model, messages, maxTokens, temperature, namespace?). Caller decides per
// request whether the cache should be consulted; non-deterministic surfaces
// must opt out.
//
// Ported 1:1 from a prototype `services/ai/router/cache.ts`.

import { LRUCache } from 'lru-cache';
import { createHash } from 'node:crypto';

import type { ChatMessage } from './types.js';

export interface CacheKeyInput {
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Optional namespace to keep e.g. critique/refine entries separate. */
  namespace?: string;
}

export interface CacheEntry {
  contentText: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string;
}

export function hashKey(input: CacheKeyInput): string {
  const h = createHash('sha256');
  h.update(input.namespace ?? '');
  h.update('|');
  h.update(input.model);
  h.update('|');
  h.update(input.maxTokens === undefined ? '' : String(input.maxTokens));
  h.update('|');
  h.update(input.temperature === undefined ? '' : input.temperature.toFixed(3));
  h.update('|');
  for (const m of input.messages) {
    h.update(m.role);
    h.update('::');
    h.update(m.content);
    h.update('||');
  }
  return h.digest('hex');
}

export class RouterCache {
  private readonly lru: LRUCache<string, CacheEntry>;

  constructor(opts: { max?: number; ttlMs?: number } = {}) {
    this.lru = new LRUCache<string, CacheEntry>({
      max: opts.max ?? 500,
      ttl: opts.ttlMs ?? 5 * 60_000,
      allowStale: false,
    });
  }

  get(key: string): CacheEntry | undefined {
    return this.lru.get(key);
  }

  set(key: string, entry: CacheEntry): void {
    this.lru.set(key, entry);
  }

  has(key: string): boolean {
    return this.lru.has(key);
  }

  clear(): void {
    this.lru.clear();
  }

  get size(): number {
    return this.lru.size;
  }
}

let _shared: RouterCache | null = null;
export function getSharedRouterCache(): RouterCache {
  if (!_shared) _shared = new RouterCache();
  return _shared;
}
