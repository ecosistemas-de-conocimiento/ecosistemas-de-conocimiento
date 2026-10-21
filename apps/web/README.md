# @edc/web

The web frontend of **Ecosistemas de Conocimiento** — a multitenant content
repository with a knowledgebase. Users belong to an **ecosistema**: a group of
people who build a corpus together. A user only ever sees content from their own
ecosistema. They upload documents, chat over them with RAG, publish the
documents worth sharing, and rate the answers 1–5 stars.

One ecosistema is one organization — same frontend for everyone, different
content. The code keeps the identifiers (`org`, the `organizations` collection);
only the Spanish UI copy says *ecosistema*.

SvelteKit 5 + Tailwind. It is a **BFF**: the browser only ever talks to this
app's own `/api/**` routes, which proxy the backend and ai-service server-side.
No bearer token and no service URL ever reaches the browser.

## Where it sits

| Piece | What it is | This app talks to it via |
| --- | --- | --- |
| `apps/backend` | Next.js + Payload — identity **and** domain data (organizations, users, sessions, messages, documents, ratings) | `$lib/server/auth.ts` → `backendFetch`, with the user's JWT |
| `services/ai-service` | Fastify + pgvector RAG service (generation, retrieval, budget) | `$lib/server/aiService` → `getAIClient()`, with an app-role bearer |
| `packages/chat-engine` | `./core` (backend-agnostic turn assembly) + `./svelte` (component library) | imported directly |
| `packages/ai-client` | typed ai-service client | declared as a dependency but **currently imported by nothing**; this app uses its own server-only client in `$lib/server/aiService`. Kept for planned work. |

## What's in the UI

- **Ecosistema picker** — top of the sidebar, always visible. Which ecosistema
  you are in, and a chooser when you belong to more than one. See below.
- **Sessions sidebar** — create / select / rename / delete a chat.
- **Chat pane** — streaming turns (SSE), with a non-streaming fallback, cancel
  mid-stream, and citation cards on grounded answers.
- **Documents panel** — upload PDF/DOCX (20 MB cap) or write a markdown note;
  ingest status polls until it is `ready`. Pinned docs feed the next turn.
  Everything lands as a **draft** and shows its publication state (below).
- **`@`-mentions** — type `@` in the composer to cite the organization or one
  of the session's documents.
- **Answer rating** — 1–5 stars under every assistant answer. See below.
- **Sign-in** — Payload accounts, httpOnly cookie session. There is no public sign-up: a platform admin creates each account in the Payload admin panel (`/admin` on the backend) and adds it to an ecosistema. `/sign-up` redirects to `/sign-in` with a note saying who to ask.

## Which ecosistema am I in?

A user can belong to **more than one** ecosistema. The picker sits at the top of
the sidebar and is never hidden — the collapsed rail keeps a two-letter badge —
because whether a document is private or shared depends entirely on which
ecosistema it lands in. With exactly one membership there is no chooser, only
the name: a dropdown with one option teaches people to ignore the control that
matters on the day they have two.

| File | Role |
| --- | --- |
| `src/lib/ecosystems.ts` | the contract + every pure rule (resolve, validate, clear). No `$env`, no fetch — imported by both sides, unit-tested directly |
| `src/lib/server/ecosystem.ts` | the I/O half: list memberships, resolve the cookie, read a session's ecosistema |
| `src/routes/api/ecosistemas/+server.ts` | `GET` the list + resolved selection, `POST` to switch |
| `src/lib/components/EcosystemPicker.svelte` | the control (sidebar, expanded + collapsed) |
| `src/lib/components/NoEcosystem.svelte` | the zero-membership screen |
| `src/lib/stores/app.svelte.ts` | `switchEcosystem()` — clear, then re-hydrate |

**The choice lives in an httpOnly cookie** (`eco_selected`), not in
`localStorage` and not on the user record. It is an *input to a server decision*
— it picks the `organization` stamped on every new session, and therefore the
corpora that session searches — so it has to arrive on the request that uses it.
`localStorage` would put it on the wrong side of that boundary. A field on
`users` would mean a backend migration for what is genuinely a per-device
preference (two ecosistemas in two windows is a normal thing to want).

⚠ **The cookie is a hint, never an authority.** Every read runs it through
`resolveEcosystemSelection` against the membership list Payload just returned
for this JWT, so a forged or stale value can only ever select an ecosistema the
caller already belongs to — worst case it is ignored and rewritten. Three
independent checks stand behind a switch: the store refuses an id outside the
list it was given, the BFF `POST` answers **403 `not_a_member`**, and the backend
re-checks it in `Sessions.beforeValidate` on create. The frontend is never the
only guard.

