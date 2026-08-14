// Service-to-service grant lookup for @edc/identity-client.
//
// `GET /v1/identity/resolve?email=&project=` answers "what is this human
// allowed to do here?" WITHOUT a user token. It is authenticated by
// `X-Service-Token` alone, so:
//
//   ⚠ SERVER-SIDE ONLY. The service token is a bearer credential for the
//     whole IdP resolve surface. Shipping it to a browser hands every caller
//     the ability to enumerate the whole permission map.
//
// Reach for this on background jobs, webhooks and migrations — paths where a
// user token does not exist. On a request carrying a user token, verify the
// token instead: it is already signed, already scoped, and costs no round-trip.

import type { ProjectGrant, ResolvedPrincipal } from './types.js';
import {
  requireServiceConfig,
  serviceError,
  serviceGet,
  type ServiceCallOptions,
} from './serviceRequest.js';

/** Shared with {@link resolveExport} — one options shape for every service call. */
export type ResolveOptions = ServiceCallOptions;

/**
 * Resolve one user's grant in one project.
 *
 * Returns `null` when the IdP answers 404, which today means EITHER "no active
 * account for that email" OR "that account holds nothing on this project".
 * The endpoint does not distinguish the two, so neither can this function —
 * treat `null` as "no access", not as "user does not exist".
 *
 * A platform admin with no explicit assignment resolves to empty arrays rather
 * than 404. Ordinary users get their permissions already flattened (roles +
 * `extraPermissions`, unioned). If you need the admin flag itself, call
 * {@link resolvePrincipal}.
 */
export async function resolveGrant(
  email: string,
  projectSlug: string,
  options: ResolveOptions,
): Promise<ProjectGrant | null> {
  const principal = await resolvePrincipal(email, projectSlug, options);
  if (!principal) return null;
  // The response is narrowed to one project, so the single entry IS the answer
  // even if the server echoed the slug with different casing.
  return (
    principal.projects[projectSlug] ??
    Object.values(principal.projects)[0] ?? { roles: [], permissions: [] }
  );
}

/**
 * Same call as {@link resolveGrant}, but returns the whole
 * {@link ResolvedPrincipal} — including `isPlatformAdmin` and the display name.
 *
 * The IdP answers with a flat body (`{ email, name, project, roles,
 * permissions, isPlatformAdmin }`); this lifts it into the standard principal
 * shape with `projects` narrowed to the one project asked about, so the same
 * helpers work on it as on `/v1/identity/me`.
 */
export async function resolvePrincipal(
  email: string,
  projectSlug: string,
  options: ResolveOptions,
): Promise<ResolvedPrincipal | null> {
  const fetchImpl = requireServiceConfig('resolveGrant', options, [
    ['email', email],
    ['projectSlug', projectSlug],
  ]);

  const normalizedEmail = email.trim().toLowerCase();
  const url =
    `${options.baseUrl.replace(/\/+$/, '')}/v1/identity/resolve` +
    `?email=${encodeURIComponent(normalizedEmail)}&project=${encodeURIComponent(projectSlug)}`;

  const { status, body } = await serviceGet('resolveGrant', fetchImpl, url, options);

  // 404 is a normal answer here, not a failure — see the doc comment above.
  if (status === 404) return null;
  if (status < 200 || status >= 300) throw serviceError('resolveGrant', status, body);

  return normalize(body, normalizedEmail, projectSlug);
}

/**
 * Lift the resolve response into the standard `ResolvedPrincipal` shape.
 *
 * The endpoint's own body is FLAT — `{ email, name, project, roles,
 * permissions, isPlatformAdmin }` — so the first branch below is the one that
 * fires today. The nested `projects` branch is kept because `/v1/identity/me`
 * uses that shape and the resolve body is the part of the contract still
 * settling; a client that hard-fails on the other shape would turn a
 * server-side wording change into a platform-wide outage.
 */
function normalize(body: unknown, email: string, projectSlug: string): ResolvedPrincipal | null {
  if (!body || typeof body !== 'object') return null;
  const raw = body as Record<string, unknown>;

  const base = {
    email: typeof raw.email === 'string' ? raw.email.toLowerCase() : email,
    name: typeof raw.name === 'string' ? raw.name : null,
    isPlatformAdmin: raw.isPlatformAdmin === true,
  };

  if (Array.isArray(raw.permissions) || Array.isArray(raw.roles)) {
    const grant: ProjectGrant = {
      roles: Array.isArray(raw.roles) ? (raw.roles as string[]) : [],
      permissions: Array.isArray(raw.permissions) ? (raw.permissions as string[]) : [],
    };
    // Trust the server's echoed `project` over our request parameter.
    const slug = typeof raw.project === 'string' && raw.project ? raw.project : projectSlug;
    return { ...base, projects: { [slug]: grant } };
  }

  if (raw.projects && typeof raw.projects === 'object') {
    return { ...base, projects: raw.projects as Record<string, ProjectGrant> };
  }

  return null;
}
