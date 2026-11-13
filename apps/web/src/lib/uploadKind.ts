import { env } from '$env/dynamic/public';
import { CONSENT_CHANGED } from './consent';

/**
 * What an upload IS — a `documento` or a Voz (`testimonio`) — and who may say so.
 *
 * Pure and client-safe, so the upload route, the layout load and `DocsPanel`
 * share one copy and vitest can assert it (this repo has no DOM tests).
 *
 * ── 🔴 WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * The backend gates a testimonio through anonymisation before it reaches any
 * corpus, and refuses `contentKind: 'testimonio'` from anyone without
 * `voces:upload` in that ecosistema (`enforceVocesUploadRights` in
 * `apps/backend/src/collections/Documents.ts`). But the upload route never SENT
 * `contentKind`, so every upload from the UI landed as a `documento` and the
 * gate never ran on one. Found by the 2026-10-17 audit.
 *
 * ⚠ THE CHOICE IS PRESENTATION; THE BACKEND IS THE CONTROL. A caller without
 * the permission who forges the form field gets a 400 from the backend.
 */

/** The content kinds an upload form may name. `conversacion` never comes from a form. */
export const UPLOAD_CONTENT_KINDS = ['documento', 'testimonio'] as const;
export type UploadContentKind = (typeof UPLOAD_CONTENT_KINDS)[number];

/** Mirrors `PERMISSIONS.vocesUpload` in the backend. */
export const VOCES_UPLOAD = 'voces:upload';

/**
 * Read the form field. Absent or empty ⇒ `documento` (the backend default).
 * Anything else that is not a known kind ⇒ `null`, which the route refuses.
 */
export function parseUploadContentKind(raw: unknown): UploadContentKind | null {
  if (raw === null || raw === undefined || raw === '') return 'documento';
  return typeof raw === 'string' && (UPLOAD_CONTENT_KINDS as readonly string[]).includes(raw)
    ? (raw as UploadContentKind)
    : null;
}

/** The shape `$lib/server/holds.ts` `ReviewCapability` has. Kept structural. */
export interface PermissionGrant {
  isPlatformAdmin: boolean;
  slugs: string[];
  ok: boolean;
}

/**
 * May this person file a Voz in the ecosistema with this slug?
 *
 * ⚠ Per ecosistema: `voces:upload` is held IN an organization. Fails closed on
 * a failed identity read, a missing slug, or a missing grant.
 */
export function mayUploadVoces(
  grant: PermissionGrant | null | undefined,
  slug: string | null | undefined,
): boolean {
  if (!grant || !grant.ok) return false;
  if (grant.isPlatformAdmin) return true;
  if (!slug) return false;
  return grant.slugs.includes(slug);
}

/** May they file one ANYWHERE? The route's cheap pre-check before the file goes up. */
export function mayUploadVocesAnywhere(grant: PermissionGrant | null | undefined): boolean {
  return Boolean(grant?.ok && (grant.isPlatformAdmin || grant.slugs.length > 0));
}

/** Copy for the choice in `DocsPanel`. */
export const UPLOAD_KIND_LABELS: Record<UploadContentKind, string> = {
  documento: 'Documento',
  testimonio: 'Voz / testimonio',
};

// ── Audio upload switch ─────────────────────────────────────────────────────

/**
 * 🔴 AUDIO UPLOAD IS OFF unless the environment runs audio-service.
 *
 * Decided 2026-10-21 (UX demo backlog #8): an audio file went up, then failed
 * with "Falta configurar el servicio de audio" and an English env-var detail.
 * So it is ON only where `PUBLIC_AUDIO_UPLOAD_ENABLED=1` is set at runtime —
 * today dev on edc-1, next to the compose profile `audio`
 * (infra/fleet/edc-1.md §4y). It is the ONLY switch: the file picker, the
 * button tooltip, the panel's refusal and the upload route read it.
 *
 * ⚠ Presentation only. The upload route still accepts audio from a direct POST.
 * A Voz (`testimonio`) stays available: it can be a PDF or a DOCX.
 */
export const AUDIO_UPLOAD_ENABLED = env.PUBLIC_AUDIO_UPLOAD_ENABLED === '1';

/** True for the parts of an `accept` list that name audio or video. */
function isAudioAcceptEntry(entry: string, audioExtensions: RegExp): boolean {
  return entry.startsWith('audio/') || entry.startsWith('video/') || audioExtensions.test(entry);
}

/**
 * The file picker's `accept` string. With audio off, every audio or video entry
 * is dropped from `fullAccept`, so the picker only offers PDF and DOCX.
 */
export function uploadAccept(
  fullAccept: string,
  audioExtensions: RegExp,
  audioEnabled: boolean = AUDIO_UPLOAD_ENABLED,
): string {
  if (audioEnabled) return fullAccept;
  return fullAccept
    .split(',')
    .filter((entry) => !isAudioAcceptEntry(entry.trim(), audioExtensions))
    .join(',');
}

/** The upload button's tooltip. */
export function uploadButtonTitle(audioEnabled: boolean = AUDIO_UPLOAD_ENABLED): string {
  return audioEnabled
    ? 'Subir documento o audio (PDF, DOCX, XLSX, XLS, CSV, HTML, MD, MP3, M4A, WAV, OGG, OPUS)'
    : 'Subir documento (PDF, DOCX, XLSX, XLS, CSV, HTML o MD)';
}

/**
 * Toast copy for a failed upload from Mis documentos (`POST /api/documentos`).
 * Keyed by the route's error code; anything unknown gets a generic Spanish line,
 * never the code itself.
 */
export function looseUploadErrorCopy(
  code: string | null | undefined,
  maxBytesLabel: string,
): { title: string; message: string } {
  const consent = consentErrorCopy(code);
  if (consent) return consent;
  switch (code) {
    case 'unsupported_kind':
    case 'unsupported_media_type':
      return {
        title: 'Tipo de archivo no admitido',
        message: AUDIO_UPLOAD_ENABLED
          ? 'Aceptamos PDF, DOCX, XLSX, XLS, CSV, HTML, Markdown y audio en MP3, M4A, WAV, OGG u OPUS.'
          : 'Aceptamos PDF, DOCX, XLSX, XLS, CSV, HTML y Markdown.',
      };
    case 'file_too_large':
      return { title: 'El archivo es muy grande', message: `El máximo es ${maxBytesLabel}.` };
    case 'voces_upload_forbidden':
      return {
        title: 'Sin permiso para subir voces',
        message: 'Subir testimonios requiere el rol de investigador en este ecosistema.',
      };
    case 'unauthorized':
      return { title: 'Tu sesión expiró', message: 'Vuelve a iniciar sesión para subir documentos.' };
    default:
      return { title: 'No se pudo subir el archivo', message: 'Inténtalo de nuevo en un momento.' };
  }
}

/** What the panel says when someone picks an audio file while audio is off. */
export const AUDIO_UPLOAD_OFF_COPY = {
  title: 'Por ahora no se pueden subir grabaciones',
  message: 'Sube un PDF o un DOCX. Pronto podrás subir audio.',
} as const;

/** The upload consent refusals' copy, or null for any other code. */
export function consentErrorCopy(code: string | null | undefined): { title: string; message: string } | null {
  if (code === 'upload_consent_required') {
    return { title: 'Falta el consentimiento', message: 'Marca la casilla de consentimiento.' };
  }
  if (code === 'consent_version_changed') return { title: 'El consentimiento cambió', message: CONSENT_CHANGED };
  return null;
}
