# Shared context — put this in every agent brief

Each item below cost real time to discover in the session that built the corpus
graph. None of it is obvious from the code.

## Running anything

- 🔴 **`pnpm` is NOT on PATH.** Use `node ~/.cache/node/corepack/v1/pnpm/9.15.4/bin/pnpm.cjs`.
- 🔴 **A fresh worktree needs a build, not just an install.** `packages/chat-engine/dist`
  is gitignored. `apps/web` typechecks green against a stale `dist` while the
  feature silently does nothing:
  ```
  <pnpm> install --prefer-offline
  <pnpm> --filter '@edc/ai-client' --filter '@edc/chat-engine' --filter '@edc/identity-client' build
  ```
- 🔴 **Agent worktrees are cut from `origin/main`, which has run ~29 commits stale.**
  Three agents hit this. Always: `git log --oneline -1`, `git rev-list --count HEAD..main`,
  and `git merge --ff-only main` before reading anything.
- ⚠ Credentials are in `infra/.env`. Read at runtime, never hardcode, never commit.
  Postgres is on `localhost:45432`, user `edc`.

## Databases

- `edc_backend` — Payload. 🔴 **The shared dev database. Do not run scripts or
  janitors against it without saying so.**
- `edc_ai` — ai-service (chunks, embeddings).
- **Pattern for any schema work:** create your own scratch DB, migrate into it,
  drop it when done.

## Migrations (Payload)

- Generate with `payload migrate:create`, never hand-write. A hand-written
  migration with no `.json` snapshot broke this repo's chain once already.
- 🔴 **The snapshot is the trap.** `migrate:create` diffs the config against the
  *latest snapshot by filename order*. If another branch lands a migration that
  sorts after yours, its snapshot — which knows nothing of your tables — becomes
  the baseline, and the next generate tries to create them again. Fix: rename
  yours to sort last and regenerate the snapshot.
- Some indexes and all the graph FK `ON DELETE cascade` fixes are **hand-appended**
  to generated migrations. A regeneration drops them. `PAYLOAD_ALLOW_PUSH=1` also
  drops them, silently. See `apps/backend/src/migrations/README.md`.

## ai-service limits — the cause of the worst incident here

- `/v1` 100/min, `/v1/generate` 30/min. Hardcoded in `services/ai-service/src/server-limits.ts`.
- 🔴 **They are enforced per IP, not per API key.** `keyGenerator` reads
  `req.auth?.apiKeyId ?? req.ip`, but the limiter runs at `onRequest` and auth is
  a `preHandler`, so `req.auth` is never set. Every consumer behind one address
  shares one bucket. This is task 03.
- ⚠ **The backend uses ONE `AI_SERVICE_API_KEY` for every ecosistema.** Per-key
  limiting would not isolate tenants even once 03 lands. That is task 02.
- 🔴 **Generation is slow here: ~8 tokens/second.** One `deep` extraction window
  takes 70–95s. `LLM_REQUEST_TIMEOUT_MS` was raised to 600000 for this reason;
  the graph client's own timeout is 660s and **must stay above the server's**, or
  every failure looks like a network fault.

## Privacy rules that are load-bearing

Breaking any of these is worse than shipping nothing.

- 🔴 **The graph reads `corpusTextFor(row)`, never `extractedText`.** For a
  testimonio that is the raw un-scrubbed transcript. It also requires
  `anonymisationStatus` in `('ready','approved')` — a row that cleared the gate
  once and was later held carries a stale `redactedText`.
- 🔴 **Titles go through `titleFor(contentKind, name)`.** `documents.name` is free
  text the uploader typed and never passed the gate. `lib/contentKind.ts` records
  "Testimonio de María López.mp3" as the case that nearly reached a citation card.
- 🔴 **`persona` nodes cannot come from a testimonio.** Three layers: the response
  schema omits it from the enum, `personaAllowed()` is `=== 'documento'` and fails
  closed, and an unconditional post-filter drops any that appear.
- 🔴 **Every graph SQL statement carries three gates** — organization named
  explicitly, a JOIN to `documents` requiring `published`, and `GRAPH_MIN_SUPPORT`
  over distinct documents. A test iterates every registered statement and asserts
  all three; register new queries in `graphStatements` or they are unguarded.
- 🔴 **`GRAPH_MIN_SUPPORT` is 3 and stays 3.** It was 1 for one day while the only
  content was fixture text. Never lower it to make a view look fuller.

## Testing

- Baselines: backend **1250**, web **1213**, chat-engine **48**, ai-client **68**.
- `apps/web` runs vitest in a `node` env with **no DOM**. Nothing inside a
  `.svelte` file can be asserted — all copy and all pure logic go in `.ts`
  modules. Do not claim a rendering test; there is no such thing here.
- ⚠ **A suite of only negative assertions cannot tell "correctly suppressed" from
  "never produced".** Every privacy rule above is a negative assertion. Each needs
  a positive counterpart proving the thing it suppresses exists at all. This was a
  real bug: the snippet feature could have been silently dead with the suite green.
- ⚠ **Do not loop over real inference while iterating.** ~85s and real money per
  call. Fake the ai-client.

## Conventions

- Spanish user-facing copy, English identifiers.
- `es-MX` for dates.
- Design tokens are bare `var()`, so Tailwind opacity modifiers (`bg-warning/10`)
  render nothing. Use the shipped `-soft` / `-outline` pairs.

## State of the data

- 285 documents in organization 1: 250 from the `corpus-generativo` seed, 35 e2e residue.
- **216 published**, 69 draft (61 held by the anonymisation gate, 8 with no text).
- Graph: **788 entities, 3065 mentions, 2502 relations** from 261 documents.
- At `GRAPH_MIN_SUPPORT=3` the view shows **221 entities, 99 connections**.
- Ground truth for the seed: `~/chamba/cide/corpus-generativo/resultados/MANIFEST.csv`.
  Columns include `nombre`, `sitio_ancla`, `pariente`, `cruce_ecosistema`.
  Documents carry their `SIM_xxxx` id in `documents.name`.
- ⚠ All 250 are in **one** organization. The corpus's four `ecosistema` values are
  a column on the row, not separate tenants.
