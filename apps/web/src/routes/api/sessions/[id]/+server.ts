import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendFetch } from '$lib/server/auth';
import { refsToRelationships, relationshipsToRefs } from '$lib/server/contextRefs';
import type { ContextRef } from '$lib/types';

// PATCH /api/sessions/[id] → update title, panelState, lastUsedAt, contextScope.
// `kind` (Generales/Resonancias) is fixed at create and dropped here.
export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    /* allow empty */
  }
  delete body.kind;

  // CANONICAL ref-field contract: `contextScope` is a polymorphic relationship
  // on the backend now. The FE store sends `{ refs: [{kind,id,label}] }`; map
  // it to Payload's `[{relationTo, value}]` (the `org` sentinel → empty = whole
  // org). Anything else passes through untouched.
  if (body.contextScope && typeof body.contextScope === 'object') {
    const refs = (body.contextScope as { refs?: ContextRef[] }).refs;
    body.contextScope = refsToRelationships(refs);
  }

  // Read back depth=1 so the relationship is populated and we can recover the
  // entity names for the chip labels.
  const res = await backendFetch(locals.token, `/api/sessions/${params.id}?depth=1`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  const out = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
    doc?: Record<string, unknown>;
  };

  // Translate the relationship back to the store shape on the way out.
  const doc = (out.doc ?? out) as Record<string, unknown>;
  if (doc && 'contextScope' in doc) {
    doc.contextScope = { refs: relationshipsToRefs(doc.contextScope) };
  }
  return json(out, { status: res.status });
};

// DELETE /api/sessions/[id] → the backend's `Sessions.beforeDelete` cascade:
// ratings, messages, and the uploads that belong to this conversation alone
// (`apps/backend/src/lib/conversationUploads.ts`).
export const DELETE: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
  const res = await backendFetch(locals.token, `/api/sessions/${params.id}`, {
    method: 'DELETE',
  });
  const out = await res.json().catch(() => ({}));
  return json(out, { status: res.status });
};
