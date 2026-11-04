# Running the tests

```bash
pnpm test          # every workspace, in parallel
pnpm typecheck
```

Current unit counts, **measured 2026-10-17** with `vitest run` in each workspace, on
Rodrigo's 16-core dev box at load average ~17 (other agents running), from a worktree
at `main` plus the graph-status badge change. All passing, 0 skipped, 0 failing.

| Workspace | Tests | Provenance |
| --- | ---: | --- |
| `apps/backend` | 1,655 | measured 2026-10-17 |
| `apps/web` | 1,442 | measured 2026-10-17 |
| `packages/chat-engine` | 211 | measured 2026-10-17 |
| `services/ai-service` | 688 | quoted from this file, 2026-08-29; not re-measured |
| `packages/ai-client` | 55 | quoted from this file, 2026-08-29; not re-measured |
| `packages/identity-client` | 50 | quoted from this file, 2026-08-29; not re-measured |

⚠ **A fresh worktree fails 27 backend test files and 4 web test files before you build the
packages.** `@edc/ai-client`, `@edc/identity-client` and `@edc/chat-engine` export from
`dist/`, which is gitignored. The error is `Failed to resolve entry for package` or
`Cannot find package '@edc/chat-engine/core'`. Build them once (measured 2026-10-17):

```bash
pnpm --filter @edc/ai-client build
pnpm --filter @edc/identity-client build
pnpm --filter @edc/chat-engine build
```

⚠ **`pnpm test` is the UNIT suite only.** It does not touch a running stack. The
end-to-end suites are separate, need the containers up, and are described under
"The e2e suites" below.

The 13 that used to show as skipped were `services/ai-service/src/routes/registry.test.ts`,
and they were never really a skip: the suite published its throwaway Postgres on a
**fixed host port 45432 — the same port `infra/docker-compose.yml` gives the local
demo**, so `docker run` failed with "port is already allocated" whenever the demo was
up. Those containers now bind an ephemeral host port (`-p 0:5432`) and read the
assignment back from `docker port`, so the suite runs alongside a live local stack.
See `services/ai-service/src/test/docker-pg.ts`.

They still skip where Docker itself is absent — that is a real environment problem, and
the only one left that this harness treats as one.

## ✅ Parallel again — and why it was not, for three days

`pnpm test` runs all six workspaces concurrently. It used to produce
**intermittent failures that were not real**: a different test failed on each run,
and every one failed at almost exactly 5000 ms — vitest's default per-test timeout.

The cause was never flakiness in the usual sense. Two suites did multi-second
setup work *inside a test body*, and were charged for it against that one test's
budget:

- **`services/ai-service`** — every route test called `await import('../server.js')`
  inside `makeApp()`, paying ~3 s of module-graph transform on the first test of
  each file. Hoisted into `beforeAll` via `src/test/server-harness.ts`. Slowest
  single test: **4,564 ms → 877 ms**.
- **`apps/backend`** — `payload.config.storage.test.ts` built the real Payload
  config in the test body, ~3.8 s. Both configs are now built once in a single
  `beforeAll`. Slowest single test in that file is now under 2 s.

`testTimeout` stays at the strict 5 s default in both. That is deliberate: a slow
*test* should still fail, while a slow one-time *setup* should not be charged to
one. `hookTimeout` carries the real budget instead.

**Evidence for flipping the default back** (2026-08-18, 16-core box): three
consecutive parallel runs clean, plus one more under 12 synthetic busy workers at
load average 34 — **1,811 passing, 0 failing, zero 5000 ms timeouts** every time.

`pnpm test:sequential` remains for when you want to rule the scheduler out entirely.

⚠ **Why this mattered more than the minute it cost.** A suite that fails randomly
teaches everyone to re-run it until it passes, and a real regression then reads as
"just the flaky one again". Sequential was the honest stopgap; this is the fix.

## Upload fixtures come from `corpus-generativo`, and are not committed

Every file the e2e suites upload is **built**, by:

```bash
./scripts/corpus-fixtures.sh      # run once, and again after a corpus update
```

It reads `../corpus-generativo` — a **separate repo**, 250 synthetic documents built to
look like what this product actually receives — and writes three fixtures plus a
`fixtures.json` manifest into `apps/backend/e2e/fixtures/` and `apps/web/e2e/fixtures/`.
Both directories are gitignored.

