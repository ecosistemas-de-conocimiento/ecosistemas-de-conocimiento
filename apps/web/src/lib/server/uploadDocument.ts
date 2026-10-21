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

export type UploadResult = { status: number; body: Record<string, unknown> };

/**
 * Upload one file and create its `documents` row — THE one upload flow.
 *
 * Used by `POST /api/sessions/[id]/documents` (the panel in a conversation) and
 * `POST /api/documentos` (Mis documentos, no conversation; UX demo backlog #15).
 * Both used to keep a copy of these rules; one copy cannot drift.
 *
 * Order matters, and every refusal happens BEFORE the bytes go up:
 *   1. `contentKind` (documento | testimonio), and the Voz pre-check.
 *   2. File kind, sniffed PDF → DOCX → audio. ⚠ PDF and DOCX first:
 *      `isAudioUpload` accepts `.mp4`/`.mov` and a generous extension list, so
 *      running it first would send an odd-MIME document to the transcriber.
 *   3. A client-supplied `kind` is a HINT: honoured only when it agrees.
 *   4. The size cap for that kind.
 *
 * 🔴 AUDIO IS REFUSED WHILE `AUDIO_UPLOAD_ENABLED` IS OFF (backlog #8). Server
 * side, so a direct POST cannot slip a recording past the hidden picker.
 *
 * 🔴 The ecosistema is never named. The backend derives it from the session,
 * or, with no session, from the caller's single membership.
 */
export async function uploadDocument(
  token: string | undefined,
  form: FormData,
  opts: { session: Array<string | number>; defaultPinned: boolean },
): Promise<UploadResult> {
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
  else if (AUDIO_UPLOAD_ENABLED && isAudioUpload(file)) kind = 'audio';
  if (!kind) return { status: 400, body: { error: 'unsupported_kind' } };

  const kindHint = form.get('kind');
  if (typeof kindHint === 'string' && kindHint && kindHint !== kind) {
    // A client that thinks it uploaded audio and gets a PDF back has a bug
    // worth surfacing, not silently overriding.
    return { status: 400, body: { error: 'unsupported_kind', inferred: kind } };
  }

  // The browser checks too, but it is not a security boundary: a body accepted
  // here lands on the backend's disk before anything can refuse it.
  const cap = maxUploadBytesFor(file);
  if (file.size > cap) return { status: 413, body: { error: 'file_too_large', limit: cap, kind } };

  // Payload's `POST /api/media` wants multipart with a `file` field. No
  // content-type header: fetch generates the boundary.
  const mediaForm = new FormData();
  mediaForm.append('file', file, file.name);
  const headers = new Headers();
  if (token) headers.set('Authorization', `JWT ${token}`);
  let mediaRes: Response;
  try {
    mediaRes = await fetch(`${backendUrl()}/api/media`, { method: 'POST', headers, body: mediaForm });
  } catch (err) {
    // `detail` is for logs and bug reports; the browser maps the code to Spanish.
    return {
      status: 502,
      body: {
        error: 'upstream_unreachable',
        detail: (err instanceof Error ? err.message : String(err)).slice(0, 500),
      },
    };
  }
  if (!mediaRes.ok) {
    return mapUpstreamMediaError(mediaRes.status, await mediaRes.text().catch(() => ''));
  }
  const mediaId = ((await mediaRes.json().catch(() => ({}))) as { doc?: { id?: number | string } })
    .doc?.id;
  if (mediaId == null) return { status: 502, body: { error: 'media_id_missing' } };

  const name = form.get('name');
  const pinnedRaw = form.get('isPinned');
  const docRes = await backendFetch(token, '/api/documents', {
    method: 'POST',
    body: JSON.stringify({
      // ⚠ AN ARRAY, ALWAYS: `documents.session` is `hasMany`. Empty = no
      // conversation (Mis documentos).
      session: opts.session,
      kind,
      contentKind,
      mode: 'rag-retrieve',
      name: typeof name === 'string' && name.trim() ? name : file.name,
      mediaFile: mediaId,
      isPinned: pinnedRaw === null ? opts.defaultPinned : pinnedRaw !== 'false',
      ingestStatus: 'pending',
    }),
  });
  const body = (await docRes.json().catch(() => ({}))) as Record<string, unknown>;
  // ⚠ Payload's validation messages are English. Never pass one to the browser.
  if (!docRes.ok) return { status: docRes.status, body: { error: 'document_create_failed' } };
  return { status: docRes.status, body };
}

/** Mis documentos: no conversation, not pinned anywhere. */
export function uploadLooseDocument(token: string | undefined, form: FormData): Promise<UploadResult> {
  return uploadDocument(token, form, { session: [], defaultPinned: false });
}
