# @edc/ai-client

Typed TypeScript client for this repo's AI/RAG service (`services/ai-service`).

Zero production dependencies. Uses the platform `fetch` (Node 20+ or any
modern browser) and a small hand-rolled SSE parser. Targets the v1 surface
documented at `/v1/openapi.json` on a running ai-service deployment.

## Workspace package — not published

This is a **private workspace package**. It is never installed from a registry;
`pnpm` links it from `packages/ai-client` into whatever declares it. Consumers
here are `apps/web` and `apps/backend`.

Depend on it as:

```json
"@edc/ai-client": "workspace:*"
```

### Build

`main`/`types`/`exports` all point into `dist/`, which is **not** committed —
the package resolves to nothing until it has been built at least once:

```bash
pnpm --filter @edc/ai-client build     # tsc -> dist/
# or, from the repo root, build everything in dependency order:
pnpm build
```

Other scripts: `pnpm --filter @edc/ai-client typecheck`, `… test` (vitest).

## Quick start

```ts
import {
  AIClient,
  BudgetExceededError,
  IdempotencyConflictError,
  toCredits,
} from '@edc/ai-client';

const client = new AIClient({
  baseUrl: 'https://ai.example.internal',
  apiKey: process.env.AI_SERVICE_KEY!,
});

// Synchronous one-shot.
try {
  const result = await client.generate.sync({
    unit: { unitKey: 'preview', input: { topic: 'pgvector basics' } },
  });
  console.log(result.text);
  console.log('credits charged:', toCredits(result.costUsd, 1000));
} catch (err) {
  if (err instanceof BudgetExceededError) {
    console.warn(
      `budget exceeded for ${err.org}: shortfall $${err.shortfallUsd}`,
    );
  } else {
    throw err;
  }
}

// Async batch + SSE progress.
const { requestId, channel } = await client.generate.enqueue({
  units: [{ unitKey: 'u1' }, { unitKey: 'u2' }],
  clientRequestId: 'batch-1', // idempotent retry-safe
});
const events = client.events(channel);
events.on('generation.job.completed', (e) => {
  console.log(`job done: ${e.unitKey} ($${e.costUsd})`);
});
events.on('generation.request.completed', () => events.close());
await events.closed;

// Poll for final state.
const snapshot = await client.generate.get(requestId);
console.log(snapshot.status, snapshot.actualCostUsd);
```

## Surface

- `client.generate` — `enqueue`, `sync`, `stream`, `streamRaw`, `get`,
  `getUnitLatest`, `cancel`
- `client.registry` — `getConfig`, `putConfig`, `listUnitTypes`,
  `listVersions`, `getVersion`, `createVersion`, `activateVersion`
- `client.ingest` — `enqueue`, `enqueueAll`, `status`. **Every `POST /v1/ingest`
  goes through a process-wide, 429-aware gate** — see *Ingest gate* below.
- `client.retrieve` — `retrieve`, `retrieveMulti`, `retrieveOutcome`,
  `retrieveMultiOutcome` (see *Retrieval outcome* below)
- `client.route(req)` — capability router: classify a question onto one of a
  caller-supplied candidate list. Fail-safe (always returns a valid `routeId`).
- `client.textToSql(req)` — generate a read-only `SELECT` for `{question,
  tableName, columns}`, validated client-side by the pure guard. ai-service
  never executes SQL — you run the returned string against your own database.
  Ships a **Spanish** built-in prompt in the `specDefault` FLOOR slot, so it
  works with an empty registry **and** a project can take it over by registering
  the `text-to-sql` unit-type. Requires the `specDefaultSlot` capability — see
  below. (Before 0.10.0 the built-in rode in `specOverride`, a ceiling, and
  silently discarded every registered row.)
- `client.embed` — `embed`, `embedQuery` (query embeddings; every failure throws
  `RetrievalUnavailableError`)
- `client.budget` — `get`
- `client.admin` — `getOpenRouterCredits` (admin-role token required)
- `client.events(channel)` — typed SSE stream
- `client.capabilities` — `get`, `negotiate` (boot-time capability check, ADR-0004)
- `isReadOnlySelect(sql)` / `guardReadOnlySelect(sql, rowLimit?)` — exported
  PURE functions (no client instance needed): reject DML/DDL, `;`-chains, and
  `--`/`/* */` comments; require a leading `SELECT`; auto-append a `LIMIT`.

## Retrieval outcome — "no documents" is not "retrieval is down"

Since 0.25.0. Before it, every consumer caught retrieval errors and carried
on, so a 401, 429, 5xx or dead network produced an ungrounded answer or "no
requirement matches". The rule:

| ai-service answers                                  | outcome                                   |
|-----------------------------------------------------|-------------------------------------------|
| 200 with chunks                                     | `{ kind: 'hits', hits, result, traceId }` |
| 200 with no chunks                                  | `{ kind: 'empty', reason: 'no_match' }`   |
| 404 `CORPUS_NOT_FOUND` / `TARGET_CORPUS_NOT_FOUND`  | `{ kind: 'empty', reason: 'corpus_not_found' }` |
| 404 `DOCUMENT_NOT_FOUND`                            | `{ kind: 'empty', reason: 'document_not_found' }` |
| 404 with no taxonomy code (route missing)           | throws `RetrievalUnavailableError` (`not_found`) |
| 400, 401, 402, 403, 429, 5xx, network, timeout       | throws `RetrievalUnavailableError`        |
| multi: any corpus diagnostic `failed`               | throws (`corpus_failed`), even with hits  |
| caller's own abort                                  | rethrows `RequestAbortedError` unchanged  |

