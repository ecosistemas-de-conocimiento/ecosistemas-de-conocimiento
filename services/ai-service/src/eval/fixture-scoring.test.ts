// Unit tests for the three offline fixture SCORING functions the retrieval
// evals stand on: `fixtureEmbed` (dense leg), `fixtureSparseEmbed` (sparse
// leg) and `fixtureRerankScore` (rerank rung).
//
// WHY THESE EXIST. The integration evals compare a rung ON against the same run
// with it OFF. That comparison only means something if each fixture models the
// property it claims to model: the dense fixture DROPS numerals, the sparse one
// KEEPS them, the reranker rewards exact identifiers. Earlier nothing
// tested these functions directly, and `fixtureRerankScore` → `return 0` passed
// every gate. Each block below fails if its function goes constant.

import { describe, expect, it } from 'vitest';

import { fixtureEmbed } from './fixture-embedder.js';
import { fixtureReranker, fixtureRerankScore } from './fixture-reranker.js';
import { fixtureSparseEmbed } from './fixture-sparse-embedder.js';

const cosine = (a: number[], b: number[]): number => {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
};

describe('fixtureEmbed — the dense leg drops identifiers', () => {
  it('returns a unit vector of the live column width', () => {
    const v = fixtureEmbed('retention of personal records');
    expect(v).toHaveLength(1024);
    expect(cosine(v, v)).toBeCloseTo(1, 10);
  });

  it('scores shared content words above unrelated text', () => {
    const q = fixtureEmbed('retention of personal records');
    const related = fixtureEmbed('personal records retention schedule');
    const unrelated = fixtureEmbed('budget allocation for municipal roads');
    expect(cosine(q, related)).toBeGreaterThan(cosine(q, unrelated));
    expect(cosine(q, related)).toBeGreaterThan(0.5);
  });

  it('cannot tell "section 120" from "section 440" — the hazard it models', () => {
    // Three-digit numerals on purpose: two-digit ones are also dropped by the
    // length filter, which would hide a broken numeral filter (measured: it did).
    // Positive control in the same test: a word change DOES move the vector, so
    // the equality is about numerals only.
    expect(fixtureEmbed('privacy section 120')).toEqual(fixtureEmbed('privacy section 440'));
    expect(fixtureEmbed('privacy section 2018')).toEqual(fixtureEmbed('privacy section 2019a'));
    expect(fixtureEmbed('privacy section 120')).not.toEqual(fixtureEmbed('retention section 120'));
  });

  it('ignores stopwords and case/accents', () => {
    expect(fixtureEmbed('the Política')).toEqual(fixtureEmbed('politica'));
  });

  it('returns a fixed unit vector, not zeros, when no content token survives', () => {
    const v = fixtureEmbed('12 iv the');
    expect(cosine(v, v)).toBeCloseTo(1, 10);
    expect(v[0]).toBe(1);
  });
});

describe('fixtureSparseEmbed — the sparse leg keeps identifiers', () => {
  it('separates "section 12" from "section 44"', () => {
    const a = fixtureSparseEmbed('section 12');
    const b = fixtureSparseEmbed('section 44');
    expect(a.indices.length).toBe(2);
    expect(a).not.toEqual(b);
    // They still share the "section" id.
    expect(a.indices.filter((i) => b.indices.includes(i))).toHaveLength(1);
  });

  it('emits ascending, unique ids inside the stub id space', () => {
    const v = fixtureSparseEmbed('alpha beta gamma delta epsilon 1 2 3 a b');
    expect(v.indices.length).toBe(10);
    expect(new Set(v.indices).size).toBe(v.indices.length);
    for (let i = 1; i < v.indices.length; i++) {
      expect(v.indices[i]!).toBeGreaterThan(v.indices[i - 1]!);
    }
    for (const id of v.indices) {
      expect(id).toBeGreaterThanOrEqual(0);
      expect(id).toBeLessThan(65536);
    }
    expect(v.values).toHaveLength(v.indices.length);
  });

  it('weights repeats by 1 + ln(tf)', () => {
    const v = fixtureSparseEmbed('records records records');
    expect(v.indices).toHaveLength(1);
    expect(v.values[0]).toBeCloseTo(1 + Math.log(3), 12);
    expect(fixtureSparseEmbed('records').values[0]).toBe(1);
  });

  it('is empty for text with no alphanumeric run', () => {
    expect(fixtureSparseEmbed(' -- ')).toEqual({ indices: [], values: [] });
  });
});

describe('fixtureRerankScore — the reranker rewards exact identifiers', () => {
  it('scores full overlap 1 and no overlap 0', () => {
    expect(fixtureRerankScore('privacy notice', 'the privacy notice applies')).toBe(1);
    expect(fixtureRerankScore('privacy notice', 'budget for roads')).toBe(0);
  });

  it('scores the fraction of distinct query tokens present', () => {
    expect(fixtureRerankScore('privacy notice', 'a privacy rule')).toBe(0.5);
  });

  it('ranks the document holding the identifier above the one holding the topic word', () => {
    const query = 'section 12';
    const withId = fixtureRerankScore(query, 'see 12 below');
    const withTopic = fixtureRerankScore(query, 'see section 44 below');
    // Each matches one of two tokens; the identifier bonus breaks the tie.
    expect(withTopic).toBe(0.5);
    expect(withId).toBeCloseTo(0.65, 12);
    expect(withId).toBeGreaterThan(withTopic);
  });

  it('stays inside [0, 1] when the identifier bonus would overflow', () => {
    expect(fixtureRerankScore('12 34 56 78 90', '12 34 56 78 90')).toBe(1);
  });

  it('scores every document 0 for a query with no tokens', () => {
    expect(fixtureRerankScore(' -- ', 'anything at all')).toBe(0);
  });

  it('the Reranker sorts by that score and honours topN', async () => {
    const documents = ['budget for roads', 'see section 44', 'section 12 applies'];
    const out = await fixtureReranker({ query: 'section 12', documents, topN: 2, model: 'm' });
    expect(out.results.map((r) => r.index)).toEqual([2, 1]);
    expect(out.results[0]!.relevanceScore).toBe(1);
    expect(out.results[1]!.relevanceScore).toBe(0.5);
  });
});
