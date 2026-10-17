# Running the tests

```bash
pnpm test          # every workspace, in parallel
pnpm typecheck
```

Current state, measured 2026-08-29: **2,593 passing, 0 skipped, 0 failing.**

| Workspace | Tests |
| --- | ---: |
| `apps/web` | 888 |
| `apps/backend` | 884 |
| `services/ai-service` | 688 |
| `packages/ai-client` | 55 |
| `packages/identity-client` | 50 |
| `packages/chat-engine` | 28 |

⚠ **`pnpm test` is the UNIT suite only.** It does not touch a running stack. The
end-to-end suites are separate, need the containers up, and are described under
"The e2e suites" below — including the one application bug they currently catch.

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

## The e2e suites — they now actually run

Measured 2026-08-29, against the live `infra/` stack. Until this date **neither suite
had ever executed**: both were written against a stack that was not up, so every
assertion in them was an unverified claim. They are no longer.

| Suite | Command | Result |
| --- | --- | ---: |
| `apps/backend/e2e` (API-level, vitest) | `pnpm --filter @edc/backend test:e2e` | **96 passing, 1 failing, 12 skipped** |
| `apps/web/e2e/revision.spec.ts` (Playwright) | `pnpm --filter @edc/web test:e2e revision` | **8 passing** |
| `apps/web/e2e/journey.spec.ts` (Playwright) | `pnpm --filter @edc/web test:e2e journey` | **blocked — see below** |

The one failure and the twelve skips are **all the same application bug**, not test
problems. `POST /api/messages` answers `400 The following field is invalid: Corpus
Status` for every authenticated caller, so no chat turn can be written at all. See
"Known failures" below. Nothing was weakened to hide it.

### Running them yourself

```bash
cd infra && docker compose up -d --wait     # 1. the stack must be up
./scripts/corpus-fixtures.sh                # 2. build the upload fixtures
pnpm --filter @edc/backend test:e2e         # 3a. API-level
pnpm --filter @edc/web     test:e2e         # 3b. browser
```

Both suites read `infra/.env` at runtime for `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`
and the Postgres credentials. Neither has a secret in it, and neither ever prints one.

⚠ **From a `git worktree`, two things need pointing.**

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
`654db7d fix(web): traducir el frente de la casa`, so `/sign-in` still rendered
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

### Known failures — application bugs, not test bugs

- 🔴 **`POST /api/messages` → 400 for every authenticated caller.**
  `apps/backend/src/collections/Messages.ts:105`. The `protectMessageCorpusState`
  `beforeValidate` hook `delete`s `corpusStatus` on create, on the stated assumption
  that "removing the key lets Payload apply the default". Payload resolves field
  defaults *before* the collection hook, so the field arrives `required` and empty.
  Measured directly against the running backend, and against the seeded admin.
  It breaks **chat in the live app**, not only the suites: the web BFF creates turns
  through this same route (`apps/web/src/routes/api/generate/+server.ts:88` and
  `apps/web/src/routes/api/sessions/[id]/messages/+server.ts:51`).
  Blocks: `ratings.e2e.ts` (12), `tenancy.e2e.ts` "messages are private via their
  session" (1), and `journey.spec.ts` from the chat step onwards.

## Not covered by any of this

- **No `docker build` has ever run.** Every Dockerfile is unverified.
- ~~**The audio path has never run end to end.**~~ ✅ It has, 2026-08-29:
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