`RetrievalUnavailableError` carries `status` (0 when no response arrived),
`kind`, `retryable`, `traceId` (ai-service's `x-request-id`) and, for multi,
`failedCorpora`. The original client error is on `cause`.

```ts
import {
  groundingOf, GROUNDING_FIELD, RetrievalUnavailableError,
  RETRIEVAL_EMPTY_MESSAGE, AI_UNAVAILABLE_MESSAGE,
} from '@edc/ai-client';

try {
  const out = await client.retrieve.retrieveMultiOutcome({ corpora, query });
  if (out.kind === 'empty') {
    return { content: RETRIEVAL_EMPTY_MESSAGE, provenance: { [GROUNDING_FIELD]: 'empty' } };
  }
  const answer = await generateFrom(out.hits);
  return { content: answer, provenance: { [GROUNDING_FIELD]: groundingOf(out) } }; // 'retrieved'
} catch (err) {
  if (err instanceof RetrievalUnavailableError) {
    // 5xx, grounding 'none'. Never answer without the passages instead.
    throw httpError(503, AI_UNAVAILABLE_MESSAGE, { [GROUNDING_FIELD]: 'none', traceId: err.traceId });
  }
  throw err;
}
```

`GROUNDING_FIELD` is `'grounding'`; values are `'retrieved' | 'empty' |
'none'`. Put it in the answer's provenance and show it in the UI.
Import `AI_UNAVAILABLE_MESSAGE` instead of hand-rolling the sentence.

**Wrapping a call this package does not make** (a raw `fetch`, a filter the
old client did not type): `const o = toRetrievalOutcomeError(err); if (o
instanceof Error) throw o; return o;`.

**Conformance.** `RETRIEVAL_CONFORMANCE_CASES` is a fake ai-service per status.
Run your own wrapper against it:

```ts
it.each(RETRIEVAL_CONFORMANCE_CASES)('$name', async (c) => {
  const client = new AIClient({ baseUrl: 'http://ai.local', apiKey: 'k',
    fetch: retrievalConformanceFetch(c), timeoutMs: RETRIEVAL_CONFORMANCE_TIMEOUT_MS });
  expect(await checkRetrievalConformance(c, () => myRetrieve(client))).toEqual([]);
});
```

**Migrating from 0.21–0.24.** Nothing breaks: `retrieve` and `retrieveMulti`
are unchanged. Swap each call site to the `*Outcome` method and delete the
local `catch { return [] }`. Then delete the hand-rolled
`AI_UNAVAILABLE_MESSAGE` and import this one.

## Token streaming — `client.generate.stream`

Wraps `POST /v1/generate/stream`, which token-streams a **single** unit over
SSE. Same request body as `generate.sync`.

```ts
// ⚠ Wrap the ITERATION, not just the open call — see the 402 note below.
try {
  const stream = await client.generate.stream({ unit: { unitKey: 'answer', input } });

  // Convenience form: drain, render each chunk, keep the terminal frame.
  const done = await stream.collect((text) => res.write(text));

  // Or iterate the frames yourself.
  for await (const frame of stream) {
    if (frame.type === 'delta') res.write(frame.text);
    else finalise(frame);           // frame.type === 'done'
  }
} catch (err) {
  // Both halves land here: pre-stream 400/401/429 AND mid-stream 402/spec.
  if (err instanceof BudgetExceededError) { … }
  throw err
}
```

`await client.generate.stream(...)` resolves once the response **headers** are
in. So 400, 401 and 429 throw from that `await` as the usual typed class,
before you write any iteration code.

🔴 **A budget 402 does NOT throw from that `await`.** `/v1/generate/stream`
calls `reply.hijack()` **before** it reserves budget, so the headers are
already on the wire by the time the reservation is refused. `BudgetExceededError`,
`BudgetNotConfiguredError` and `BudgetMisconfiguredError` therefore reach you
during **iteration** (or from `collect()`), as a terminal `error` frame. This
differs from `generate.sync`, where a 402 *does* come from the await. A
consumer that wraps only the open call leaks the budget rejection as an
unhandled rejection — wrap the iteration.

Every failure **after** the headers arrives as a terminal `error` frame, thrown
as **the same typed classes** (`BudgetExceededError`,
`BudgetNotConfiguredError`, `BudgetMisconfiguredError`,
`SpecResolutionError`, …), so one `catch` around open + iterate covers the
whole call. An error frame carries only `code` and `message`, so those classes'
numeric fields (`requested`, `remaining`, …) are zero when they came from
mid-stream — read `message`. A frame's `errorCode` and `retryAfterMs` are
preserved, so a `ProviderUnavailable` frame throws `ProviderUnavailableError`
with the breaker's own cool-down intact. A code this client version predates
becomes an `AIServiceError` with `body.error` set to the code and `err.code` set
to the frame's `errorCode`.

⚠ **`done.text` is authoritative and is not always the deltas concatenated.**
On a cache hit the route emits no deltas at all and the whole answer lands in
`done`. Render deltas optimistically; keep `done.text`.

The `done` frame is contractually the same payload as `generate.sync` plus the
`type` discriminator: `text`, `parsed`, `modelUsed`, `provider`, `costUsd`,
`usage?`, `finishReason?`, `traceId`, `systemPromptApplied?`, `warnings?`.
`usage` is **absent** when the provider reported no token counts — a credits
meter must fall back to its own estimate rather than bill an authoritative-
looking zero.

- `stream.httpRequestId` — the server's `x-request-id` from the response
  headers. This is the correlation id for a stream that dies mid-flight, which
  has no error body to carry one.
- `stream.abort()` / `{ signal }` — both cancel the connection **and** the
  in-flight body, which is what makes ai-service see the disconnect and refund
  the unspent budget reserve. The iterator then throws `RequestAbortedError`
  with `reason: 'cancel'`.
- `{ maxElapsedMs }` — a wall-clock cap over the whole stream, connect through
  the terminal frame. The client's `timeoutMs` covers the connect only (its
  timer clears when the headers land), so without this a stream that opens and
  then stalls is capped by nothing. On expiry the reader is cancelled and the
  call throws `RequestAbortedError` with `reason: 'timeout'`. `streamRaw`
  honours it up to the headers only. Must be a positive finite number.
