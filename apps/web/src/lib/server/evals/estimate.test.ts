/**
 * The estimate before "Ejecutar": measured from the last finished run, unless
 * that run tells nothing about price (ai-service's prompt cache answered it).
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_PRIVACY_USD, DEFAULT_QUESTION_USD, estimateRun } from './estimate';
import type { EvalItem, EvalRun, ItemResult } from './types';

const q = { id: '1', kind: 'pregunta', question: '¿?', expectedDocIds: [], shouldRefuse: false, notes: '', text: '', privateNames: [], publicNames: [], gateKind: 'documento' } as EvalItem;
const p = { ...q, id: '2', kind: 'privacidad' } as EvalItem;

const answer = (costUsd: number, error?: string) => ({ kind: 'pregunta', costUsd, ...(error ? { error } : {}) }) as unknown as ItemResult;
const run = (results: ItemResult[]): EvalRun =>
  ({ id: 'r', status: 'done', createdAt: '', results }) as unknown as EvalRun;

describe('estimateRun', () => {
  it('no finished run: the static defaults', () => {
    expect(estimateRun([q, p], [])).toMatchObject({ usd: DEFAULT_QUESTION_USD + DEFAULT_PRIVACY_USD, basis: 'supuesto' });
  });

  it('a priced run: its mean per answered question', () => {
    expect(estimateRun([q, q], [run([answer(0.004), answer(0.002)])])).toMatchObject({ usd: 0.006, basis: 'medido' });
  });

  it('errored questions do not pull the mean down', () => {
    expect(estimateRun([q], [run([answer(0.004), answer(0, '402 Sin presupuesto')])])).toMatchObject({ usd: 0.004, basis: 'medido' });
  });

  it('🔴 a cache-hit run ($0) does not drive the next estimate to ~$0', () => {
    expect(estimateRun([q], [run([answer(0), answer(0)])])).toMatchObject({ usd: DEFAULT_QUESTION_USD, basis: 'supuesto' });
  });

  it('🔴 a mostly cached run falls back too', () => {
    expect(estimateRun([q], [run([answer(0), answer(0), answer(0.004)])])).toMatchObject({ basis: 'supuesto' });
  });
});
