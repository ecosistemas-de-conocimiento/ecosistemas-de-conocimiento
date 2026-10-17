# Fake model provider — TEST ONLY, never shipped

A tiny zero-dependency HTTP server that speaks the three OpenRouter API shapes
ai-service calls: chat completions, streaming chat completions (SSE), and
embeddings. Point ai-service at it and the service runs its **real** code path —
router, budget, cache, PII egress scrub, traces — against a provider that costs
nothing and needs no key.

It replaces the in-service `MOCK_LLM`, `MOCK_LLM_STREAM` and `MOCK_EMBEDDINGS`
switches, removed. The shipped service can no longer produce fake
model output. Setting one of those variables now **refuses boot** in every
environment, so a forgotten flag fails loudly instead of making real, billed calls.

## Everything it returns is marked as test data

- Every completion body starts with `[FAKE-PROVIDER TEST DATA]`, unless the
  request scripted the reply with `[[FAKE_REPLY:…]]` (see below).
- Every response carries the header `x-fake-provider: test-data`.
- Every JSON body carries `provider: "fake-provider"` and an `id` starting `fake-provider-`.
- `usage.cost` is `0` unless you set another value.

⚠ A cap below about 7 tokens cuts the marker text itself, because the body is
cut at `max_tokens`. The header and the `id` still mark it.

## It cannot ship

- It lives outside `src/`. `tsconfig.build.json` compiles only `src/`, so it is never in `dist/`.
- `.dockerignore` lists `test-support`, so it is not even in the image's build context.
- The runtime image copies only `dist/`, `drizzle/`, `static/` and `scripts/schema-gate.mjs`.

## How a consumer e2e uses it

You need an ai-service checkout. Node 18 or newer runs the server; it has no dependencies.

**1. Start the fake provider.**

```bash
FAKE_PROVIDER_PORT=4010 node <ai-service>/test-support/fake-provider/server.mjs &
```

**2. Boot ai-service against it.** These three variables replace `MOCK_LLM=1`:

```bash
CHAT_COMPLETIONS_URL=http://127.0.0.1:4010/api/v1/chat/completions
EMBEDDINGS_URL=http://127.0.0.1:4010/api/v1/embeddings
OPENROUTER_API_KEY=fake-provider-test-key   # placeholder; never send a real key here
```

If ai-service runs in a container, use a host the container can reach, for
example `host.docker.internal`. Then start the fake provider with
`FAKE_PROVIDER_HOST=0.0.0.0`.

**3. Remove every `MOCK_LLM`, `MOCK_LLM_STREAM` and `MOCK_EMBEDDINGS`** from the
e2e setup and CI workflows. ai-service refuses to boot while one is set.

From a Node test runner you can start it in-process instead:

```js
import { startFakeProvider } from '<ai-service>/test-support/fake-provider/server.mjs';

const fake = await startFakeProvider({ streamTokensPerSec: 10 });
// spawn ai-service with { ...process.env, ...fake.env }
// fake.requests lists every request body it received
await fake.close();
```

## Settings

| Option (in-process) | CLI env var | Default | What it does |
|---|---|---|---|
| `port` | `FAKE_PROVIDER_PORT` | 0 (CLI: 4010) | Port to bind. |
| `host` | `FAKE_PROVIDER_HOST` | `127.0.0.1` | Host to bind. |
| `bodyTokens` | `FAKE_PROVIDER_BODY_TOKENS` | 200 | Answer length in tokens (chars/4). |
| `streamTokensPerSec` | `FAKE_PROVIDER_STREAM_TOKENS_PER_SEC` | 0 (no pacing) | Streaming pace, one token per frame. |
| `streamFirstDelayMs` | `FAKE_PROVIDER_STREAM_FIRST_DELAY_MS` | 0 | Pause before the first frame. |
| `embeddingDim` | `FAKE_PROVIDER_EMBEDDING_DIM` | 1024 | Vector length. Must match ai-service's `EMBEDDING_DIM`. |
| `embeddingDelayMs` | `FAKE_PROVIDER_EMBEDDING_DELAY_MS` | 0 | Pause before an embeddings response. |
| `costUsd` | `FAKE_PROVIDER_COST_USD` | 0 | `usage.cost` on completions. |

Per request, a prompt containing `[[FAKE_OUTPUT_TOKENS:<n>]]` sets that answer's
length (1 to 20000). Two tests in one run can then ask for different lengths.

Per request, a prompt containing `[[FAKE_REPLY:<base64>]]` makes the answer
**exactly** the decoded text, with no marker. Use it to test a path that parses
model JSON, for example a PII detector that must answer `{"spans":[]}`:

```js
const reply = Buffer.from('{"spans":[]}', 'utf8').toString('base64'); // eyJzcGFucyI6W119
const prompt = `${realPrompt}\n[[FAKE_REPLY:${reply}]]`;
```

- The payload is base64 of UTF-8 text, standard or URL-safe alphabet. Base64
  keeps `]]` in the reply from ending the directive, and keeps ai-service's PII
  egress scrub from rewriting the reply on its way to the fake.
- Put it in any message, system or user. The last `FAKE_REPLY` wins, and it
  overrides `FAKE_OUTPUT_TOKENS`.
- `max_tokens` still cuts it (chars/4), and streaming sends it in 4-char frames.
- The `x-fake-provider` header and the `fake-provider-` id still mark the response.

Only this test-only server reads the directive. A real provider sees it as plain
prompt text, so nothing about it exists in the shipped service.

Behaviour that matches a real provider:

- `max_tokens` cuts the body. `finish_reason` is then `length`; otherwise it is `stop`.
- A client that disconnects mid-stream stops the stream.
- `fakeEmbedOne(text)` returns the same unit-length vector the server returns
  for `text`. A test can seed a chunk with it, and a query for the same text
  then scores 1.0.

Migrating from the old knobs:

| Old ai-service variable | Fake provider |
|---|---|
| `MOCK_BODY_TOKENS` | `FAKE_PROVIDER_BODY_TOKENS` |
| `[[MOCK_OUTPUT_TOKENS:n]]` in the prompt | `[[FAKE_OUTPUT_TOKENS:n]]` |
| `MOCK_LLM_STREAM_TOKENS_PER_SEC` | `FAKE_PROVIDER_STREAM_TOKENS_PER_SEC` |
| `MOCK_LLM_STREAM_TOTAL_TOKENS` | `FAKE_PROVIDER_BODY_TOKENS` |
| `MOCK_LLM_STREAM_FIRST_DELAY_MS` | `FAKE_PROVIDER_STREAM_FIRST_DELAY_MS` |
| `MOCK_EMBEDDINGS_DELAY_MS` | `FAKE_PROVIDER_EMBEDDING_DELAY_MS` |
| body starts `[MOCK] response` | body starts `[FAKE-PROVIDER TEST DATA]` |

Two differences from the old `MOCK_LLM` switch:

- The real router now runs. The **cache** and the **budget** therefore apply,
  so seed a `budget_state` row for the org.
- The trace's `model` is the requested model, and `usage.cost` is 0.

The contract test, `src/test/fake-provider.test.ts`, drives ai-service's real
adapters at this server. It goes red if the server drifts from what they parse.
