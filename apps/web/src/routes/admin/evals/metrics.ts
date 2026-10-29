/**
 * `/admin/evals` — which numbers each tab shows, and how they read.
 * Client-safe (no server import): the page and its tests use it.
 */
import type { EvalMetrics } from '$lib/server/evals/types';

export type TabId = 'respuestas' | 'recuperacion' | 'privacidad' | 'estilo' | 'preguntas';

export const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'respuestas', label: 'Respuestas' },
  { id: 'recuperacion', label: 'Recuperación' },
  { id: 'privacidad', label: 'Privacidad' },
  { id: 'estilo', label: 'Estilo' },
  { id: 'preguntas', label: 'Preguntas' },
];

export interface MetricDef {
  key: keyof EvalMetrics;
  label: string;
  /** `true` = higher is better. */
  up: boolean;
  /** The count the rate is over. */
  of: (m: EvalMetrics) => number;
}

export const METRICS: Record<Exclude<TabId, 'preguntas'>, MetricDef[]> = {
  respuestas: [
    { key: 'citationSupport', label: 'Citas respaldadas', up: true, of: (m) => m.claims },
    { key: 'refusalAccuracy', label: 'Rechazo correcto', up: true, of: (m) => m.questions },
  ],
  recuperacion: [
    { key: 'hit1', label: 'hit@1', up: true, of: (m) => m.retrievalItems },
    { key: 'hit3', label: 'hit@3', up: true, of: (m) => m.retrievalItems },
    { key: 'hit5', label: 'hit@5', up: true, of: (m) => m.retrievalItems },
  ],
  privacidad: [
    { key: 'leakRate', label: 'Fugas', up: false, of: (m) => m.privateTerms },
    { key: 'overRedaction', label: 'Sobre-redacción', up: false, of: (m) => m.publicTerms },
  ],
  estilo: [{ key: 'styleShown', label: 'Estilo presente', up: true, of: (m) => m.styleItems }],
};

export const pct = (v: number | null | undefined): string => (typeof v === 'number' ? `${Math.round(v * 100)}%` : '—');

export const usd = (v: number | null | undefined): string =>
  typeof v === 'number' ? `$${v < 0.01 ? v.toFixed(4) : v.toFixed(2)}` : '—';

export function rateOf(m: EvalMetrics | null | undefined, key: keyof EvalMetrics): number | null {
  const v = m?.[key];
  return typeof v === 'number' ? v : null;
}

/** Change against the previous run, and whether it is good news. `null` = no comparison. */
export function delta(
  current: number | null,
  previous: number | null,
  up: boolean,
): { text: string; good: boolean | null } | null {
  if (current === null || previous === null) return null;
  const d = Math.round((current - previous) * 100);
  if (d === 0) return { text: '±0', good: null };
  return { text: `${d > 0 ? '+' : ''}${d}`, good: d > 0 === up };
}

/** Sparkline points (0–1 values) in a `w`×`h` box; nulls are skipped. */
export function sparkPoints(values: Array<number | null>, w: number, h: number): Array<[number, number]> {
  const n = values.length;
  return values.flatMap((v, i) =>
    v === null ? [] : [[n === 1 ? w / 2 : (i / (n - 1)) * w, h - 2 - v * (h - 4)] as [number, number]],
  );
}
