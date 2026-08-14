# @edc/backend

The backend for **Ecosistemas de Conocimiento** — a multitenant content
repository with a knowledgebase. Organizations upload documents, their members
chat over those documents with retrieval-augmented answers, and every answer can
be rated 1-5 stars.

Payload 3 + Next.js 15, on Postgres.

**It is also the identity provider.** One app signs the tokens, publishes the
JWK Set peers verify them against, and owns the domain data. That is a merge of
two apps, and the reasoning behind what survived it is in
[`src/lib/permissions.ts`](src/lib/permissions.ts).

---

## The shape of it

```
apps/web  ──session cookie──▶  THIS APP  ──API key──▶  services/ai-service
(SvelteKit)                  (Payload 3)              (Fastify + pgvector)
                                  │                          │
                                  ◀────── HMAC callback ──────┘
```

- `apps/web` authenticates against `POST /api/users/login` and forwards the
  Payload token as `Authorization: JWT <token>` on every proxied call.
- This app enqueues document ingests with ai-service and receives signed
  callbacks when embedding finishes.
- `@edc/identity-client` verifies the tokens this app issues. Nothing consumes
  them yet — the surface exists, it is not load-bearing today.

## Collections

| Collection | One row is |
|---|---|
| `users` | a person. One account, many ecosistemas. Public sign-up. |
| `organizations` | **an ecosistema** — a group of people building one corpus. Its `slug` is the token audience. |
| `memberships` | a person's role in an ecosistema: `member` / `admin` / `owner`. |
| `teams`, `projects` | domain structure inside an ecosistema. Mentionable in chat. |
| `documents` | an uploaded PDF/DOCX or a markdown note, `draft` or `published`. |
| `media` | Payload's upload collection, behind `documents.mediaFile`. |
| `sessions` | one private conversation, inside one ecosistema. |
| `messages` | one turn — user, assistant or system. |
| `ratings` | **1-5 stars on one assistant answer, by one person.** |
| `aiServiceCallbacks` | webhook idempotency ledger. |

### Ecosistemas, drafts and the corpus layout

An **ecosistema** is a group of people who together build a corpus. An
`organizations` row *is* an ecosistema — one level of tenancy, no second
collection. A person only ever sees content in their own ecosistemas.

A document is either:

- **`draft`** — visible only to whoever uploaded it. They can chat against it,
  which is the point: upload → try it in chat → publish.
- **`published`** — part of the ecosistema's shared corpus, visible to every
  member.

Two corpus kinds at ai-service, and **isolation is by name, not by a filter**:

```
eco-{organizationId}                    the ecosistema's published corpus
eco-{organizationId}-draft-{userId}     one private draft corpus per person
```

⚠ ai-service resolves a corpus by `{org, project, name}` and a corpus that is
not yours is indistinguishable from one that does not exist — it 404s. So the
isolation is structural: there is no predicate to write, and therefore none to
write wrong. Do not collapse this into one corpus plus a metadata filter.

**A chat turn retrieves from both**, in one `POST /v1/retrieve/multi`. Ask the
backend for the names — never build them client-side:

```
GET /api/sessions/:id/corpora
→ { corpora: ["eco-10", "eco-10-draft-3"], published, draft, asOf }
```

**Publishing re-embeds.** `POST /api/documents/:id/publish` enqueues the
document into the shared corpus and returns `202`; the row sits in `publishing`
until ai-service calls back, and only then is the draft copy retired. Poll
`publicationStatus`, and show `publicationError` when it is set — that pair
means *retryable*, not *broken*. `POST /api/documents/:id/unpublish` is the
mirror, with the opposite ordering (stop sharing first, re-embed after).

### The role model

Three roles, on the membership. There is no editable permission catalogue: the
role → permission map is code (`ROLE_PERMISSIONS`).

| Role | Holds |
|---|---|
| `member` | `documents:read`, `documents:write`, `chat:use`, `ratings:write` |
| `admin` | the above + `documents:delete`, `members:manage` |
| `owner` | the above + `organization:manage` |

A `users.isPlatformAdmin` account is an owner of every active organization.

**Deactivation is the revoke switch, at three levels** — `users.isActive`,
`memberships.isActive`, `organizations.isActive`. Any one of them false and the
grant resolves to nothing.

## The identity surface

| Route | Who may call it | Returns |
|---|---|---|
| `GET /.well-known/jwks.json` | anyone | the Ed25519 public key, cacheable 1h |
| `GET /api/v1/identity/me` | a signed-in user | their profile + every organization they can reach |
| `POST /api/v1/identity/token` | a signed-in user | a ≤15-minute token for ONE organization |
| `GET /api/v1/identity/resolve` | a service with `X-Service-Token` | one person's roles in one organization |