- A stream that ends with neither `done` nor `error` throws an `AIServiceError`
  with `body.error === 'StreamTruncated'` — never a clean end, because a
  truncated answer the caller cannot recognise as truncated is worse than a
  failure.
- Heartbeat comment frames (`: ok`, `: ping`) are parsed and discarded.

🔴 **Never retried, at any stage, whatever `retry` the client carries.** The
rule under *Retries* below is that a POST may be retried only when the caller
supplies a `clientRequestId` the server dedupes on. `/v1/generate/stream`
cannot meet it: ai-service's request schema is `.strict()`, so a
`clientRequestId` in the body is a 400, and the route reads no such field. A
resend is a second generation and a second budget debit. There is deliberately
no opt-in knob — it would have been an option to double-spend. A caller who
wants connect-level retry owns that loop and the duplicate-charge question with
it.

### Proxying the stream onward — `streamRaw`

`client.generate.streamRaw(req, opts?)` makes the same call and hands back the
raw `Response` with the SSE body **unread**, for a consumer that re-streams
frames to its own clients rather than consuming them. You still get the bearer,
the abort plumbing and the typed pre-stream errors; you own parsing and closing
the body — including deciding whether to forward heartbeat comments (a browser
`EventSource` behind a buffering proxy wants them).

If you keep your own parser, run ours against yours:

```ts
import { GENERATE_STREAM_CONFORMANCE_CASES } from '@edc/ai-client';

it.each(GENERATE_STREAM_CONFORMANCE_CASES)('$name', async (c) => {
  expect(await drainMyParser(c.wire)).toEqual(c.expect);
});
```

Each case carries the exact bytes ai-service writes, **chunked** — a frame
split across two network reads is the bug every hand-rolled SSE parser has had
at least once. Cases cover heartbeats, split and coalesced frames, a cache-hit
`done` with no deltas, a delta whose own text contains a blank line, an unknown
frame type, a terminal error, and truncation.

## Strict structured output — `responseSchemaStrict`

With only a `responseSchema`, ai-service asks the provider for JSON mode, which
promises valid JSON and nothing more: a model can answer with the schema itself
and still pass. Add `responseSchemaStrict: true` next to the schema and the
provider constrains decoding to the schema.

```ts
const res = await client.generate.sync({
  unit: {
    unitKey: 'summary-1',
    input: { text },
    specOverride: {           // or specDefault, for a built-in
      promptTemplate: 'Summarise: {{text}}',
      model: 'openai/gpt-4o-mini',
      responseSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'owner'],
        properties: {
          title: { type: 'string' },
          owner: { type: ['string', 'null'] }, // "optional" = nullable
        },
      },
      responseSchemaStrict: true,
    },
  },
})
res.parsed // validated against the full schema, as with JSON mode
```

Rules, enforced before any budget is reserved (`400 SpecResolutionError`):

- The model must be listed. `GET /v1/capabilities` names each one as
  `strictStructuredOutput:<model id>`. Require them at boot with
  `strictStructuredOutputCapabilities(model)`.
- The schema must be inside the strict subset: a `type: "object"` root; every
  object has `additionalProperties: false` and lists every property in
  `required`; only `type`, `description`, `title`, `enum`, `const`, `anyOf`,
  `$ref`, root `$defs`, and per-type `properties`/`required`/
  `additionalProperties`, `items`/`minItems`/`maxItems`, `pattern`/`format`,
  `minimum`/`maximum`/`exclusive*`/`multipleOf`. ai-service rejects anything
  else and never rewrites the schema; the error lists every offending path.
- No silent downgrade: a refused call is an error, never a JSON-mode call.

## Capability negotiation (ADR-0004)

ai-service and its consumers are version-coupled **in both directions**, and
every environment runs its own ai-service. Declare what you require and check it
**once at boot**, so a wrong promotion order fails at deploy time with an
actionable message — instead of degrading silently (service ahead of consumer)
or throwing mid-user-action (consumer ahead of service).

