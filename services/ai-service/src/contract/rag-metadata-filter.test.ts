// Contract tests for the retrieve metadata `filter` — the `$in` operator and
// the per-corpus `corpusFilters` on /v1/retrieve/multi.

import { describe, expect, it } from 'vitest';

import { retrieveMultiRequestSchema, retrieveRequestSchema } from './rag.js';

const single = (filter: unknown) =>
  retrieveRequestSchema.safeParse({ corpus: 'c', query: 'q', filter });

function messages(r: { success: boolean; error?: { issues: Array<{ message: string }> } }) {
  return r.success ? '' : r.error!.issues.map((i) => i.message).join('; ');
}

describe('retrieve filter: $in', () => {
  it('accepts a non-empty array of strings and numbers', () => {
    expect(single({ docId: { $in: ['12', '34'] } }).success).toBe(true);
    expect(single({ docId: { $in: [12, 34.5, '7'] } }).success).toBe(true);
    expect(single({ docId: { $in: ['1'] }, kind: 'draft' }).success).toBe(true);
  });

  it('accepts exactly 500 values and rejects 501', () => {
    const vals = Array.from({ length: 500 }, (_, i) => String(i));
    expect(single({ docId: { $in: vals } }).success).toBe(true);
    const r = single({ docId: { $in: [...vals, '500'] } });
    expect(r.success).toBe(false);
    expect(messages(r)).toMatch(/filter\.docId\.\$in/);
  });

  it('rejects an empty array', () => {
    const r = single({ docId: { $in: [] } });
    expect(r.success).toBe(false);
    expect(messages(r)).toMatch(/filter\.docId\.\$in/);
  });

  it('rejects a non-array operand', () => {
    expect(single({ docId: { $in: '12' } }).success).toBe(false);
    expect(single({ docId: { $in: null } }).success).toBe(false);
  });

  it('rejects element types other than string or number', () => {
    for (const bad of [null, true, { a: 1 }, ['1']]) {
      const r = single({ docId: { $in: ['ok', bad] } });
      expect(r.success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('rejects $in combined with other keys in the same operand', () => {
    const r = single({ docId: { $in: ['1'], other: 2 } });
    expect(r.success).toBe(false);
    expect(messages(r)).toMatch(/filter\.docId/);
  });

  it('keeps today’s plain-containment filters valid (backward compatible)', () => {
    expect(single({ sessionId: 'A' }).success).toBe(true);
    expect(single({ tags: { nested: [1, 2] } }).success).toBe(true);
    expect(single({}).success).toBe(true);
  });
});

describe('retrieve/multi: corpusFilters', () => {
  const multi = (extra: Record<string, unknown>) =>
    retrieveMultiRequestSchema.safeParse({ corpora: ['shared', 'drafts'], query: 'q', ...extra });

  it('accepts a per-corpus filter keyed by a requested corpus', () => {
    const r = multi({ mode: 'hybrid', corpusFilters: { drafts: { docId: { $in: ['12', '34'] } } } });
    expect(r.success).toBe(true);
  });

  it('applies the same $in validation inside corpusFilters', () => {
    const r = multi({ corpusFilters: { drafts: { docId: { $in: [] } } } });
    expect(r.success).toBe(false);
  });

  it('rejects a corpusFilters key that is not in corpora (a typo would leak unfiltered rows)', () => {
    const r = multi({ corpusFilters: { draft: { docId: { $in: ['1'] } } } });
    expect(r.success).toBe(false);
    expect(messages(r)).toMatch(/corpusFilters\.draft/);
  });

  it('still validates the shared filter', () => {
    expect(multi({ filter: { docId: { $in: [] } } }).success).toBe(false);
    expect(multi({ filter: { docId: { $in: ['1'] } } }).success).toBe(true);
  });
});
