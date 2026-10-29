/**
 * `/estudiante` — the student view of the selected ecosistema.
 *
 * 🔴 THE CONTROL IS THE BACKEND (`endpoints/estudiante.ts`): `studentView` on,
 * role `estudiante`, own data + opted-in peers only. A 404 or 403 there is a
 * 404 here. The `preguntas` action is the one paid model call.
 */

import { fail } from '@sveltejs/kit';

import { CONSENT_CHANGED } from '$lib/consent';
import { ECOSYSTEM_DEPENDENCY } from '$lib/ecosystems';
import { ESTUDIANTE_DEPENDENCY } from '$lib/estudiante';
import { notFound } from '$lib/server/deny';
import { resolveEcosystem } from '$lib/server/ecosystem';
import { fetchOverview, postSuggestion, savePerfil } from '$lib/server/estudiante';
import { allowQuestions, generateQuestions } from '$lib/server/preguntas';
import type { Actions, PageServerLoad } from './$types';

const KINDS = ['contenido', 'arquitectura', 'interaccion'] as const;

async function selected(cookies: Parameters<PageServerLoad>[0]['cookies'], token: string | undefined) {
  const eco = await resolveEcosystem(cookies, token);
  if (!eco.selected) notFound({ entity: 'page' });
  return eco.selected!;
}

const org = async (cookies: Parameters<PageServerLoad>[0]['cookies'], token: string | undefined): Promise<string> =>
  (await selected(cookies, token)).id;

export const load: PageServerLoad = async ({ locals, cookies, depends }) => {
  // Topics land after a trabajo is processed; the page re-runs this to show them.
  depends(ESTUDIANTE_DEPENDENCY, ECOSYSTEM_DEPENDENCY);
  if (!locals.user) notFound({ entity: 'page' });
  const eco = await selected(cookies, locals.token);
  const organization = eco.id;
  // The page's kicker; display only.
  const ecosystemName = eco.name ?? null;
  const r = await fetchOverview(locals.token, organization);
  if (!r.ok) {
    if (r.status === 403 || r.status === 404) notFound({ entity: 'page' });
    return { organization, ecosystemName, overview: null };
  }
  return { organization, ecosystemName, overview: r.value };
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
    // 🔴 Accepting the testimonio consent names the wording version THE PAGE
    // showed (owner ruling Q20), from its hidden `consentVersion` input. Never
    // the server's own: a page built before a wording change must get the
    // backend's 409, not a consent to text the student never read. Missing or
    // not a number → sent as undefined, which the backend refuses too.
    const shown = Number(form.get('consentVersion'));
    const consentVersion = form.has('consentVersion') && Number.isInteger(shown) ? shown : undefined;
    const r = await savePerfil(
      locals.token,
      organization,
      key === 'shareTestimonios' && value ? { shareTestimonios: true, consentVersion } : { [key]: value },
    );
    if (!r.ok && r.status === 409 && key === 'shareTestimonios') return fail(409, { message: CONSENT_CHANGED });
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
