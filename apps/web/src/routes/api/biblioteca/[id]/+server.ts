import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readPublished } from '$lib/server/biblioteca';
import { resolveEcosystem } from '$lib/server/ecosystem';

/**
 * `GET /api/biblioteca/[id]` — read ONE published document.
 *
 * 🔴 OPENING A PUBLISHED DOCUMENT IS NOT A NEW PERMISSION. "Published" already
 * means "shared with everyone in this ecosistema", so a member reading one is
 * the thing publishing was for. What this route must not do is let that
 * sentence stretch: it is a member of THIS ecosistema, reading something that
 * is actually published.
 *
 * ⚠ Both halves are re-checked server-side on the returned row
 * (`isLibraryVisible`), because a read-by-id cannot be constrained by a `where`
 * and the backend's own access rule is more generous than this page: it shows a
 * caller their own drafts, and it shows a platform admin everything.
 *
 * ⚠ A row that fails either check answers 404, never 403. A 403 would confirm
 * that the id exists somewhere else.
 */
export const GET: RequestHandler = async ({ locals, cookies, params }) => {
  if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });

  const id = String(params.id ?? '').trim();
  if (!id) return json({ error: 'document_required' }, { status: 400 });

  const eco = await resolveEcosystem(cookies, locals.token);
  if (!eco.ok) return json({ error: 'upstream_unavailable' }, { status: 502 });
  if (!eco.selected) return json({ error: 'not_found' }, { status: 404 });

  const result = await readPublished(locals.token, eco.selected.id, id, eco.selected.name);
  if (result.state === 'not-found') return json({ error: 'not_found' }, { status: 404 });
  if (result.state === 'unavailable') return json({ error: 'upstream_unavailable' }, { status: 502 });

  return json({ doc: result.doc, ecosystem: { id: eco.selected.id, name: eco.selected.name } });
};
