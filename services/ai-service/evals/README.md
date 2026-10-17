# `evals/` — generation-quality harness (promptfoo)

A **manual, CLI-only** harness that grades what ai-service actually generates.
It is not a gate, it is not in CI, and it is not in `npm test`.

## What it measures — and what it does not

| | measured by | when it runs |
|---|---|---|
| **Retrieval** — does the RAG layer find the right chunks? | `src/eval/` + `npm run eval:retrieval` | free, offline, on every change |
| **Generation** — is the answer good? | **this directory** | manual, paid, on request only |

The two do not overlap. `plan/tecnología/ai-infra/reranker-and-eval-plan.md` §2.6
rejected Ragas / DeepEval / LangSmith **as the retrieval gate** — they all need an
LLM judge, cannot run free in CI, and send data out. promptfoo survived that
table only as a *complement* on the generation side, which is exactly the scope
here. It never replaces `src/eval/`.

The harness is a **black-box eval of the service**, not of a model: every case
goes over the wire to `POST /v1/generate/sync`, so spec resolution, the effort
profile, the system-prompt ladder and the Handlebars render are all inside the
thing under test.

## Project-agnostic, like the rest of the service

ADR-0001: ai-service carries no product's domain logic, and that extends to its
eval content. The five cases are deliberately generic — summarize, classify,
extract JSON, list action items, rewrite in plain language — over invented
neutral material (a library's opening hours, a late parcel). No consumer
product's vocabulary appears here. A consumer that wants to grade *its own*
prompts on *its own* content authors those cases in its own repo and points
this config's `tests:` at them.

There are also no "built-in unit types" to draw on: unit types are per-project
registry rows. Each case therefore ships its prompt as
`unit.specDefault.promptTemplate` — the registry **floor** (`src/contract/generate.ts`).
That is the zero-config path, and a project registering the same `unitType`
still wins over it. Putting the prompt in `specOverride` instead would make a
registry row resolve and then be silently discarded.

## The two modes

### `fake` — free, and the one to run first

```bash
scripts/eval-generation.sh fake          # or: npm run eval:generation
```

Targets an ai-service whose `CHAT_COMPLETIONS_URL` points at the TEST-ONLY fake
provider (`test-support/fake-provider/`). The real router runs; the fake
provider answers with a body marked `[FAKE-PROVIDER TEST DATA]`. **Zero cost**:
no tokens on the target, and no LLM judge anywhere in
`promptfooconfig.fake.yaml` — every assertion is deterministic (response-shape
JSON schema + a JavaScript check that the body is the fake provider's and
`costUsd` is 0).

It proves the *harness* works end to end — auth header, request body, spec
resolution, render, response transform, assertion wiring. It proves **nothing**
about generation quality.

Booting a throwaway target:

```bash
docker run -d --name pf-eval-pg    -e POSTGRES_USER=pf -e POSTGRES_PASSWORD=pf \
  -e POSTGRES_DB=ai_service -p 0:5432 pgvector/pgvector:pg16
docker run -d --name pf-eval-redis -p 0:6379 redis:7-alpine
docker port pf-eval-pg 5432 && docker port pf-eval-redis 6379   # note the ports

FAKE_PROVIDER_PORT=4010 node test-support/fake-provider/server.mjs &

export DATABASE_URL=postgres://pf:pf@127.0.0.1:<pgport>/ai_service
export REDIS_URL=redis://127.0.0.1:<redisport>
export API_KEYS='{"eval-key":{"org":"evalorg","project":"evalproj","role":"admin"}}'
export CHAT_COMPLETIONS_URL=http://127.0.0.1:4010/api/v1/chat/completions
export EMBEDDINGS_URL=http://127.0.0.1:4010/api/v1/embeddings
export OPENROUTER_API_KEY=fake-provider-test-key PORT=3411
npx tsx src/db/migrate.ts && npx tsx src/index.ts &

AI_SERVICE_URL=http://localhost:3411 AI_SERVICE_KEY=eval-key \
  scripts/eval-generation.sh fake

docker rm -f pf-eval-pg pf-eval-redis    # afterwards
```

⚠ `npm run db:up` is NOT used here on purpose — its published ports collide with
whatever else is already running locally. Ephemeral ports (`-p 0:5432`) do not.

### `real` — 🔴 spends money

```bash
AI_EVAL_CONFIRM=yes scripts/eval-generation.sh real
```

The script **refuses** without `AI_EVAL_CONFIRM=yes`. That is the enforcement of
Rodrigo's conserve-tokens rule: **no LLM-judge sweep runs without his explicit
OK, per run.** Same gate the real-embedder eval sits behind
(reranker-and-eval-plan §2.5).

Cost is paid twice per case: once by the target model that answers, once by the
judge that grades it. Five cases, short prompts, `openai/gpt-4o-mini` on both
sides ⇒ cents, not dollars — but it is real money on a real OpenRouter account,
and it grows with every case added.

The judge routes through **OpenRouter** (`openrouter:$AI_EVAL_JUDGE_MODEL`, on
`OPENROUTER_API_KEY`), never a vendor SDK default that would bill an account
this service does not use.

## When to run it

- Before changing a shipped prompt template, an effort profile, or the default
  model — then again after, and compare.
- When a consumer reports that answers got worse and you need something better
  than an anecdote.
- Never on a schedule, never in CI, never as part of a green-suite gate.

## Installing it

The harness needs a FULL `npm ci` — no `--omit` flags.

promptfoo pulls 43 optionalDependencies (playwright + a chromium download,
onnxruntime, transformers, sharp, several agent SDKs). MEASURED on
this lockfile: `npm ci --include=dev` installs 1372 packages / 2.6GB, and
`npm ci --include=dev --omit=optional` installs 778 / 402MB. So the Dockerfile
and `.github/workflows/test.yml` both pass `--omit=optional`: nothing they run —
`tsc`, eslint, vitest — touches promptfoo, and this harness is manual-only and
appears in no CI job.

🔴 That flag is NOT safe for a developer checkout. promptfoo keeps its results
in SQLite through libsql, and the native binding (`@libsql/linux-x64-gnu` here)
is itself an optionalDependency. Under `--omit=optional` promptfoo refuses to
start, with an error that recommends reinstalling and never mentions the flag.
`scripts/eval-generation.sh` preflights for this and names the real cause.

## Environment

| var | default | meaning |
|---|---|---|
| `AI_SERVICE_URL` | `http://localhost:3000` | base URL of the target ai-service |
| `AI_SERVICE_KEY` | `dev-key` | bearer token; a neutral placeholder — must map to an `API_KEYS` entry on the target |
| `OPENROUTER_API_KEY` | — | required in `real` mode, for the judge |
| `AI_EVAL_JUDGE_MODEL` | `openai/gpt-4o-mini` | judge model id, as OpenRouter names it |
| `AI_EVAL_CONFIRM` | — | must be `yes` for `real` mode |

## Layout

```
evals/
  promptfooconfig.yaml        paid config  — llm-rubric + deterministic asserts
  promptfooconfig.fake.yaml   free config  — deterministic asserts only
  prompts/*.txt               the five prompt templates
  prompts/render.js           the single promptfoo prompt entry; picks a .txt by var
  tests/generation.yaml       the five paid cases
  tests/wire-shape.yaml       the five free cases
```

`prompts/render.js` exists because promptfoo runs the cross-product of
`prompts` x `tests`: five files and five cases would fire 25 calls, 20 of them
nonsense. One function prompt, selected per case by the `promptFile` var, keeps
it at one call per case.

Both configs run with `--no-cache -j 1`. `--no-cache` because a cached row is
not evidence; `-j 1` because `/v1/generate*` is capped at 30 requests/min
(`src/server-limits.ts`) and a parallel fan-out trips it.
