// Unit tests for the retrieve metadata-filter SQL builder. Renders the drizzle
// fragment with the real Postgres dialect and asserts on the SQL TEXT and the
// bound PARAMS separately — the point of the `$in` operator's tests is that no
// caller-supplied value (key or element) ever lands in the SQL text.

import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import { MAX_IN_VALUES, isInOperand, metadataFilterClause } from './metadata-filter.js';

const dialect = new PgDialect();
function render(filter?: Record<string, unknown>) {
  return dialect.sqlToQuery(sql`SELECT 1 WHERE true${metadataFilterClause(filter)}`);
}

describe('metadataFilterClause', () => {
  it('absent or {} filter emits no clause (byte-identical to before)', () => {
    expect(render(undefined)).toEqual({ sql: 'SELECT 1 WHERE true', params: [] });
    expect(render({})).toEqual({ sql: 'SELECT 1 WHERE true', params: [] });
  });

  it('plain key/value filter stays a single jsonb containment', () => {
    const q = render({ sessionId: 'A', n: 5 });
    expect(q.sql).toBe('SELECT 1 WHERE true AND "metadata" @> $1::jsonb');
    expect(q.params).toEqual(['{"sessionId":"A","n":5}']);
  });

  it('$in becomes a parameterised set-membership test on that key', () => {
    const q = render({ docId: { $in: ['12', 34] } });
    expect(q.sql).toBe(
      'SELECT 1 WHERE true AND ("metadata" -> $1) IN (SELECT jsonb_array_elements($2::jsonb))',
    );
    expect(q.params).toEqual(['docId', '["12",34]']);
  });

  it('mixes containment and $in with AND, containment first', () => {
    const q = render({ kind: 'draft', docId: { $in: ['1'] }, owner: { $in: [7, 8] } });
    expect(q.sql).toBe(
      'SELECT 1 WHERE true AND "metadata" @> $1::jsonb' +
        ' AND ("metadata" -> $2) IN (SELECT jsonb_array_elements($3::jsonb))' +
        ' AND ("metadata" -> $4) IN (SELECT jsonb_array_elements($5::jsonb))',
    );
    expect(q.params).toEqual(['{"kind":"draft"}', 'docId', '["1"]', 'owner', '[7,8]']);
  });

  it('never interpolates a hostile key or value into the SQL text', () => {
    const evilKey = `x") OR 1=1; --`;
    const evilVal = `'); DROP TABLE chunks; --`;
    const q = render({ [evilKey]: { $in: [evilVal] } });
    expect(q.sql).not.toContain('DROP');
    expect(q.sql).not.toContain('1=1');
    expect(q.params).toEqual([evilKey, JSON.stringify([evilVal])]);
  });

  it('a nested object WITHOUT $in is still plain containment', () => {
    const q = render({ tags: { a: 1 } });
    expect(q.sql).toBe('SELECT 1 WHERE true AND "metadata" @> $1::jsonb');
    expect(q.params).toEqual(['{"tags":{"a":1}}']);
  });
});

describe('isInOperand', () => {
  it('recognises only a plain object carrying the $in key', () => {
    expect(isInOperand({ $in: [1] })).toBe(true);
    expect(isInOperand({ $in: [] })).toBe(true); // shape check only — the contract caps it
    expect(isInOperand({ in: [1] })).toBe(false);
    expect(isInOperand([1])).toBe(false);
    expect(isInOperand(null)).toBe(false);
    expect(isInOperand('x')).toBe(false);
  });

  it('caps at a documented size', () => {
    expect(MAX_IN_VALUES).toBe(500);
  });
});
