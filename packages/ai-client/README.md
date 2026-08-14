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

- `client.generate` — `enqueue`, `sync`, `get`, `getUnitLatest`, `cancel`
- `client.registry` — `getConfig`, `putConfig`, `listUnitTypes`,
  `listVersions`, `getVersion`, `createVersion`, `activateVersion`
- `client.ingest` — `enqueue`, `status`
- `client.retrieve` — `retrieve`
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
- `client.embed` — `embed`
- `client.budget` — `get`
- `client.admin` — `getOpenRouterCredits` (admin-role token required)
- `client.events(channel)` — typed SSE stream
- `client.capabilities` — `get`, `negotiate` (boot-time capability check, ADR-0004)
- `isReadOnlySelect(sql)` / `guardReadOnlySelect(sql, rowLimit?)` — exported
  PURE functions (no client instance needed): reject DML/DDL, `;`-chains, and
  `--`/`/* */` comments; require a leading `SELECT`; auto-append a `LIMIT`.

## Capability negotiation (ADR-0004)

ai-service and its consumers are version-coupled **in both directions**, and
every environment runs its own ai-service. Declare what you require and check it
**once at boot**, so a wrong promotion order fails at deploy time with an
actionable message — instead of degrading silently (service ahead of consumer)
or throwing mid-user-action (consumer ahead of service).

```ts
import { AIClient, capabilityModeFromEnv } from '@edc/ai-client'

// Only when AI is enabled — a consumer configured without ai-service must keep
// starting and working exactly as before.
await client.capabilities.negotiate({
  consumer: 'edc-backend',
  // Add 'specDefaultSlot' if you call client.textToSql().
  require: ['systemPrompt', 'strictParsed'],
  mode: capabilityModeFromEnv(), // strict in production, warn elsewhere
  logger: payload.logger,
})
```

Outcomes:

| Situation | `status` | Result |
|---|---|---|
| Has everything required | `ok` | continues |
| Reachable, lacks a required capability | `missing` | **throws** in `strict`, warns in `warn` |
| Reachable but predates `/v1/capabilities` (404) | `unsupported` | **throws** in `strict`, warns in `warn` |
| Unreachable / 5xx / unintelligible answer | `unreachable` | **always continues**, logged loudly |

That last row is deliberate: an unreachable service is *not* evidence a
capability is missing, and blocking boot on a briefly-restarting dependency
would be a worse failure than the mis-promotion this check exists to catch.
Retries use exponential backoff (3 attempts by default); a 404 is definitive and
is never retried.

`AI_CAPABILITY_MODE=strict|warn` overrides the mode in any environment.

## Errors

All HTTP failures throw a subclass of `AIServiceError`. Pattern-match the
discriminator:

| Class                          | Status | Notes                                        |
|--------------------------------|--------|----------------------------------------------|
| `BudgetExceededError`          | 402    | `org`, `requested`, `remaining`, `shortfallUsd` |
| `IdempotencyConflictError`     | 409    | `existingRequestId`                          |
| `SpecResolutionError`          | 400    | `resolutionCause`                            |
| `DependencyCycleError`         | 400    | `cycle: string[]`                            |
| `CrossBatchDependencyError`    | 400    | `missing: string[]`                          |
| `CorpusNotFoundError`          | 404    | RAG retrieve only                            |
| `AuthError`                    | 401    |                                              |
| `ForbiddenError`               | 403    |                                              |
| `NotFoundError`                | 404    |                                              |
| `AIServiceError`               | any    | base class; always has `.status` and `.body` |

## Credits

`toCredits(usd, rate)` converts USD spend into integer credits. Rounds up
(ceil) so consumers never under-count. `rate` is credits-per-USD.

## SSE notes

`client.events(channel)` opens `GET /v1/events/:channel` with the bearer
token. The 15-second heartbeat from the server (`: ping`) is parsed and
discarded. Call `events.close()` to abort the underlying request; the
`events.closed` promise resolves once the stream is fully drained.