⚠ **`GET /api/sessions` filters by the selected ecosistema.** Payload's access
rule is per *user*, so it returns conversations across every ecosistema someone
belongs to — correct for access, wrong for the screen.

🔴 **Switching clears everything the previous ecosistema put on screen** before
anything from the new one arrives: conversations, messages, documents and the
degraded banner. A stale document list under a new ecosistema's name is
indistinguishable, to the person looking at it, from a real cross-tenant leak.
Two mechanisms: `clearEcosystemScopedState()` blanks the state, and an **epoch
counter** makes any read still in flight for the old ecosistema discard its own
result when it lands. Adding a per-ecosistema field to the store means adding it
to `EcosystemScopedState` too — the test serialises a populated state and greps
it, so a forgotten field fails the build.

**Zero memberships is a real state**, not an error: `NoEcosystem.svelte` says
what it means and names the account to be added. It is shown only when we *know*
the list is empty — a failed read renders the degraded banner instead, because
telling someone with perfectly good access to go request access is worse than
saying nothing.

## Draft vs published documents

| State | Who sees it |
| --- | --- |
| `draft` | **only the person who uploaded it** — but they can already chat against it |
| `publishing` | still only the uploader; a slow re-index into the shared corpus is running |
| `published` | everyone in the ecosistema |
| `failed` | still only the uploader; the publish did not complete and can be retried |

The intended workflow is **upload → try it in chat → publish**. Everything about
this surface follows from two facts: a draft is private, and publishing is slow.

| File | Role |
| --- | --- |
| `src/lib/publication.ts` | the contract, the Spanish copy, and every pure rule |
| `src/lib/components/DocsPanel.svelte` | per-document state badge + publish/retry |
| `src/routes/api/documents/[id]/publish/+server.ts` | the BFF proxy |
| `src/lib/stores/app.svelte.ts` | `publishDoc()` + `pollPublication()` |
| `src/lib/components/Message.svelte` | marks citations that quote your own drafts |
| `src/lib/server/retrieval.ts` | corpus + `asOf` scoping (pure, tested) |
| `src/lib/server/corpora.ts` | reads `GET /api/sessions/:id/corpora` |

⚠ **Publishing is deliberately NOT optimistic**, unlike `rateMessage`. Optimism
suits a rating: cheap, instant, reversible, private. Publishing is slow, costs
tokens, and changes who else can see the document — painting "Publicado" before
the backend confirms would be a lie about visibility, and a user would act on it
by telling a colleague to go read something they cannot open. So the local state
only ever moves to what the server actually reported, and a failed request
changes nothing at all (there is nothing to roll back).

⚠ **An unknown or missing `publicationStatus` reads as `draft`.** The two ways
to be wrong are not symmetric: calling a published document private is a
harmless under-claim; calling a draft published tells someone their document is
shared when it is not.

⚠ **Every retrieve carries `asOf`.** Unpublishing a document does not delete
its chunks — it end-dates them. A retrieve without `asOf` still returns them, so
`$lib/server/retrieval` **fails closed**: no `asOf`, no retrieve at all. Corpus
names come from `GET /api/sessions/:id/corpora` and are never composed here; a
client that can compose a corpus name can address another ecosistema's.

⚠ **A cited draft is labelled in the citation card**, plus a one-line warning
above it. Without that, someone forwards an answer and sends a colleague after a
source they cannot open. A cited document we cannot find in the session's list
is left unlabelled rather than called published — retrieval can reach documents
outside the session, and we must not claim a visibility we cannot verify.
Two independent signals mark a draft: a server-side stamp on the provenance
chunk (exact, and it survives across sessions) and this session's own document
list (the fallback for older turns).

## Answer ratings

A rating is one row in the backend `ratings` collection: `message`, `session`,
`organization`, `user`, `stars` (1–5), optional `comment`. **One row per
(message, user)** — re-rating updates it rather than adding a second row.

| File | Role |
| --- | --- |
| `src/lib/ratings.ts` | pure helpers + the wire contract, in one place |
| `src/lib/primitives/StarRating.svelte` | the accessible input: ARIA radio group, roving tabindex, Down/Right + Up/Left + Home/End move focus, Space/Enter commits |
| `src/lib/components/MessageRating.svelte` | wires the input to the store |
| `src/lib/components/Message.svelte` | decides a turn is ratable — assistant only, settled, server id |
| `src/routes/api/sessions/[id]/ratings/+server.ts` | the BFF proxy: GET this user's ratings, POST an upsert |
| `src/lib/stores/app.svelte.ts` | `rateMessage()` — optimistic write, rollback + toast on failure |