| Fixture | Source | Exercises |
| --- | --- | --- |
| `.pdf` | a long `testimonio`, rendered by `scripts/lib/txt_to_pdf.py` | `unpdf` extraction, multi-chunk ingest |
| `.docx` | a `carta de presentación`, copied from the corpus untouched | `mammoth` extraction |
| `.m4a` | a `testimonio` read aloud by Piper (`scripts/corpus-voices.sh`) | transcription → the same ingest path a PDF uses |

**What this replaced, and why.** The old fixtures were invented here: two hand-written
PDFs carrying nonsense canary words (`ZANAHORIA-E2E-BACKEND`, `NUBELIRIO`) and
`es-clip.mp3`, a 45-second recording committed as a binary with no recorded provenance.
They proved the plumbing moved bytes. They could not tell you whether the chunker,
the retriever or the transcriber behave on **the shape of document we are really
handed** — Spanish testimonies with place names, indigenous-language references,
and words like `descacharrización` and `ovitrampa`.

🔴 **Nothing in `e2e/` may hardcode a fixture filename or marker.** The corpus is
regenerable (`gen_corpus.py`, seed `445`), so which document sorts first can change.
Read `apps/backend/e2e/support/fixtures.ts` or `apps/web/e2e/fixtures.ts` instead.
Each fixture carries a **marker** — the subject's name, unique across the corpus's 250
documents — so "this exact name came back" can only mean the text travelled from that
file, through extraction, onto the row.

⚠ **The audio marker is not assertable.** It is a transcriber's guess at a spoken
proper noun, and no ASR model spells `Valdés Colín` reliably. `markerIsAssertable: false`
says so in the manifest. The audio assertions check that the transcript is real Spanish,
not that it contains a particular word.

⚠ **The voice is synthetic and sounds it.** Piper is a neural TTS with a Mexican Spanish
voice, which is far better than the `espeak-ng` formant synthesis that
`services/audio-service/scripts/make-fixtures.sh` uses — but it is still a machine
reading, not a person in a room with background noise. A real recording remains the
missing fixture.

### What was deliberately left alone

- **`services/ai-service/src/eval/fixtures/`** stays domain-free. ai-service ships
  retrieval machinery for several products, and its own header says a fixture encoding
  one consumer's subject matter would smuggle that consumer's domain into a shared
  service. Corpus content must not go there.
- **`services/audio-service/scripts/make-fixtures.sh`** stays on `espeak-ng`. Its test
  asserts content-word recall against deliberately robotic speech, which is the *harder*
  case. Making it prettier would weaken the test.

## The e2e suites

Last recorded run: **2026-10-17, on an isolated fake-provider stack** (method below).
Results quoted from `plan/auditoria-ia-2026-10-17.md`, where they are marked measured.

| Suite | Result on the fake stack |
| --- | --- |
| `apps/backend/e2e/anonymisation.e2e.ts` | 3/3 passing |
| `apps/backend/e2e/holds.e2e.ts` | 20/20 passing |
| `apps/backend/e2e/tenancy.e2e.ts` | 22/22 passing |
| `apps/backend/e2e/documents.e2e.ts` + `testimonyRead.e2e.ts` | 22/22 passing |
| `apps/web/e2e/grafo.spec.ts` | 3/3 passing |
| `apps/backend/e2e/audio.e2e.ts` | 9/9 passing — needs `docker-compose.audio.yml` (see step 1) |
| `apps/backend/e2e/identity.e2e.ts` | 15/15 passing — needs a signing keypair (see step 3) |
| `apps/backend/e2e/ratings.e2e.ts` | 13/13 passing |
| `apps/web/e2e/retrieval.spec.ts` | 2/2 passing (re-run 2026-10-17, bag-of-words fake embeddings) |
| `apps/web/e2e/journey.spec.ts` | 1/1 passing, all 12 steps, cite step hard (re-run 2026-10-17, with audio; see below) |

**The fake provider's embeddings are a hashed bag of words now, not random.** Texts that
share words land close (`services/ai-service/test-support/fake-provider/README.md`), so a
retrieval e2e on the fake stack means something. Measured 2026-10-17 on an isolated
fake-provider stack (project `edc-e2e-hyb`, backend and web built from this tree, the
ai-service image of the local demo, 163 published seeded documents):

