/**
 * `/estudiante/companero/<id>` — one opted-in classmate: name, the topics we
 * share, their published works. `<id>` is the backend's opaque slug.
 *
 * 🔴 THE CONTROL IS THE BACKEND (`GET /api/estudiante/companero`): same
 * ecosistema, opted in to `shareWithPeers` right now, published documentos
 * only. Anything else there (not opted in, withdrawn, another ecosistema,
 * not a student, `studentView` off) is a 404 here.
 */

import { notFound } from '$lib/server/deny';
import { resolveEcosystem } from '$lib/server/ecosystem';
import { fetchCompanero } from '$lib/server/estudiante';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, cookies, params }) => {
  if (!locals.user) notFound({ entity: 'page' });
  const eco = await resolveEcosystem(cookies, locals.token);
  if (!eco.selected) notFound({ entity: 'page' });
  const organization = eco.selected!.id;
  const r = await fetchCompanero(locals.token, organization, params.id);
  if (!r.ok) {
    if (r.status === 403 || r.status === 404 || r.status === 400) notFound({ entity: 'page' });
    return { organization, ecosystemName: eco.selected!.name ?? null, companero: null };
  }
  return { organization, ecosystemName: eco.selected!.name ?? null, companero: r.value.companero };
};
