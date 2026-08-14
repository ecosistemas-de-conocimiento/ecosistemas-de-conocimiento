# @edc/identity-client

Consumer-side identity client. Three things: verify a token, ask what it
allows, and look up a grant when there is no token. One runtime dependency
(`jose`); everything else is the platform `fetch`.

**Who issues the tokens here.** In this repo there is no standalone identity
provider — `apps/backend` (Payload) *is* the identity provider. It mints the
EdDSA access tokens, publishes the JWKS, and serves the
`/v1/identity/resolve` + `/v1/identity/export` service endpoints. This package
is the verifying/consuming half of that contract, used by `apps/web` and by
backend code that needs to check a permission.

## Workspace package — not published

This is a **private workspace package**. It is never installed from a registry;
`pnpm` links it from `packages/identity-client`.

Depend on it as:

```json
"@edc/identity-client": "workspace:*"
```

### Build

`main`/`types`/`exports` point into `dist/`, which is **not** committed — the
package resolves to nothing until it has been built at least once:

```bash
pnpm --filter @edc/identity-client build   # tsc -> dist/
# or, from the repo root, build everything in dependency order:
pnpm build
```

Other scripts: `pnpm --filter @edc/identity-client typecheck`, `… test`
(vitest: pure helpers, a real Ed25519 keypair, a real local JWKS).

**Zero peerDependencies, deliberately.** This package is imported by both the
SvelteKit app and the Payload backend; a peer here would force one of them to
carry a dependency it does not otherwise need. Do not add one.

## Quick start

Verify the bearer token on an inbound request, then gate on a permission.

```ts
import {
  verifyIdentityToken,
  canInProject,
  IdentityTokenError,
} from '@edc/identity-client'

const PROJECT = 'edc' // your project slug — this is the token audience

export async function principalFromRequest(req: Request) {
  const bearer = req.headers.get('authorization')?.replace(/^Bearer /i, '')
  if (!bearer) return null

  try {
    return await verifyIdentityToken(bearer, {
      issuer: process.env.IDENTITY_ISSUER!,   // the apps/backend origin
      audience: PROJECT,
      // Root path, NOT under /api — see the note below.
      jwksUrl: process.env.IDENTITY_JWKS_URL!,
    })
  } catch (err) {
    if (err instanceof IdentityTokenError) {
      // `reason` is 'expired' | 'signature' | 'audience' | 'jwks' | ...
      // `isPermanent === false` means the issuer was unreachable, not that the
      // token was forged — back off, do not force a re-login.
      req.log?.warn({ reason: err.reason }, 'identity token rejected')
      return null
    }
    throw err
  }
}

// In a route handler:
const claims = await principalFromRequest(req)
if (!claims || !canInProject(claims, PROJECT, 'document:edit')) {
  return new Response('Forbidden', { status: 403 })
}
```

Server-to-server, where no user token exists (jobs, webhooks, backfills):

```ts
import { resolveGrant } from '@edc/identity-client'

const grant = await resolveGrant('ana@example.org', 'edc', {
  baseUrl: process.env.IDENTITY_URL!,
  serviceToken: process.env.IDENTITY_SERVICE_TOKEN!, // NEVER ship to a browser
})

if (!grant) { /* no access — unknown account, or no grant on this project */ }
else if (grant.permissions.includes('document:edit')) { /* … */ }
```

Seeding your own users table, in one call:

```ts
import { resolveExport } from '@edc/identity-client'

const { members } = await resolveExport('edc', {
  baseUrl: process.env.IDENTITY_URL!,
  serviceToken: process.env.IDENTITY_SERVICE_TOKEN!, // NEVER ship to a browser
})

for (const member of members) {
  // member.permissions is already flattened: roles + extras, unioned.
  await upsertLocalUserByEmail(member.email, { name: member.name })
}
```

⚠ **`resolveExport` throws on 404 where `resolveGrant` returns `null`.** The
difference is the point. For `resolve`, 404 means "this person has no access" —
a normal answer. For `export`, 404 means the project slug does not exist or is
deactivated — a broken configuration. A project that really has no members
answers `200` with `members: []`. A seed job that swallowed the 404 would write
nothing and report success.

### Two URL forms — the difference is deliberate

| Option | Value |
|---|---|
| `baseUrl` (for `resolveGrant` / `resolveExport`) | `<backend-origin>/api` — **with** `/api` |
| `jwksUrl` (for `verifyIdentityToken`) | `<backend-origin>/.well-known/jwks.json` — **without** `/api` |

The issuer is a Payload app, and Payload mounts custom endpoints under
`routes.api`, so `/v1/identity/*` really lives at `/api/v1/identity/*`. JWKS is
the one exception: it is served at the true root, because ADR-0001 pins that
URL and every verifier reads exactly it.