⚠ **JWKS is served at the root path**, not under `/api`. A rewrite in
`next.config.ts` does that, and it is load-bearing — every verifier fetches
exactly that URL.

⚠ **A token's `aud` is an organization slug**, not a service name. That is what
makes the audience check worth doing: a token minted for one customer cannot be
replayed against another's data.

## Running it

Requires Node 22+, pnpm, Docker.

```bash
cp apps/backend/.env.example apps/backend/.env
# then, at minimum, set SEED_ADMIN_PASSWORD and generate a keypair:
pnpm --filter @edc/backend keygen        # prints AUTH_PRIVATE_KEY / AUTH_PUBLIC_KEY

pnpm install                             # from the repo root
pnpm --filter @edc/backend docker:up     # Postgres 16 on host port 5433
pnpm dev:backend                         # http://localhost:3002
```

Check it:

```bash
curl -i http://localhost:3002/api/health              # 200 {"status":"ok"}
curl -i http://localhost:3002/api/health/ready        # 200, or 503 with which dep is down
curl -s http://localhost:3002/.well-known/jwks.json   # your public key
open http://localhost:3002/admin
```

### Two things that will bite you on a first run

**An empty database with no demo content is the gate working.** Demo seeding is
allow-listed on `EDC_ENV` and fails closed. Set `EDC_ENV=local`.

**No admin is created unless `SEED_ADMIN_PASSWORD` is set.** There is
deliberately no default password anywhere — this app holds the token signing
key. With it unset the seed skips and logs why; create the first user through
`/admin` instead.

### Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Next dev server on :3002 |
| `pnpm test` | vitest |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm keygen` | print a fresh Ed25519 signing keypair |
| `pnpm seed:demo` | seed the demo organization by hand (local/dev/demo-0 only) |
| `pnpm generate:types` | regenerate `src/payload-types.ts` |
| `pnpm migrate:create` | create a migration — read `src/migrations/README.md` first |
| `pnpm docker:reset` | drop the database volume and start clean |

## Rating an answer

`POST /api/ratings/upsert` with the user's session:

```json
{ "message": 123, "stars": 4, "comment": "clear, but missed the annex" }
```

One rating per (message, user) — re-rating updates the existing row. Payload's
generated REST also works (`GET`/`POST`/`PATCH /api/ratings`); the `upsert`
route exists because "find, then POST or PATCH" is two round trips and a race.

The server derives `session`, `organization` and `user` itself and refuses
anything that is not an assistant answer in your own conversation. See
[`src/collections/Ratings.ts`](src/collections/Ratings.ts).

## Things to know before changing something

**Tenant isolation is this app's job, not ai-service's.** ai-service reads its
`{org, project}` from a boot-time API-key map, so every ecosistema reaches it
under one key. The only thing separating them there is the corpus name, and
[`src/lib/corpus.ts`](src/lib/corpus.ts) is the single place one is derived. A
corpus name must never come from a request body.

⚠ **Budget is keyed on `org` alone at ai-service**, so all ecosistemas share one
spend cap and one of them can exhaust it for the rest.

**Retirement is a validity window, not a delete.** `@edc/ai-client` has no
per-document corpus delete, so promoting a document out of drafts stamps
`validTo = now`. Every retrieve must therefore pass `asOf` — the corpora
endpoint hands you one. A retrieve without it can still return retired
documents.

**The baseline migration exists, and four of its indexes are hand-written.**
Migrations create the schema in *every* environment now, the laptop demo
included — both container entrypoints run `payload migrate` first. Schema push
is opt-in (`PAYLOAD_ALLOW_PUSH=1`) and off everywhere by default. Three of those
hand-written indexes are compound UNIQUE constraints that Payload's field config
cannot express, and they are the only real lock behind de-duplication that is
otherwise done in `beforeValidate` hooks. Push does not know about them and
removes them without erroring, after which the ratings table quietly accepts
duplicate rows and every average over it is wrong. That is why the gate is
opt-in rather than opt-out: one forgotten variable should not be able to lose
those locks silently.
[`src/migrations/README.md`](src/migrations/README.md) has the list and the
reasoning.

**The rate limiter is in-process.** N replicas allow N× every published limit.

**A token cannot be revoked.** Deactivating someone stops the *next* token, not
the one in their hand. The ≤15-minute lifetime is the revocation delay.

**Deleting a document does not remove its chunks.** There is no per-document
corpus delete; for a published document that means the assistant can keep
quoting something the UI no longer shows. Not yet wired — see the note on
`Documents.hooks`.
