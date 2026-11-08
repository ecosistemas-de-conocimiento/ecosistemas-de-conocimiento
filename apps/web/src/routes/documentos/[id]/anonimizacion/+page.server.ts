/**
 * `/documentos/[id]/anonimizacion` — what the anonymisation kept and removed
 * (counts only), and this document's two "keep names" switches.
 *
 * 🔴 THE CONTROL IS THE BACKEND. It answers 403 to anyone who may not change
 * this document (only the uploader, `holds:review` in its ecosistema, or a
 * platform admin may) and 404 to an unknown id; this load turns those into the
 * normal error page. The save is a form action, so it works without JS.
 */

import { fail } from '@sveltejs/kit';

import { CONVERSACIONES_HREF } from '$lib/inicio';
import { backHref, patchFromForm, saveErrorMessage, savedMessage, UNCHANGED } from '$lib/anonimizacion';
import { readAnonimizacion, saveAnonimizacion } from '$lib/server/anonimizacion';
import { denyAccess, notFound } from '$lib/server/deny';
import type { Actions, PageServerLoad } from './$types';

const deny = (): never =>
  denyAccess({ module: 'anonimizacion', reason: 'no-anon-edit', cta: { label: 'Volver al chat', href: CONVERSACIONES_HREF } });

export const load: PageServerLoad = async ({ locals, params, url }) => {
  if (!locals.user) deny();
  const back = backHref(url.searchParams.get('volver'));
  const result = await readAnonimizacion(locals.token, String(params.id ?? ''));
  if (result.state === 'forbidden') deny();
  if (result.state === 'not-found') {
    notFound({ entity: 'document', module: 'anonimizacion', cta: { label: 'Volver', href: back } });
  }
  if (result.state !== 'ready') return { state: 'unavailable' as const, view: null, back };
  return { state: 'ready' as const, view: result.view, back };
};

export const actions: Actions = {
  guardar: async ({ locals, params, request }) => {
    if (!locals.user) return fail(401, { message: saveErrorMessage(401) });
    const body = patchFromForm(await request.formData());
    if (Object.keys(body).length === 0) return { saved: true, message: UNCHANGED };
    const result = await saveAnonimizacion(locals.token, String(params.id ?? ''), body);
    if (!result.ok) return fail(result.status, { message: saveErrorMessage(result.status) });
    return { saved: true, message: savedMessage(result.regate), regate: result.regate };
  },
};
