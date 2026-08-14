import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFetch, backendUrl } from '$lib/server/auth';
import { mapUpstreamMediaError } from '$lib/server/documents';
import { degradeListResponse } from '$lib/server/degrade';

// GET /api/sessions/[id]/documents → all docs for this session.
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
//   - multipart/form-data   → PDF/DOCX upload (M6). The proxy first POSTs the
//     binary to the backend's Payload media endpoint, then creates the
//     `documents` row pointing at the freshly-uploaded media id. The
//     `Documents` afterChange hook (the backend) takes it from there:
//     extract → enqueue ingest → status updates land via the M5 webhook
//     receiver.
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
    let kind: 'pdf' | 'docx' | null = null;
    if (kindRaw === 'pdf' || kindRaw === 'docx') {
      kind = kindRaw;
    } else if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      kind = 'pdf';
    } else if (
      file.type ===
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      /\.docx$/i.test(file.name)
    ) {
      kind = 'docx';
    }
    if (!kind) {
      return json({ error: 'unsupported_kind' }, { status: 400 });
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
        session: sessionId,
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
    kind?: 'markdown' | 'pdf' | 'docx';
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
      session: sessionId,
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
