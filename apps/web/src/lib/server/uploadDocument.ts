import { backendFetch, backendUrl } from '$lib/server/auth';
import { mapUpstreamMediaError } from '$lib/server/documents';
import { isAudioUpload, maxUploadBytesFor } from '$lib/config';
import { readReviewCapability } from '$lib/server/holds';
import {
  AUDIO_UPLOAD_ENABLED,
  mayUploadVocesAnywhere,
  parseUploadContentKind,
  VOCES_UPLOAD,
} from '$lib/uploadKind';

/**
 * Upload one file and create its `documents` row, with NO conversation.
 * Used by `POST /api/documentos` ("Subir documento" in Mis documentos, UX demo
 * backlog #15).
 *
 * ⚠ SAME RULES AS `POST /api/sessions/[id]/documents`, which keeps its own
 * copy of this flow (owned by another lane at write time). The two must agree
 * on: kind sniffing order (PDF/DOCX before audio), the size cap, the Voz
 * pre-check, and never trusting a client-supplied `kind`. Folding the session
 * route onto this function is the follow-up.
 *
 * 🔴 The ecosistema is not named here. The backend derives it from the caller's
 * single membership when `session` is empty (`Documents.ts` beforeValidate) and
 * refuses when there are several; the route checks that first.
 */
export async function uploadLooseDocument(
  token: string | undefined,
  form: FormData,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const file = form.get('file');
  if (!(file instanceof File)) return { status: 400, body: { error: 'multipart_missing_file' } };

  const contentKind = parseUploadContentKind(form.get('contentKind'));
  if (!contentKind) return { status: 400, body: { error: 'invalid_content_kind' } };
  if (contentKind === 'testimonio') {
    const grant = await readReviewCapability(token, VOCES_UPLOAD);
    if (!mayUploadVocesAnywhere(grant)) {
      return { status: 403, body: { error: 'voces_upload_forbidden' } };
    }
  }

  let kind: 'pdf' | 'docx' | 'audio' | null = null;
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) kind = 'pdf';
  else if (
    file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    /\.docx$/i.test(file.name)
  )
    kind = 'docx';
  // 🔴 Audio is off (`AUDIO_UPLOAD_ENABLED`): refused here, before the bytes go up.
  else if (AUDIO_UPLOAD_ENABLED && isAudioUpload(file)) kind = 'audio';
  if (!kind) return { status: 400, body: { error: 'unsupported_kind' } };

  const cap = maxUploadBytesFor(file);
  if (file.size > cap) return { status: 413, body: { error: 'file_too_large', limit: cap, kind } };

  const mediaForm = new FormData();
  mediaForm.append('file', file, file.name);
  const headers = new Headers();
  if (token) headers.set('Authorization', `JWT ${token}`);
  let mediaRes: Response;
  try {
    mediaRes = await fetch(`${backendUrl()}/api/media`, { method: 'POST', headers, body: mediaForm });
  } catch {
    return { status: 502, body: { error: 'upstream_unreachable' } };
  }
  if (!mediaRes.ok) {
    return mapUpstreamMediaError(mediaRes.status, await mediaRes.text().catch(() => ''));
  }
  const mediaId = ((await mediaRes.json().catch(() => ({}))) as { doc?: { id?: number | string } })
    .doc?.id;
  if (mediaId == null) return { status: 502, body: { error: 'media_id_missing' } };

  const name = form.get('name');
  const docRes = await backendFetch(token, '/api/documents', {
    method: 'POST',
    body: JSON.stringify({
      session: [],
      kind,
      contentKind,
      mode: 'rag-retrieve',
      name: typeof name === 'string' && name.trim() ? name : file.name,
      mediaFile: mediaId,
      isPinned: false,
      ingestStatus: 'pending',
    }),
  });
  const body = (await docRes.json().catch(() => ({}))) as Record<string, unknown>;
  // ⚠ Payload's validation messages are English. Never pass one to the browser.
  if (!docRes.ok) return { status: docRes.status, body: { error: 'document_create_failed' } };
  return { status: docRes.status, body };
}
