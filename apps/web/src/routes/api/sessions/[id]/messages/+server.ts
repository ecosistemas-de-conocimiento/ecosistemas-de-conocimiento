import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFetch } from '$lib/server/auth';
import { degradeListResponse } from '$lib/server/degrade';
import { refsToRelationships, relationshipsToRefs } from '$lib/server/contextRefs';
import { toBrowserMessage } from '$lib/server/citationProvenance';
import { backendTitleFetcher, messagesWithTestimonioTitles } from '$lib/server/testimonioTitles';
import type { ContextRef } from '$lib/types';
import { backendJson } from '$lib/server/backendResponse';

// GET /api/sessions/[id]/messages → ordered messages for this session.
// Fragile read: degrade a 403/transient backend failure to an empty list.
//
// `depth=1` so the polymorphic `contextRefs` relationship is populated; each
// message's `[{relationTo,value}]` is mapped back to `{refs:[{kind,id,label}]}`
// for the store (CANONICAL ref-field contract).
export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
  const qs = new URLSearchParams({
    'where[session][equals]': String(params.id),
    sort: 'createdAt',
    limit: '1000',
    depth: '1',
  });
  const res = await backendFetch(locals.token, `/api/messages?${qs.toString()}`, {
    method: 'GET',
  });
  const body = (await res.json().catch(() => ({}))) as { docs?: Record<string, unknown>[] };
  if (Array.isArray(body.docs)) {
    // 🔴 Persisted provenance may predate the write-side allowlist and still
    // carry chunk `sessionId` / `authoredBy` (Fable audit #8). Strip here, at
    // the read boundary — `$lib/server/citationProvenance`.
    body.docs = body.docs.map((doc) =>
      toBrowserMessage({ ...doc, contextRefs: relationshipsToRefs(doc.contextRefs) }),
    );
    // Testimonio sources get their system-proposed titles, one lookup for the
    // whole history, read with the caller's token (`$lib/server/testimonioTitles`).
    body.docs = await messagesWithTestimonioTitles(body.docs, backendTitleFetcher(locals.token));
  }
  const out = degradeListResponse(res, body, 'messages');
  return json(out.body, { status: out.status });
};

// POST /api/sessions/[id]/messages → create a new message.
export const POST: RequestHandler = async ({ locals, params, request }) => {
  if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
  let body: { role?: string; content?: string; generationMeta?: unknown; contextRefs?: ContextRef[] } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    /* allow empty */
  }
  // Payload's relationship column is `bigint` for the default Postgres
  // adapter — passing the URL param as a string fails its validator. Coerce
  // numeric strings; leave anything else (future uuid mode) untouched.
  const sessionId = /^\d+$/.test(String(params.id)) ? Number(params.id) : params.id;
  // CANONICAL ref-field contract: map the turn's @-mention refs to the
  // polymorphic `contextRefs` relationship (org sentinel dropped → empty).
  const contextRefs = refsToRelationships(body.contextRefs);
  const res = await backendFetch(locals.token, '/api/messages', {
    method: 'POST',
    body: JSON.stringify({
      session: sessionId,
      role: body.role,
      content: body.content ?? '',
      generationMeta: body.generationMeta ?? null,
      ...(contextRefs.length ? { contextRefs } : {}),
    }),
  });
  const out = (await res.json().catch(() => ({}))) as { doc?: unknown };
  // This route never sends provenance, but the echoed row is a message: same
  // allowlist as the GET, so no path returns a raw one.
  if (out.doc && typeof out.doc === 'object') {
    out.doc = toBrowserMessage(out.doc as Record<string, unknown>);
  }
  return backendJson(out, res);
};
