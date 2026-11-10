/**
 * `/ajustes` — the ecosistema's re-anonymisation backlog, in one line each
 * (`GET /api/organizations/:id/anonimizacion`, I-01 / I-02). After a save the
 * page never says a bare "Guardado" while documents still wait for it.
 */

import type { AnonRegateStatus } from '$lib/server/features';

const docs = (n: number) => (n === 1 ? '1 documento' : `${n} documentos`);

/** Null when there is nothing waiting. `justSaved`: the switches were just saved. */
export function regateLine(status: AnonRegateStatus | null | undefined, justSaved = false): string | null {
  if (!status) return null;
  const n = status.pendingRegate;
  let line: string | null = null;
  if (status.regating) line = n > 0 ? `Volviendo a anonimizar: ${n === 1 ? 'queda' : 'quedan'} ${docs(n)}.` : 'Volviendo a anonimizar.';
  else if (n > 0) line = `${n === 1 ? 'Queda' : 'Quedan'} ${docs(n)} por volver a anonimizar.`;
  return line && justSaved ? `Guardado. ${line}` : line;
}

/** "Reintentar" only when nothing runs and something is left. */
export const canRetryRegate = (status: AnonRegateStatus | null | undefined): boolean =>
  Boolean(status && !status.regating && status.pendingRegate > 0);

export function unpublishedLine(status: AnonRegateStatus | null | undefined): string | null {
  const n = status?.unpublishedByRegate ?? 0;
  if (n <= 0) return null;
  return n === 1 ? '1 documento volvió a borrador.' : `${n} documentos volvieron a borrador.`;
}
