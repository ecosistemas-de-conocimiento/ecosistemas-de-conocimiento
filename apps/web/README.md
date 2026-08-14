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

- **Sessions sidebar** — create / select / rename / delete a chat.
- **Chat pane** — streaming turns (SSE), with a non-streaming fallback, cancel
  mid-stream, and citation cards on grounded answers.
- **Documents panel** — upload PDF/DOCX (20 MB cap) or write a markdown note;
  ingest status polls until it is `ready`. Pinned docs feed the next turn.
  Everything lands as a **draft** and shows its publication state (below).
- **`@`-mentions** — type `@` in the composer to cite the organization or one
  of the session's documents.
- **Answer rating** — 1–5 stars under every assistant answer. See below.
- **Sign-in / sign-up** — Payload accounts, httpOnly cookie session.

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
handlers and pure helpers, no component rendering. There is no e2e suite.

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
    api/                  the BFF: auth, sessions, messages, documents
                          (+ publish), ratings, generate, context-search, health
```

Anything under `src/lib/server/` is server-only by SvelteKit convention — the
build fails rather than shipping it to the browser. That is what keeps
`AI_SERVICE_API_KEY` and the user's JWT out of the client bundle.
