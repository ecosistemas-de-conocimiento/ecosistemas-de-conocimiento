// Bulk project export for @edc/identity-client.
//
// `GET /v1/identity/export?project=<slug>` answers "who can reach this product,
// and with what?" in ONE call. It is the seeding counterpart to `resolveGrant`:
// use it to populate a consumer's own users table, not to authorize a request.
//
//   ⚠ SERVER-SIDE ONLY. Same `X-Service-Token` credential as `resolveGrant`,
//     and the response is the whole grant map for a product.
//
// For a single live authorization decision, verify the user's token instead —
// it is already signed, already scoped, and costs no round trip.

import type { ProjectExport } from './types.js';
import {
  requireServiceConfig,
  serviceError,
  serviceGet,
  type ServiceCallOptions,
} from './serviceRequest.js';

export type ResolveExportOptions = ServiceCallOptions;

/**
 * Every active member of one project, ready to seed.
 *
 * ⚠ THIS THROWS ON 404, where {@link resolveGrant} returns `null`. The
 * difference is deliberate and it is the point of the endpoint. For `resolve`,
 * 404 means "this person has no access", which is a normal answer. For
 * `export`, 404 means THE PROJECT SLUG DOES NOT EXIST (or is deactivated),
 * which is a broken configuration — a seed job that swallowed it would write
 * nothing, report success, and leave a product with no users at all. Catch
 * `IdentityRequestError` and check `status === 404` if you need to handle it.
 *
 * A project that exists with no members returns `200` and an empty `members`
 * array. That is a real answer and is safe to seed from.
 *
 * WHAT YOU GET BACK, and the two guarantees that matter for a seed:
 *
 *   - DETERMINISTIC. `members` is sorted by email, and `roles`/`permissions`
 *     are deduplicated and sorted. Two exports of unchanged data differ only in
 *     `exportedAt`, so re-running a seed is a no-op and diffing two exports
 *     shows real changes only.
 *   - FLATTENED. `permissions` is already the union of every role's permissions
 *     plus the assignment's extras. Consumers never expand roles themselves.
 *
 * Inactive users, inactive assignments and inactive projects are excluded, by
 * the same rules the token endpoint uses — an export can never grant more than
 * a live token would.
 *
 * PLATFORM ADMINS are included, flagged with `isPlatformAdmin: true`, and
 * carry the project's full role and permission catalogue even when they hold no
 * assignment. That mirrors what `/v1/identity/resolve` answers for them, so a
 * seed and a live lookup agree. Decide deliberately whether to mirror that
 * grant locally: it comes from a platform-wide flag that can be revoked centrally,
 * and your copy will not hear about it until the next export.
 *
 * @example
 * const { members } = await resolveExport('edc', {
 *   baseUrl: process.env.IDENTITY_URL!,       // https://backend.example.org/api
 *   serviceToken: process.env.IDENTITY_SERVICE_TOKEN!,
 * })
 * for (const member of members) {
 *   await upsertLocalUserByEmail(member.email, { name: member.name })
 * }
 */
export async function resolveExport(
  projectSlug: string,
  options: ResolveExportOptions,
): Promise<ProjectExport> {
  const fetchImpl = requireServiceConfig('resolveExport', options, [
    ['projectSlug', projectSlug],
  ]);

  const normalizedSlug = projectSlug.trim().toLowerCase();
  const url =
    `${options.baseUrl.replace(/\/+$/, '')}/v1/identity/export` +
    `?project=${encodeURIComponent(normalizedSlug)}`;

  const { status, body } = await serviceGet('resolveExport', fetchImpl, url, options);

  if (status < 200 || status >= 300) throw serviceError('resolveExport', status, body);

  return normalizeExport(body, normalizedSlug);
}

/**
 * Validate and narrow the response.
 *
 * A malformed body is an ERROR, not an empty export. Returning `{ members: [] }`
 * for an unparseable response would make a seed job wipe or skip every user and
 * call it a success — the exact failure this endpoint's 404 rule exists to
 * prevent, reintroduced on the client side.
 */
function normalizeExport(body: unknown, requestedSlug: string): ProjectExport {
  if (!body || typeof body !== 'object') {
    throw serviceError('resolveExport', 502, { message: 'identity provider returned a non-JSON body' });
  }

  const raw = body as Record<string, unknown>;
  if (!Array.isArray(raw.members)) {
    throw serviceError('resolveExport', 502, {
      message: 'identity provider returned a body with no `members` array',
    });
  }

  return {
    project: typeof raw.project === 'string' && raw.project ? raw.project : requestedSlug,
    exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : new Date().toISOString(),
    members: raw.members.map((entry) => {
      const member = (entry ?? {}) as Record<string, unknown>;
      return {
        email: typeof member.email === 'string' ? member.email.toLowerCase() : '',
        name: typeof member.name === 'string' ? member.name : null,
        isPlatformAdmin: member.isPlatformAdmin === true,
        roles: stringArray(member.roles),
        permissions: stringArray(member.permissions),
      };
    }),
  };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}
