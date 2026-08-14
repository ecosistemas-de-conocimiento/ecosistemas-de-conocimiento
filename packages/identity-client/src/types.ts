// Wire types for @edc/identity-client.
//
// These mirror the identity provider's HTTP contract exactly. If a field is
// not listed here, the IdP does not promise it. Do not widen these types
// speculatively — a claim the IdP does not sign is a claim you cannot trust.

/** What one user is allowed to do inside ONE project. */
export interface ProjectGrant {
  /** Role slugs held in this project, e.g. `['facilitador']`. */
  roles: string[];
  /**
   * Effective permission slugs in this project — the union of every role's
   * permissions plus the assignment's `extraPermissions`. Already flattened
   * by the IdP; consumers never expand roles themselves.
   */
  permissions: string[];
}

/**
 * A user's full platform-wide standing, as returned by `GET /v1/identity/me` and
 * `GET /v1/identity/resolve`.
 *
 * `projects` is keyed by **project slug** (`edc`, `chat`,
 * `ai-service`). A project the user has no assignment in is simply absent —
 * it is never present with empty arrays.
 */
export interface ResolvedPrincipal {
  /** Lowercased, trimmed. The cross-product join key (ADR-0001 §1). */
  email: string;
  name: string | null;
  /** Platform admins implicitly hold every permission in every project. */
  isPlatformAdmin: boolean;
  projects: Record<string, ProjectGrant>;
}

/**
 * One person in a bulk project export (`GET /v1/identity/export`).
 *
 * There is no id — email is the join key (ADR-0001 §1), and internal ids never
 * cross a service boundary in either direction.
 */
export interface ProjectMember {
  /** Lowercased, trimmed. Find-or-create your local row on this. */
  email: string;
  name: string | null;
  /**
   * True when this person reaches the project as a PLATFORM admin rather than
   * through an assignment, in which case `roles`/`permissions` are the
   * project's entire catalogue.
   *
   * ⚠ It is a grant you do not own. Revoking it happens in the IdP, and your
   * copy will not hear about it until the next export. Decide deliberately
   * whether to mirror it locally or to re-check it live.
   */
  isPlatformAdmin: boolean;
  roles: string[];
  /** Already flattened — roles plus extras, unioned, deduplicated, sorted. */
  permissions: string[];
}

/**
 * The body of `GET /v1/identity/export?project=<slug>`.
 *
 * `members` is sorted by email and every array inside it is deduplicated and
 * sorted, so two exports of unchanged data are byte-identical apart from
 * `exportedAt`. That is what makes a consumer's seed stable across runs.
 */
export interface ProjectExport {
  /** Echoed project slug, normalized by the IdP. */
  project: string;
  /** ISO-8601. A snapshot instant, not a cache key — the data is `no-store`. */
  exportedAt: string;
  members: ProjectMember[];
}

/**
 * Claims carried by an access token from `POST /v1/identity/token`.
 *
 * A token is scoped to exactly ONE project: `aud` names it, and `roles`/`perms`
 * describe the holder's standing **in that project only**. There is no
 * platform-wide token.
 */
export interface IdentityTokenClaims {
  /** Token issuer, e.g. `https://backend.example.org`. */
  iss: string;
  /** Subject — always the user's email (ADR-0001 §1). */
  sub: string;
  /** Audience — the project slug this token is scoped to. */
  aud: string;
  email: string;
  name?: string;
  iat: number;
  exp: number;
  /** Role slugs in `aud`'s project. */
  roles: string[];
  /** Effective permission slugs in `aud`'s project (roles + extras, flattened). */
  perms: string[];
  /** Key id of the signing key, echoed from the JWT header for convenience. */
  kid?: string;
}

/**
 * Anything the permission helpers can reason about: a verified single-project
 * token, or a platform-wide resolved principal.
 */
export type Principal = IdentityTokenClaims | ResolvedPrincipal;

/** Empty grant. Returned instead of `undefined` so callers can always read `.permissions`. */
export const EMPTY_GRANT: ProjectGrant = Object.freeze({
  roles: Object.freeze([]) as unknown as string[],
  permissions: Object.freeze([]) as unknown as string[],
});

/** The only signature algorithm this platform accepts. ADR-0001 §2 forbids HMAC. */
export const IDENTITY_JWT_ALG = 'EdDSA' as const;

/** ADR-0001 §2 caps access-token lifetime at 15 minutes. */
export const MAX_TOKEN_LIFETIME_SEC = 900;

/** Header the IdP checks on `GET /v1/identity/resolve`. */
export const SERVICE_TOKEN_HEADER = 'X-Service-Token';
