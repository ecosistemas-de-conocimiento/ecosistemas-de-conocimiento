/**
 * Shapes shared by the evals dashboard (`/admin/evals`) and its runner.
 * The rows live in the backend: `eval-items`, `eval-runs` (platform admin only).
 */
import type { Provenance, RetrievedChunk } from '@edc/chat-engine/core';

/** What `POST /api/generate` hands `locals.evalTap`: the turn's numbered sources. */
export interface EvalTurnTap {
  matches: RetrievedChunk[];
  provenance: Provenance | null;
}

export type EvalItemKind = 'pregunta' | 'privacidad';

export interface EvalItem {
  id: string;
  kind: EvalItemKind;
  question: string;
  expectedDocIds: number[];
  shouldRefuse: boolean;
  notes: string;
  /** Privacy only. Synthetic. */
  text: string;
  privateNames: string[];
  publicNames: string[];
  gateKind: 'documento' | 'testimonio';
}

export interface ClaimVerdict {
  n: number;
  claim: string;
  /** `false` also for an `[N]` that names no source. */
  ok: boolean;
}

export interface SourceRef {
  n: number;
  docId: string | null;
  title: string | null;
}

export interface ChatItemResult {
  itemId: string;
  kind: 'pregunta';
  question: string;
  shouldRefuse: boolean;
  expectedDocIds: number[];
  answer: string;
  sources: SourceRef[];
  /** 1-based position of the first expected document among the sources; null = not found. */
  rank: number | null;
  refused: boolean;
  refusalOk: boolean;
  claims: ClaimVerdict[];
  style: { ok: boolean; reason: string } | null;
  costUsd: number;
  model: string | null;
  error?: string;
}

export interface GateTermVerdict {
  term: string;
  cls: 'privado' | 'publico';
  before: number;
  after: number;
  ok: boolean | null;
}

export interface PrivacyItemResult {
  itemId: string;
  kind: 'privacidad';
  notes: string;
  status: 'ready' | 'hold' | 'error';
  stage?: string;
  detector: string | null;
  model: string | null;
  terms: GateTermVerdict[];
  error?: string;
}

export type ItemResult = ChatItemResult | PrivacyItemResult;

/** Every rate is 0–1, or `null` when the run had nothing to measure it on. */
export interface EvalMetrics {
  citationSupport: number | null;
  claims: number;
  refusalAccuracy: number | null;
  falseRefusals: number;
  missedRefusals: number;
  questions: number;
  hit1: number | null;
  hit3: number | null;
  hit5: number | null;
  retrievalItems: number;
  leakRate: number | null;
  overRedaction: number | null;
  privateTerms: number;
  publicTerms: number;
  holds: number;
  privacyItems: number;
  styleShown: number | null;
  styleItems: number;
  errors: number;
}

export type EvalRunStatus = 'queued' | 'running' | 'done' | 'failed';

export interface EvalRun {
  id: string;
  status: EvalRunStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  estimateUsd: number | null;
  costUsd: number | null;
  progress: { done: number; total: number } | null;
  models: { chat: string[]; judge: string[]; gate: string[] } | null;
  commitSha: string | null;
  metrics: EvalMetrics | null;
  results: ItemResult[];
  error: string | null;
}