ai-service is a required dependency, so the check is strict in every
environment (since 0.32.0): there is no `warn` mode and no env override.

```ts
await client.capabilities.negotiate({
  consumer: 'edc-backend',       // your product's name; only used in messages
  // Add 'specDefaultSlot' if you call client.textToSql().
  require: ['systemPrompt', 'strictParsed'],
  logger: payload.logger,
})
```

Outcomes:

| Situation | `status` | Result |
|---|---|---|
| Has everything required | `ok` | resolves |
| Reachable, lacks a required capability | `missing` | **throws** |
| Reachable but predates `/v1/capabilities` (404) | `unsupported` | **throws**, no retry |
| Unreachable / 5xx / unintelligible answer | `unreachable` | **throws** after the startup window |

The throw is a `CapabilityNegotiationError` carrying `status`, `missing`,
`consumer` and `baseUrl`. The probe retries with exponential backoff before it
concludes `unreachable`, so a briefly restarting ai-service does not fail the
boot: `attempts` (default 5), `retryDelayMs` (default 1000, doubling) and
`attemptTimeoutMs` (default 5000 per attempt). Worst case is about 40 s
(inferred from those defaults).

### The boot check itself — `createCapabilityCheck`

`negotiate()` is the question. `createCapabilityCheck` is the wrapper around it
that every consumer needs: run once per process (Payload's
`onInit` re-fires on every `next dev` reload), fail the boot when ai-service is
not configured, and expose a reset seam for tests.

```ts
// lib/capabilityCheck.ts
export const aiCapabilityCheck = createCapabilityCheck({
  consumer: 'my-app',
  // A FUNCTION: the list may depend on env, and a module-scope array is
  // captured at import time, before any test hook can change it.
  require: () => (process.env.MY_APP_BACKEND_URL ? ['ingestChunkCallback'] : []),
  client: () => getAppAIClient(),          // null ⇒ not configured ⇒ throws
})

// payload.config.ts
onInit: async (payload) => { await aiCapabilityCheck.run(payload.logger) }
```

`run()` resolves only when ai-service is configured, reachable and has every
required capability; only a passing run latches. An empty list still probes,
which proves ai-service is reachable. What stays in the product is the
required-capability **list**: it must describe what that codebase actually
does — an aspirational entry blocks boots for nothing, a missing one lets the
failure through.

## Budget failures (HTTP 402)

ai-service refuses a call with 402 for three different reasons whose remedies
are different, and the usual advice is actively wrong for one of them. Three
products each wrote 290–385 lines to sort this out, and they had drifted.

```ts
const failure = classifyBudgetFailure(err)          // null ⇒ not a budget failure
if (!failure) throw err

logger.error(budgetFailureLogFields(failure, 'generate'),
             BUDGET_FAILURE_LOG_MESSAGE[failure.kind])

// Amounts are commercially sensitive: only the owning org may see them.
const detail = mayDiscloseBudgetAmounts(failure, requesterOrgKey)
  ? `Faltan ${formatUsd(failure.shortfallUsd)}.`   // your product's copy
  : undefined
```

| `kind` | Meaning | Remedy |
|---|---|---|
| `not_configured` | No budget row exists at all | An operator provisions one. Permanent — "try again later" is a lie. |
| `exceeded` | A configured cap ran out | Top it up. |
| `misconfigured` | The row is fine; the effort profile's `estimatedCostUsdPerCall` is zero/non-finite, so no hold could bind | An **admin** fixes the profile. Provisioning or topping up will **not** help. |

`classifyBudgetFailure` walks the `cause` chain **and** falls back to
`error.name` at each level — the first because products wrap ai-client errors in
their own, the second because two hoisted copies of this package produce classes
that are not `instanceof` each other while being the same error. For code still on a bespoke `fetch`, `budgetFailureFromWire(status,
bodyText)` and `budgetFailureFromFrame(sseFrame)` classify the raw wire instead.

**No copy and no framework here on purpose.** The Spanish sentence a funcionario
reads is content and stays in the product; the classification and the disclosure
rule are machinery and live here.

## Retries

Transport-level retry, applied by `HttpClient` under every sub-API.

```ts
const client = new AIClient({
  baseUrl, apiKey,
  retry: { attempts: 3, baseDelayMs: 250, maxDelayMs: 20_000 }, // the defaults
})

await client.http.json({ path: '/v1/x', retry: { attempts: 1 } })   // opt out, one call
await client.http.json({ method: 'POST', path: '/v1/ingest', idempotent: true })
```

**Idempotent requests only, and that is not a nicety.** A retried
non-idempotent POST is a double spend: `/v1/generate` debits the org budget, so
a request that succeeded server-side but whose response was lost in transit gets
charged twice if it is resent blind. `GET` is retried (safe by HTTP semantics);
anything else needs an explicit `idempotent: true`, which is honest only when
the call carries a `clientRequestId` (ai-service dedupes on it, answering 409
`IdempotencyConflictError`) or has no side effect at all.

| | Retried | Not retried |
|---|---|---|
| **Transport** | network / DNS / socket errors | an abort — a caller cancel or a `timeoutMs` expiry stays ONE observable failure |
| **Status** | 408, 425, 429, 5xx (not 501) | every other 4xx, and 501 — a decision does not change when you re-ask |

