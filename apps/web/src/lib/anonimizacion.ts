/**
 * `/documentos/[id]/anonimizacion` — one document's anonymisation controls:
 * the copy, the wire shape of `GET|PATCH /api/documents/:id/anonimizacion`
 * (backend `endpoints/anonimizacion.ts`), and the pure rules the page needs.
 *
 * 🔴 NOTHING HERE MAY HOLD A NAME THAT WAS REMOVED. The backend sends the names
 * it KEPT (the uploader, public figures, cited authors) and COUNTS of what it
 * took out. There is no field for a removed name or a name ↔ stand-in pair, and
 * {@link parseView} drops anything it does not know, so one cannot ride along.
 *
 * Spanish copy lives here, not in the `.svelte` file (ADR-0018), so
 * `anonimizacion.test.ts` can check it.
 */

import type { PermissionGrant } from '$lib/uploadKind';

export const SWITCH_KEYS = ['keepDocumentAuthor', 'keepCitedAuthors', 'keepPublicFigures'] as const;
export type SwitchKey = (typeof SWITCH_KEYS)[number];
export const isSwitchKey = (k: unknown): k is SwitchKey => typeof k === 'string' && (SWITCH_KEYS as readonly string[]).includes(k);

export type AnonStatus = 'n/a' | 'pending' | 'held' | 'ready' | 'approved' | 'rejected';
export type SwitchOrigin = 'ecosistema' | 'documento';

export interface SwitchState {
  value: boolean;
  origin: SwitchOrigin;
}

export interface AnonStageCount {
  stage: string;
  removed: number;
}

export interface AnonView {
  id: string;
  name: string;
  contentKind: string;
  gated: boolean;
  publicationStatus: string | null;
  status: AnonStatus;
  /** A switch now off would remove a kept name, but the document was not re-checked yet. */
  pendingRegate: boolean;
  /** `pendingRegate` or a failed re-check, and the row is free: the page offers "Reintentar". */
  retryable: boolean;
  /** A re-check put it back to draft, and it still is. */
  unpublishedByRegate: boolean;
  kept: { authors: string[]; publicFigures: string[]; citedAuthors: string[] };
  counts: { stages: AnonStageCount[]; pseudonyms: number | null; addresses: number | null } | null;
  /**
   * The two author switches are always here (missing = the ecosistema's off);
   * `keepPublicFigures` only when the backend sends it.
   */
  switches: Record<Exclude<SwitchKey, 'keepPublicFigures'>, SwitchState> & Partial<Record<SwitchKey, SwitchState>>;
  /**
   * 🔴 Which switches THIS caller may change, as the backend says (R-09): the
   * page never guesses. Missing or junk = false (read-only).
   */
  editable: Record<SwitchKey, boolean>;
}

export type Regate = 'started' | 'not-needed' | 'saved-only';

// ── Copy ────────────────────────────────────────────────────────────────────

export const PAGE_TITLE = 'Anonimización';
export const LINK_LABEL = 'Anonimización';

export const STATUS_LABELS: Record<AnonStatus, string> = {
  'n/a': 'No aplica',
  pending: 'Pendiente',
  held: 'Retenido',
  ready: 'Listo',
  approved: 'Aprobado',
  rejected: 'Rechazado',
};

/** The gate's stage machine words (`structural | deterministic | content | verify`). */
export const STAGE_COUNT_LABELS: Record<string, string> = {
  structural: 'Estructura',
  deterministic: 'Reglas',
  content: 'Modelo',
  verify: 'Verificación',
};

export const SWITCH_LABELS: Record<SwitchKey, string> = {
  keepDocumentAuthor: 'Conservar al autor del documento',
  keepCitedAuthors: 'Conservar autores citados',
  keepPublicFigures: 'Conservar figuras públicas',
};

export const ORIGIN_LABELS: Record<SwitchOrigin, string> = {
  ecosistema: 'Del ecosistema',
  documento: 'De este documento',
};

export const KEPT_TITLE = 'Nombres que se conservan';
export const KEPT_LABELS = {
  authors: 'Autor del documento',
  publicFigures: 'Figuras públicas',
  citedAuthors: 'Autores citados',
} as const satisfies Record<keyof AnonView['kept'], string>;

export const COUNTS_TITLE = 'Datos quitados';
export const PSEUDONYMS_LABEL = 'Nombres reemplazados';
export const ADDRESSES_LABEL = 'Direcciones';
export const SWITCHES_TITLE = 'Nombres';
export const SAVE_LABEL = 'Guardar';
export const RESET_LABEL = 'Usar el del ecosistema';
export const BACK_LABEL = '← Volver';
export const UNAVAILABLE = 'No pudimos abrir esto. Inténtalo más tarde.';

