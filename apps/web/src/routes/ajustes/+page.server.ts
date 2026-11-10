/**
 * `/ajustes` — feature switches per ecosistema, and the platform switches.
 *
 * 🔴 THE CONTROL IS THE BACKEND (`/api/funciones`, `/api/plataforma`): it lists
 * only what the caller may edit (platform admin: every ecosistema + platform;
 * responsable: their own ecosistemas) and re-checks every save. This load
 * picks which ecosistema to show and hides the page from everyone else.
 */

import { fail } from '@sveltejs/kit';

import { ANSWER_STYLE_KINDS, type AnswerStyles } from '$lib/answerStyle';
import { FEATURE_KEYS, type Features } from '$lib/features';
import { CONVERSACIONES_HREF } from '$lib/inicio';
import { denyAccess } from '$lib/server/deny';
import {
  fetchAnonRegateStatus,
  fetchEditables,
  retryEcosystemRegate,
  saveAnswerStyles,
  saveFeatures,
  savePlatform,
} from '$lib/server/features';
import type { Actions, PageServerLoad } from './$types';

const deny = (): never =>
  denyAccess({
    module: 'ajustes',
    reason: 'no-feature-edit',
    message: 'Esta sección es para quien es responsable de un ecosistema.',
    cta: { label: 'Volver al chat', href: CONVERSACIONES_HREF },
  });

export const load: PageServerLoad = async ({ locals, url }) => {
  if (!locals.user) deny();
  const result = await fetchEditables(locals.token);
  if (result.state === 'forbidden') deny();
  if (result.state !== 'ready') {
    return {
      state: 'unavailable' as const,
      ecosistemas: [],
      selected: null,
      plataforma: null,
      lockedFeatures: [],
      answerStylesEditable: false,
      anon: null,
    };
  }
  // A retired ecosistema is never the default nor a chip; `?eco=` still opens
  // it, so an admin keeps access to its switches (ruling R54).
  const active = result.ecosistemas.filter((e) => e.isActive);
  const requested = url.searchParams.get('eco') ?? '';
  const selected = result.ecosistemas.find((e) => e.id === requested) ?? active[0] ?? null;
  // Re-read after every save (the action reruns this load): what is still
  // waiting to be anonymised again. Null = say nothing.
  const anon = selected ? await fetchAnonRegateStatus(locals.token, selected.id) : null;
  return {
    state: 'ready' as const,
    ecosistemas: active,
    selected,
    plataforma: result.plataforma,
    lockedFeatures: result.lockedFeatures,
    answerStylesEditable: result.answerStylesEditable,
    anon,
  };
};

export const actions: Actions = {
  funciones: async ({ locals, request }) => {
    if (!locals.user) return fail(401, { message: 'Necesitas iniciar sesión.', scope: 'funciones' as const });
    const form = await request.formData();
    const organization = String(form.get('organization') ?? '');
    // A checkbox sends only when ticked (unticked = off). 🔴 ONLY A SWITCH THAT
    // MOVED IS WRITTEN (I-12): each box posts `was-<key>`, the value the page
    // loaded, so a save never re-writes a switch someone else changed since.
    // A read-only one (`locked`) is never written: a disabled box never posts.
    // The backend refuses a tampered `locked` anyway. No `was-` (an old page):
    // that key is written as before.
    const locked = new Set(form.getAll('locked').map(String));
    const features = Object.fromEntries(
      FEATURE_KEYS.filter((k) => !locked.has(k))
        .map((k) => [k, form.get(k) === 'on'] as const)
        .filter(([k, now]) => !form.has(`was-${k}`) || (form.get(`was-${k}`) === 'on') !== now),
    ) as Partial<Features>;
    if (Object.keys(features).length === 0) return { saved: true, scope: 'funciones' as const };
    const result = await saveFeatures(locals.token, organization, features);
    if (!result.ok) return fail(result.status, { message: result.message, scope: 'funciones' as const });
    return { saved: true, scope: 'funciones' as const };
  },
  // The answer style: platform admin only; the backend refuses anyone else.
  // Every textarea is sent; blank clears that style.
  estilo: async ({ locals, request }) => {
    if (!locals.user) return fail(401, { message: 'Necesitas iniciar sesión.', scope: 'estilo' as const });
    const form = await request.formData();
    const organization = String(form.get('organization') ?? '');
    const answerStyles = Object.fromEntries(
      ANSWER_STYLE_KINDS.map((k) => [k, String(form.get(`style-${k}`) ?? '')]),
    ) as unknown as AnswerStyles;
    const result = await saveAnswerStyles(locals.token, organization, answerStyles);
    if (!result.ok) return fail(result.status, { message: result.message, scope: 'estilo' as const });
    return { saved: true, scope: 'estilo' as const };
  },
  // Re-run the ecosistema's pending re-anonymisation (I-01).
  reintentar: async ({ locals, request }) => {
    if (!locals.user) return fail(401, { message: 'Necesitas iniciar sesión.', scope: 'reintentar' as const });
    const form = await request.formData();
    const organization = String(form.get('organization') ?? '');
    const result = await retryEcosystemRegate(locals.token, organization);
    if (!result.ok) return fail(result.status, { message: result.message, scope: 'reintentar' as const });
    return { saved: true, scope: 'reintentar' as const };
  },
  plataforma: async ({ locals, request }) => {
    if (!locals.user) return fail(401, { message: 'Necesitas iniciar sesión.', scope: 'plataforma' as const });
    const form = await request.formData();
    const raw = String(form.get('detectorFallback') ?? '');
    const value = raw === 'hosted' || raw === 'none' ? raw : null;
    const result = await savePlatform(locals.token, value);
    if (!result.ok) return fail(result.status, { message: result.message, scope: 'plataforma' as const });
    return { saved: true, scope: 'plataforma' as const };
  },
};
