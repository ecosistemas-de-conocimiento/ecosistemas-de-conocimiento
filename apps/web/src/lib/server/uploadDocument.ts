import { backendFetch, backendUrl } from '$lib/server/auth';
import { mapUpstreamMediaError } from '$lib/server/documents';
import { isAudioUpload, MAX_AUDIO_UPLOAD_BYTES, MAX_UPLOAD_BYTES } from '$lib/config';
import { readReviewCapability } from '$lib/server/holds';
import {
  AUDIO_UPLOAD_ENABLED,
  mayUploadVocesAnywhere,
  parseUploadContentKind,
  VOCES_UPLOAD,
} from '$lib/uploadKind';

export type UploadResult = { status: number; body: Record<string, unknown> };

/** A PDF header may sit after some junk; the spec reader looks in the first 1 KB. */
const SNIFF_BYTES = 1024;

const ascii = (bytes: Uint8Array, at: number, text: string): boolean =>
  [...text].every((ch, i) => bytes[at + i] === ch.charCodeAt(0));

function looksLikePdf(b: Uint8Array): boolean {
  for (let i = 0; i + 5 <= b.length; i++) if (ascii(b, i, '%PDF-')) return true;
  return false;
}

/** DOCX is a ZIP: local file header `PK\x03\x04`. */
function looksLikeDocx(b: Uint8Array): boolean {
  return b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

/** MP3 (ID3 or frame sync), AAC/ADTS, WAV, OGG/Opus, FLAC, M4A/MP4/MOV, WebM, AMR. */
function looksLikeAudio(b: Uint8Array): boolean {
  if (ascii(b, 0, 'ID3')) return true;
  if (b[0] === 0xff && b[1] !== undefined && (b[1] & 0xe0) === 0xe0) return true;
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WAVE')) return true;
  if (ascii(b, 0, 'OggS') || ascii(b, 0, 'fLaC') || ascii(b, 0, '#!AMR')) return true;
  if (ascii(b, 4, 'ftyp')) return true;
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return true;
  return false;
}

/** Do the file's first bytes agree with the kind its name and MIME settled on? */
export function bytesMatchKind(head: Uint8Array, kind: 'pdf' | 'docx' | 'audio'): boolean {
  if (kind === 'pdf') return looksLikePdf(head);
  if (kind === 'docx') return looksLikeDocx(head);
  return looksLikeAudio(head);
}

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
 * 🔴 With a conversation the ecosistema is never named: the backend derives it
 * from the session. Without one (`organization`), the caller passes the
 * ecosistema `resolveEcosystem` validated, and the backend checks membership
 * again before filing the document there.
 */
export async function uploadDocument(
  token: string | undefined,
  form: FormData,
  opts: { session: Array<string | number>; defaultPinned: boolean; organization?: string },
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
  // The SETTLED kind, not the MIME: a PDF sent as `audio/mp4` gets the 20 MB cap.
  const cap = kind === 'audio' ? MAX_AUDIO_UPLOAD_BYTES : MAX_UPLOAD_BYTES;
  if (file.size > cap) return { status: 413, body: { error: 'file_too_large', limit: cap, kind } };

  // 🔴 The name and MIME are the client's word. The first bytes are the file's:
  // an audio file renamed `a.pdf` used to go up as a PDF. A mismatch is refused
  // with the ordinary "Tipo de archivo no admitido" copy (`unsupported_kind`).
  const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
  if (!bytesMatchKind(head, kind)) {
    return { status: 400, body: { error: 'unsupported_kind', reason: 'content_mismatch', kind } };
  }

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
      ...(opts.organization ? { organization: opts.organization } : {}),
      kind,
      contentKind,
      // 🔴 "Anonimizar" (owner ruling 2026-10-26): a documento whose text passes
      // the gate. Asking is always allowed; the backend also sets it itself on
      // a participant's PDF/DOCX.
      ...(form.get('anonymise') === 'true' ? { anonymise: true } : {}),
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

/**
 * Mis documentos: no conversation, not pinned anywhere, filed in `organization`.
 * ⚠ Pass only an id `resolveEcosystem` returned — never one from the request.
 */
export function uploadLooseDocument(
  token: string | undefined,
  form: FormData,
  organization: string,
): Promise<UploadResult> {
  return uploadDocument(token, form, { session: [], defaultPinned: false, organization });
}