⚠ `idempotent: true` is honest for `POST /v1/generate`, which dedupes on
`clientRequestId` and answers 409 — and **false for `POST /v1/generate/sync`,
which has no dedupe at all**. A resend there is a second generation and a
second debit.

**An explicit `timeoutMs` is per attempt, in full; `maxElapsedMs` is the
retry budget.** Set `timeoutMs` on the client, or on one call
(`http.json({ timeoutMs })`, `generate.sync(req, { timeoutMs })`), and every
attempt gets all of it. The retry budget, `maxElapsedMs` (default 30 s), then
decides only whether ANOTHER attempt — and the backoff before it — starts. So
a retried GET can take up to about `maxElapsedMs + timeoutMs`; pass
`signal: AbortSignal.timeout(ms)` for a hard ceiling over the whole ladder.

Set no `timeoutMs` and nothing changes from earlier releases: the 30 s default
attempt is cut to the budget remaining, so the whole call, retries included,
takes at most `maxElapsedMs` (30 s). `maxElapsedMs: Infinity` lifts the budget;
`timeoutMs: Infinity` disables the deadline.

🔴 Before 0.26.0 each attempt was clamped to the budget remaining, so an
explicit `timeoutMs: 120_000` became 30 s on every call, `generate.sync`
included. Upgrade if you set `timeoutMs` above 30 s.

Backoff is `baseDelayMs × 2^(n-1)` with **equal jitter** (half fixed, half
random): full jitter can collapse to ~0 and re-fire immediately, no jitter
re-synchronises every client that failed together. Every wait is abortable — a
caller that cancels mid-backoff rejects at once instead of paying out the rest
of the ladder.

**`Retry-After` longer than `maxDelayMs` means STOP.** ai-service answers
`retryAfterMs: ctx.ttl` on a 429, reaching a full 60 s window. Clamping that to
20 s and retrying early spends three requests on a bucket that is still full and
then fails anyway, so the 429 is handed back instead, carrying the server's own
`retryAfterMs` for you to honour. `Retry-After: 0`, blank, or a past date counts
as **absent** — proxies emit it as a placeholder, and obeying it literally means
hammering with no backoff at all. When it is used it gets up to 10% padding
(capped at 1 s), because every client rejected in one window was handed the same
number and firing exactly on it re-synchronises the herd.

🔴 **Ladders multiply, they do not replace.** SSE (`events.ts`) opens with a GET
and is retried by default. A caller hosted by a queue that already retries the
job — BullMQ above all — stacks its `attempts` on top of these. When a caller
already owns a retry, pass `retry: { attempts: 1 }` and let the outer one own
the policy; `CapabilitiesAPI.probe` does exactly that.

`/v1/ingest` is separately governed by the ingest gate below, which is a rate
limiter rather than a retry loop and has its own, larger, budget.

### Waiting out a rate limit: `withRetry` (opt-in, 0.34.0)

