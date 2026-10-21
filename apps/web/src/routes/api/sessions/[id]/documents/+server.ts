import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFetch } from '$lib/server/auth';
import { degradeListResponse } from '$lib/server/degrade';
import { uploadDocument } from '$lib/server/uploadDocument';

// GET /api/sessions/[id]/documents → all docs attached to this session.
//
// ⚠ `documents.session` is a `hasMany` relationship — one document can be
// attached to several conversations at once. `where[session][equals]` reads as
// "this conversation is somewhere in that list", which is exactly what we
// want: the panel shows what is attached HERE, and the same row may also be
// showing in another conversation's panel. Nothing is duplicated and nothing
// is moved; see `documents/[docId]` for attach/detach.
//
// Fragile read: degrade a 403/transient backend failure to an empty list.
export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
  const qs = new URLSearchParams({
    'where[session][equals]': String(params.id),
    sort: 'createdAt',
    limit: '500',
    depth: '0',
  });
  const res = await backendFetch(locals.token, `/api/documents?${qs.toString()}`, {
    method: 'GET',
  });
  const body = await res.json().catch(() => ({}));
  const out = degradeListResponse(res, body, 'documents');
  return json(out.body, { status: out.status });
};

// POST /api/sessions/[id]/documents
//
// Two content-types depending on the kind being created:
//   - application/json      → markdown working-doc (current M4 behaviour).
//   - multipart/form-data   → PDF/DOCX/audio upload. The proxy first POSTs the
//     binary to the backend's Payload media endpoint, then creates the
//     `documents` row pointing at the freshly-uploaded media id. The
//     `Documents` afterChange hook (the backend) takes it from there:
//     extract → enqueue ingest → status updates land via the M5 webhook
//     receiver.
//
// ⚠ AUDIO TAKES THE SAME PATH, on purpose. The only difference is that its
// text comes from `services/audio-service` instead of an inline extractor, and
// therefore arrives minutes-to-hours later via the same webhook. Nothing here
// branches on it beyond naming the `kind`; there is no second pipeline and no
// second corpus. The corpus is derived server-side either way and is never
// named by this proxy. 🔴 Audio is refused while `AUDIO_UPLOAD_ENABLED` is off.
export const POST: RequestHandler = async ({ locals, params, request }) => {
  if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });

  const sessionIdRaw = String(params.id);
  const sessionId = /^\d+$/.test(sessionIdRaw) ? Number(sessionIdRaw) : sessionIdRaw;
  const contentType = request.headers.get('content-type') ?? '';

  if (contentType.startsWith('multipart/form-data')) {
    // ── M6 — PDF / DOCX (/ audio, when switched on) upload ────────────
    // The whole flow, and every rule in it, lives in `uploadDocument` — shared
    // with Mis documentos so the two routes cannot drift. 🔴 It refuses audio
    // while `AUDIO_UPLOAD_ENABLED` is off (backlog #8).
    const { status, body } = await uploadDocument(locals.token, await request.formData(), {
      session: [sessionId],
      defaultPinned: true,
    });
    return json(body, { status });
  }

  // ── JSON path — markdown working-doc ──────────────────────────────
  let body: {
    name?: string;
    bodyMarkdown?: string;
    isPinned?: boolean;
    kind?: 'markdown' | 'pdf' | 'docx' | 'audio';
    mode?: 'full-text' | 'rag-retrieve';
  } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    /* allow empty */
  }
  const res = await backendFetch(locals.token, '/api/documents', {
    method: 'POST',
    body: JSON.stringify({
      // ⚠ An array — see the multipart branch above. Same `hasMany` field.
      session: [sessionId],
      kind: body.kind ?? 'markdown',
      mode: body.mode ?? 'full-text',
      name: body.name ?? 'Untitled document',
      bodyMarkdown: body.bodyMarkdown ?? '',
      isPinned: body.isPinned ?? true,
      ingestStatus: 'n/a',
    }),
  });
  const out = await res.json().catch(() => ({}));
  return json(out, { status: res.status });
};
