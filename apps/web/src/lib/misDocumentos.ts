/**
 * "Mis documentos" (`/documentos`) — the pure rules behind the redesign: what
 * each card's tile and pills say, which upload steps a person sees, and when
 * the list re-reads itself. Client-safe and DOM-free, so vitest covers it.
 *
 * Minimal copy (owner rule): every label here is a word or two. The longer
 * sentences live in `title=` tooltips, from the existing helpers.
 */
import { docStatusBadge, gateState, isIngestFailure } from './docStatus';
import { graphBadge } from './graphStatus';
import { ingestFailureCopy } from './ingest';
import { publicationBadge, type PublicationStatus } from './publication';
import type { WorkingDoc } from './types';

export type PillTone = 'neutral' | 'progress' | 'shared' | 'error' | 'held';

export interface Pill {
  label: string;
  tone: PillTone;
  /** The longer explanation, for `title=`. */
  title: string;
  /** Kept for the e2e specs (`graph-status-<id>`). */
  testid?: string;
  /** Show a spinner: something is running. */
  busy?: boolean;
}

type DocLike = Pick<
  WorkingDoc,
  | 'id'
  | 'kind'
  | 'isNote'
  | 'ingestStatus'
  | 'ingestError'
  | 'anonymisationStatus'
  | 'audioMeta'
  | 'publicationStatus'
  | 'graphStatus'
  | 'subtitle'
>;

/** The square tile on the left of a card: what kind of thing this is. */
export function kindTile(d: Pick<DocLike, 'kind' | 'isNote' | 'subtitle'>): { label: string; tone: 'note' | 'audio' | 'voz' | 'file' } {
  // A testimonio carries its source line as `subtitle` (`workingDocHeading`).
  if (d.subtitle != null) return { label: 'Voz', tone: 'voz' };
  if (d.isNote) return { label: 'Nota', tone: 'note' };
  if (d.kind === 'audio') return { label: 'Audio', tone: 'audio' };
  if (d.kind === 'markdown') return { label: 'MD', tone: 'file' };
  return { label: (d.kind ?? 'doc').toUpperCase(), tone: 'file' };
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const PUBLICATION_TONE: Record<string, PillTone> = {
  private: 'neutral',
  progress: 'progress',
  shared: 'shared',
  error: 'error',
};

/**
 * The card's pills, most urgent first. Nothing that is not news: "listo",
 * "Conexiones: listas" and "Sin conexiones" never show (demo pass, review).
 *
 * 1. The pipeline, only while it runs or when it stopped: en cola…, en
 *    revisión (held by the anonymisation gate), rechazado, or the failure's
 *    own short title.
 * 2. Who can see it: always — "Borrador · solo tú" is the privacy promise.
 * 3. Conexiones, only while it prepares or when it did not finish.
 */
export function statusPills(d: DocLike): Pill[] {
  const pills: Pill[] = [];

  const gate = gateState(d);
  if (gate === 'review') {
    pills.push({ label: 'En revisión', tone: 'held', title: 'Detenido para revisión de anonimización' });
  } else if (gate === 'rejected') {
    pills.push({ label: 'Rechazado', tone: 'error', title: 'Rechazado en la revisión de anonimización' });
  } else if (isIngestFailure(d)) {
    const failure = ingestFailureCopy(d.ingestError);
    pills.push({ label: failure.title, tone: 'error', title: failure.message });
  } else {
    const ing = docStatusBadge(d);
    if (ing && ing.tone === 'pending') {
      pills.push({ label: capitalise(ing.label), tone: 'progress', title: ing.title, busy: !ing.label.startsWith('en cola') });
    }
  }

  const pub = publicationBadge(d.publicationStatus);
  pills.push({
    label: pub.label,
    tone: PUBLICATION_TONE[pub.tone] ?? 'neutral',
    title: pub.description,
    busy: d.publicationStatus === 'publishing' || d.publicationStatus === 'unpublishing',
  });

  const graph = graphBadge(d.graphStatus);
  if (graph && d.graphStatus !== 'ready' && d.graphStatus !== 'skipped') {
    pills.push({
      label: graph.label,
      tone: d.graphStatus === 'failed' ? 'neutral' : 'progress',
      title: graph.title,
      testid: `graph-status-${d.id}`,
      busy: d.graphStatus === 'pending' || d.graphStatus === 'extracting',
    });
  }
  return pills;
}

/** The publish button's words. "Publicar cambios" is the edited-published-note case. */
export function publishLabel(status: PublicationStatus): string {
  if (status === 'failed') return 'Reintentar publicación';
  if (status === 'published') return 'Publicar cambios';
  return 'Publicar';
}

const RUNNING_INGEST = new Set(['pending', 'extracting', 'transcribing', 'transcribed', 'embedding']);

/**
 * Is anything on this row still moving? The list re-reads itself while one is,
 * so a pill never sits on "En cola" after the work finished.
 */
export function isInFlight(d: Pick<DocLike, 'ingestStatus' | 'publicationStatus' | 'graphStatus'>): boolean {
  return (
    RUNNING_INGEST.has(d.ingestStatus) ||
    d.publicationStatus === 'publishing' ||
    d.publicationStatus === 'unpublishing' ||
    d.graphStatus === 'pending' ||
    d.graphStatus === 'extracting'
  );
}

// ── Upload: a short stepped flow ─────────────────────────────────────────

/**
 * `archivo` → (`opciones`) → `listo`. The options step exists only for someone
 * who has a choice to make: Documento or Voz, and Anonimizar (`voces:upload`).
 * Everyone else picks a file and it goes up.
 */
export type UploadStep = 'archivo' | 'opciones' | 'listo';

export function uploadSteps(hasOptions: boolean): UploadStep[] {
  return hasOptions ? ['archivo', 'opciones', 'listo'] : ['archivo', 'listo'];
}

export const UPLOAD_STEP_LABELS: Record<UploadStep, string> = {
  archivo: 'Archivo',
  opciones: 'Tipo',
  listo: 'Listo',
};

/** The format chips under the file target. Audio only where it is switched on. */
export function uploadFormats(audioOn: boolean): string[] {
  const base = ['PDF', 'DOCX', 'XLSX', 'CSV', 'HTML', 'MD'];
  return audioOn ? [...base, 'Audio'] : base;
}

/** The kind tile for a chosen file, before it is a document. */
export function fileTile(name: string, isAudio: boolean): string {
  if (isAudio) return 'Audio';
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  if (!ext) return 'Archivo';
  if (ext === 'markdown') return 'MD';
  if (ext === 'htm') return 'HTML';
  return ext.toUpperCase();
}