The transport ladder above hands back what it cannot honestly wait out: a 429
whose `Retry-After` exceeds `maxDelayMs` (ai-service's window is 1 minute), its
own timeout, and anything on a non-idempotent call. `withRetry` is the outer
layer for those. By default it retries a 429 and nothing else.

```ts
import { withRetry, RateLimitError, type WithRetryAttempts } from '@edc/ai-client'

try {
  const res = await withRetry(
    () => client.http.json({ path: '/v1/x', retry: { attempts: 1 } }), // one ladder, not two
    {
      signal, // cancels the wait between attempts
      onRetry: ({ attempt, waitMs }) => log.warn({ attempt, waitMs }, 'ai-service retry'),
    },
  )
} catch (err) {
  if (err instanceof RateLimitError) {
    // the ORIGINAL 429, throttled for the whole budget: record it where a person can see it
    log.error({ attempts: (err as WithRetryAttempts).retryAttempts }, 'gave up')
  }
  throw err
}
```

| Failure | Retried? | Wait |
|---|---|---|
| 429 (`status` 429 or `name` `RateLimitError`) | yes | server's `retryAfterMs`, capped at `maxRetryAfterMs`; the full cap when no hint |
| typed `retryable: true` (breaker 503, provider-timeout 504), network fault, own timeout | only with `retryTransient: true` | server's hint, else `baseDelayMs × 2^(n-1)`, same cap |
| anything not marked retryable (4xx, 500, a "database unavailable" 503), caller cancel | no, rethrown unchanged | |

The checks read the error's shape, not its class. A 429 from another copy of
this package in the same process still matches.

Every wait gets up to 25% jitter, at most 5 s, always late. Callers refused in
the same second would otherwise wake together and re-stampede the window.

The four defaults are quoted from a consumer's production retry helper, tuned
against ai-service's own limiter.

| Option | Default | Why |
|---|---|---|
| `attempts` | 4 | Total tries, first included. An integer ≥ 1 |
| `maxElapsedMs` | 120 000 | Fits one full window plus jitter, short enough for a waiting user. Wall clock, measured from the first attempt; no sleep starts that would end past it |
| `maxRetryAfterMs` | 61 000 | One ai-service window plus 1 s. A longer ask is not ai-service's limiter |
| `baseDelayMs` | 1 000 | 1 s, 2 s, 4 s rides out a restart or a breaker cool-down |
| `retryTransient` | false | Also retry the transient row above. Only for calls whose repeat is harmless |
| `signal` | none | Abort cancels the wait and rethrows `signal.reason`. It does not cancel an attempt in flight |

A non-integer, negative, `NaN` or infinite `attempts`, or a negative, `NaN` or
infinite delay option, rejects with a `RangeError` before `fn` runs.

Two unhinted 429s (61 s each) overrun the 120 s budget, so that case stops after
two attempts. When the server will not say how long, a visible failure beats
minutes of blind waiting.

On giving up it rethrows the **original last error**, so `instanceof
RateLimitError` (or `ProviderUnavailableError`) keeps working. It adds one
non-enumerable field, `retryAttempts`: the attempts made, first included. Logs
and `JSON.stringify` do not show it. Nothing is swallowed. `sleep`, `now` and
`random` are injectable, so tests need no real waits.

🔴 **`retryTransient` only for work whose repeat is harmless.** A 429 is
refused before the handler runs. A 503, a dropped socket or a timeout can mean
the work happened and the answer was lost. `POST /v1/generate/sync` has no
dedupe, so a resend is a second generation and a second debit. Leave
`retryTransient` off there.

## Errors

All HTTP failures throw a subclass of `AIServiceError`. Pattern-match the
discriminator:

| Class                          | Status | Notes                                        |
|--------------------------------|--------|----------------------------------------------|
| `BudgetExceededError`          | 402    | `org`, `requested`, `remaining`, `shortfallUsd`. Cap ran out — top up. |
| `BudgetNotConfiguredError`     | 402    | `org`. No budget row — ask the platform to provision a cap. |
| `BudgetMisconfiguredError`     | 402    | `org`, `estimatedCostUsdPerCall`. The budget row is fine; the effort profile's per-call estimate is zero/non-finite, so nothing could be held. An admin fixes the profile — surface `message`. |
| `IdempotencyConflictError`     | 409    | `existingRequestId`                          |
| `SpecResolutionError`          | 400    | `resolutionCause`                            |
| `DependencyCycleError`         | 400    | `cycle: string[]`                            |
| `CrossBatchDependencyError`    | 400    | `missing: string[]`                          |
| `CorpusNotFoundError`          | 404    | RAG retrieve only                            |
| `AuthError`                    | 401    |                                              |
| `ForbiddenError`               | 403    |                                              |
| `NotFoundError`                | 404    |                                              |
| `RateLimitError`               | 429    | `retryAfterMs` — the server's OWN stated wait. Read from the body, falling back to the `Retry-After` header. |
| `IngestRateLimitExhaustedError`| —      | not an HTTP error: the ingest gate ran out of attempts or wall clock. `corpus`, `documentIds`, `attempts`, `waitedMs`, `reason`, `lane`, `partialResults`. |
| `IngestBatchTooLargeError`     | —      | thrown before the network call: more than 100 documents in one `enqueue`. Use `enqueueAll`. |
| `AIServiceError`               | any    | base class; always has `.status` and `.body` |


## Callbacks — `@edc/ai-client/callbacks`

A separate subpath because it imports `node:crypto`, and the main entry is
bundled for the browser/edge by at least one consumer.

`signCallback` / `verifyCallbackSignature` are THE verifier. Three receivers
used to carry hand-copied ones, two of them with comments claiming to be
byte-identical to the others; both claims were false, and they had drifted on
four behaviours and on the replay window. A comment is not a control. These are:

```ts
import {
  verifyCallbackSignature,
  runCallbackVerifierConformance,
  findLocalVerifierReimplementations,
  CALLBACK_VERIFIER_CONFORMANCE_CASES,
} from '@edc/ai-client/callbacks'

// 1. BEHAVIOUR — the verifier this repo imports matches the shared cases.
//    Catches a stale package pin or a lookalike wrapper, which an identity
//    check cannot see: a stale build is still "the shared module" by identity.
expect(runCallbackVerifierConformance(verifyCallbackSignature)).toEqual([])
expect(CALLBACK_VERIFIER_CONFORMANCE_CASES.length).toBeGreaterThan(0)

// 2. SOURCE — nobody has grown a local verifier in a file nothing imports.
//    The failure mode the behaviour check is blind to.
expect(findLocalVerifierReimplementations(SRC_DIR, { exclude: [thisFile] })).toEqual([])
```

Each repo keeps only
the assertion that names its own `src/`. `node_modules`, `.next`, `dist`,
`build` and `coverage` are never walked, and the forbidden needles are assembled
at runtime so the module never reports itself.

Runtime identity — "the receiver route calls THE shared verifier" — belongs in
the receiver's own test, not here: a `toBe` between two imports of the same
module in the conformance file is a tautology that can never fail.

## Callback claims — `@edc/ai-client/callbacks/claims`

The idempotency ledger a callback receiver keeps (contract §Idempotency,
items 1-7). It imports nothing — no `pg`, no Payload, no node builtins —
and takes any `pg`-shaped `query(text, params)` as its pool, per call, so
`finish` can run inside a transaction.

```ts
import { createCallbackClaims } from '@edc/ai-client/callbacks/claims'

export const claims = createCallbackClaims({
  table: 'callback_dedupe',                    // ^[a-z_][a-z0-9_]*$
  stateColumn: 'outcome',                      // holds in_progress | done | error
  sourceEnumType: 'enum_callback_dedupe_source', // omit if `source` is varchar
  // finishExtras: { outcome: { column: 'outcome', type: 'enum_x', clearOnReclaim: true } },
})

const c = await claims.claim(pool, { source, sourceId, itemKey, event }, rawBody)
if (!c.claimed) return ok()                    // duplicate or in flight elsewhere
try {
  await dispatch()
  await claims.finish(pool, c, { state: 'done' })
} catch (err) {
  await claims.finish(pool, c, { state: 'error', detail: String(err) })
  return status(500)                           // so ai-service re-delivers
}
```

- Lifecycle `in_progress → done | error`. Reclaim is an allow-list: `error`,
  and `in_progress` older than the 120 s lease. `done`, NULL and unknown
  values are never re-claimed.
- `finish` is fenced on `claimed_at`: a zombie past its lease writes nothing.
- No degraded mode: a missing pool throws `CallbackClaimsPoolError` from every
  method. Let it become a 5xx; ai-service re-delivers.
- `findStuck(pool)` lists unfinished rows (both `in_progress` and `error`)
  past the lease, oldest first by the same age expression it filters on.
- Required columns: `id` (int), `source`, `source_id`, `item_key`
  (`NOT NULL DEFAULT ''`), `event`, `received_at`, `raw_body`, `claimed_at`,
  `attempts`, `detail`, `created_at`, `updated_at`, the state column, and a
  UNIQUE index on `(source, source_id, item_key, event)`.
- ⚠ The unique index is required for concurrency. `WHERE NOT EXISTS` alone
  let 4 of 8 parallel claims through (measured, repo integration
  suite).

Run the conformance cases against your real table in your integration suite:

```ts
import { CALLBACK_CLAIMS_CONFORMANCE_CASES } from '@edc/ai-client/callbacks/claims'
it.each(CALLBACK_CLAIMS_CONFORMANCE_CASES)('$name', (c) => c.run({ claims, pool }))
```

## Ingest gate

`POST /v1/ingest` lands on ai-service's **100/min per API key** bucket (the
30/min figure is generate/retrieve/route only). That bucket is shared with
`GET /v1/ingest/:id` status polls, `/v1/embed`, `/v1/corpora*`, `/v1/budget` and
the registry routes.

