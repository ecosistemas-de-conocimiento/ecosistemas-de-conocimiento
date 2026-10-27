import { MAX_UPLOAD_BYTES, formatBytes } from './config';
import { AUDIO_UPLOAD_ENABLED } from './uploadKind';

/**
 * Map a BFF upload error code (see /api/sessions/[id]/documents +server.ts)
 * to user-facing toast copy. Unknown codes fall through to a generic message
 * so the UX still says something useful.
 */
export function uploadErrorToast(
  code: string,
  status: number,
  limitBytes: number = MAX_UPLOAD_BYTES,
): { title: string; message: string } {
  switch (code) {
    case 'file_too_large':
      return {
        title: 'El archivo es muy grande',
        // The limit depends on what was being uploaded — audio gets a much
        // larger one — so quote the cap that actually applied, not a constant.
        message: `El máximo es ${formatBytes(limitBytes)}.`,
      };
    case 'unsupported_media_type':
    case 'unsupported_kind':
      return {
        title: 'Tipo de archivo no admitido',
        // Follows the audio switch (backlog #8): never offer what is turned off.
        message: AUDIO_UPLOAD_ENABLED
          ? 'Aceptamos PDF, DOCX, XLSX, CSV, HTML y audio en MP3, M4A, WAV, OGG u OPUS.'
          : 'Aceptamos PDF, DOCX, XLSX, CSV y HTML.',
      };
    case 'unauthorized':
      return {
        title: 'Tu sesión expiró',
        message: 'Vuelve a iniciar sesión para subir documentos.',
      };
    case 'forbidden':
      return {
        title: 'Sin permiso',
        message: 'No puedes subir documentos a esta conversación.',
      };
    case 'voces_upload_forbidden':
      return {
        title: 'Sin permiso para subir voces',
        message: 'Subir testimonios requiere el rol de investigador en este ecosistema.',
      };
    case 'invalid_content_kind':
      return { title: 'Tipo de material no válido', message: 'Elige Documento o Voz / testimonio.' };
    case 'media_upload_rejected':
      return {
        title: 'El servidor rechazó el archivo',
        message: 'Prueba con otro documento.',
      };
    case 'upstream_unavailable':
      return {
        title: 'Algo falló en el servidor',
        message: 'Inténtalo de nuevo en un momento.',
      };
    case 'upstream_unreachable':
      return {
        title: 'No se pudo conectar',
        message: 'Revisa tu conexión e inténtalo de nuevo.',
      };
    case 'multipart_missing_file':
    case 'media_id_missing':
      return { title: 'No se pudo subir', message: 'Algo salió mal. Inténtalo de nuevo.' };
    default:
      // No code we know. A bare status can still say something useful — a
      // proxy in front of the BFF answers 413 / 401 without our JSON body.
      // Never show the number itself: "HTTP 502" means nothing to the people
      // using this (UX backlog #26).
      if (status === 413) return uploadErrorToast('file_too_large', status, limitBytes);
      if (status === 401) return uploadErrorToast('unauthorized', status, limitBytes);
      return {
        title: 'No se pudo subir el archivo',
        message: 'Inténtalo de nuevo en un momento.',
      };
  }
}