The browser never sends `user` or `organization`: the backend derives both from
the authenticated request, so a client cannot write into another tenant. On
create the proxy also checks that the message really belongs to the session in
the URL, since that URL is what gets written into the row.

⚠ Arrow keys move focus but do NOT commit. Selection-follows-focus is the usual
radio-group behaviour, but here every selection is a network write: walking 1→5
would fire five writes, and each would lock the group and swallow the next key
press. Space or Enter commits.

## Run

```bash
cp .env.example .env    # then fill in AI_SERVICE_URL + AI_SERVICE_API_KEY
pnpm install            # from the REPO ROOT — this is a pnpm workspace
pnpm --filter @edc/web dev      # http://localhost:5173
```

The backend (`apps/backend`) and `services/ai-service` must be running, or
sign-in and generation fail. `BACKEND_URL` defaults to
`http://localhost:3002`; `AI_SERVICE_URL` has no default on purpose — this app
listens on :3000 itself, and a localhost fallback would loop it back to itself.

Every variable is documented in [`.env.example`](./.env.example).

## Scripts

```bash
pnpm --filter @edc/web check       # svelte-check
pnpm --filter @edc/web typecheck   # svelte-check, errors only
pnpm --filter @edc/web test        # vitest (node env, no DOM)
pnpm --filter @edc/web build       # adapter-node → ./build
```

Vitest runs `src/**/*.test.ts` under the **node** environment: BFF route
handlers and pure helpers, no component rendering.

⚠ Because there is no DOM here, a component's behaviour cannot be unit-tested.
The convention is to lift every rule and every load-bearing string into a plain
`$lib/` module that vitest CAN assert — see `$lib/nav.ts`, `$lib/publication.ts`,
`$lib/holds.ts`, `$lib/layout.ts`, `$lib/design/contrast.ts` — and to check
layout by screenshot. A claim about how something looks belongs to a screenshot,
never to this suite.

There **is** an e2e suite, in `e2e/` (Playwright, against a live stack). It is
separate from the command above; see `TESTING.md` at the repo root for how to
build its fixtures and run it.

## Docker

Both images build from the **repo root**, because `@edc/ai-client` and
`@edc/chat-engine` are `workspace:*` dependencies:

```bash
docker build -f apps/web/Dockerfile     -t edc-web     .   # production, :3000
docker build -f apps/web/Dockerfile.dev -t edc-web-dev .   # vite dev, :5173
```

There is no private registry and no install-time token — everything resolves
from the workspace or the public npm registry.

## Health checks

Two unauthenticated routes, short-circuited in `hooks.server.ts` before any auth
work:

- `GET /api/health` — **liveness**. Checks nothing downstream, on purpose. A
  liveness probe that checks a dependency turns a backend blip into a restart
  crash-loop.
- `GET /api/health/ready` — **readiness**. Proxies one level down to the
  backend's readiness route and redacts what it reports.

## Error handling, on purpose

- **Degrade** (`$lib/server/degrade.ts`) — a list read that 403s (Payload
  answers 403, not an empty list, for an empty tenant) or 5xxs becomes an empty
  list plus a `degraded` flag, which drives a dismissible banner. A 401 is never
  degraded: it is a real session expiry and redirects to sign-in.
- **Deny** (`$lib/server/deny.ts`) — genuine access gates throw a structured
  403/404 that `+error.svelte` renders with copy and an escape hatch.
- **Budget failures** — ai-service budget errors are rewritten to one canonical
  sentence before they reach the browser. Amounts, limits and tenant names are
  never leaked to a non-owner, and today that means everyone.

## Layout

```
src/
  lib/
    api.ts                client-side generate (sync + SSE stream)
    ecosystems.ts         ecosistema picker contract + pure rules
    publication.ts        draft/published contract, copy + pure rules
    ratings.ts            answer-rating contract + pure helpers
    types.ts              Message / Session / WorkingDoc
    components/           app-specific Svelte components
    primitives/           design-system parts (Button, Input, StarRating, …)
    engine/               client-safe chat-engine glue (kind registry, search)
    stores/app.svelte.ts  the runes store — all optimistic writes live here
    server/               SERVER-ONLY: auth, aiService client, engine wiring,
                          health, degrade/deny
  routes/
    api/                  the BFF: auth, ecosistemas, sessions, messages,
                          documents (+ publish), ratings, generate,
                          context-search, health
```

Anything under `src/lib/server/` is server-only by SvelteKit convention — the
build fails rather than shipping it to the browser. That is what keeps
`AI_SERVICE_API_KEY` and the user's JWT out of the client bundle.