Every ingest this package sends is admitted by a **process-wide gate** that
bounds rate, concurrency, retries and wall clock. It lives *below*
`client.ingest`, so no call site can bypass it, and it counts **HTTP requests,
not documents** — a caller handing over one document at a time is bounded
exactly as hard as one sending a hundred.

### Defaults

| Knob | Default | Why |
|------|---------|-----|
| `maxPerWindow` / `windowMs` | 40 per 60 000 ms, **sliding** | 40% of the server bucket. The other 60% is reserved for status polls, budget and corpora calls on the same key. Sliding, not fixed: our window and the server's are unaligned, so a fixed window could put 2× the budget inside one of theirs. |
| `interactiveReserveShare` | 0.25 (10 of 40) | Bulk may never take the last 25% of a window; interactive may use all of it. Lanes alone only reorder the queue — once bulk has spent the window, an upload arriving next waits for a stamp to age out and fails after its 15 s queue budget. |
| `maxConcurrent` | 4 | Ingest is an enqueue (202), so concurrency hides latency, it does not buy throughput. |
| `maxAttempts` | 5 | Bounded, and sized against the server's real hint (up to 59 s), not a short fixed ladder. |
| `deadlineMs` (RETRY budget, from the first attempt) | `interactive` 30 s · `bulk` 5 min | A person holding a connection fails fast; background work can outlast a busy window. |
| `queueDeadlineMs` (QUEUE budget, waiting for the first slot) | `interactive` 15 s · `bulk` 45 min | **Deliberately separate.** Folded together, the last call of a large seed fails with `deadline` having never been attempted — a silent partial seed. |
| `busyMessage` | neutral English | User-facing wording is CONTENT. Set your own if you show it to a person. |
| `logger` | none | **Set it.** A gate parked for a minute in silence looks like a hang. |

### Lanes

```ts
await client.ingest.enqueue(req);                    // 'interactive' (default)
await client.ingest.enqueue(req, { lane: 'bulk' });  // seeds, backfills, hooks
```

`interactive` is admitted first and fails fast; `bulk` waits its turn. **Pass
`'bulk'` from every seed, backfill and background hook** — a seed left on the
default lane jumps ahead of real users and gives up after 15 s of queueing.

### Configuring it

```ts
import { configureIngestGate } from '@edc/ai-client';

configureIngestGate({
  maxPerWindow: 25,
  busyMessage: 'El servicio de IA está ocupado. Intenta de nuevo en un minuto.',
  logger: (e) => log.warn(e, 'ai-service ingest gate'),
});
```

Call it once at startup — before or after building clients; it reaches gates
that already exist. `new AIClient({ ingestGate: {...} })` does the same for one
client's scope.

Gates are scoped per `(baseUrl, apiKey)` by default, because the server's
limiter is keyed on the API key: two keys have two independent server-side
buckets, and one shared gate would halve each one's throughput and let a 429 on
one key park the other. Override with `ingestGateScope`.

