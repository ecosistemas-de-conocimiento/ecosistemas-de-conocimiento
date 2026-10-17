// Unit tests for the router in-memory cache.

import { describe, expect, it } from 'vitest';

import type { ChatMessage } from './types.js';
import {
  RouterCache,
  getSharedRouterCache,
  hashKey,
  type CacheEntry,
  type CacheKeyInput,
} from './cache.js';

const baseMessages: ChatMessage[] = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'Hello.' },
];

function makeEntry(overrides: Partial<CacheEntry> = {}): CacheEntry {
  return {
    contentText: 'ok',
    inputTokens: 10,
    outputTokens: 5,
    costUsd: 0.0001,
    model: 'm',
    ...overrides,
  };
}

describe('hashKey', () => {
  it('produces the same hash for identical inputs', () => {
    const a: CacheKeyInput = {
      model: 'gpt-4o',
      messages: baseMessages,
      maxTokens: 256,
      temperature: 0.2,
    };
    const b: CacheKeyInput = {
      model: 'gpt-4o',
      messages: [...baseMessages],
      maxTokens: 256,
      temperature: 0.2,
    };
    expect(hashKey(a)).toBe(hashKey(b));
  });

  it('produces a different hash when model changes', () => {
    const a: CacheKeyInput = {
      model: 'gpt-4o',
      messages: baseMessages,
      maxTokens: 256,
      temperature: 0.2,
    };
    const b: CacheKeyInput = { ...a, model: 'claude-3-5-sonnet' };
    expect(hashKey(a)).not.toBe(hashKey(b));
  });

  it('produces a different hash when messages differ', () => {
    const a: CacheKeyInput = {
      model: 'gpt-4o',
      messages: baseMessages,
      maxTokens: 256,
      temperature: 0.2,
    };
    const b: CacheKeyInput = {
      ...a,
      messages: [...baseMessages, { role: 'user', content: 'more' }],
    };
    expect(hashKey(a)).not.toBe(hashKey(b));
  });

  it('produces a different hash when namespace differs', () => {
    const a: CacheKeyInput = {
      model: 'gpt-4o',
      messages: baseMessages,
      maxTokens: 256,
      temperature: 0.2,
      namespace: 'generate',
    };
    const b: CacheKeyInput = { ...a, namespace: 'critique' };
    expect(hashKey(a)).not.toBe(hashKey(b));
  });

  it('handles optional fields without throwing', () => {
    const k: CacheKeyInput = { model: 'm', messages: baseMessages };
    expect(typeof hashKey(k)).toBe('string');
    expect(hashKey(k)).toHaveLength(64);
  });

  it('produces a different hash for a different org', () => {
    // The cache is process-shared, so the tenant is part of the entry's
    // identity. Without this, one organisation serves another's completion.
    const a: CacheKeyInput = { model: 'm', messages: baseMessages, org: 'acme', project: 'p' };
    const b: CacheKeyInput = { ...a, org: 'globex' };
    expect(hashKey(a)).not.toBe(hashKey(b));
  });

  it('🔴 produces a different hash for a different project in the SAME org', () => {
    // FG-18. `router.ts` used to pass the org as `namespace` and carry no
    // project at all, so these two collided and shared an answer for the
    // 5-minute TTL. Same org is not the same caller.
    const a: CacheKeyInput = { model: 'm', messages: baseMessages, org: 'acme', project: 'proj-a' };
    const b: CacheKeyInput = { ...a, project: 'proj-b' };
    expect(hashKey(a)).not.toBe(hashKey(b));
  });

  it('treats a missing project and a null project as the same tenant', () => {
    // Both mean "no project". They must not split the cache in two, or a caller
    // that omits the field never hits an entry written by one that passed null.
    const a: CacheKeyInput = { model: 'm', messages: baseMessages, org: 'acme' };
    const b: CacheKeyInput = { ...a, project: null };
    expect(hashKey(a)).toBe(hashKey(b));
  });

  it('keeps org and project distinguishable when one value contains the other', () => {
    // The fields are joined before hashing, so a separator that a value could
    // contain would let these two produce one digest. They must not.
    const a: CacheKeyInput = { model: 'm', messages: baseMessages, org: 'a', project: 'b|c' };
    const b: CacheKeyInput = { model: 'm', messages: baseMessages, org: 'a|b', project: 'c' };
    expect(hashKey(a)).not.toBe(hashKey(b));
  });

  it('🔴 keeps org and project distinct when a value contains the SEPARATOR', () => {
    // FG-18 follow-up. The fields used to be joined by a lone `\u0000` and the
    // comment claimed that byte "CANNOT occur in any field". It can: `org` and
    // `project` are read from the `API_KEYS` JSON env, and a JS string holds any
    // code unit. These two are the shortest proof — with a lone separator they
    // both hash the byte sequence `a NUL b NUL c`.
    const a: CacheKeyInput = { model: 'm', messages: baseMessages, org: 'a\u0000b', project: 'c' };
    const b: CacheKeyInput = { model: 'm', messages: baseMessages, org: 'a', project: 'b\u0000c' };
    expect(hashKey(a)).not.toBe(hashKey(b));
  });

  it('🔴 message boundaries cannot be forged from message CONTENT', () => {
    // The same defect one field over, and this one needs no operator at all:
    // message content is whatever the end user typed. The messages used to be
    // joined by the literals `::` and `||`, so a single message containing
    // `x||user::y` reproduced the byte sequence of TWO messages `x` and `y`.
    const a: CacheKeyInput = {
      model: 'm',
      messages: [
        { role: 'user', content: 'x' },
        { role: 'user', content: 'y' },
      ],
      org: 'acme',
      project: 'proj-a',
    };
    const b: CacheKeyInput = {
      ...a,
      messages: [{ role: 'user', content: 'x||user::y' }],
    };
    expect(hashKey(a)).not.toBe(hashKey(b));
  });

  it('frames fields even when a value BEGINS with digits', () => {
    // A regression guard, not a report of a live defect: it passes on the old
    // separator scheme too. It exists so nobody "simplifies" `writeField` down
    // to a bare `update(String(v.length)); update(v)` — these two collide under
    // exactly that, because the length digits then run into a value that starts
    // with digits. The `FIELD_SEP` terminator is what stops it.
    const a: CacheKeyInput = { model: 'm', messages: baseMessages, org: '0', project: 'abcdefgh6ijklmn' };
    const b: CacheKeyInput = { model: 'm', messages: baseMessages, org: '15abcdefgh', project: 'ijklmn' };
    expect(hashKey(a)).not.toBe(hashKey(b));
  });

  it('still separates namespaces within one project', () => {
    // `namespace` keeps critique/refine entries apart and is now only that —
    // it no longer doubles as the tenant.
    const a: CacheKeyInput = {
      model: 'm',
      messages: baseMessages,
      org: 'acme',
      project: 'proj-a',
      namespace: 'generate',
    };
    const b: CacheKeyInput = { ...a, namespace: 'critique' };
    expect(hashKey(a)).not.toBe(hashKey(b));
  });
});

