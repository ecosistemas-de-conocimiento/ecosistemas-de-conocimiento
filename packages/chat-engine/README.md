# @edc/chat-engine

Domain-agnostic chat/RAG engine: the logic that turns a user message plus a
context scope into a grounded, cited assistant turn — and the Svelte components
that render it.

One package, **two build outputs**:

- **`@edc/chat-engine` / `@edc/chat-engine/core`** — backend-agnostic
  TypeScript: mention parsing, query condensation, thread titling, retrieve
  orchestration, the user-turn assembly (the load-bearing context invariant),
  the generic **corpus-sync** scaffolding, and the **`DomainAdapter`** seam +
  injected **`EngineConfig`** / **`KindRegistry`**. No `svelte`, no DOM, no
  backend SDK — so the Payload backend can import it too.

- **`@edc/chat-engine/svelte`** — the SvelteKit component library
  (`ChatMentionMenu`, `ContextChips`, `MessageContent`, `ContextHeader`,
  `CitationCard`). Labels, glyphs, navigation and search are injected as
  props/config; no component reaches into a store, a route, or an i18n bundle.

  `CitationCard` is the canonical citation surface: clickable `[N]` markers →
  inline cards with the quoted passage (`<blockquote>`), source title, and an
  injected link to the original asset, plus a "Fuentes consultadas" list. It
  shows no relevance number (≥0.6.0). Feed it `CitationLike[]` — use the core
  `provenanceToCitations(provenance)` helper to map engine `Provenance`.
  Before any provenance leaves your server, pass it through
  `toBrowserProvenance(provenance)` (≥0.8.0): an allowlist of the fields the
  card reads, so raw ingest metadata stays server-side.

## Workspace package — not published

This is a **private workspace package**. It is never installed from a registry
and never copied as a tarball; `pnpm` links it from `packages/chat-engine`.
The consumer in this repo is `apps/web` (both subpaths) and `apps/backend`
(`./core` only).

Depend on it as:

```json
"@edc/chat-engine": "workspace:*"
```

## Build

`exports` points at `dist/core` and `dist/svelte`, neither of which is
committed — **the package resolves to nothing until it has been built**:

```bash
pnpm --filter @edc/chat-engine build
# or, from the repo root, build everything in dependency order:
pnpm build
```

`build` runs, in this order:

```
tsc -p tsconfig.core.json && svelte-package -i src/svelte -o dist/svelte
```

The order matters. The Svelte components import their types through the package
self-reference `@edc/chat-engine/core`, which the `exports` map resolves to
`dist/core` — so **core must be built before svelte**. `pnpm build` already
orders this; `build:svelte` on its own will fail on a clean tree.