- `retrieval.spec.ts`: 2/2. It needed one test fix: the draft upload now sends an `Origin`
  header. SvelteKit answers 403 "Cross-site POST form submissions are forbidden" to a
  multipart POST without one, and Playwright's API request context sends none.
- **Re-run, 2026-10-17 21:40 UTC (measured).** Isolated project `edc-e2e-jrn`, backend,
  web and ai-service built, `docker-compose.audio.yml` on,
  `SEED_CORPUS_INGEST=1` (250 seeded, 163 published; 191 ingests completed on the fake
  provider). ⚠ Without that flag the seed embeds nothing, and the cite step would pass
  against an empty corpus: it would test nothing. Every step
  passed up to the cite step: sign in, ecosistema picker, chat, rate 4 then 2, keyboard
  rating, rating survives a reload, PDF upload and ingest (2 s), audio upload and
  transcription (55.2 s clip, `listo` in 127 s), publish (3 s, POST 202). The cite step
  failed on ranking. A scratch copy with only the cite assertion made soft also passed
  sign out, with no console errors. Ranks of the uploaded PDF on that stack, top 50:
  the journey's question: dense not in top 50, hybrid 26; `¿qué cuenta <name> sobre su
  trabajo?`: dense 44, hybrid 8; the name alone: dense 4, hybrid 1. The recording is not
  in either top 50 for the journey's question. Same picture as the earlier run below.
- Earlier run: the journey stopped at "rate the answer 4 stars, then re-rate it to 2": the row reads
  `Tu valoración ★★☆☆☆ Quitar` and never `Valoración guardada: 2 de 5.` Not investigated
  here (ratings belong to another lane). A throwaway copy with every assertion made
  soft got through to the cite step. There, the audio upload failed (no audio-service in
  that stack, expected) and the cite step failed.
- Before the fix below, the cite step failed on the fake stack. The old question was a
  follow-up in the first conversation, and the PDF ranked outside dense's top 50 for it.
- ✅ **Cite step fixed, 2026-10-17 (measured).** Isolated project `edc-e2e-cite`, every
  image built from this tree, `docker-compose.audio.yml` on, `SEED_CORPUS_INGEST=1`
  (163 published seeded documents embedded, 28 drafts). The full journey passed, 1/1 in
  2.4 min, no console errors: sign in, ecosistema picker, chat, rate 4 then 2, keyboard
  rating, rating survives a reload, PDF upload and ingest (2 s), audio upload and
  transcription (55.2 s clip, `listo` in 98 s), publish (3 s, POST 202), cite, sign out.
  The uploaded PDF was citation [1].
  - **Why the old question could never pass on the fake stack.** A follow-up is not
    searched with its own words. On a turn with history the engine condenses the
    question first (`condenseQuery`, chat-engine), and the fake provider answers that
    with its stub text. The old turn's top three citations were, in order, the three
    documents nearest the stub; the PDF ranks 119 of 164 for the stub. Rewording a
    follow-up changes nothing on the fake stack.
  - **The draft corpus does not help either.** Publishing retires the PDF's draft copy
    (0 live chunks left in the draft corpus), and a draft is retrieved only in its own
    conversation, where the condensed stub is what gets searched.
  - **The fix.** The cite question is now the first message of a NEW conversation, so it
    skips condensing and proves the PDF is cited through the published corpus. Its words
    come from the manifest: `¿Quién es <marker>? <formato>, <ecosistema>`. Over 1000
    random RUN_IDs, with a port of `fakeEmbedOne` checked against the stored vectors
    (cosine 1.0000), it ranks the PDF 1st in 95% and top 2 in 98%. Expect a rare
    fake-stack miss from hash collisions with the RUN_ID's digits.
  - **Not vacuous.** With the PDF upload, PDF ingest and audio steps skipped (throwaway
    copy), the cite assertion failed. That run's citation [1] was an identical PDF left
    by an earlier run under another RUN_ID: only the run-scoped name check caught it.

⚠ **Running from a worktree: the fixtures, the web origin and a trailing newline.**
`apps/web/e2e/fixtures/` is gitignored; copy it from the main checkout or rebuild it.
Set `WEB_ORIGIN` in the isolated stack's `.env` to the web host port you chose, or every
form POST answers 403. If you build that `.env` by appending lines to a copy of the main
one, check the copy ended with a newline: the 2026-10-17 run glued `COMPOSE_PROFILES=fake`
onto `PUBLIC_BACKEND_URL`, and every ingest answered 400 `Invalid URL`.

The audio, identity and ratings rows are a later run the same day (measured,
2026-10-17, isolated project on the dev box, CPU transcription with Whisper `small`;
audio reached `ready` in 79–91 s for the 55.2 s clip). On the earlier run they failed
for three reasons, none of them a product bug:

- **audio** — the stack had no `docker-compose.audio.yml`, so the backend ran with
  `AUDIO_SERVICE_URL` empty and logged "transcription is off". The suite now
  **skips** with a banner when audio-service does not answer, instead of failing.
- **identity** — the fake `.env` had no `AUTH_PRIVATE_KEY` / `AUTH_PUBLIC_KEY`. The
  backend served an empty JWK Set and answered every mint with 503. The suite now
  stops in `beforeAll` with a message naming the keypair.
- **ratings** — the test sent a `comment` with no `reason`. Free text is kept only
  with `reason: 'other'` (`normalizeFeedback`, `collections/Ratings.ts`), so the
  upsert answered 400. The test predated that rule; it now sends `other`.

Not in the table: `publish.e2e.ts`, `storage.e2e.ts` and `revision.spec.ts` have no
recorded result on this date.

### Running them against an isolated fake-provider stack

This keeps the e2e run off the shared `edc` demo stack and its volumes, and costs no
model calls. The method below is quoted from the 2026-10-17 run; it is not re-run here.

1. Copy `infra/docker-compose.override.yml` to a scratch file and delete two things from
   the copy: the top-level `name: edc`, and the `networks: default: name: edc` block. Both
   pin the project to the shared demo; without them `-p` picks the names.
   For `audio.e2e.ts`, also pass `-f docker-compose.audio.yml` (after the override
   copy). Without it the audio suite skips. It runs on CPU; no GPU is needed.
2. Change the host ports in the copy (the `*_HOST_PORT` env vars work) so they do not
   collide with a running demo. Keep them in the 454xx block.
3. Turn on the fake provider in `infra/.env`: uncomment the four-line fake-provider
   block from `.env.example` (`COMPOSE_PROFILES=fake` plus the chat, embeddings and key
   lines). ⚠ The three URL/key lines reach ai-service through `env_file: .env`
   (`infra/docker-compose.yml`), so exporting them in your shell does nothing; only
   `COMPOSE_PROFILES` works from the shell (inferred from reading the compose file).
   🔴 Also set, in the same `.env`: a signing keypair (`pnpm --filter @edc/backend
   keygen`, paste both lines), and `AUTH_ISSUER` plus `ALLOWED_ORIGINS` on the
   **new** backend host port. `identity.e2e.ts` asserts `AUTH_ISSUER` equals
   `E2E_BACKEND_URL`. Then bring it up:

```bash
cd infra
docker compose -p edc-e2e-<x> -f docker-compose.yml -f /path/to/override-copy.yml \
  up -d --build --wait
