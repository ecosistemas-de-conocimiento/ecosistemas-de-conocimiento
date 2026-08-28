# Running the tests

```bash
pnpm test          # every workspace, in parallel
pnpm typecheck
```

Current state, measured 2026-08-18: **1,811 passing, 0 skipped, 0 failing.**

| Workspace | Tests |
| --- | ---: |
| `services/ai-service` | 688 |
| `apps/backend` | 564 |
| `apps/web` | 426 |
| `packages/ai-client` | 55 |
| `packages/identity-client` | 50 |
| `packages/chat-engine` | 28 |

The 13 that used to show as skipped were `services/ai-service/src/routes/registry.test.ts`,
and they were never really a skip: the suite published its throwaway Postgres on a
**fixed host port 45432 — the same port `infra/docker-compose.yml` gives the local
demo**, so `docker run` failed with "port is already allocated" whenever the demo was
up. Those containers now bind an ephemeral host port (`-p 0:5432`) and read the
assignment back from `docker port`, so the suite runs alongside a live local stack.
See `services/ai-service/src/test/pg-container.ts`.

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

## Not covered by any of this

- **No `docker build` has ever run.** Every Dockerfile is unverified.
- **The audio path has never run end to end** — no model weights, no built image.
- **Svelte components are typechecked and built, never rendered.** There is no DOM
  test environment, so UI logic is tested only where it was extracted into pure
  functions.
- **Object storage was exercised live against RustFS `1.0.0-rc.1`** — upload, ranged
  GET, cross-tenant 403 — but only with a **root** credential. A scoped credential is
  untested, and it is the one a real deployment would use.