The registry lives on `globalThis` under a `Symbol.for` key so it survives
Next.js evaluating the same module in several bundles. A per-bundle gate would
mean two gates each honouring 40/min against one 100/min limit.

### Batching

`enqueueAll` chunks to ai-service's 100-document schema cap and returns **one
`IngestResult` per batch**, sequentially, with an `onBatch` hook:

```ts
const results = await client.ingest.enqueueAll(
  { corpus: 'laws', documents: manyDocs },
  { lane: 'bulk', onBatch: (r, docs) => recordIngestId(r.ingestId, docs) },
);
```

🔴 The gate **never coalesces separate calls into one batch**, and neither does
`client.ingest`. ai-service returns one `ingestId` per call; its per-document
callbacks carry `docId`, but a consumer that joins them on `(ingestId, corpus)`
alone strands N−1 rows at `indexing` while all N callbacks report success.
Coalescing is the opt-in `IngestBatcher` below.

### Coalescing bulk writes: `IngestBatcher`

For hooks that ingest one edited row at a time. It groups documents by their
batch-level request (corpus, `callbackUrl`, `embeddingModel`, …), keeps the
**last write per document `id`**, and sends one `bulk` call per group after
`quietMs` of silence, after `maxWaitMs` at most, or at once at `maxBatch`
(100). One batch per group is in flight at a time, so a re-written document is
never raced against its previous version.

```ts
import { IngestBatcher } from '@edc/ai-client';

const batcher = new IngestBatcher({
  ingest: client.ingest,
  onError: ({ request, documents, error, result }) =>
    markFailed(request.corpus, documents.map((d) => d.id), error), // required
  onBatch: (result, documents) => recordIngestId(result.ingestId, documents),
  // quietMs: 2_000, maxWaitMs: 10_000, maxBatch: 100, maxBuffered: 10_000
});

batcher.add({ corpus: 'project-42' }, { id: 'row-7', text });   // returns at once
// On shutdown — sends what is pending and waits for every batch to settle:
await batcher.close();
```

- **Prerequisite:** your ingest-callback handler must find the row by the
  callback's `docId`, not by `ingestId`. Callers that send no `callbackUrl` are
  safe today.
- **No silent drops.** Every document ends in `onBatch`, `onError`, or a
  synchronous throw from `add`: no `id` (`TypeError`), after `close()`, or
  `IngestBatcherFullError` once `maxBuffered` documents are pending or in
  flight. An `onBatch` that throws is reported to `onError` with `result` set,
  meaning the batch DID land.
- Timers are not `unref()`ed, so a CLI stays alive until the batcher is flushed.

### Testing against it

```ts
import { IngestGate, _setIngestGateForTests, _resetIngestGatesForTests } from '@edc/ai-client';

beforeEach(() => _resetIngestGatesForTests());
// No scope = a process-wide override every client uses, whatever its key.
_setIngestGateForTests(new IngestGate({ maxPerWindow: 3, windowMs: 100 }));
```

🔴 Pass **no scope**. A client derives its gate scope from `(baseUrl, apiKey)`,
so a gate installed under a named scope your client does not use is silently
ignored — the suite then runs against the real 40/min budget and looks like a
hang. Note the reset helper is plural: `_resetIngestGatesForTests`.

### Failure

On exhaustion the gate throws `IngestRateLimitExhaustedError`, naming the corpus
and **every document id** that did not land (never a bare batch index), plus any
batches that *did* land before the failure:

```ts
catch (err) {
  if (err instanceof IngestRateLimitExhaustedError) log.error(err.describe());
}
```

Errors that are not rate limits (budget, 400, network) propagate unchanged and
immediately — the gate is a rate limiter, not a general retry loop.

## Credits

`toCredits(usd, rate)` converts USD spend into integer credits. Rounds up
(ceil) so consumers never under-count. `rate` is credits-per-USD.

## SSE notes

Two endpoints stream: `client.events(channel)` (progress events) and
`client.generate.stream(...)` (tokens — see *Token streaming* above).

`client.events(channel)` opens `GET /v1/events/:channel` with the bearer
token. The 15-second heartbeat from the server (`: ping`) is parsed and
discarded. Call `events.close()` to abort the underlying request; the
`events.closed` promise resolves once the stream is fully drained.

## Publishing

Publish only with `bash scripts/publish-ai-client.sh` from the repo root — never
`npm publish` by hand. The repo's root `.npmrc` sets `ignore-scripts=true` as
deliberate hardening, and that flag suppresses this package's `prepack: tsc` on
every `npm pack` and `npm publish`, so a bare publish ships three files and no
`dist/` while `main`, `types` and `exports` all point into `dist/` — an
installable tarball that cannot be imported. (A `prepublishOnly` hook would be
suppressed by the same flag, which is why the build has to be an explicit step.)
The script builds the client, asserts the tarball actually contains `dist/`, and
runs `npm publish --dry-run` unless you pass `PUBLISH_CONFIRM=yes`. It also
refuses to run on a dirty tree or on a commit that is not contained in
`origin/main`. CI runs the same assertion in `test.yml`'s `build` job, so an
unpublishable tree goes red before anyone reaches for the script.
