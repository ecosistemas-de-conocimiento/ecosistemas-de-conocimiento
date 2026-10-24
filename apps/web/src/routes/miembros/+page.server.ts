/**
 * `/miembros` — an ecosistema's people: list, add, change role, remove.
 *
 * 🔴 THE CONTROL IS THE BACKEND. `/api/miembros` checks that the caller holds
 * `members:manage` in THAT ecosistema (or is a platform admin), caps every role
 * at the caller's own, and never reveals anything about a person beyond email
 * and name. This load only picks which ecosistema to show and hides the page
 * from people who manage none — the same shape as `/revision`.
 *
 * ⚠ THE ONE-TIME PASSWORD lives only in the `add` action's return value: it is
 * rendered once and is gone on the next navigation. Nothing here stores it.
 */

import { fail } from '@sveltejs/kit';

import { denyAccess } from '$lib/server/deny';
import { listAllEcosystems, readEcosystem } from '$lib/server/admin';
import { ECOSYSTEM_COOKIE, listEcosystems } from '$lib/server/ecosystem';
import { mayReviewAnywhere, mayReviewSlug, readReviewCapability } from '$lib/server/holds';
import { addMember, changeRole, listMembers, MEMBERS_MANAGE, removeMember } from '$lib/server/miembros';
import { ECOSYSTEM_DEPENDENCY, resolveEcosystemSelection } from '$lib/ecosystems';
import type { Actions, PageServerLoad } from './$types';

const NOT_A_MANAGER = 'Esta sección es para quien es responsable de un ecosistema.';

const deny = (): never =>
  denyAccess({
    module: 'miembros',
    reason: 'no-members-manage',
    message: NOT_A_MANAGER,
    cta: { label: 'Volver al chat', href: '/' },
  });

export const load: PageServerLoad = async ({ locals, url, cookies, depends }) => {
  depends(ECOSYSTEM_DEPENDENCY);

  const capability = locals.user ? await readReviewCapability(locals.token, MEMBERS_MANAGE) : null;
  if (!capability || !mayReviewAnywhere(capability)) deny();
  const cap = capability!;

  const mine = await listEcosystems(locals.token);
  const manageable = mine.list.filter((eco) => mayReviewSlug(cap, eco.slug));

  const requested = url.searchParams.get('eco') ?? '';
  const requestedEco = requested ? await readEcosystem(locals.token, requested) : null;
  const allowed = requestedEco && mayReviewSlug(cap, requestedEco.slug) ? requestedEco : null;

  const picked = resolveEcosystemSelection(mine.list, cookies.get(ECOSYSTEM_COOKIE));
  const pickedEco =
    picked.source === 'requested' && picked.selected && mayReviewSlug(cap, picked.selected.slug)
      ? picked.selected
      : null;

  let fallback = pickedEco ?? manageable[0] ?? null;
  if (!allowed && !fallback && cap.isPlatformAdmin) {
    fallback = (await listAllEcosystems(locals.token, '')).rows[0] ?? null;
  }
  const selected = allowed ?? fallback;
  const notFound = Boolean(requested) && allowed === null;

  if (!selected) {
    return { state: 'unavailable' as const, selected: null, ecosystems: manageable, members: [], myRole: '', notFound };
  }

  const result = await listMembers(locals.token, selected.id);
  if (result.state === 'forbidden') deny();
  return {
    state: result.state === 'ready' ? ('ready' as const) : ('unavailable' as const),
    selected,
    ecosystems: manageable,
    members: result.state === 'ready' ? result.members : [],
    myRole: result.state === 'ready' ? result.myRole : '',
    notFound,
  };
};

const field = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
};

export const actions: Actions = {
  add: async ({ locals, request }) => {
    if (!locals.user) return fail(401, { message: 'Necesitas iniciar sesión.' });
    const form = await request.formData();
    const result = await addMember(locals.token, {
      organization: field(form, 'organization'),
      email: field(form, 'email'),
      name: field(form, 'name'),
      role: field(form, 'role'),
    });
    if (!result.ok) return fail(result.status, { message: result.message });
    return { added: result.value };
  },
  role: async ({ locals, request }) => {
    if (!locals.user) return fail(401, { message: 'Necesitas iniciar sesión.' });
    const form = await request.formData();
    const result = await changeRole(locals.token, field(form, 'id'), field(form, 'role'));
    if (!result.ok) return fail(result.status, { message: result.message });
    return { saved: true };
  },
  remove: async ({ locals, request }) => {
    if (!locals.user) return fail(401, { message: 'Necesitas iniciar sesión.' });
    const form = await request.formData();
    const result = await removeMember(locals.token, field(form, 'id'));
    if (!result.ok) return fail(result.status, { message: result.message });
    return { removed: true };
  },
};
