// Unit tests for the eval metrics and the item scorer.
//
// The harness is the thing every later rung will be judged by, so its own
// arithmetic needs to be trustworthy. The specific hazard these tests exist
// for: a metric that can exceed 1, which is what happens the moment relevance
// is counted per CHUNK instead of per labelled unit — one relevant document
// producing eight chunks then "recalls" 800% of itself, and the whole report
// silently becomes meaningless.

import { describe, expect, it } from 'vitest';

import { mean, ndcg, normalizeForMatch, precision, recall, reciprocalRank } from './metrics.js';
import { evaluateItem } from './runner.js';
import type { GoldenItem } from './types.js';
import type { RetrievedChunk } from '../services/rag/types.js';

function chunk(id: string, over: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    chunkId: id,
    documentId: `doc-${id}`,
    ordinal: 0,
    text: `contenido ${id}`,
    score: 0.5,
    ...over,
  };
}

/** Maps `doc-<id>` → `<id>` so fixtures can talk in external ids. */
const resolve = (documentId: string) => documentId.replace(/^doc-/, '');

describe('metrics', () => {
  it('recall and precision behave at the boundaries', () => {
    expect(recall(0, 4)).toBe(0);
    expect(recall(2, 4)).toBe(0.5);
    expect(recall(4, 4)).toBe(1);
    // No known-relevant set ⇒ vacuously complete, not a division by zero.
    expect(recall(0, 0)).toBe(1);
    expect(precision(0, 0)).toBe(0);
    expect(precision(2, 8)).toBe(0.25);
  });

  it('reciprocal rank finds the first hit', () => {
    expect(reciprocalRank([true, false])).toBe(1);
    expect(reciprocalRank([false, false, true])).toBeCloseTo(1 / 3, 6);
    expect(reciprocalRank([false, false])).toBe(0);
  });

  it('ndcg is 1 for a perfect ranking and lower when hits sink', () => {
    expect(ndcg([true, true, false], 2)).toBeCloseTo(1, 6);
    expect(ndcg([false, true, true], 2)).toBeLessThan(1);
    expect(ndcg([false, false], 2)).toBe(0);
  });

  it('never exceeds 1 given label-deduplicated flags', () => {
    for (const flags of [[true], [true, true], [true, true, true]]) {
      expect(ndcg(flags, flags.length)).toBeLessThanOrEqual(1);
    }
  });

  it('normalizeForMatch folds accents, case and whitespace', () => {
    expect(normalizeForMatch('  Séction  16   BIS ')).toBe('section 16 bis');
    expect(normalizeForMatch('Protección')).toBe(normalizeForMatch('PROTECCION'));
  });

  it('mean of nothing is 0, not NaN', () => {
    expect(mean([])).toBe(0);
    expect(mean([1, 0])).toBe(0.5);
  });
});

describe('evaluateItem — relevance is counted per labelled unit', () => {
  it('caps recall at 1 when one document yields many chunks', () => {
    const item: GoldenItem = {
      id: 'x',
      kind: 'retrieval_relevance',
      corpus: 'c',
      query: 'q',
      relevantDocs: ['a'],
    };
    const chunks = [chunk('a1'), chunk('a2'), chunk('a3')].map((c) => ({
      ...c,
      documentId: 'doc-a',
    }));
    const r = evaluateItem(item, chunks, resolve);
    expect(r.recallAtK).toBe(1);
    expect(r.ndcgAtK).toBeLessThanOrEqual(1);
    // Precision still counts every on-target chunk — three of three returned
    // chunks really were from the right document.
    expect(r.precisionAtK).toBe(1);
    expect(r.pass).toBe(true);
  });

  it('scores partial coverage of a multi-label item', () => {
    const item: GoldenItem = {
      id: 'x',
      kind: 'retrieval_relevance',
      corpus: 'c',
      query: 'q',
      relevantDocs: ['a', 'b'],
    };
    const r = evaluateItem(item, [chunk('a'), chunk('z')], resolve);
    expect(r.recallAtK).toBe(0.5);
    expect(r.precisionAtK).toBe(0.5);
    expect(r.pass).toBe(true); // at least one relevant result was found
  });

  it('fails when nothing relevant is retrieved', () => {
    const item: GoldenItem = {
      id: 'x',
      kind: 'retrieval_relevance',
      corpus: 'c',
      query: 'q',
      relevantDocs: ['a'],
    };
    const r = evaluateItem(item, [chunk('z')], resolve);
    expect(r.pass).toBe(false);
    expect(r.failures).toContain('NO RELEVANT RESULT retrieved');
  });

  it('requires BOTH document and section labels to match when both are given', () => {
    // "Right document, wrong article" is the error a citation surface must
    // never make, so it has to count as a miss.
    const item: GoldenItem = {
      id: 'x',
      kind: 'retrieval_relevance',
      corpus: 'c',
      query: 'q',
      relevantDocs: ['a'],
      relevantSections: [{ section: '16' }],
    };
    const wrongSection = { ...chunk('a'), metadata: { section: '15' } };
    expect(evaluateItem(item, [wrongSection], resolve).pass).toBe(false);
    const rightSection = { ...chunk('a'), metadata: { section: '16' } };
    expect(evaluateItem(item, [rightSection], resolve).pass).toBe(true);
  });
});

