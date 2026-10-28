import { resolveEcosystem } from '$lib/server/ecosystem';
import { showsStartScreen, CONVERSACIONES_PARAM } from '$lib/inicio';
import { roleIn } from '$lib/roles';
import type { PageServerLoad } from './$types';

/**
 * `/` — the start screen or the full conversations UI (see `$lib/inicio`).
 *
 * ⚠ One ecosistema read per load of a bare `/`; `?conversaciones` skips it.
 * A failed read selects nothing, so the role is null and today's UI shows.
 */
export const load: PageServerLoad = async ({ locals, cookies, url }) => {
  if (!locals.user || url.searchParams.has(CONVERSACIONES_PARAM)) return { startScreen: false };
  const eco = await resolveEcosystem(cookies, locals.token);
  return {
    startScreen: showsStartScreen({
      role: roleIn(locals.user, eco.selected?.id),
      isPlatformAdmin: (locals.user as { isPlatformAdmin?: unknown }).isPlatformAdmin,
      search: url.searchParams,
    }),
  };
};
