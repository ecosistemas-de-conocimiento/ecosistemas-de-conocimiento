# @edc/identity-client

Consumer-side identity client. Four things: run a human's **session** (sign
in, keep it alive, sign out), verify a token, ask what it allows, and look up a
grant when there is no token. One runtime dependency (`jose`), used only by the
verifier; everything else is the platform `fetch`.

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
  canInAudience,
  IdentityTokenError,
} from '@edc/identity-client'

const AUDIENCE = 'edc' // your audience slug — the token's `aud`

export async function principalFromRequest(req: Request) {
  const bearer = req.headers.get('authorization')?.replace(/^Bearer /i, '')
  if (!bearer) return null

  try {
    return await verifyIdentityToken(bearer, {
      issuer: process.env.IDENTITY_ISSUER!,   // the apps/backend origin
      audience: AUDIENCE,
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
if (!claims || !canInAudience(claims, AUDIENCE, 'document:edit')) {
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
| `baseUrl` (for `resolveGrant` / `resolveExport`, and the first argument to every session helper) | `<backend-origin>/api` — **with** `/api` |
| `jwksUrl` (for `verifyIdentityToken`) | `<backend-origin>/.well-known/jwks.json` — **without** `/api` |

The issuer is a Payload app, and Payload mounts custom endpoints under
`routes.api`, so `/v1/identity/*` really lives at `/api/v1/identity/*`. JWKS is
the one exception: it is served at the true root, because ADR-0001 pins that
URL and every verifier reads exactly it.

## Sessions — signing a human in

Three calls for a consumer's **BFF** (the server half of your app — a Next route
handler, an Express router, a SvelteKit endpoint). They take **no service
token**: the credential is the user's password, or their refresh ticket in the
request body.

```
loginWithPassword  → POST /v1/identity/login    password in, refresh ticket out
refreshSession     → POST /v1/identity/refresh  ticket in, NEW ticket out (+ a
                                                ≤900s project token, on request)
revokeSession      → POST /v1/identity/revoke   sign out; idempotent, always 204
```

### ⚠ Every refresh returns a NEW ticket, and the old one is dead

**There is no non-rotating refresh in this system.** Every `200` from
`refreshSession` carries a `refreshToken` you have never seen before, and the
one you sent stops working the instant the call succeeds.

- **Rewrite the cookie on every single call.** Not on login only. Not "when it
  changes" — it always changes.
- **Persist it before you do anything else with the result.** An early `return`,
  a thrown render, a cookie write behind an `if` — any of those and the user is
  logged out with no way back but a password.
- **Reusing a spent ticket is treated as theft.** The IdP cannot tell a thief
  from a consumer that failed to save, so it assumes the worse one: it revokes
  the **entire chain**. Every tab, every product, everyone signed in from that
  login — gone. This is the one mistake a consumer makes silently.

### Signing in

```ts
import { loginWithPassword, IdentitySessionError } from '@edc/identity-client'

const IDENTITY_URL = process.env.IDENTITY_URL! // https://identity.dev.example.org/api

export async function POST(req: Request) {
  const { email, password } = await req.json()

  try {
    const session = await loginWithPassword(
      IDENTITY_URL,
      { email, password },
      { client: 'chat' },          // shows up in the user's session list
    )

    // httpOnly: the browser's own JavaScript must never read this value.
    setCookie('fleet_session', session.refreshToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      expires: new Date(session.expiresAt),
    })
    return Response.json({ user: session.user })
  } catch (err) {
    if (err instanceof IdentitySessionError) {
      if (err.reason === 'account_inactive') {
        // Correct password, deactivated account. Say so — sending them back to
        // the login form is an infinite loop.
        return Response.json({ error: 'account-deactivated' }, { status: 403 })
      }
      return Response.json({ error: 'invalid-credentials' }, { status: 401 })
    }
    throw err
  }
}
```

⚠ **`invalid_credentials` covers three different failures on purpose** — wrong
password, unknown account, and locked out. Show the user one message. Do not
offer a password reset link only for addresses that exist; that leaks exactly
the bit the single message is hiding.

### Forwarding the end-user IP — `forwardedFor` (optional)

Your BFF terminates the browser's connection, so from the IdP's side every one
of your users shares **one** IP: your server's. The IdP's per-IP rate-limit
buckets (login and refresh) would then treat your whole user base as a single
client. Pass the end user's real IP as `forwardedFor` and the client forwards it
as `X-Forwarded-For`, so those buckets count the actual person:

```ts
await loginWithPassword(
  IDENTITY_URL,
  { email, password },
  { client: 'chat', forwardedFor: clientIpFromRequest(req) },
)
// same option on refreshSession(...) and revokeSession(...)
```

- **Optional and additive.** Omit it and nothing changes — no header is sent, and
  every existing caller behaves exactly as before.
- **The value is trimmed; a blank one is dropped.**

#### 🔴 Do NOT set `IDENTITY_TRUSTED_PROXY_HOPS=2` for this

**An earlier version of this page told operators to.** That instruction was
wrong, and following it disables every per-IP limit the IdP has — including the
cap on service-token brute force. **The default of `1` is correct in every
EDC environment. Leave it unset.**

**What the setting actually counts.** `IDENTITY_TRUSTED_PROXY_HOPS` is the
number of **trusted proxies that sit in front of the IdP on the path of every
request**. The IdP reads `X-Forwarded-For` from the **right** and steps that
many entries left (`src/endpoints/http.ts`, `clientIp`). One trusted proxy —
Coolify's Traefik — means `1`, which is the default.

**Why your BFF is not a hop, even though it forwards the header.** Two separate
reasons, and either one alone is enough:

1. **It is not on everyone's path.** A proxy hop is only trustworthy because
   *nothing can reach the IdP without passing through it*. Your BFF is an
   ordinary HTTP client of the IdP; anyone else on the internet reaches Traefik
   directly. Raising the count to `2` makes the IdP trust the second-from-right
   entry on **every** request, so an attacker sends
   `X-Forwarded-For: <anything>` and picks their own bucket key — a fresh
   rate-limit budget per request, plus the ability to burn someone else's
   bucket by naming their address. The code header calls this a **"SILENT,
   TOTAL BYPASS"** and it is not an overstatement: nothing fails, nothing logs
   an error, the limits simply stop existing.
2. **It replaces the header rather than appending to it.** A real proxy appends
   its upstream and so adds exactly one trustworthy entry from the right. This
   client sets `X-Forwarded-For` to the single value you pass
   (`src/session.ts`), which is not the same shape and does not make the list
   one entry longer in the way the count assumes.

**When `2` would ever be right:** only if a *second* proxy were added in front
of Traefik that every request must traverse — a CDN, or an L7 load balancer that
appends `X-Forwarded-For`.

⚠ **So what does `forwardedFor` buy you right now?** Less than it seems, and you
should know that before wiring it. A Traefik with no `forwardedHeaders.trustedIPs`
**overwrites** an incoming `X-Forwarded-For` with the connecting address instead
of appending to it. In that setup the value you send is
replaced by your BFF's egress IP before the IdP ever sees it, and the IdP buckets
your whole user base together regardless. That is a real, separately-tracked
finding on the IdP side (audit A29), not something this client can fix, and it is
**not** a reason to raise the hop count. Sending `forwardedFor` remains harmless
and correct — it is what will start working the moment the IdP side is fixed —
but do not treat it as a live control until someone re-measures the header the
IdP actually receives.

### Keeping it alive, and getting a product token

```ts
import { refreshSession, IdentitySessionError } from '@edc/identity-client'

export async function withProjectToken(req: Request) {
  const presented = readCookie(req, 'fleet_session')
  if (!presented) return redirectToLogin()

  try {
    const next = await refreshSession(IDENTITY_URL, {
      refreshToken: presented,
      audience: 'chat',            // omit to keep the session warm and mint nothing
    })

    setSessionCookie(next.refreshToken, next.expiresAt)   // ⚠ ALWAYS. First. Every time.

    return fetch(upstream, {
      headers: { Authorization: `${next.tokenType} ${next.token}` },
    })
  } catch (err) {
    if (err instanceof IdentitySessionError) {
      if (err.refreshTokenIsDead)   return clearCookieAndRedirectToLogin()
      if (err.refreshTokenSurvived) return new Response('Forbidden', { status: 403 })
      return new Response('Identity provider unavailable', { status: 503 })
    }
    throw err
  }
}
```

### ⚠ `401` and `403` mean opposite things here

This is the mistake that costs a fleet its sessions.

| The IdP says | `reason` | What it means | What you do |
|---|---|---|---|
| **401** | `session_expired` | The **ticket is dead** — unknown, revoked, expired, already rotated, or the account was deactivated. The IdP will not say which. | Clear the cookie. Login form. |
| **403** | `project_access_denied` | The **ticket is fine.** This user holds no assignment on that one project. | **Keep the cookie.** Return 403. |
| **404** | `unknown_project` | The **ticket is fine.** That project slug is unknown or inactive. (A `baseUrl` missing its `/api` suffix 404s identically — check the URL first.) | **Keep the cookie.** Fix the config. |
| **503** | `token_signing_unavailable` | The **ticket is fine.** The IdP has no signing key; nobody gets a token. | **Keep the cookie.** Back off, page an operator. |

The IdP mints the access token **before** it rotates the ticket precisely so the
403 can be given without ending the session. A consumer that clears the cookie on
any `4xx` signs a person out of every product in the fleet because one project
assignment was missing.

Branch on the getters, never on `status >= 400`:

| Getter | True when |
|---|---|
| `refreshTokenIsDead` | refresh + `session_expired` or `response_unusable`. **Delete the cookie.** |
| `refreshTokenSurvived` | refresh + `project_access_denied`, `unknown_project`, `token_signing_unavailable`, `malformed_request`, `rate_limited`. **Keep the cookie.** |
| `mustReauthenticate` | `invalid_credentials`, or anything `refreshTokenIsDead` covers. Deliberately **false** for `account_inactive`. |
| `isTransient` | `status` is 0, 429, or ≥ 500. The IdP or the wire failed, not the credential. |

⚠ **They are not opposites.** Both are `false` for `unreachable` and for a `500`
on a refresh, and that gap is honest: the request may have reached the IdP and
rotated before the wire broke. Keep the cookie, retry **at most once**, and treat
a `401` on that retry as an ordinary logout rather than a bug.

### Signing out

```ts
import { revokeSession } from '@edc/identity-client'

clearCookie('fleet_session')                                  // first
await revokeSession(IDENTITY_URL, { refreshToken: presented })
  .catch((err) => log.warn({ err }, 'revoke failed; user is signed out locally anyway'))
```

Clear your own cookie **before** the call. The browser must end up signed out
whatever the network does — a logout stuck on a failed round trip is worse than
one that leaves a ticket alive for its remaining minutes.

`revokeSession` resolves for a live ticket, an already-revoked one, and one that
never existed: all three answer `204` and are indistinguishable on purpose, so
the endpoint cannot be used to sort real ticket values out of a list of guesses.
It still throws on `malformed_request` (400), `rate_limited` (429) and
`unreachable` — those describe *your call*, not any ticket.

### Where a refresh ticket may live

- **httpOnly, `Secure`, `SameSite` cookie. Nowhere else.** A ticket is a
  long-lived credential for the user's whole fleet session — 14 days by default,
  and the IdP's `expiresAt` is the only value to size the cookie from. If it
  reaches page JavaScript, one XSS is a fortnight of impersonation across every
  product.
- **Never in a log.** `IdentitySessionError` stores no response body and redacts
  any credential the IdP echoed back before it reaches `message` — an error
  object is the thing that gets piped into a log aggregator. A test asserts it.
- **Never in a URL.** These helpers always send it in the JSON body. A ticket in
  a query string lands in the proxy's access log, the browser's history, and
  every `Referer` header the page sends afterwards.
- **Never in client-side state.** Not localStorage, not a JWT you sign yourself,
  not a hidden form field.

## Surface

| Export | What it does |
|---|---|
| `loginWithPassword(baseUrl, { email, password }, opts?)` | `POST /v1/identity/login`. Returns `IdentitySession`. **Server-side only.** |
| `refreshSession(baseUrl, { refreshToken, audience? }, opts?)` | `POST /v1/identity/refresh`. Returns `RefreshedSession` — **always a new ticket**, plus an access token when `audience` was sent. **Server-side only.** |
| `revokeSession(baseUrl, { refreshToken }, opts?)` | `POST /v1/identity/revoke`. Resolves for any ticket the IdP accepts the shape of. **Server-side only.** |
| `verifyIdentityToken(token, opts)` | Verifies signature, `iss`, `aud`, expiry and claim shapes. Returns `IdentityTokenClaims`, throws `IdentityTokenError`. |
| `can(principal, perm)` | Pure. Token → checks its own audience. Principal → true if held in **any** project, or platform admin. |
| `canInAudience(principal, slug, perm)` | Pure. The check to use in a route handler. `canInProject` is the same function under its older name (0.4.0). |
| `grantOf(principal, slug)` | Pure. Always returns a `ProjectGrant`, never `undefined`. |
| `hasRoleInProject` / `projectsOf` / `isPlatformAdmin` / `isTokenClaims` | Pure conveniences. |
| `resolveGrant(email, slug, opts)` | `GET /v1/identity/resolve`. Returns `ProjectGrant \| null` — `null` means "no access" (the endpoint 404s for both an unknown account and a known account with no grant). **Server-side only.** |
| `resolvePrincipal(email, slug, opts)` | Same call, returns the full `ResolvedPrincipal` (keeps `isPlatformAdmin`). |
| `resolveExport(slug, opts)` | `GET /v1/identity/export`. Every active member of one project, for seeding. Returns `ProjectExport`; **throws** `IdentityRequestError` on 404. **Server-side only.** |
| `createIdentitySession({ baseUrl, audience, store, ... })` | The **stateful** layer over the three session calls: rotate → persist → classify `dead`/`survived`/`unavailable`, single-flight per ticket. **Server-side only.** |
| `checkCatalogueDrift(expected, { project, ... })` | One `resolveExport` call, diffed against the product's own permission list. See below. |
| `resetIdentitySessionState()` | Drops every in-flight refresh and spent-ticket memo. Tests only. |
| `clearJwksCache()` | Drops cached key sets. Tests and rotation drills only. |

Types: `IdentityTokenClaims`, `ResolvedPrincipal`, `ProjectGrant`, `Principal`,
`ProjectExport`, `ProjectMember`, `IdentitySession`, `IdentitySessionUser`,
`RefreshedSession` (= `RotatedSession | RotatedSessionWithToken`),
`VerifyIdentityTokenOptions`, `ResolveOptions`, `ResolveExportOptions`,
`SessionOptions`, `ServiceCallOptions`, `HttpCallOptions`,
`TokenRejectionReason`, `IdentitySessionFailureReason`,
`IdentitySessionOperation`.
Errors: `IdentityError`, `IdentityTokenError`, `IdentityRequestError`,
`IdentitySessionError`, `IdentityConfigError`.
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

## `createIdentitySession` — the session lifecycle, not just the calls

The three calls above are stateless and map 1:1 onto three endpoints. Every BFF
then wrote the same layer on top of them by hand. `createIdentitySession` **is**
that layer, and it exists because three of its rules are impossible to get right
by remembering:

1. **Rotate → persist, in that order, on every 200.** The presented ticket dies
   the instant `/refresh` returns. The successor is written through your `store`
   *before* the result reaches you — including on a 200 that minted no access
   token, which still spent the ticket.
2. **401 ends the session; 403 does not.** The verdict is `dead` (store cleared
   for you **and the memo chain purged**, exactly as `end()` purges it — since
   0.3.1; on 0.3.0 the memo survived and a straggler could be re-authenticated)
   / `survived` (this user holds nothing on this project — answer 403,
   touch nothing) / `unavailable` (the IdP could not answer; the ticket's fate is
   unknown — touch nothing, answer 503, retry is fine) / `misconfigured` (400:
   the ticket is fine and **retrying never helps** — almost always a `project`
   the IdP will not accept as an audience).
3. **Single-flight per ticket, plus a spent-ticket memo.** The IdP treats two
   concurrent rotations of one ticket as **theft** and revokes the whole chain.
   Serializing is the consumer's job. The memo covers the case the flight cannot:
   a request the browser dispatched before the rotated `Set-Cookie` landed, which
   arrives seconds later still carrying the spent ticket.

```ts
const session = createIdentitySession({
  baseUrl: process.env.IDENTITY_URL!,   // WITH the /api
  audience: 'chat',                     // the `aud` of every token minted
  store: {
    saveTicket: (t) => cookies.set('chat_idp', t.refreshToken, cookieOptions(t.maxAge)),
    saveToken:  (t) => cookies.set('chat_auth', t.token, cookieOptions(t.maxAge)),
    clear:      () => { cookies.delete('chat_idp'); cookies.delete('chat_auth') },
  },
  forwardedFor: event.getClientAddress(),
})

const result = await session.renew(cookies.get('chat_idp'))
// cookies are already written; branch only on the verdict
if (!result.ok && result.kind === 'unavailable') return error(503)
```

⚠ **Create one manager per request** — the store is a cookie jar. The
single-flight and memo state is module-level and shared by every manager built
against the same `(baseUrl, audience)` pair, which is what makes it work. The
audience is part of the key because a memo entry holds an access token scoped to
one audience.

⚠ **`project` is the deprecated name of `audience`** (0.4.0). It still works.
Set both only while switching env vars: equal slugs are accepted, different
slugs throw `IdentityConfigError` at construction. A blank `audience` counts as
unset.

⚠ **`end()` is the interlock, not just a revoke.** It clears the store, then
purges the memo chain in **both** directions and marks every ticket it reaches
as ended for the memo window. A rotation already in the air when the sign-out
lands settles into `dead` and is never persisted — otherwise its awaiter, which
holds its own cookie jar that `end()` cannot reach, would write a live session
into a signed-out browser.

⚠ `memoMs` and `memoMax` are per-manager options over that shared map: an entry
carries the window of whoever wrote it. A BFF builds every manager from one
config, so they agree; vary them only in tests.

⚠ **One process only.** A plain `Map` is enough because `adapter-node` runs a
single process. A multi-replica BFF needs shared state, and that has to be
designed — two replicas rotating one ticket is the theft signal above.

## `checkCatalogueDrift` — is the IdP behind your product?

A product adds a permission its code enforces, nobody adds it to the IdP's
catalogue, so no role carries it, so no token carries it, and the feature is
dead for everyone who should have had it. Nothing errors: absent means denied.
The IdP's own seed-time drift check cannot see this — a key it never had leaves
no row to notice. Only the consumer can.

It answers **two** questions, and conflating them hides the second:

| | Read from | Failure it names |
|---|---|---|
| `exists` | a **platform admin**'s export entry = the project's whole catalogue | `missingFromIdp` — the IdP never heard of the key |
| `granted` | the **non-admin** members = what roles actually hand out | `ungranted` — the key exists but sits on no role, so everyone is still denied |

```ts
const drift = await checkCatalogueDrift(PERMISSIONS, {
  project: 'edc',
  baseUrl: process.env.IDENTITY_URL!,
  serviceToken: process.env.IDENTITY_SERVICE_TOKEN!,
})
if (drift.catalogueKnown && (!drift.ok || drift.ungranted.length > 0)) {
  throw new Error(`not seeded: ${drift.missingFromIdp} · on no role: ${drift.ungranted}`)
}
```

⚠ **Gate on `catalogueKnown`.** With no platform admin in the export there is no
catalogue in the answer at all: `exists` falls back to `granted`, so
`missingFromIdp` can name a permission that does exist and `ungranted` is
meaningless. Platform admin is a fleet-wide flag, so in most deployments this is
simply true — read it as "was a catalogue available", not as a quality signal.
`extraInIdp` is trustworthy either way.

⚠ **Point `baseUrl` at the environment you care about, not at a file.** The seed
only upserts, so editing the IdP's `catalog.ts` changes nothing until someone
runs it somewhere. Measured on dev: the file was one key behind its product and
the database was three.

This is a **check, not a sync.** Two-way sync between a TS constant and a
database is deliberately not built (identity `OPEN.md` R14).

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

- **Every refresh rotates.** Persist the new `refreshToken` on every `200`, or
  you have logged your user out and armed the theft detector. See above.
- **`refreshTokenIsDead` is the only reason to clear a session cookie.** Not
  `status >= 400`, not `!res.ok`, not `catch (err) { logout() }`.
- **A refresh ticket is not an access token.** It opens no product. Trade it for
  a project token with `audience`, then verify *that* token downstream.
- **A token grants only its `aud`.** `canInAudience(token, 'other-project', …)`
  is always `false`, platform admin or not. Mint a second token instead.
- **Tokens carry no `isPlatformAdmin` flag.** The issuer flattens an admin's
  permissions into `perms` when it mints the token. Only `ResolvedPrincipal`
  carries the flag.
- **`can()` on a `ResolvedPrincipal` is platform-wide.** It answers "anywhere",
  which is almost never what a route handler means. Use `canInAudience`.
- **The service token is not a user credential.** It authenticates *your
  service* to the whole resolve surface. Server-side environments only.
- **Permissions are already flattened.** Never expand roles yourself — that is
  how two consumers drift apart.
- **`resolveGrant` returns `null` on 404; `resolveExport` throws.** See above —
  the two 404s mean different things.
- **Your extra scoping axes stay in your own tables.** The identity model is
  project-scoped and does not model organizations, workspaces or tenants, by
  decision. Join on email; never store an issuer-side user id (it never emits one).
