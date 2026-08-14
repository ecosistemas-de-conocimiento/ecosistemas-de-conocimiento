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
