/**
 * `/estudiante` — the student view of the selected ecosistema.
 *
 * 🔴 THE CONTROL IS THE BACKEND (`endpoints/estudiante.ts`): `studentView` on,
 * role `estudiante`, own data + opted-in peers only. A 404 or 403 there is a
 * 404 here. The `preguntas` action is the one paid model call.
 */

import { fail } from '@sveltejs/kit';

import { TESTIMONIO_CONSENT_VERSION } from '$lib/consent';
import { notFound } from '$lib/server/deny';
import { resolveEcosystem } from '$lib/server/ecosystem';
import { fetchOverview, postSuggestion, savePerfil } from '$lib/server/estudiante';
import { allowQuestions, generateQuestions } from '$lib/server/preguntas';
import type { Actions, PageServerLoad } from './$types';

const KINDS = ['contenido', 'arquitectura', 'interaccion'] as const;

async function org(cookies: Parameters<PageServerLoad>[0]['cookies'], token: string | undefined): Promise<string> {
  const eco = await resolveEcosystem(cookies, token);
  if (!eco.selected) notFound({ entity: 'page' });
  return eco.selected!.id;
}

export const load: PageServerLoad = async ({ locals, cookies }) => {
  if (!locals.user) notFound({ entity: 'page' });
  const organization = await org(cookies, locals.token);
  const r = await fetchOverview(locals.token, organization);
  if (!r.ok) {
    if (r.status === 403 || r.status === 404) notFound({ entity: 'page' });
    return { organization, overview: null };
  }
  return { organization, overview: r.value };
};

export const actions: Actions = {
  perfil: async ({ locals, cookies, request }) => {
    const form = await request.formData();
    const organization = await org(cookies, locals.token);
    const key = String(form.get('key') ?? '');
    if (key !== 'shareWithPeers' && key !== 'shareActivity' && key !== 'shareTestimonios') {
      return fail(400, { message: 'Valor no válido.' });
    }
    const value = form.get('value') === 'true';
    // 🔴 Accepting the testimonio consent names the wording version this page shows (owner ruling Q20).
    const r = await savePerfil(
      locals.token,
      organization,
      key === 'shareTestimonios' && value ? { shareTestimonios: true, consentVersion: TESTIMONIO_CONSENT_VERSION } : { [key]: value },
    );
    if (!r.ok) return fail(r.status, { message: r.message });
    return { saved: true };
  },

  sugerir: async ({ locals, cookies, request }) => {
    const form = await request.formData();
    const organization = await org(cookies, locals.token);
    const kind = String(form.get('kind') ?? '');
    const text = String(form.get('text') ?? '').trim();
    if (!(KINDS as readonly string[]).includes(kind)) return fail(400, { message: 'Elige un tipo.', text });
    if (!text) return fail(400, { message: 'Escribe tu sugerencia.', text });
    const r = await postSuggestion(locals.token, organization, kind, text);
    if (!r.ok) return fail(r.status, { message: r.message, text });
    return { suggested: true };
  },

  preguntas: async ({ locals, cookies }) => {
    if (!locals.user) return fail(401, { message: 'Necesitas iniciar sesión.' });
    const organization = await org(cookies, locals.token);
    const r = await fetchOverview(locals.token, organization);
    if (!r.ok) return fail(r.status, { message: r.message });
    const userId = String(locals.user.id ?? locals.user.email ?? '');
    if (!allowQuestions(userId)) return fail(429, { message: 'Intenta más tarde.' });
    try {
      const preguntas = await generateQuestions(organization, userId, r.value);
      if (preguntas.length === 0) return fail(502, { message: 'No se pudieron generar. Intenta de nuevo.' });
      return { preguntas };
    } catch (err) {
      console.warn('[estudiante] preguntas failed', err);
      return fail(502, { message: 'No se pudieron generar. Intenta de nuevo.' });
    }
  },
};