## Surface

| Export | What it does |
|---|---|
| `verifyIdentityToken(token, opts)` | Verifies signature, `iss`, `aud`, expiry and claim shapes. Returns `IdentityTokenClaims`, throws `IdentityTokenError`. |
| `can(principal, perm)` | Pure. Token → checks its own audience. Principal → true if held in **any** project, or platform admin. |
| `canInProject(principal, slug, perm)` | Pure. The check to use in a route handler. |
| `grantOf(principal, slug)` | Pure. Always returns a `ProjectGrant`, never `undefined`. |
| `hasRoleInProject` / `projectsOf` / `isPlatformAdmin` / `isTokenClaims` | Pure conveniences. |
| `resolveGrant(email, slug, opts)` | `GET /v1/identity/resolve`. Returns `ProjectGrant \| null` — `null` means "no access" (the endpoint 404s for both an unknown account and a known account with no grant). **Server-side only.** |
| `resolvePrincipal(email, slug, opts)` | Same call, returns the full `ResolvedPrincipal` (keeps `isPlatformAdmin`). |
| `resolveExport(slug, opts)` | `GET /v1/identity/export`. Every active member of one project, for seeding. Returns `ProjectExport`; **throws** `IdentityRequestError` on 404. **Server-side only.** |
| `clearJwksCache()` | Drops cached key sets. Tests and rotation drills only. |

Types: `IdentityTokenClaims`, `ResolvedPrincipal`, `ProjectGrant`, `Principal`,
`ProjectExport`, `ProjectMember`, `VerifyIdentityTokenOptions`,
`ResolveOptions`, `ResolveExportOptions`, `ServiceCallOptions`,
`TokenRejectionReason`.
Errors: `IdentityError`, `IdentityTokenError`, `IdentityRequestError`,
`IdentityConfigError`.
Constants: `IDENTITY_JWT_ALG`, `MAX_TOKEN_LIFETIME_SEC`, `SERVICE_TOKEN_HEADER`,
`EMPTY_GRANT`.

### What the issuer promises about an export

- **Deterministic.** `members` sorted by email; `roles` and `permissions`
  deduplicated and sorted. Two exports of unchanged data differ only in
  `exportedAt`, so re-running a seed is a no-op.
- **Flattened.** `permissions` is already roles-plus-extras, unioned. Never
  expand roles yourself.
- **Filtered.** Inactive users, inactive assignments and inactive projects are
  excluded — an export can never grant more than a live token would.
- **Platform admins included**, `isPlatformAdmin: true`, carrying the project's
  whole catalogue even with no assignment. That mirrors what `/resolve` answers
  for them, so a seed and a live lookup agree. It is a grant you do not own:
  revoking it happens at the issuer and your copy will not hear about it until
  the next export.
- **Rate-limited to 60/min per consumer.** It is a seeding call. For a single
  live decision, verify the user's token instead.

## What verification enforces

| Rule | Why |
|---|---|
| `alg` must be `EdDSA` | ADR-0001 §2 forbids HMAC. `alg: none` and `HS256` are rejected from the header, before any network call. |
| `iss` must match | A token from another issuer is not ours. |
| `aud` must match | Without this, a token minted for one project would unlock another. Confused-deputy bug. |
| `exp - iat` ≤ 900s | ADR-0001 caps access-token lifetime at 15 minutes. Override with `maxTokenLifetimeSec` only if the contract changes. |
| Claim shapes | A signed-but-malformed token fails loudly instead of granting `undefined` permissions. Missing `roles`/`perms` mean "none", not an error. |

JWKS is fetched once per URL and cached for an hour, process-wide. `jose`
refetches early — no more than once every 30s — when a token arrives with an
unseen `kid`, so a key rotation does not need a consumer redeploy.

## Rules that are easy to get wrong

- **A token grants only its `aud`.** `canInProject(token, 'other-project', …)`
  is always `false`, platform admin or not. Mint a second token instead.
- **Tokens carry no `isPlatformAdmin` flag.** The issuer flattens an admin's
  permissions into `perms` when it mints the token. Only `ResolvedPrincipal`
  carries the flag.
- **`can()` on a `ResolvedPrincipal` is platform-wide.** It answers "anywhere",
  which is almost never what a route handler means. Use `canInProject`.
- **The service token is not a user credential.** It authenticates *your
  service* to the whole resolve surface. Server-side environments only.
- **Permissions are already flattened.** Never expand roles yourself — that is
  how two consumers drift apart.
- **`resolveGrant` returns `null` on 404; `resolveExport` throws.** See above —
  the two 404s mean different things.
- **Your extra scoping axes stay in your own tables.** The identity model is
  project-scoped; join on email, and never store an issuer-side user id.
