// In-memory response cache for the router. Keyed by a stable SHA-256 hash of
// (model, messages, maxTokens, temperature, namespace?). Caller decides per
// request whether the cache should be consulted; non-deterministic surfaces
// must opt out.

import { LRUCache } from 'lru-cache';
import { createHash, type Hash } from 'node:crypto';

import type { ChatMessage } from './types.js';

export interface CacheKeyInput {
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  /**
   * 🔴 THE TENANT. This cache is SHARED across every caller in the process
   * (`getSharedRouterCache`), so the tenant is not context — it is part of the
   * identity of the entry. Omit it and one tenant serves another's completion.
   */
  org?: string;
  /**
   * 🔴 THE PROJECT INSIDE THAT TENANT, and it belongs in the key for the same
   * reason `org` does. It used to be missing: `router.ts` passed the org as
   * `namespace` and nothing carried the project, so two projects in one
   * organisation shared a cached completion for the 5-minute TTL.
   *
   * ⚠ That was never a cross-ORG leak — the org WAS in the key the whole time,
   * via `namespace`. An early report claiming otherwise read this function and
   * not its caller. It was a narrower, real surprise: same org, different
   * project, same answer.
   */
  project?: string | null;
  /** Optional namespace to keep e.g. critique/refine entries separate. */
  namespace?: string;
  /**
   * The provider `response_format` (JSON mode or a strict schema), when the
   * call sets one. Different formats are different provider requests, so they
   * must not share an entry. Absent ⇒ the digest is byte-identical to the one
   * this function produced before the field existed.
   */
  responseFormat?: unknown;
}

/**
 * The byte that terminates a field's length prefix. See `writeField`.
 *
 * ⚠ THIS COMMENT USED TO SAY `\u0000` "CANNOT occur in any field", AND THAT WAS
 * WRONG. A JS string holds any code unit, and `org`/`project` are parsed out of
 * the `API_KEYS` JSON env — an operator can put this byte in a slug. A separator
 * alone therefore never framed these fields safely; it only made the collision
 * harder to reach.
 */
const FIELD_SEP = '\u0000';

/**
 * Append ONE field to the digest, framed so it cannot be confused with its
 * neighbours: the value's BYTE length, `FIELD_SEP`, then the value.
 *
 * 🔴 WHY FRAMING AND NOT A SEPARATOR. Every field lands in one flat byte stream,
 * so a separator a value can contain lets two different inputs produce one
 * digest — and this cache is process-shared, so a collision hands a caller
 * another caller's completion. Two were real here:
 *   · `{org:'a\u0000b', project:'c'}` and `{org:'a', project:'b\u0000c'}`, which
 *     both hashed the stream `a` NUL `b` NUL `c`. Operator-reachable through
 *     `API_KEYS`, which is why it was low and not high.
 *   · messages, which were joined by the literals `::` and `||`. Message CONTENT
 *     is whatever the end user typed, so ONE message `x||user::y` reproduced the
 *     stream of TWO messages `x` and `y`. No operator needed.
 * Length-prefixing removes the class instead of narrowing it: the digits say how
 * many bytes follow, so no value can end its own field early or run into the
 * next one.
 *
 * ⚠ BYTE length, not `String.length`. `.length` counts UTF-16 code units while
 * `update()` hashes UTF-8 bytes, so `'é'` would announce 1 and contribute 2.
 *
 * ⚠ AND THE LENGTH STILL NEEDS THE TERMINATOR. Digits alone are not enough,
 * because a value may itself begin with digits. Measured: under a bare
 * `update(String(v.length)); update(v)`, `{org:'0', project:'abcdefgh6ijklmn'}`
 * and `{org:'15abcdefgh', project:'ijklmn'}` still collide. `FIELD_SEP` ends the
 * digit run, and a decimal length can never contain it.
 */
function writeField(h: Hash, value: string): void {
  h.update(String(Buffer.byteLength(value)));
  h.update(FIELD_SEP);
  h.update(value);
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
  // 🔴 TENANT FIRST, and both halves of it. `org` alone is not the tenant of a
  // cached completion — two projects inside one organisation are different
  // callers with different context, and they used to share entries.
  writeField(h, input.org ?? '');
  writeField(h, input.project ?? '');
  writeField(h, input.namespace ?? '');
  writeField(h, input.model);
  writeField(h, input.maxTokens === undefined ? '' : String(input.maxTokens));
  writeField(h, input.temperature === undefined ? '' : input.temperature.toFixed(3));
  // Written only when set, so plain-text keys are unchanged. Framed like every
  // other field; the `rf:` tag keeps it from reading as a message role.
  if (input.responseFormat !== undefined) {
    writeField(h, `rf:${JSON.stringify(input.responseFormat)}`);
  }
  for (const m of input.messages) {
    writeField(h, m.role);
    writeField(h, m.content);
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

  /**
   * 🔴 AN EMPTY ANSWER IS NEVER STORED. Measured on dev 2026-11-10: a cached
   * empty completion was re-served to a later identical request in 0 ms. The
   * router raises `EmptyCompletion` before it gets here; this is the second
   * lock, for any other caller of the cache.
   *
   * Entries live in this process only (an LRU, `ttlMs` default 5 min), so a
   * restart — every deploy — drops whatever an older build stored.
   */
  set(key: string, entry: CacheEntry): void {
    if (entry.contentText.trim() === '') return;
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