Other scripts: `build:core`, `build:svelte`, `typecheck`, `test` (vitest, core
only — the Svelte layer is covered by the consumer's Playwright suite), `clean`.

### Why the peer deps are optional

`svelte` and `@sveltejs/kit` are **optional peerDependencies** so that the
Payload backend, which imports `./core` only and has no Svelte installed, does
not error on install. `sideEffects` lists `*.css` / `*.svelte` so a core-only
import tree-shakes all component CSS away.

### Theming

Components hardcode no colors; they read the shared `--edc-*` CSS custom
properties, which the consumer supplies (`apps/web` defines them in
`src/lib/design/tokens.css`). The `--edc-` prefix is historical — treat it as
the shared design-token namespace. Renaming it means changing both this package
and every consumer in the same commit.

### The `scopeId` shim

The engine's injected `AIClient` seam uses domain-neutral `scopeId`, while the
`@edc/ai-client` wire client uses `projectId`. A consumer wiring the real client
supplies a thin adapter that maps `scopeId → projectId` (and forwards the
optional `/v1/retrieve` `filter` field). The engine has no notion of "project"
on purpose — see `apps/web/src/lib/server/engine/aiClient.ts`.

## 0.4.3 — `prepublishOnly` stopped calling a script this repo deleted

No code moved; the diff against 0.4.2 is one line of `scripts.prepublishOnly` plus the CI
workflow and this note. The hook used to shell out to `scripts/ci/suite-census.mjs` twice
(`--suite unit`, then `--verify-all --workflow ci`). That script is deleted on this branch, so
the old hook would have died on `MODULE_NOT_FOUND` and made every hand-typed `npm publish`
from this repo fail. It is now `npm run typecheck && npm run build && npm test` — the same
three gates `verify.yml` runs, invoked directly. ⚠ This supersedes the census description in
the 0.4.1 note below.

⚠ **Committed, not published.** The version exists because `guard-version-bump` reads any
non-`version` edit to `package.json` as shipped source moving — the same reason 0.4.1 exists.
Publishing here is `workflow_dispatch` only (see `DISTRIBUTION.md`), so a number in this file
says a tree was committed, never that a tarball was served. Check `dist-tags.latest` on GitHub
Packages before assuming a consumer has it.

## 0.4.1 — a publish typed by hand now runs the gate

No code moved. `prepublishOnly` runs the same list `verify.yml` runs, in the same order —
typecheck → the unit suite under `suite-census` → `--verify-all` → build — so `npm publish`
or `pnpm publish` from a laptop cannot skip the checks a merge cannot skip. That path
reaches no workflow file, and under the fleet's no-pinning rule every consumer resolves
`latest`: a publish from a red tree lands on all of them at their next install without
anyone choosing to take it.

🔴 **Watched refuse, then watched pass**. With one assertion in
`src/core/citation.test.ts` flipped to a wrong expectation, `npm publish --dry-run` stopped
at census C1 — exit 1, no tarball, `prepack` never reached. Restored, it packs 0.4.1.
MEASURED on npm 11.19.0 and pnpm 9.15.9: both run the hook FIRST, before `prepack`.
⚠ `npm pack` does NOT run it — pack is gated by `prepack`, a separate script.

⚠ **0.4.1 is not published.** The version exists because `guard-version-bump` correctly
reads any non-`version` edit to `package.json` as shipped source moving. Until someone runs
the publish workflow, a consumer still installs 0.4.0.

## 0.4.0 — behaviour change in the default prompt

`DEFAULT_ENGINE_CONFIG.userContextPreamble` changed, so **every consumer that spreads
`DEFAULT_ENGINE_CONFIG` gets different model behaviour on upgrade** even though no API
changed. Two things moved:

1. **It can now admit a fact is missing.** The old default banned saying "I have no
   information" without qualifying it to the context that is present, so a model asked for
   a number absent from the context would count what it could see and answer confidently.
   The instruction is now scoped: use what is below, and say plainly when something is not
   below. Numbers are gated on being written or derivable, never on being countable.
2. **The directive is English; the block headers stay Spanish.** The preamble is machinery
   (the engine instructing the model). `blockHeaders` and `teamInstructionsHeader` are
   content — labels on product prose the model can echo — so they follow the product's
   locale. The preamble now states the reply language explicitly so an English directive
   cannot pull answers into English.

`systemPrompt` also stopped hard-coding `Responde en español`; it now says "same language
as the user", matching `condenseSystemPrompt` and `titlePrompt`.

⚠ Prompt behaviour is **not** verified by the unit suite — those tests only pin strings.
See [`harness/README.md`](./harness/README.md) for the old-vs-new experiment against a real
model, what it costs, and what is still unmeasured.

## The one seam: `DomainAdapter`

The consumer implements this against its own data layer; the engine stays
domain-blind:

```ts
interface DomainAdapter {
  searchEntities(kind: string | undefined, query: string, scope: ContextScope): Promise<ContextSearchResult[]>;
  resolveEntity(ref: ContextRef): Promise<string>;            // → clean text
  scopeHierarchy(scope: ContextScope): Promise<ResolvedScope>; // → { summaryText, corpora }
  syncEntity(ref: ContextRef): Promise<void>;
  backfill(scope: ContextScope): Promise<void>;
  summary(scope: ContextScope): Promise<string>;
}
```

`apps/web/src/lib/server/engine/adapter.ts` is the implementation in this repo.

## Corpus ingest (`core/corpus-sync.ts`)

The engine owns the ingest MECHANISM; the product owns the CONTENT. Supply an
`EntitySource` — `docsForEntity(ref)` and `entitiesInScope(scopeId)`, both
returning `CorpusBatch[]` / `ContextRef[]` — and drive it with:

- `syncEntity(aiClient, source, ref)` — one entity, on the write path.
  Every batch is attempted, but since 0.5.0 a failure REJECTS with a
  `CorpusSyncError` — a fire-and-forget caller must attach its own `.catch`.
- `backfillScope(aiClient, source, scopeId)` — every entity in a scope,
  sequentially. For an offline/boot job, **not** the write path.

`CorpusDoc.id` is the stable dedupe key: re-syncing the same id REPLACES the
document rather than duplicating it. This is the seam the advanced-RAG ingest
path builds on.

⚠ Two different `syncEntity`s, on purpose. `DomainAdapter.syncEntity(ref)` is
the product's hook — what `respond()`'s callers reach for. The free
`syncEntity(aiClient, source, ref)` above is the mechanism. The usual wiring is
to implement the adapter method by calling the free function with your
`EntitySource`. Same for `DomainAdapter.backfill` and `backfillScope`.

## Optional extension point: `graphProvider` (≥0.7.0)

A consumer with a second, non-vector retrieval path (a knowledge graph, say)
can pass `RespondArgs.graphProvider`. Omit it and nothing changes.

```ts
type GraphProvider = (condensedQuery: string) =>
  Promise<{ chunks?: RetrievedChunk[]; context?: string } | null>;
```

- It runs concurrently with the vector/hybrid retrieve, on the condensed query.
- Its `chunks` are fused with the retrieved matches by `fuseMatches`
  (Reciprocal Rank Fusion, k=60). A hybrid result is fused by its server order,
  never re-sorted by score.
- Its `context` string is injected verbatim into the user turn, under
  `EngineConfig.blockHeaders.graph`, after the summary and before the
  retrieved block. It carries no `[N]` markers, so citation numbers do not move.
- `PreparedTurn.maxDenseScore` ignores graph chunks: their `score` is on the
  provider's own scale, not a cosine.
- A provider that throws or rejects warns `graph.failed` and the turn proceeds
  without it. Timeouts are the provider's job.

What the graph holds, and how it is queried, stays in the consumer.
