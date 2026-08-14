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
  inline cards with the quoted passage (`<blockquote>`), source title, an
  injected link to the original asset, and a relevance %, plus a "Fuentes
  consultadas" list. Feed it `CitationLike[]` — use the core
  `provenanceToCitations(provenance)` helper to map engine `Provenance`.

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
  Fire-and-forget: a slow or down ai-service is swallowed and never propagates.
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
