/**
 * The corpus graph's per-document state as the user sees it — the states, the
 * Spanish copy, and the one rule for "may I rebuild it". Sibling of
 * `$lib/ingest.ts`, same shape: plain functions so the copy is testable (this
 * repo has no DOM test environment).
 *
 * ⚠ SEPARATE FROM THE INGEST BADGE, deliberately — the backend keeps
 * `graphStatus` apart from `ingestStatus` for the same reason. A document can
 * be `ready` for retrieval and `failed` for the graph; one badge for both would
 * make a graph failure look like a broken upload.
 */

/** Backend `documents.graphStatus`, mirrored. An unknown value reads as `n/a`. */
export type GraphStatus = 'n/a' | 'pending' | 'extracting' | 'ready' | 'failed' | 'skipped';

export const GRAPH_STATUSES: readonly GraphStatus[] = [
  'n/a',
  'pending',
  'extracting',
  'ready',
  'failed',
  'skipped',
];

export function parseGraphStatus(value: unknown): GraphStatus {
  return typeof value === 'string' && (GRAPH_STATUSES as readonly string[]).includes(value)
    ? (value as GraphStatus)
    : 'n/a';
}

export interface GraphBadge {
  label: string;
  tone: 'pending' | 'ready' | 'failed' | 'muted';
  title: string;
}

/**
 * The badge for one document, or `null` when there is nothing to say.
 *
 * `n/a` gets no badge: a markdown note or a row older than the graph was never
 * meant to be in it, and a "sin grafo" chip on every note would be noise.
 */
export function graphBadge(status: GraphStatus | undefined, error?: string | null): GraphBadge | null {
  switch (status) {
    case 'pending':
      return { label: 'grafo en cola', tone: 'pending', title: 'El grafo de este documento está en cola.' };
    case 'extracting':
      return {
        label: 'construyendo grafo…',
        tone: 'pending',
        title: 'Se están extrayendo las entidades y relaciones de este documento.',
      };
    case 'ready':
      return { label: 'grafo listo', tone: 'ready', title: 'Este documento ya forma parte del grafo.' };
    case 'failed':
      return {
        label: 'grafo falló',
        tone: 'failed',
        title: error
          ? `No se pudo construir el grafo: ${error}`
          : 'No se pudo construir el grafo de este documento.',
      };
    case 'skipped':
      return {
        label: 'sin grafo',
        tone: 'muted',
        title: 'Este documento no tiene texto del que extraer un grafo. No es un error.',
      };
    default:
      return null;
  }
}

/** The button's label. Lives here so the copy is asserted, not just rendered. */
export const GRAPH_RETRY_LABEL = 'Reconstruir grafo';

/**
 * Show "Reconstruir grafo"?
 *
 * 🔴 THE BACKEND IS THE AUTHORITY (`POST /api/documents/:id/graph-retry`):
 * it lets ONLY the uploader through (403 for anyone else, admins included) and
 * refuses a recent in-flight run or a document with no text (409). This mirrors
 * the first rule so nobody is shown a button that can only answer 403, and
 * offers it only on `failed` — the state the button exists to rescue.
 */
export function canRetryGraph(doc: {
  graphStatus?: GraphStatus;
  uploadedByCaller?: boolean;
}): boolean {
  return doc.graphStatus === 'failed' && doc.uploadedByCaller === true;
}

/** Toast copy for a refused rebuild, keyed by the status the proxy passed through. */
export function graphRetryErrorCopy(status: number): string {
  if (status === 403) return 'Solo quien subió el documento puede reconstruir su grafo.';
  if (status === 409) return 'Ahora no se puede reconstruir: ya está en curso o el documento no tiene texto.';
  return 'Inténtalo de nuevo en un momento.';
}