/** Testimonio with a keep-names switch on (owner ruling: allowed, off by default). */
export const TESTIMONY_WARNING = 'En un testimonio, esto puede dejar visible a quien habla.';

/** `pendingRegate`: the kept names are STILL in the text. Never say they were removed. */
export const PENDING_REGATE = 'Pendiente: los nombres conservados siguen visibles hasta la próxima revisión.';
/** `pendingRegate` with no kept name: there is nothing "still visible" to speak of. */
export const PENDING_REGATE_NONE_KEPT = 'Pendiente de volver a anonimizar.';
export const UNPUBLISHED_BY_REGATE = 'Volvió a borrador.';
export const RETRY_LABEL = 'Reintentar';

export const SAVED = 'Guardado.';
export const SAVED_REGATE = 'Guardado. Se está revisando de nuevo.';
export const RETRIED = 'Se está revisando de nuevo.';
export const UNCHANGED = 'Sin cambios.';
export const BUSY = 'El documento se está procesando. Inténtalo en un momento.';
export const SAVE_FAILED = 'No se pudo guardar.';
export const SAVE_FORBIDDEN = 'No puedes cambiar esto.';
export const SAVE_NOT_FOUND = 'No encontramos este documento.';

export const statusLabel = (s: AnonStatus): string => STATUS_LABELS[s];
/** An unknown stage still reads as a plain word, never as the machine one. */
export const stageCountLabel = (stage: string): string => STAGE_COUNT_LABELS[stage] ?? 'Otros';

/** Only `pendingRegate` may say kept names are still visible; a failed re-check alone does not. */
export const pendingRegateMessage = (view: AnonView): string =>
  view.pendingRegate && keptLists(view).length > 0 ? PENDING_REGATE : PENDING_REGATE_NONE_KEPT;

/** "Reintentar" answered: a started re-check, or there was nothing left to do. */
export const retriedMessage = (regate: Regate | null | undefined): string => (regate === 'started' ? RETRIED : UNCHANGED);

export function savedMessage(regate: Regate | null | undefined): string {
  return regate === 'started' ? SAVED_REGATE : SAVED;
}

/**
 * The message for a refused PATCH or retry: the backend's own words when it
 * sent any (`errors[0].message`, e.g. a failed erase), else one by status.
 */
export function saveErrorMessage(status: number, backendMessage?: string | null): string {
  if (typeof backendMessage === 'string' && backendMessage.trim() !== '') return backendMessage;
  if (status === 409) return BUSY;
  if (status === 403) return SAVE_FORBIDDEN;
  if (status === 404) return SAVE_NOT_FOUND;
  return SAVE_FAILED;
}

// ── Wire ────────────────────────────────────────────────────────────────────

const STATUSES: readonly AnonStatus[] = ['n/a', 'pending', 'held', 'ready', 'approved', 'rejected'];
const names = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []);
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

function switchFrom(v: unknown): SwitchState {
  const o = (v && typeof v === 'object' ? v : {}) as { value?: unknown; origin?: unknown };
  return { value: o.value === true, origin: o.origin === 'documento' ? 'documento' : 'ecosistema' };
}

/**
 * The backend's view, made whole. Only the known fields are copied: an extra
 * field (say, a list of removed names) never reaches the page. Null on junk.
 */
export function parseView(raw: unknown): AnonView | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.id == null) return null;
  const kept = (r.kept && typeof r.kept === 'object' ? r.kept : {}) as Record<string, unknown>;
  const c = r.counts && typeof r.counts === 'object' ? (r.counts as Record<string, unknown>) : null;
  const sw = (r.switches && typeof r.switches === 'object' ? r.switches : {}) as Record<string, unknown>;
  return {
    id: String(r.id),
    name: typeof r.name === 'string' ? r.name : '',
    contentKind: typeof r.contentKind === 'string' ? r.contentKind : '',
    gated: r.gated === true,
    publicationStatus: typeof r.publicationStatus === 'string' ? r.publicationStatus : null,
    status: STATUSES.includes(r.status as AnonStatus) ? (r.status as AnonStatus) : 'n/a',
    pendingRegate: r.pendingRegate === true,
    retryable: r.retryable === true,
    unpublishedByRegate: r.unpublishedByRegate === true,
    kept: { authors: names(kept.authors), publicFigures: names(kept.publicFigures), citedAuthors: names(kept.citedAuthors) },
    counts: c
      ? {
          stages: (Array.isArray(c.stages) ? c.stages : [])
            .map((s) => (s && typeof s === 'object' ? (s as Record<string, unknown>) : {}))
            .filter((s) => typeof s.stage === 'string' && count(s.removed) !== null)
            .map((s) => ({ stage: s.stage as string, removed: s.removed as number })),
          pseudonyms: count(c.pseudonyms),
          addresses: count(c.addresses),
        }
      : null,
    switches: {
      keepDocumentAuthor: switchFrom(sw.keepDocumentAuthor),
      keepCitedAuthors: switchFrom(sw.keepCitedAuthors),
      ...(sw.keepPublicFigures && typeof sw.keepPublicFigures === 'object'
        ? { keepPublicFigures: switchFrom(sw.keepPublicFigures) }
        : {}),
    },
    editable: editableFrom(r.editable),
  };
}

