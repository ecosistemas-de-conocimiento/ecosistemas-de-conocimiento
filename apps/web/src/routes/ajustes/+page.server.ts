/**
 * `/ajustes` — feature switches per ecosistema, and the platform switches.
 *
 * 🔴 THE CONTROL IS THE BACKEND (`/api/funciones`, `/api/plataforma`): it lists
 * only what the caller may edit (platform admin: every ecosistema + platform;
 * responsable: their own ecosistemas) and re-checks every save. This load
 * picks which ecosistema to show and hides the page from everyone else.
 */

import { fail } from '@sveltejs/kit';

import { FEATURE_KEYS, type Features } from '$lib/features';
import { denyAccess } from '$lib/server/deny';
import { fetchEditables, saveFeatures, savePlatform } from '$lib/server/features';
import type { Actions, PageServerLoad } from './$types';

const deny = (): never =>
  denyAccess({
    module: 'ajustes',
    reason: 'no-feature-edit',
    message: 'Esta sección es para quien es responsable de un ecosistema.',
    cta: { label: 'Volver al chat', href: '/' },
  });

export const load: PageServerLoad = async ({ locals, url }) => {
  if (!locals.user) deny();
  const result = await fetchEditables(locals.token);
  if (result.state === 'forbidden') deny();
  if (result.state !== 'ready') {
    return { state: 'unavailable' as const, ecosistemas: [], selected: null, plataforma: null };
  }
  const requested = url.searchParams.get('eco') ?? '';
  const selected = result.ecosistemas.find((e) => e.id === requested) ?? result.ecosistemas[0] ?? null;
  return { state: 'ready' as const, ecosistemas: result.ecosistemas, selected, plataforma: result.plataforma };
};

export const actions: Actions = {
  funciones: async ({ locals, request }) => {
    if (!locals.user) return fail(401, { message: 'Necesitas iniciar sesión.' });
    const form = await request.formData();
    const organization = String(form.get('organization') ?? '');
    // A checkbox sends only when ticked: every key is written, unticked = off.
    const features = Object.fromEntries(FEATURE_KEYS.map((k) => [k, form.get(k) === 'on'])) as Features;
    const result = await saveFeatures(locals.token, organization, features);
    if (!result.ok) return fail(result.status, { message: result.message });
    return { saved: true };
  },
  plataforma: async ({ locals, request }) => {
    if (!locals.user) return fail(401, { message: 'Necesitas iniciar sesión.' });
    const form = await request.formData();
    const raw = String(form.get('detectorFallback') ?? '');
    const value = raw === 'hosted' || raw === 'none' ? raw : null;
    const result = await savePlatform(locals.token, value);
    if (!result.ok) return fail(result.status, { message: result.message });
    return { saved: true };
  },
};
