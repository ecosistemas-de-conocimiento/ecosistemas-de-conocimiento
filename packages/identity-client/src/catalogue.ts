// Catalogue-drift check for @edc/identity-client.
//
// The problem (identity OPEN.md R14, measured twice in two weeks on the same
// file): a product adds a permission its code enforces, nobody adds it to the
// IdP's `src/seed/catalog.ts`, so no role carries it, so no token carries it,
// so the feature is simply DEAD for everyone who should have had it. Nothing
// errors — absent means denied. The only symptom is a person saying "I can't
// see the button", which reads like a bug in the product.
//
// The IdP's own seed-time drift check CANNOT see this. A permission the IdP
// never had leaves no row to notice. Only the consumer — the side that knows
// what it enforces — can catch it, which is why this lives in the client.
//
// ⚠ TWO DIFFERENT QUESTIONS, AND CONFLATING THEM HIDES THE SECOND ONE.
//
//   "Does the IdP KNOW this permission?"  → the catalogue. Read off a PLATFORM
//     ADMIN's export entry, which carries the project's whole catalogue whether
//     or not any role references it.
//   "Does anyone actually GET it?"        → the grants. The union of what real
//     assigned members hold, i.e. what roles hand out.
//
// A key can exist and be on no role. It is seeded, the admin's entry lists it,
// and every ordinary user is still denied — the same dead feature, one step
// further along. So this reports BOTH sets and lets the caller decide which one
// its CI fails on. `ok` answers only the first question.
//
// ⚠ THIS IS A CHECK, NOT A SYNC. R14's "do" list is explicit that two-way sync
// between a TS constant and a database is a bigger commitment than the problem
// justifies, and that the seed being deliberately behind is a legitimate state.
// So this reports and returns; it never writes to the IdP, and it does not
// decide what your CI does about the answer.

import { resolveExport } from './export.js';
import type { ResolveExportOptions } from './export.js';
import type { ProjectExport } from './types.js';
import { isPlatformAdminFlag } from './permissions.js';

export interface CatalogueDriftOptions extends ResolveExportOptions {
  /** The project slug whose catalogue to compare against, e.g. `edc`. */
  project: string;
  /**
   * Skip the network call and diff against an export you already have.
   * Useful when a job checks several things off one export.
   */
  export?: ProjectExport;
}

export interface CatalogueDrift {
  /** Echoed project slug, normalized. */
  project: string;
  /**
   * True when the IdP's catalogue contains every permission this product
   * declares — i.e. `missingFromIdp` is empty.
   *
   * ⚠ IT ANSWERS ONLY THE EXISTENCE QUESTION. A key that exists but sits on no
   * role still denies everybody. Check `ungranted` too, and read
   * {@link catalogueKnown} before failing CI on `ok: false`.
   */
  ok: boolean;
  /**
   * True when the export carried at least one PLATFORM ADMIN, whose entry is
   * the project's entire catalogue (see `resolveExport`).
   *
   * When it is FALSE there is no catalogue in the answer at all: `exists` falls
   * back to `granted`, which is a LOWER BOUND, so `missingFromIdp` may name a
   * permission the IdP does have and `ungranted` is meaningless. `extraInIdp`
   * stays trustworthy either way — a key cannot be handed out without existing.
   *
   * ⚠ Platform admin is a GLOBAL flag, so in most deployments an export
   * contains one and this is simply true. Do not read it as a quality signal;
   * read it as "was a catalogue available".
   */
  catalogueKnown: boolean;
  /** Your `PERMISSIONS` constant, deduplicated and sorted. */
  expected: string[];
  /**
   * What the IdP's catalogue for this project CONTAINS, from the platform
   * admins in the export. Falls back to {@link granted} when there is none.
   */
  exists: string[];
  /**
   * What real assigned members actually HOLD — the union over non-admin
   * members, i.e. what the project's roles hand out. Empty when the project has
   * no ordinary members, which is itself worth a look.
   */
  granted: string[];
  /**
   * 🔴 THE SILENT UNDER-GRANT. Your code enforces these; the IdP's catalogue has
   * never heard of them, so nobody will ever hold one. This is the failure R14
   * documents.
   */
  missingFromIdp: string[];
  /**
   * 🔴 THE SAME DEAD FEATURE, ONE STEP LATER. The key exists in the IdP and no
   * role carries it, so every ordinary user is still denied. Meaningless when
   * {@link catalogueKnown} is false.
   */
  ungranted: string[];
  /**
   * The other direction, and it OVER-grants. The IdP's catalogue holds keys
   * this product does not declare — a stale seed, or an organization-level role
   * seeded as a project role, which is how `edc`'s `observer` reached a
   * live platform-admin token.
   */
  extraInIdp: string[];
  /** How many members the export carried. `0` is itself worth a hard look. */
  memberCount: number;
  /** How many of them were platform admins. */
  adminCount: number;
}