function editableFrom(v: unknown): Record<SwitchKey, boolean> {
  const o = (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  return Object.fromEntries(SWITCH_KEYS.map((k) => [k, o[k] === true])) as Record<SwitchKey, boolean>;
}

/** Any switch this caller may change: else the page has no "Guardar". */
export const anyEditable = (view: AnonView): boolean => shownSwitches(view).some(({ key }) => view.editable[key]);

export const parseRegate = (v: unknown): Regate | null =>
  v === 'started' || v === 'not-needed' || v === 'saved-only' ? v : null;

/** The kept-name lists to show: only the non-empty ones, in a fixed order. */
export function keptLists(view: AnonView): Array<{ key: keyof AnonView['kept']; label: string; names: string[] }> {
  return (Object.keys(KEPT_LABELS) as Array<keyof AnonView['kept']>)
    .map((key) => ({ key, label: KEPT_LABELS[key], names: view.kept[key] }))
    .filter((l) => l.names.length > 0);
}

/** Warn when a testimonio keeps any names: by the EFFECTIVE value, whatever its origin. */
export const showTestimonyWarning = (view: AnonView): boolean =>
  view.contentKind === 'testimonio' && SWITCH_KEYS.some((k) => view.switches[k]?.value === true);

/** The switches to draw: every one the backend sent, in a fixed order; `editable` from the backend. */
export const shownSwitches = (view: AnonView): Array<{ key: SwitchKey; sw: SwitchState; editable: boolean }> =>
  SWITCH_KEYS.flatMap((key) => {
    const sw = view.switches[key];
    return sw ? [{ key, sw, editable: view.editable?.[key] === true }] : [];
  });

// ── The form ────────────────────────────────────────────────────────────────

export type PatchBody = Partial<Record<SwitchKey, boolean | null>>;

/**
 * What the form asks for. `reset=<key>` (the "Usar el del ecosistema" button)
 * sends only `{ key: null }`. Otherwise only a switch that moved is sent —
 * each box posts with `was-<key>`, the value the page showed — so saving one
 * switch never pins the other to this document. 🔴 A read-only switch posts
 * no `was-<key>` (R-09), so it is never sent: no `was-` = not this form's.
 */
export function patchFromForm(form: FormData): PatchBody {
  const reset = form.get('reset');
  if (isSwitchKey(reset)) return { [reset]: null };
  const body: PatchBody = {};
  for (const k of SWITCH_KEYS) {
    if (!form.has(`was-${k}`)) continue;
    const now = form.get(k) === 'on';
    const was = form.get(`was-${k}`) === 'on';
    if (now !== was) body[k] = now;
  }
  return body;
}

// ── Links ───────────────────────────────────────────────────────────────────

/** Where the page is, with where to go back to. */
export function anonimizacionHref(id: string, from?: string): string {
  const base = `/documentos/${encodeURIComponent(id)}/anonimizacion`;
  return from ? `${base}?volver=${encodeURIComponent(from)}` : base;
}

const BACK_PATHS = /^\/(?:(?:documentos|revision)(?:[/?]|$)|biblioteca\/[^/])/;

/** `?volver=`, only when it is one of the pages that link here. Else Mis documentos. */
export function backHref(raw: string | null | undefined): string {
  return raw && !raw.includes('\\') && BACK_PATHS.test(raw) ? raw : '/documentos';
}

/**
 * Show the link on a document card? The uploader, a platform admin, or a
 * `holds:review` holder (admin / investigador / responsable) in that
 * ecosistema. ⚠ A courtesy: the backend is the check, and refuses anyone else.
 */
export function mayOpenAnonimizacion(input: {
  uploadedByCaller?: boolean | null;
  holdsReview: PermissionGrant | null | undefined;
  slug: string | null | undefined;
}): boolean {
  if (input.uploadedByCaller === true) return true;
  const g = input.holdsReview;
  if (!g || !g.ok) return false;
  if (g.isPlatformAdmin) return true;
  return Boolean(input.slug) && g.slugs.includes(input.slug as string);
}