describe('evaluateItem — assertion scoping by kind', () => {
  const base = { id: 'x', corpus: 'c', query: 'q', relevantDocs: ['a'] };

  it('citation_groundedness asserts on rank 1 only', () => {
    const item: GoldenItem = {
      ...base,
      kind: 'citation_groundedness',
      mustContain: ['setenta y dos horas'],
    };
    const buried = [chunk('a'), { ...chunk('a2'), text: 'setenta y dos horas' }].map((c) => ({
      ...c,
      documentId: 'doc-a',
    }));
    const r = evaluateItem(item, buried, resolve);
    expect(r.pass).toBe(false);
    expect(r.failures.some((f) => f.startsWith('MISSING at rank 1'))).toBe(true);
  });

  it('qa_faithfulness asserts on the union of the top-k', () => {
    const item: GoldenItem = {
      ...base,
      kind: 'qa_faithfulness',
      mustContain: ['setenta y dos horas'],
    };
    const buried = [chunk('a'), { ...chunk('a2'), text: 'setenta y dos horas' }].map((c) => ({
      ...c,
      documentId: 'doc-a',
    }));
    expect(evaluateItem(item, buried, resolve).pass).toBe(true);
  });

  it('matches mustContain accent- and case-insensitively', () => {
    const item: GoldenItem = {
      ...base,
      kind: 'citation_groundedness',
      mustContain: ['Secretaría Anticorrupción'],
    };
    const c = { ...chunk('a'), text: 'la SECRETARIA ANTICORRUPCION vigilará' };
    expect(evaluateItem(item, [c], resolve).pass).toBe(true);
  });
});

describe('evaluateItem — the forbidden-content floor', () => {
  it('counts and fails on any forbidden hit, at any rank', () => {
    const item: GoldenItem = {
      id: 'x',
      kind: 'retrieval_relevance',
      corpus: 'c',
      query: 'q',
      relevantDocs: ['a'],
      mustNotContain: ['Instituto Federal de Acceso a la Información'],
    };
    const chunks = [
      chunk('a'),
      { ...chunk('old'), text: 'El Instituto Federal de Acceso a la Información vigilará' },
    ];
    const r = evaluateItem(item, chunks, resolve);
    // A superseded citation buried at rank 2 is still a superseded citation:
    // the generator sees every retrieved chunk.
    expect(r.forbiddenHits).toBe(1);
    expect(r.pass).toBe(false);
    expect(r.failures[0]).toContain('FORBIDDEN');
  });

  it('is clean when nothing forbidden is retrieved', () => {
    const item: GoldenItem = {
      id: 'x',
      kind: 'retrieval_relevance',
      corpus: 'c',
      query: 'q',
      relevantDocs: ['a'],
      mustNotContain: ['INAI'],
    };
    expect(evaluateItem(item, [chunk('a')], resolve).forbiddenHits).toBe(0);
  });
});
