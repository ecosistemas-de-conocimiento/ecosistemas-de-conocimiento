/**
 * THE COST ESTIMATE shown before "Ejecutar". Always an estimate (inferred).
 *
 * Basis, in order:
 *   1. `medido` — the mean measured cost per question of this ecosistema's
 *      last finished run (sum of `costUsd` over its answered questions /
 *      answered questions; errored ones cost nothing and say nothing).
 *   2. `supuesto` — the defaults below, also when that run says nothing about
 *      price: ai-service's prompt cache answers a repeat within minutes at $0,
 *      so a run with half or more of its answers at $0 (or a $0 mean) would
 *      drive the next estimate to ~$0.
 *
 * ⚠ The measured basis inherits `costUsd`'s gaps (no gate, condense,
 * embedding or rerank calls; see `EvalRuns.costUsd`), so it reads low.
 *
 * Defaults, inferred 2026-10-29 from dev (`edc_backend.messages`, last 4 days:
 * mean answer `costUsd` $0.0021–0.0025 + expansion $0.00004–0.00008 per turn,
 * orgs 6/7/8; model `deepseek/deepseek-chat-v3.1`) plus up to
 * {@link MAX_CLAIMS} judge calls of ≤ 6000 characters each, priced as an
 * upper bound at the turn's own cost per input token (~$0.0006 per call), and
 * one style call. A privacy item is $0 on the Spark detector; the default
 * prices a hosted-fallback call so the estimate never reads low.
 */
import { MAX_CLAIMS } from './score';
import type { EvalItem, EvalRun } from './types';

export const DEFAULT_QUESTION_USD = 0.0025 + MAX_CLAIMS * 0.0006 + 0.0006;
export const DEFAULT_PRIVACY_USD = 0.002;

export interface CostEstimate {
  usd: number;
  questions: number;
  privacy: number;
  basis: 'medido' | 'supuesto';
}

export function estimateRun(items: readonly EvalItem[], runs: readonly EvalRun[]): CostEstimate {
  const questions = items.filter((i) => i.kind === 'pregunta').length;
  const privacy = items.length - questions;
  const last = runs.find((r) => r.status === 'done' && r.results.some((x) => x.kind === 'pregunta'));
  const costs = (last?.results ?? []).flatMap((x) => (x.kind === 'pregunta' && !x.error ? [x.costUsd] : []));
  const mean = costs.length ? costs.reduce((s, c) => s + c, 0) / costs.length : 0;
  const priced = costs.length > 0 && mean > 0 && costs.filter((c) => c <= 0).length * 2 < costs.length;
  const perQuestion = priced ? mean : DEFAULT_QUESTION_USD;
  return {
    usd: questions * perQuestion + privacy * DEFAULT_PRIVACY_USD,
    questions,
    privacy,
    basis: priced ? 'medido' : 'supuesto',
  };
}