describe('RouterCache', () => {
  it('round-trips entries via get/set', () => {
    const c = new RouterCache({ max: 10 });
    const key = hashKey({ model: 'm', messages: baseMessages });
    expect(c.get(key)).toBeUndefined();
    const entry = makeEntry({ contentText: 'hello' });
    c.set(key, entry);
    expect(c.get(key)).toEqual(entry);
    expect(c.has(key)).toBe(true);
    expect(c.size).toBe(1);
  });

  it('evicts the oldest entry past max (LRU)', () => {
    const max = 3;
    const c = new RouterCache({ max });
    const keys: string[] = [];
    for (let i = 0; i < max + 1; i++) {
      const k = hashKey({
        model: `m-${i}`,
        messages: baseMessages,
      });
      keys.push(k);
      c.set(k, makeEntry({ contentText: `v-${i}` }));
    }
    expect(c.size).toBe(max);
    // First inserted key should have been evicted.
    expect(c.get(keys[0]!)).toBeUndefined();
    // Most recent should still be present.
    expect(c.get(keys[max]!)?.contentText).toBe(`v-${max}`);
  });

  it('clear() resets size to 0', () => {
    const c = new RouterCache({ max: 10 });
    c.set('a', makeEntry());
    c.set('b', makeEntry());
    expect(c.size).toBe(2);
    c.clear();
    expect(c.size).toBe(0);
    expect(c.get('a')).toBeUndefined();
  });
});

describe('getSharedRouterCache', () => {
  it('returns the same instance on repeated calls', () => {
    const a = getSharedRouterCache();
    const b = getSharedRouterCache();
    expect(a).toBe(b);
  });
});
