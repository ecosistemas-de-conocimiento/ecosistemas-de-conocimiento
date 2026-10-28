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
import { fetchEditables, saveAnswerStyles, saveFeatures, savePlatform } from '$lib/server/features';
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
    };
  }
  const requested = url.searchParams.get('eco') ?? '';
  const selected = result.ecosistemas.find((e) => e.id === requested) ?? result.ecosistemas[0] ?? null;
  return {
    state: 'ready' as const,
    ecosistemas: result.ecosistemas,
    selected,
    plataforma: result.plataforma,
    lockedFeatures: result.lockedFeatures,
    answerStylesEditable: result.answerStylesEditable,
  };
};

export const actions: Actions = {
  funciones: async ({ locals, request }) => {
    if (!locals.user) return fail(401, { message: 'Necesitas iniciar sesión.', scope: 'funciones' as const });
    const form = await request.formData();
    const organization = String(form.get('organization') ?? '');
    // A checkbox sends only when ticked: every key is written, unticked = off —
    // except a read-only one (`locked`), which a disabled box never sends and so
    // would read as "off". The backend refuses a tampered `locked` anyway.
    const locked = new Set(form.getAll('locked').map(String));
    const features = Object.fromEntries(
      FEATURE_KEYS.filter((k) => !locked.has(k)).map((k) => [k, form.get(k) === 'on']),
    ) as Partial<Features>;
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