```

4. Point the suites at it:

```bash
export E2E_BACKEND_URL=http://localhost:<backend-port>
export E2E_AI_SERVICE_URL=http://localhost:<ai-service-port>
export EDC_E2E_COMPOSE_PROJECT=edc-e2e-<x>   # the suites' direct-SQL seeding uses it
export EDC_WEB_URL=http://localhost:<web-port>
pnpm --filter @edc/backend test:e2e
pnpm --filter @edc/web     test:e2e
```

5. 🔴 Tear it down with its volumes and its locally built images. The disk on the dev
   box sat at 95% on 2026-10-17 (measured, `df -h /`):

```bash
docker compose -p edc-e2e-<x> -f docker-compose.yml -f /path/to/override-copy.yml \
  down -v --rmi local
```

⚠ **A throwaway Postgres for a one-off check:** `docker run --rm --tmpfs /var/lib/postgresql/data …`.
`--rm` deletes the container on exit and `--tmpfs` keeps its data in memory, so nothing
lands on the disk.

### Running them against the local demo stack

```bash
cd infra && docker compose up -d --wait     # 1. the stack must be up
./scripts/corpus-fixtures.sh                # 2. build the upload fixtures
pnpm --filter @edc/backend test:e2e         # 3a. API-level
pnpm --filter @edc/web     test:e2e         # 3b. browser
```

Both suites read `infra/.env` at runtime for `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`
and the Postgres credentials. Neither has a secret in it, and neither ever prints one.

⚠ **The demo stack's images may predate your checkout.** After rebuilding past the
per-ecosistema org change, run `scripts/ai-org-per-ecosystem.sql` or retrieval comes
back empty. See "Stack local" in `plan/deploy-and-local-demo.md`.

⚠ **From a `git worktree`, three things need pointing.**

- `infra/.env` is gitignored and exists only in the MAIN checkout. Both suites already
  walk back to it through `.git`; `EDC_E2E_ENV_FILE` (backend) or `EDC_ENV_FILE` (web)
  overrides that.
- `scripts/corpus-fixtures.sh` defaults `CORPUS_DIR` to `<repo>/../corpus-generativo`,
  which resolves *inside* `.claude/worktrees/` from a linked worktree and does not
  exist. Set it: `CORPUS_DIR=/path/to/corpus-generativo ./scripts/corpus-fixtures.sh`.
- The Piper voices cache in `media/voces/` — also gitignored, also only in the main
  checkout. Symlink it in rather than paying ~14× realtime to rebuild them.

⚠ **The browser suite tests the code you are looking at only if you built it.** There
is no `webServer` block, so Playwright drives whatever is answering on
`EDC_WEB_URL` (default `http://localhost:45400`, the container). A container built
before your commit serves the old UI, and the failure looks like a wrong assertion.
This cost a session: the running container predated
the commit that translated the UI to Spanish, so `/sign-in` still rendered
English and the Spanish assertions "failed". To test a working tree instead:

