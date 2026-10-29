/**
 * The one status chip a document row shows, read from BOTH of the backend's
 * status columns: `ingestStatus` (the extract → embed pipeline) and
 * `anonymisationStatus` (the testimonio gate).
 *
 * 🔴 WHY BOTH. A testimonio the gate held never reaches the pipeline, but its
 * `ingestStatus` keeps whatever it had: `pending` (read as "en cola"), or
 * `failed` with `anonymisation_held` once the backend's stalled-hold sweep
 * runs (read as "error"). Neither is true. It waits for a person in Revisión.
 * "Error" means a real pipeline failure and nothing else.
 *
 * Display only: this changes no backend semantics.
 */

import { ingestBadge, ingestErrorCode, type IngestBadge } from './ingest';
import type { AudioMeta, DocKind, IngestStatus } from './types';

/** Backend `documents.anonymisationStatus`, mirrored. Unknown reads as `n/a`. */
export type AnonymisationStatus = 'n/a' | 'pending' | 'held' | 'approved' | 'rejected' | 'ready';

const ANONYMISATION_STATUSES: readonly AnonymisationStatus[] = [
  'n/a',
  'pending',
  'held',
  'approved',
  'rejected',
  'ready',
];

export function parseAnonymisationStatus(value: unknown): AnonymisationStatus {
  return typeof value === 'string' && (ANONYMISATION_STATUSES as readonly string[]).includes(value)
    ? (value as AnonymisationStatus)
    : 'n/a';
}

/** Backend codes (`lib/ingestRecovery.ts`, `lib/holdReview.ts`) a gate decision leaves in `ingestError`. */
const HELD_CODE = 'anonymisation_held';
const REJECTED_CODE = 'anonymisation_rejected';

export interface DocStatusInput {
  ingestStatus: IngestStatus | undefined;
  anonymisationStatus?: AnonymisationStatus;
  ingestError?: string | null;
  kind?: DocKind;
  audioMeta?: AudioMeta | null;
}

export type GateState = 'review' | 'rejected' | null;

/**
 * Is this row waiting on, or stopped by, a reviewer?
 *
 * The gate column is the authority. When it says nothing (`n/a`, or a list
 * that did not send it) the `ingestError` code is the fallback, so a row the
 * sweep marked `anonymisation_held` never reads as a pipeline error.
 */
export function gateState(input: DocStatusInput): GateState {
  const gate = input.anonymisationStatus ?? 'n/a';
  if (gate === 'held') return 'review';
  if (gate === 'rejected') return 'rejected';
  if (gate !== 'n/a') return null;
  const code = ingestErrorCode(input.ingestError);
  if (code === HELD_CODE) return 'review';
  if (code === REJECTED_CODE) return 'rejected';
  return null;
}

/** A pipeline failure a retry could address: `failed`, and no gate decision behind it. */
export function isIngestFailure(input: DocStatusInput): boolean {
  return input.ingestStatus === 'failed' && gateState(input) === null;
}

export function docStatusBadge(input: DocStatusInput): IngestBadge | null {
  switch (gateState(input)) {
    case 'review':
      return { label: 'en revisión', tone: 'pending', title: 'En revisión' };
    case 'rejected':
      // "Rechazado": the word the Revisión screen already uses (`$lib/holds`).
      return { label: 'rechazado', tone: 'failed', title: 'Rechazado' };
    default:
      return ingestBadge(input.ingestStatus, input.kind, input.audioMeta);
  }
}

/**
 * May the caller edit this note's text in the app (Editar / Vista previa)?
 *
 * 🔴 PUBLISHED NOTES TOO (bug measured on dev 3f275c5, 2026-10-28). The editor
 * used to render only for a note with no pipeline (`ingestStatus: 'n/a'`), and
 * a published note is `ready`, so "Publicar cambios" could never be reached:
 * nothing could change the body. Editing a published note is safe: autosave
 * (`PATCH /api/documents/:id/note`) writes only the body, and peers keep the
 * published text until "Publicar cambios" clears the gate (backend
 * `lib/studentNotes.ts`).
 *
 * ⚠ OWN NOTES ONLY. `uploadedByCaller` must say so. A row that did not say
 * (`undefined`) is trusted only as a private draft with no pipeline: nobody
 * else's draft can reach the caller's lists. The backend refuses the others.
 *
 * Never an uploaded file (`isNote` false), never a row a reviewer holds, never
 * mid-pipeline.
 */
export function canEditNote(d: {
  kind?: DocKind;
  isNote?: boolean;
  uploadedByCaller?: boolean;
  publicationStatus?: string;
  ingestStatus: IngestStatus | undefined;
  anonymisationStatus?: AnonymisationStatus;
  ingestError?: string | null;
}): boolean {
  if (d.kind !== 'markdown' || d.isNote !== true) return false;
  if (gateState(d) === 'review') return false;
  const ingest = d.ingestStatus ?? 'n/a';
  if (ingest !== 'n/a' && ingest !== 'ready' && ingest !== 'failed') return false;
  if (d.uploadedByCaller === true) return true;
  return d.uploadedByCaller === undefined && ingest === 'n/a' && (d.publicationStatus ?? 'draft') === 'draft';
}