/**
 * Diff a product's own permission list against the IdP's catalogue and grants.
 *
 * Runs off ONE `GET /v1/identity/export` — nothing new is needed from the IdP.
 *
 * ```ts
 * import { PERMISSIONS } from '../rbac/permissions'
 *
 * const drift = await checkCatalogueDrift(PERMISSIONS, {
 *   project: 'edc',
 *   baseUrl: process.env.IDENTITY_URL!,
 *   serviceToken: process.env.IDENTITY_SERVICE_TOKEN!,
 * })
 * if (drift.catalogueKnown && (!drift.ok || drift.ungranted.length > 0)) {
 *   console.error('not seeded:', drift.missingFromIdp, 'on no role:', drift.ungranted)
 *   process.exit(1)
 * }
 * ```
 *
 * ⚠ RUN IT AGAINST THE ENVIRONMENT YOU CARE ABOUT, not against a file. R14's
 * second drift axis is the catalogue FILE versus a DEPLOYED DATABASE: the seed
 * only upserts, so editing `catalog.ts` changes nothing until someone runs it
 * somewhere. Measured on dev, the file said one key behind and the database was
 * three. Point `baseUrl` at the deployment.
 *
 * ⚠ A PRODUCT THAT EXPANDS ROLES LOCALLY WILL NOT FEEL THIS DRIFT, and should
 * still run the check. A product that expands the token's `roles` against its own
 * matrix never sees a missing IdP permission — but INTEGRATION.md tells consumers to read `perms` straight
 * off the token, and any consumer that does gets the silent under-grant.
 *
 * @throws {IdentityRequestError} on 404 — an unknown or deactivated project
 *   slug, which is a broken configuration, not an empty answer.
 * @throws {IdentityConfigError} on a missing `baseUrl` or `serviceToken`.
 */
export async function checkCatalogueDrift(
  expectedPermissions: Iterable<string>,
  options: CatalogueDriftOptions,
): Promise<CatalogueDrift> {
  const projectExport = options.export ?? (await resolveExport(options.project, options));

  const expected = sortedUnique(expectedPermissions);

  // ⚠ STRICT, via the single normaliser. This split decides which side answers
  // the EXISTENCE question, so a truthy read is not a shortcut — it is a wrong
  // answer. `resolveExport` narrows the flag on the way in, but `options.export`
  // hands us a body nobody narrowed, and an `isPlatformAdmin: 'yes'` there
  // promoted an ordinary member: its ROLE GRANT was then read as the project's
  // whole CATALOGUE, so `missingFromIdp` went quiet and `catalogueKnown` lied.
  const admins = projectExport.members.filter((m) => isPlatformAdminFlag(m.isPlatformAdmin));
  const assigned = projectExport.members.filter((m) => !isPlatformAdminFlag(m.isPlatformAdmin));
  const catalogueKnown = admins.length > 0;

  // A platform admin's entry is the CATALOGUE (existence). Everyone else's is a
  // ROLE GRANT (reachability). Mixing them answers neither question.
  const granted = sortedUnique(assigned.flatMap((member) => member.permissions));
  const exists = catalogueKnown
    ? sortedUnique(admins.flatMap((member) => member.permissions))
    : granted;

  const existsSet = new Set(exists);
  const grantedSet = new Set(granted);
  const expectedSet = new Set(expected);

  const missingFromIdp = expected.filter((slug) => !existsSet.has(slug));
  const ungranted = expected.filter((slug) => existsSet.has(slug) && !grantedSet.has(slug));
  const extraInIdp = exists.filter((slug) => !expectedSet.has(slug));

  return {
    project: projectExport.project,
    ok: missingFromIdp.length === 0,
    catalogueKnown,
    expected,
    exists,
    granted,
    missingFromIdp,
    ungranted,
    extraInIdp,
    memberCount: projectExport.members.length,
    adminCount: admins.length,
  };
}

function sortedUnique(values: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) out.add(value.trim());
  }
  return [...out].sort();
}