```bash
pnpm --filter @edc/chat-engine build && pnpm --filter @edc/ai-client build
pnpm --filter @edc/web build
PORT=45507 ORIGIN=http://localhost:45507 \
  BACKEND_URL=http://localhost:45402 AI_SERVICE_URL=http://localhost:45401 \
  node apps/web/build &
EDC_WEB_URL=http://localhost:45507 pnpm --filter @edc/web test:e2e
```

### 🔴 The rule about holds: never decide on one you did not create

`/revision` reviews documents the anonymisation gate refused. **A decision is
terminal** — approving or rejecting clears `heldText` and `anonymisationSurvivors` for
good — and a held row **cannot be created through the API**, because those columns are
`gateWritesOnly` and only the gate (a model call) writes them.

So a suite that pressed the buttons on whatever hold it found would consume it. That
has already happened once to the hand-made fixture in the shared dev database.

Both hold suites therefore **seed their own held document by direct SQL**
(`apps/backend/e2e/support/db.ts`, `apps/web/e2e/db.ts`), decide on that, and leave
every other hold alone. `revision.spec.ts` ends with a test that asserts exactly that.
Where the database is unreachable the destructive tests **skip loudly** rather than
falling back to somebody else's row.

⚠ `anonymisation_survivors` holds `{start,end}` offsets that must land **exactly** on
the identifiers inside `held_text`. Both suites compute them with `indexOf` and then
assert by **slicing the text back out** — never by trusting the arithmetic. Getting
this wrong highlights the wrong characters and tells a reviewer that a harmless word is
the thing still identifying someone.

## Not covered by any of this

- ~~**No `docker build` has ever run.**~~ The images build: the local demo stack runs
  built images, and the 2026-10-17 isolated e2e run built its own (quoted from the
  findings doc above).
- ~~**The audio path has never run end to end.**~~ ✅ It has, 2026-08-29, and again on
  the isolated fake stack on 2026-10-17 (9/9, measured):
  `audio.e2e.ts` uploaded the Piper `.m4a`, audio-service transcribed it, and the
  transcript reached `ready` through the same ingest path a PDF uses — **75.5 s** for
  the 55.2 s clip, measured. The old "~9 s for 45 s" figure was against the retired
  `es-clip.mp3` and is gone.
- ~~**Svelte components are typechecked and built, never rendered.**~~ ✅ They render
  now — `apps/web/e2e/` drives real Chromium against the live stack. Still true that
  there is no *unit* DOM environment: `vitest` in `apps/web` is node-only, so a
  component is exercised either as a pure function or in Playwright, never in between.
- **Object storage was exercised live against RustFS `1.0.0-rc.1`** — upload, ranged
  GET, cross-tenant 403 — but only with a **root** credential. A scoped credential is
  untested, and it is the one a real deployment would use.
