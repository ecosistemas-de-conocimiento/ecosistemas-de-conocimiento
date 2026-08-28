import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFetch, backendUrl } from '$lib/server/auth';
import { mapUpstreamMediaError } from '$lib/server/documents';
import { degradeListResponse } from '$lib/server/degrade';
import { isAudioUpload, maxUploadBytesFor } from '$lib/config';

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
// named by this proxy.
export const POST: RequestHandler = async ({ locals, params, request }) => {
  if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });

  const sessionIdRaw = String(params.id);
  const sessionId = /^\d+$/.test(sessionIdRaw) ? Number(sessionIdRaw) : sessionIdRaw;
  const contentType = request.headers.get('content-type') ?? '';

  if (contentType.startsWith('multipart/form-data')) {
    // ── M6 — PDF / DOCX upload ────────────────────────────────────────
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      return json({ error: 'multipart_missing_file' }, { status: 400 });
    }
    const kindRaw = form.get('kind');
    const name = (form.get('name') as string | null) ?? file.name;
    const isPinned = form.get('isPinned') !== 'false';

    // Infer kind from MIME if not provided.
    //
    // ⚠ PDF and DOCX are checked FIRST. `isAudioUpload` accepts `.mp4`/`.mov`
    // (a phone recording's audio track is the point), and its extension
    // fallback is deliberately generous — running it first would let a document
    // with an odd MIME type fall into the audio branch and cost CPU-hours to
    // find out.
    //
    // ⚠ THE CLIENT-SUPPLIED `kind` IS A HINT, NOT A DECISION. It used to be
    // trusted outright, which let a caller post a PDF with `kind=audio` and send
    // it straight to the transcriber — defeating the ordering above and costing
    // CPU-minutes to discover. It is now only honoured when it AGREES with what
    // the file actually looks like.
    let kind: 'pdf' | 'docx' | 'audio' | null = null;
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      kind = 'pdf';
    } else if (
      file.type ===
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      /\.docx$/i.test(file.name)
    ) {
      kind = 'docx';
    } else if (isAudioUpload(file)) {
      kind = 'audio';
    }
    if (!kind) {
      return json({ error: 'unsupported_kind' }, { status: 400 });
    }
    if (typeof kindRaw === 'string' && kindRaw && kindRaw !== kind) {
      // The caller asked for something the file is not. Refuse rather than
      // silently overriding: a client that thinks it uploaded audio and gets a
      // PDF document back has a bug worth surfacing.
      return json({ error: 'unsupported_kind', inferred: kind }, { status: 400 });
    }

    // Size gate, server-side. The browser checks too, but the browser is not a
    // security boundary and a 200 MB body accepted here lands on the backend's
    // local disk before anything can refuse it.
    const cap = maxUploadBytesFor(file);
    if (file.size > cap) {
      return json({ error: 'file_too_large', limit: cap, kind }, { status: 413 });
    }

    // 1. Upload to the backend's Payload media endpoint. Payload's REST
    //    `POST /api/media` expects multipart with a `file` field — same
    //    field name we receive from the browser, so we can re-emit it.
    const mediaForm = new FormData();
    mediaForm.append('file', file, file.name);

    const headers = new Headers();
    if (locals.token) headers.set('Authorization', `JWT ${locals.token}`);
    // Don't set content-type — let fetch/FormData generate the boundary.
    let mediaRes: Response;
    try {
      mediaRes = await fetch(`${backendUrl()}/api/media`, {
        method: 'POST',
        headers,
        body: mediaForm,
      });
    } catch (err) {
      // DNS/connect/TLS failure — the backend isn't reachable at all.
      return json(
        {
          error: 'upstream_unreachable',
          detail: (err instanceof Error ? err.message : String(err)).slice(0, 500),
        },
        { status: 502 },
      );
    }
    if (!mediaRes.ok) {
      const errBody = await mediaRes.text().catch(() => '');
      const mapped = mapUpstreamMediaError(mediaRes.status, errBody);
      return json(mapped.body, { status: mapped.status });
    }
    const mediaJson = (await mediaRes.json().catch(() => ({}))) as {
      doc?: { id?: number | string };
    };
    const mediaId = mediaJson.doc?.id;
    if (mediaId == null) {
      return json({ error: 'media_id_missing' }, { status: 502 });
    }

    // 2. Create the documents row. Payload's afterChange hook on
    //    the backend will start the extraction + ingest pipeline.
    const docRes = await backendFetch(locals.token, '/api/documents', {
      method: 'POST',
      body: JSON.stringify({
        // ⚠ AN ARRAY, ALWAYS. `documents.session` is a `hasMany` relationship:
        // one document can hang off several conversations. Creating one still
        // attaches it to exactly ONE — the conversation it was uploaded into —
        // but the wire shape is the list, not the scalar. See the sibling
        // `documents/[docId]` route for how the list grows and shrinks.
        session: [sessionId],
        kind,
        mode: 'rag-retrieve',
        name,
        mediaFile: mediaId,
        isPinned,
        ingestStatus: 'pending',
      }),
    });
    const docBody = await docRes.json().catch(() => ({}));
    return json(docBody, { status: docRes.status });
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
