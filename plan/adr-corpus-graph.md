# ADR — Corpus graph and GraphRAG for Ecosistemas de Conocimiento

## 0. 🔴 AMENDMENT (2026-08-28, after the first build pass) — read this before §1

This ADR was written against `main` at `6b0117f`. **While it was being implemented, another session
advanced `main` by eight commits and shipped two of the things this ADR planned.** The body below is
left as written, because the reasoning still holds and the graph design is unaffected; this section
records exactly what is now wrong in it.

### What already exists on `main`, and supersedes parts of this document

| Commit | What it shipped | Which section it overrides |
| --- | --- | --- |
| `fd52489` | **Voces, the Investigador role, and the anonymisation gate** — including `documents.contentKind` and `apps/backend/src/lib/contentKind.ts` | § 3 in full, § 1.2.6 |
| `239ba31` | **`/biblioteca`** — the ecosystem library, list plus a `/biblioteca/[id]` detail page | § 9 step 2 |
| `b3fbcce` | `documents.session` goes `hasMany` | § 12.1 |

### § 3 — `contentKind` is no longer ours to add

The field exists, with **exactly the vocabulary this ADR specified** (`documento | testimonio |
conversacion`) and the same reasoning about not overloading `kind`. It is already applied to
`edc_backend`, and `apps/backend/src/lib/contentKind.ts` owns the single chunk-metadata builder that
every ingest path shares — which is better than the three separate call sites § 3 described, because
the publish move rebuilds its metadata and could otherwise drop the key silently.

**Consequence for the graph: none, except that the column is theirs.** The person rule (§ 5.3) keys
off it exactly as designed. 🔴 It now spans two features, so it is worth saying out loud in both
places: *`documents.contentKind` is a privacy control for the graph, not a label.* Changing its values
or its semantics silently weakens the rule that a testimonio never produces `persona` nodes.

### § 1.2.6 — the recorded Voces decision is WRONG and is withdrawn

This ADR recorded: *"the default consent level is `anónimo`"*, following
`plan/anonimizacion-y-voces.md` §3.4's rule that the default must be the most protective option.

`fd52489` decided something better and the ADR defers to it:

> **There is no `subject` field and no consent level. At all.** Not a name, not a code, not a hidden
> column. The reasoning: *a stored subject IS a re-identification map* — the same argument
> `plan/anonimizacion-y-voces.md` §3.2 already used to reject storing a pseudonym map, applied one
> level up. One rule, so there is no default a bulk upload can get wrong.

That removes the question § 1.2.6 answered rather than answering it, and it is strictly safer. It also
reinforces § 7.3.4 here: this ADR independently decided not to store snippets for a testimonio, on the
same "data you do not hold cannot leak" reasoning. Two features arrived at the same principle
separately, which is a good sign it is the right one.

### § 9 — the list view is shipped, by someone else, at a different path

`/biblioteca` exists and is more thorough than what § 9 step 2 asked for: a list **and** a detail page,
its own BFF routes, and 183 tests. 🔴 It drops a testimonio's contributor **server-side, before
serialisation**, so the name never reaches the browser — stricter than anything this ADR required.

⚠ Note one deliberate difference from what § 6 assumed. `/biblioteca` filters
`publicationStatus = 'published'` and shows **no drafts at all**, including the caller's own. This ADR
assumed the list view would follow `visibleToCaller`'s "published plus my own drafts" semantics. Their
choice is safer and the reason is good — on a page titled *"lo que ha publicado tu ecosistema"*, a
draft reads as shared. The graph view follows their precedent: **published only, for everyone.**

### What this ADR still uniquely owns

Nothing on `main` touches any of it: the graph schema (§ 4), extraction and the person rule (§ 5),
minimum support and the re-identification answer (§ 7), GraphRAG fusion (§ 8), and the graph view.

### Two defects found on `main` while checking the overlap

Both confirmed by reading `main`, both outside this ADR's scope, both cheap:

1. **`chatCitationHref()` still returns `null`** (`apps/web/src/lib/engine/client.ts`), so chat
   citations are still not clickable — even though `/biblioteca/[id]` now exists and is exactly the
   route its own comment says is missing. Both retrieval paths carry the Payload document id in
   `metadata.docId`. One line.
2. **The focus ring on `admin/DocumentsTable.svelte:188` does not render.**
   `--edc-focus-ring` is defined as a **colour** (`tokens.css:187`, a `color-mix(...)`), and every
   other one of the ten call sites uses it as `box-shadow: 0 0 0 3px var(--edc-focus-ring)`. That one
   line uses `outline: var(--edc-focus-ring)`, which is not a valid `outline` shorthand, so the
   declaration is dropped and keyboard focus is invisible on that table. An accessibility defect.


**Status:** Accepted (owner decisions of 2026-08-28 folded in). Implementation follows in this branch.
**Supersedes nothing.** Constrained by `plan/anonimizacion-y-voces.md`.
**Brief:** `plan/prompt-corpus-graph.md`.

---

## 1. Context

The product is a multitenant Spanish-language knowledge repository. One `organizations` row **is** an
ecosistema (`apps/backend/src/lib/corpus.ts:7-9`). Members upload documents and audio; audio is
transcribed; everything lands as a private draft; publishing shares it with the ecosistema. People
chat over the corpus with RAG.

**Nothing about a graph exists today.** Verified three ways: no `entities`/`mentions`/`relations`
tables in either database, no entity extraction anywhere, and `packages/chat-engine/src/core/corpus-sync.ts`
— the "closest seam" named in the brief — is an *unwired interface*: no `EntitySource` is implemented
anywhere in the repo, and `apps/web/src/lib/server/engine/aiClient.ts:126-128` stubs the ingest side to
`{ ingested: 0 }`. It is scaffolding for a mechanism this product's Documents hook already owns
directly. **We do not build on it.** (§ 4.3 explains why.)

### 1.1 What the existing stack gives us for free

| Fact | Where | Why it matters here |
| --- | --- | --- |
| Two separate Postgres databases: `edc_backend` (Payload) and `edc_ai` (ai-service) | `infra/.env` | The graph must pick a side. |
| `chunks.metadata` is `jsonb` with a GIN `jsonb_path_ops` index | `services/ai-service/src/db/schema/index.ts:875-895` | Metadata filtering is free and indexed — but containment-only (`@>`), no `IN`, no ranges. |
| `documents.external_id` is UNIQUE per corpus; re-ingest **replaces** | `services/ai-service/src/workers/ingest.worker.ts:253-306` | Stable document identity across re-ingest already exists. |
| `chunks.id` is a fresh uuid on **every** re-ingest | `ingest.worker.ts:270` | 🔴 `chunkId` is NOT a stable key. The graph must never store one. |
| `POST /v1/generate/sync` supports `responseSchema` with a strict parsed gate | `services/ai-service/src/services/ai/router/router.ts:120-135` | `parsed` is surfaced only if it validates against the full JSON Schema. Free structured-output guarantee. |
| Default model is `deepseek/deepseek-chat-v3.1` at all four effort tiers | `services/ai-service/src/services/registry/resolve.ts:99-145` | Confirmed-reliable for structured JSON here; `kimi-k2` was removed for degenerate output. |
| `POST /v1/retrieve` returns full chunk `metadata` and accepts `filter` + `asOf` | `src/services/rag/retrieve.ts:471-491, 900-921` | The vector path already carries everything a citation needs. |
| Retrieval fusion inside ai-service is pure RRF, no weights | `src/services/rag/retrieve.ts:126-201` | The house answer to non-commensurable scores. We copy it. |
| ai-service has **no chunk enumeration API** | `src/services/rag/corpus-crud.ts:70-92` | A backfill cannot iterate the corpus from ai-service. It must read Payload rows. |
| `visibleToCaller` returns bare `true` for a platform admin | `apps/backend/src/collections/Documents.ts:83-107` | 🔴 Access control is not a tenant filter. Every graph query scopes by `organization` explicitly. |
| No job queue in `apps/backend` — ingest is `setImmediate` + a retry ladder | `apps/backend/src/collections/Documents.ts:333-337, 420` | Extraction has nowhere durable to run. It copies the existing pattern and is made observable + retryable instead. |
| `apps/web` is SvelteKit 2 / Svelte 5 runes, SSR disabled app-wide | `apps/web/src/routes/+layout.ts:5-6` | New pages follow the proven `/admin` shape: `+page.server.ts` load → dumb `.svelte`. |
| Spanish copy lives in plain `.ts` modules, not in `.svelte` | `apps/web/src/lib/components/admin/summary.ts:1-22` | So vitest (node env, no DOM) can assert it. New copy follows. |

### 1.2 Owner decisions this ADR is built on

From `plan/prompt-corpus-graph.md` and the session of 2026-08-28:

1. Purpose is **analysis** — find patterns across testimonies. Scale is **hundreds** of documents.
2. Node types: temas · lugares · eventos/procesos · organizaciones. Person nodes **only** from
   non-testimonial sources.
3. Extraction runs **on ingest, per document**, in the same place as the anonymisation scrub —
   `apps/backend`, as domain logic (`plan/anonimizacion-y-voces.md` §3.5).
4. **GraphRAG is a requirement, not an experiment.** Always use both paths and fuse. No routing.
   Silent fallback. No formal evaluation.
5. 🟡 **NEW — path logging is dropped.** The brief mandated logging which path produced each answer's
   context, justified as "what makes the decision reversible". The owner has ruled that reverting
   GraphRAG is not on the table, so that justification is void and the requirement is withdrawn.
   Provenance of a chunk is still carried (`metadata.path`), because **fusion has to dedupe across the
   two paths and therefore has to know where a chunk came from**. That is a mechanism, not an audit
   trail: nothing extra is written, logged or surfaced.
6. 🟡 **NEW — Voces scope is the content-type field only.** `subject` / `onBehalf` / consent level and
   the `Investigador` role are explicitly deferred. The recorded decision for when they are built:
   **the default consent level is `anónimo`**, per `plan/anonimizacion-y-voces.md` §3.4's own rule that
   the default must be the most protective option.
7. 🟡 **NEW — one view, not two.** The brief asked for a member view and an internal team view. The
   owner has ruled: **one view in `apps/web`, visible to every role.** § 7 works through what this
   changes, and it is not cosmetic.

---

## 2. Decision summary

| # | Decision |
| --- | --- |
| D1 | Add `documents.contentKind` (`documento` \| `testimonio` \| `conversacion`) as a **new** field. Do not overload the existing `kind`. |
| D2 | Store the graph in `edc_backend` as three Payload collections. Read aggregates with raw SQL through `payload.db.drizzle`. |
| D3 | Extract in `apps/backend` via `POST /v1/generate/sync` with a `responseSchema`, windowed over long documents. |
| D4 | The person rule is enforced **twice**: a schema without `persona` for testimonios, and an unconditional post-filter keyed on the column. |
| D5 | Graph identity is `(organization, type, canonicalKey)`. Re-extraction replaces a document's mentions and relations wholesale. |
| D6 | Every shared read is gated by `publicationStatus = 'published'` **and** a minimum-support threshold `GRAPH_MIN_SUPPORT` (default 3). |
| D7 | GraphRAG fuses a graph-expanded retrieve with the vector retrieve using **RRF**, and adds a deterministic graph summary block. Both paths run concurrently. |
| D8 | The graph view is ranked lists plus an SVG ego-network, not a force-directed hairball. No new charting dependency. |
| D9 | Ship order: `contentKind` → list view → extraction + storage → GraphRAG → graph view. |

---

## 3. D1 — the content-type field

### The problem the brief did not know about

`plan/prompt-corpus-graph.md` §"Every ingested chunk carries a `kind`" asks for a `kind` of
`documento · testimonio · conversacion`. **`documents.kind` already exists and means something else** —
`markdown | pdf | docx | audio`, a *file format* (`apps/backend/src/collections/Documents.ts:1071-1087`;
Postgres enum `enum_documents_kind`). It is load-bearing: `INGESTABLE_KINDS` gates the ingest hook
(`:298`), `kindLabel()` renders it in the admin table
(`apps/web/src/lib/components/admin/summary.ts:171-182`), and it is written into chunk metadata as
`metadata.kind` (`:629`).

### Decision

Add a **separate** field `contentKind`, enum `documento | testimonio | conversacion`, `NOT NULL
DEFAULT 'documento'`, indexed. It rides into ai-service chunk metadata as `metadata.contentKind`,
alongside — not replacing — `metadata.kind`.

```
documents.kind         →  HOW it arrived   (markdown | pdf | docx | audio)
documents.contentKind  →  WHAT it is       (documento | testimonio | conversacion)
```

### Consequences

- ✅ Zero ai-service change. The key rides in `documents[].metadata`, lands on every chunk via
  `mergeChunkMetadata` (`ingest.worker.ts:60-66`), is covered by the existing GIN index, and is
  filterable today as `filter: { contentKind: 'testimonio' }`.
- ✅ Existing chunks keep working. A chunk ingested before this change has no `contentKind` key; a
  filter on it simply excludes them, which is correct — they predate the distinction.
- ⚠ Backfill: existing rows take the `documento` default. That is the right default and the honest
  one, since no testimony has ever been uploaded.
- ⚠ `conversacion` has no producer yet either — conversation ingestion is unbuilt
  (`plan/anonimizacion-y-voces.md` §3.0). The value exists so the graph's rules and the list view's
  filters are written once, not twice.
- 🔴 **The person rule keys off this column, so the column is a privacy control, not a label.** It is
  set server-side on create and is not user-writable after the fact without re-extraction (§ 5.3).

---

## 4. D2 — storage

### Decision: `edc_backend`, as Payload collections, with raw SQL for aggregates

Three collections: `graphEntities`, `graphMentions`, `graphRelations`. Not a graph database. Not
`edc_ai`.

### Why not a graph database

Hundreds of documents means low thousands of entities and low tens of thousands of mention rows. The
only traversal the product needs is **one hop** (§ 7.2). A one-hop neighbourhood is a self-join with a
`GROUP BY`. Neo4j would add a service, a query language, a backup story and a second source of truth
to answer a query Postgres answers in a few milliseconds. The brief said argue it if we disagree; we
do not disagree.

### Why `edc_backend`, not `edc_ai`

Three reasons, in order of weight:

1. 🔴 **Tenancy lives on our side of the boundary.** `apps/backend/src/lib/corpus.ts:41-57` states it
   outright: *"ai-service CANNOT enforce any of this for us."* ai-service resolves a corpus by
   `(org, project, name)` where `org`/`project` come from the API key — every ecosistema shares one
   `org`. A graph in `edc_ai` would have no column that means "ecosistema" and no way to be told.
   A graph that must never span ecosistemas cannot live where the concept does not exist.
2. **ai-service is deliberately content-agnostic.** `plan/anonimizacion-y-voces.md` §3.5 already ruled
   that it must not learn what a "Voz" is. `testimonio`, the person rule and consent levels are
   product vocabulary. They stop at the boundary.
3. **Backfill needs full document text, and only Payload has it.** ai-service has no chunk
   enumeration endpoint (`corpus-crud.ts:70-92`); retrieval is query-driven only. `documents.extractedText`
   in Payload is the enumerable source. Re-extraction over the whole corpus is therefore a Payload
   query, not a new ai-service API.

### Why Payload collections rather than hand-rolled tables

Migrations, REST, access control and admin visibility for free, and `apps/backend/src/migrations/README.md`
is explicit that schema changes go through `payload migrate:create` — a hand-written migration with no
`.json` snapshot is what broke the migration chain once already
(`20260822_071001_rating_reason.ts` header). Following the house path is both cheaper and safer.

**The escape hatch, used deliberately:** Payload's local API cannot express `GROUP BY … HAVING`, and
every graph read is exactly that. Aggregate reads go through `payload.db.drizzle` raw SQL in
`apps/backend/src/lib/graph/queries.ts`. Writes go through the collections. This split is stated here
so it is not discovered as an inconsistency later.

### 4.1 Schema

```
graph_entities
  id                 serial PK
  organization_id    → organizations   NOT NULL, indexed
  type               enum_graph_entities_type  NOT NULL, indexed
                       ('tema' | 'lugar' | 'evento' | 'organizacion' | 'persona')
  label              text NOT NULL          -- display form, Spanish, as extracted
  canonical_key      text NOT NULL, indexed -- normalise(label): NFD, strip accents,
                                            -- lowercase, collapse whitespace, trim
  aliases            jsonb                  -- other surface forms seen for this entity
  created_at / updated_at
  UNIQUE (organization_id, type, canonical_key)      ← hand-written, see § 4.2

graph_mentions                     -- one row per (document, entity) pair, not per occurrence
  id                 serial PK
  organization_id    → organizations   NOT NULL, indexed
  document_id        → documents       NOT NULL, indexed
  entity_id          → graph_entities  NOT NULL, indexed
  occurrences        integer NOT NULL DEFAULT 1
  snippet            text              -- NULL unless content_kind = 'documento' (§ 7.3)
  created_at / updated_at
  UNIQUE (document_id, entity_id)                    ← hand-written

graph_relations                    -- one row per (document, edge); the VIEW aggregates across documents
  id                 serial PK
  organization_id    → organizations   NOT NULL, indexed
  document_id        → documents       NOT NULL, indexed
  from_entity_id     → graph_entities  NOT NULL, indexed
  to_entity_id       → graph_entities  NOT NULL, indexed
  type               enum_graph_relations_type NOT NULL
                       ('ocurre_en' | 'participa_en' | 'ubicado_en'
                        | 'parte_de' | 'afecta_a' | 'relacionado_con')
  created_at / updated_at
  UNIQUE (document_id, from_entity_id, to_entity_id, type)   ← hand-written
```

And on `documents`, four new columns so extraction is observable and retryable — the same shape the
existing `ingestStatus` / `ingestError` pair already uses:

```
graph_status         enum ('n/a'|'pending'|'extracting'|'ready'|'failed'|'skipped') NOT NULL DEFAULT 'n/a'
graph_error          text
graph_prompt_version text          -- e.g. 'v1'; lets a corpus-wide re-run find stale rows
graph_extracted_at   timestamptz
```

**`organization_id` is denormalised onto all three graph tables.** It is derivable by joining
`documents`, but `corpus.ts:23-36` argues — and this ADR accepts — that structural isolation beats a
filter predicate, because *a filter predicate fails open the day someone forgets a clause*. Carrying
the column means every graph query can and does name the tenant in its own `WHERE`, with no join to
get there.

### 4.2 Three unique indexes are correctness, not tuning

Payload's field config has no compound index, so all three are appended by hand to the generated
`up()`, in a marked block — exactly as the baseline's four already are
(`apps/backend/src/migrations/README.md` § "Four indexes in the baseline are hand-written"). The same
two warnings apply verbatim: a regenerated baseline will not contain them, and a push-enabled boot can
silently drop them.

They matter because **de-duplication happens in application code, and a check is not a lock.**
Re-extraction of the same document concurrently with a backfill would otherwise double every node.

⚠ Add these three to the README's table when the migration lands, so the list stays the single place
someone looks.

### 4.3 Why not `corpus-sync.ts`

The brief flags it as the closest existing seam and says to read it before inventing a parallel
mechanism. Read: it is 88 lines of generic scaffolding (`CorpusDoc`, `EntitySource`, `syncEntity`,
`backfillScope`) whose job is *"turn a product entity into ingest documents and push them into a
second corpus"*. It has **no implementation anywhere in this repo**, and the one consumer surface
stubs it out.

It solves a different problem: making structured records *searchable* by embedding them. Our graph is
not searched by embedding — it is traversed by join and used to *steer* retrieval. Routing entities
through an embedding round-trip to get them back out as chunks would cost an embedding call per
entity and lose the edges entirely. We use it for nothing, and this paragraph is why.

---

## 5. D3/D4/D5 — extraction

### 5.1 Where and when

In `apps/backend`, immediately after `extractedText` exists — the same point `enqueueIngestForDoc`
is called (`Documents.ts:553-701`), for both the pdf/docx path (`runExtractAndIngest`) and the audio
path (`dispatchTranscribeCompleted`). Fire-and-forget via `setImmediate`, copying the existing hook's
pattern, because **there is no job queue in `apps/backend`** and adding BullMQ to a Next process to
serve hundreds of documents would be new infrastructure for a load that does not need it.

⚠ The honest cost of that choice: a backend restart mid-extraction loses the run. Mitigated, not
solved, by three things — `graphStatus` makes a lost run visible rather than silent, a retry endpoint
re-runs one document, and the backfill script re-runs everything stale. Stated here rather than
discovered later.

Extraction runs on **drafts as well as published documents** (the brief permits it). What a draft may
never do is *appear* — § 6.

### 5.2 The call

`getAppAIClient().generate.sync()` with the prompt and JSON Schema in the **`specDefault` FLOOR slot**,
never `specOverride`. `packages/ai-client/src/types.ts:44-68` is explicit: a built-in sent in the
ceiling slot makes a project's registered row resolve and then be discarded, with no error anywhere.
`specDefault` requires the `specDefaultSlot` capability; `text-to-sql.ts:70-80` already carries the
retry-on-400 pattern for a deployment that lacks it, and we reuse it.

- `effortLevel: 'deep'` — 3500 output tokens, 2 validation passes, ≈ $0.0029/call.
- `responseSchema` set ⇒ ai-service sends `response_format: json_object` and surfaces `parsed` **only
  if it validates against the full schema** (`router.ts:120-135`). An invalid response yields no
  `parsed`, which we treat as a failed window rather than parsing text by hand.
- `unitKey: graph-extract:${docId}:${window}` — stable, so `GET /v1/generate/units/:unitKey/latest`
  can be used to inspect a run without re-paying for it.

**Windowing.** Documents run long; the `/v1/generate` body limit is 1 MiB and quality degrades badly
over a whole PDF in one call. The text is split into windows of `GRAPH_EXTRACT_WINDOW_CHARS`
(default 12000) on paragraph boundaries, capped at `GRAPH_EXTRACT_MAX_WINDOWS` (default 8) so one
pathological document cannot run away. Entities are merged across windows by canonical key,
`occurrences` summed.

⚠ **Honest limitation:** a document longer than ~96k characters is extracted from its first 96k only.
At hundreds of documents that is a handful of very long PDFs. The cap is an env var, and
`graphStatus` records `ready` either way — so a truncated extraction is currently indistinguishable
from a complete one. If that matters later, the fix is a `graphWindows` count column, not a bigger cap.

**Cost, estimated not measured:** hundreds of documents × ~3 windows × $0.0029 ≈ **$2–5 for a full
corpus extraction**. Per-document ingest cost is ≈ $0.01. Both are noise next to the embedding spend.

### 5.3 The person rule, enforced twice

🔴 The brief is emphatic that the rule must key off the **column**, not a model's judgement, because
*"asking an LLM 'is this person public?' is unreliable and fails open."* Agreed, and implemented so
that the model is never asked:

1. **Schema variant.** For `contentKind !== 'documento'`, the `tipo` enum in the response schema
   simply does not contain `persona`. ai-service's strict parsed gate then makes a person node
   *unrepresentable*: a response containing one fails validation and yields no `parsed` at all.
2. **Post-filter, unconditional.** After parsing, `entities.filter(e => e.tipo !== 'persona')` runs
   whenever `contentKind !== 'documento'`, regardless of what came back, before anything is written.

Two mechanisms for one rule is deliberate. The first is the efficient one; the second is the one that
still holds if the schema is edited wrongly, if a future model ignores the enum, or if ai-service's
gate is relaxed. The rule is then auditable as a column lookup in our code, which is exactly what the
brief asked for.

⚠ **Organisations are always extracted**, from every content type. Naming an institution does not
identify a participant, and losing organisations would gut the analysis.

### 5.4 The contract

Prompt and schema live in `apps/backend/src/lib/graph/prompt.ts`, versioned by a
`GRAPH_PROMPT_VERSION` constant written to `documents.graphPromptVersion` on every run.

```jsonc
// responseSchema — the `persona` member of `tipo` is absent for testimonio/conversacion
{
  "type": "object", "additionalProperties": false,
  "required": ["entidades", "relaciones"],
  "properties": {
    "entidades": { "type": "array", "maxItems": 40, "items": {
      "type": "object", "additionalProperties": false,
      "required": ["tipo", "etiqueta"],
      "properties": {
        "tipo":      { "enum": ["tema","lugar","evento","organizacion","persona"] },
        "etiqueta":  { "type": "string", "minLength": 2, "maxLength": 120 },
        "menciones": { "type": "integer", "minimum": 1 },
        "fragmento": { "type": "string", "maxLength": 300 }
      } } },
    "relaciones": { "type": "array", "maxItems": 60, "items": {
      "type": "object", "additionalProperties": false,
      "required": ["desde", "hacia", "tipo"],
      "properties": {
        "desde": { "type": "string" }, "hacia": { "type": "string" },
        "tipo":  { "enum": ["ocurre_en","participa_en","ubicado_en",
                            "parte_de","afecta_a","relacionado_con"] }
      } } }
  }
}
```

`desde` / `hacia` carry an `etiqueta` from the same response. The writer resolves them by canonical
key and **drops any relation whose endpoints it cannot resolve** — a dangling edge is worse than a
missing one.

⚠ **Spanish.** The prompt is Spanish, instructs Spanish labels explicitly, and the type and predicate
vocabularies are Spanish so the model is never translating a category. A label that arrives in English
anyway is not machine-detectable; it is a review item on the first real run, not a guarantee.

### 5.5 Re-extraction without duplicates

The brief requires re-running the whole corpus without duplicating nodes. Three mechanisms:

1. **Entities are org-scoped and upserted** on `(organization, type, canonicalKey)`. They survive
   re-extraction; a re-run finds the existing row. New surface forms are appended to `aliases`.
2. **Mentions and relations are replaced wholesale per document.** `DELETE … WHERE document_id = ?`
   then insert, in one transaction. This mirrors what ai-service already does on re-ingest of a stable
   `external_id` (`ingest.worker.ts:270`) — same idea, same failure mode, no new one to reason about.
3. **Nothing is keyed on `chunkId`.** 🔴 `chunks.id` is a fresh uuid on every re-ingest. The graph's
   link to content is the Payload `documents.id`, which is stable for the life of the document.

Orphan entities — zero mentions after a re-run — are deleted by the backfill script, not by the
per-document path, so a mid-flight re-extraction cannot delete an entity another document still uses.

---

## 6. D6 — drafts, tenancy, and what is never shown

Three gates, all applied in SQL, all in `apps/backend/src/lib/graph/queries.ts`:

1. 🔴 **`organization_id = $1`, always, named explicitly.** Never inferred from access control.
   `visibleToCaller` returns bare `true` for a platform admin (`Documents.ts:86`), and
   `apps/web/src/lib/server/admin.ts:10-30` already documents this exact trap. The graph repeats the
   `/admin` route's pattern: resolve the ecosistema server-side, then filter on it.
2. 🔴 **`documents.publication_status = 'published'`, always, for every shared read.** A draft's
   promise is *"solo tú lo ves"*. Extraction may run on a draft; nothing derived from it is counted,
   ranked, retrieved or displayed until the document is published. This is a join to `documents` on
   every read rather than a denormalised flag, because a denormalised flag goes stale at exactly the
   moment publishing happens, which is the moment it matters.
3. 🔴 **Minimum support** — § 7.3.

⚠ **The graph never spans ecosistemas.** There is no query in the design with an unbounded
`organization_id`, including the internal one, including for a platform admin. A platform admin
changes which ecosistema they are looking at through the existing `EcosystemSwitcher`; they never see
two at once.

---

## 7. The single view, and re-identification

### 7.1 What the owner's change actually changes

The brief assumed two views: a member view with protections, and an internal team view without them —
the internal one being where you go to see the unprotected truth. The owner has ruled there is **one
view, in `apps/web`, that every role sees.**

That is a simplification with one consequence that must be said plainly:

> 🔴 **There is now no unprotected view.** Every protection in § 7.3 applies to everyone, always,
> including to the team. Nothing in the product can show a connection supported by a single testimony
> — not to an admin, not to the platform owner. If the team later needs the unfiltered graph for
> analysis, that is a new, deliberately-built surface with its own access decision, not a role check
> bolted onto this one.

We consider this the safer default and are implementing it as specified. It is recorded here because
"the internal view will show us the rest" is an assumption someone will otherwise make later.

What still differs by role is **scope selection, not content**: a platform admin can switch which
ecosistema they are viewing (the existing `EcosystemSwitcher` pattern); a member sees their own. Same
query, same thresholds, same rows.

### 7.2 What the view is

The brief's purpose is *analysis — find patterns across testimonies*. A force-directed hairball of 400
nodes is not that. The view is:

- **Ranked entity lists per type** — temas, lugares, eventos, organizaciones — with support counts
  ("aparece en 12 documentos"), searchable, accent-insensitive (`foldText` already exists at
  `apps/web/src/lib/components/admin/summary.ts:289-295`).
- **An ego-network for a selected entity** — one hop, ≤ 20 neighbours, drawn as a deterministic radial
  SVG. No physics, no layout jitter between renders, no new dependency, and it reads at a glance.
- **The supporting documents for any edge**, as a list of titles that links into the list view.

✅ No charting library is added. The tokens in `apps/web/src/lib/design/tokens.css` cover it.
⚠ Reminder from the design README: token colours are bare `var()`, so Tailwind opacity modifiers like
`bg-warning/10` produce nothing. Use the shipped `-soft` / `-outline` pairs.

### 7.3 Re-identification — the answer

🔴 The brief is right that a graph is a re-identification engine, and that "the testimony that mentions
both place X and event Y" narrows to one person fast in a small ecosistema. Four measures, of which the
third is the load-bearing one:

1. **No person nodes from testimonies** (§ 5.3), enforced twice, keyed on a column.
2. **Published-only, always** (§ 6). An unpublished draft contributes nothing to any count.
3. 🔴 **Minimum support, `GRAPH_MIN_SUPPORT` (default 3).** An entity is shown only if ≥ 3 distinct
   published documents mention it. An edge is shown only if ≥ 3 distinct published documents evidence
   it. Applied identically in the graph view **and** in the GraphRAG retrieval path — otherwise
   retrieval becomes the side door that leaks what the view refuses to show.

   This is the measure that answers the brief's exact scenario. "The testimony that mentions both X
   and Y" is by construction a support-1 edge, and a support-1 edge does not exist as far as any
   surface of this product is concerned.

   ⚠ **The cost is real and worth stating.** In a young ecosistema with two published documents the
   graph is *empty*. That is correct, and the UI says so in Spanish — *"Aún no hay suficientes
   documentos publicados para mostrar conexiones"* — rather than rendering a blank canvas that reads
   as broken.

4. **Snippets are never stored for a testimonio.** `graph_mentions.snippet` holds a short quotation
   that answers "why is this entity here", and a verbatim quotation from a testimony is the most direct
   re-identification surface in the whole design. It is written only when `contentKind = 'documento'`,
   and is `NULL` otherwise. Following `plan/anonimizacion-y-voces.md` §3.2's reasoning on the
   re-identification map: the safest thing to do with data that has no product need and a real leak
   cost is **not to have it**.

We also considered and rejected two alternatives. **Differential privacy on the counts** — wrong tool;
it protects aggregate statistics, and our leak is the existence of an edge, not the accuracy of its
weight. **k-anonymity over entity combinations** — the right idea, and minimum support is its cheap,
auditable special case; the general version needs a combinatorial pass over entity sets that costs far
more than it buys at hundreds of documents.

---

## 8. D7 — GraphRAG

### 8.1 Shape

Two contributions per turn, from one backend call, running **concurrently with** the vector retrieve:

- **G1, graph-expanded retrieval.** The condensed query is matched against this ecosistema's entity
  labels (deterministic string matching over a few hundred rows — **no LLM call, no cost**). Matched
  entities are expanded one hop over `graph_relations` at ≥ `GRAPH_MIN_SUPPORT`. The neighbour labels
  become expansion terms, and **one** extra `POST /v1/retrieve` runs over the same corpora with the
  expanded query. Its chunks are tagged `metadata.path = 'graph'`.
- **G2, a graph summary block.** A deterministic Spanish paragraph — no model call — naming the matched
  entities, their types, their support counts and their strongest neighbours. This rides into the turn
  as its own labelled context block.

G2 is where the global-question win actually comes from. *"¿Qué temas se repiten entre los
testimonios?"* is answered by the aggregate the graph already holds, not by any five chunks a vector
search can return.

### 8.2 Fusion

🔴 **Scores from the two paths are not commensurable**, and today `retrieveContext` merges with a plain
`sort((a,b) => b.score - a.score)` (`packages/chat-engine/src/core/retrieve.ts:74-77`). ai-service
faced the same problem between cosine and `ts_rank_cd` and answered with pure RRF, with the reasoning
written out at `src/services/rag/retrieve.ts:126-146`. We copy it: `Σ 1/(k + rank)`, `k = 60`, dedupe
by `chunkId`, keep the richer record.

**Fusion is applied only when the graph path returned something.** With zero graph chunks the merge is
byte-identical to today's plain score sort. Two reasons: within one modality the scores *are*
commensurable so RRF would discard usable information, and it keeps the existing behaviour — and the
existing test at `respond.test.ts:246` — untouched.

**Silent fallback falls out for free.** Every existing step in `prepareTurn` is already best-effort
with a `.catch(() => [])`; the graph provider is one more. A graph that errors, times out or matches
nothing produces zero chunks and no block, and the user sees a normal answer with no message.

### 8.3 Where the code goes

- `packages/chat-engine` stays **domain-blind**. It gains: an optional `graphProvider` on `RespondArgs`
  (called with the *condensed* query, in parallel with retrieval), a pure exported `fuseMatches()`, and
  an optional `blockHeaders.graph`. It learns nothing about entities, ecosistemas or testimonies.
- `apps/backend` owns the graph and exposes `POST /api/graph/retrieve` — org-scoped, published-only,
  min-support applied.
- `apps/web` implements the provider: call the backend, run the one expansion retrieve, build the
  Spanish block.

Fusion lives in `prepareTurn` rather than inside `retrieveContext` so the two paths can run
concurrently. The function is pure and separately tested, so this is a call-site choice, not a
duplication.

⚠ **Two retrieval invariants must not be broken**, both currently enforced in `apps/web`:
`asOf` is mandatory — `buildRetrieveBody()` returns `null` without it and the caller yields zero chunks
(`apps/web/src/lib/server/retrieval.ts:120-132`); and corpus names are **never composed client-side**,
they come from backend `GET /api/sessions/:id/corpora`. The expansion retrieve reuses the same body
builder and the same corpus list. It adds a query, nothing else.

### 8.4 The trade-off, stated plainly

The brief asks for this in the ADR and it is not a formality:

> GraphRAG wins on **global** questions — *"¿qué temas se repiten entre los testimonios?"*, *"¿qué
> lugares aparecen junto a este proceso?"* — because the answer is an aggregate over the whole corpus
> that no top-8 chunk set contains.
>
> It **adds latency and cost to local** questions — *"¿qué dice este PDF?"* — which are most of what
> people actually ask. Concretely, per turn: one extra HTTP call to the backend, one extra
> `POST /v1/retrieve`, and a longer prompt. Running it concurrently with the vector retrieve hides most
> of the latency; it does not remove the extra retrieve or the extra prompt tokens.
>
> Because we always fuse and never route, **local questions subsidise global ones.** That is the
> owner's decision and this ADR implements it as specified. Recording it is not relitigating it — it is
> making sure the bill has a name on it.

The one thing that would have made the outcome measurable — per-answer path logging — has been
withdrawn (§ 1.2.5). The consequence follows and is stated once, not argued: with always-on fusion, a
silent fallback, no evaluation and no logging, **the graph's contribution to answer quality will not be
observable from inside the product.** Fusion still tags chunk provenance in `metadata.path` because
dedupe requires it, so the raw material for a later look exists on the message rows that are already
persisted. Nothing reads it.

---

## 9. D9 — ship order

1. **`contentKind`** — Payload field, migration, and the two ingest metadata call sites. Prerequisite
   for everything else.
2. **The list view** — `/documentos` in `apps/web`. ⚠ The brief says ship it *before* the graph, and it
   is right: it reads data that already exists, it gives value on day one, and it creates the document
   route that finally makes citations clickable (`chatCitationHref()` returns `null` today —
   `apps/web/src/lib/engine/client.ts:29-31`).
3. **Graph schema + extraction** — collections, migration, prompt, the ingest hook, retry, backfill.
4. **GraphRAG** — backend retrieve endpoint, chat-engine fusion, web provider.
5. **The graph view** — `/grafo`.

---

## 10. Consequences, collected

### Good

- ✅ No new service, no new database, no new runtime dependency. One migration and three tables.
- ✅ Zero ai-service change. `contentKind` rides in existing metadata; extraction uses an existing
  endpoint; the graph retrieve is an ordinary retrieve with a different query.
- ✅ The privacy rules are column lookups and SQL predicates, so they can be read and audited without
  trusting a model.
- ✅ Silent fallback is inherited from the pipeline's existing best-effort shape rather than built.

### Costs and risks

- ⚠ **Extraction has no durable queue.** A restart mid-run loses it. Visible via `graphStatus`,
  recoverable via retry and backfill. Not solved.
- ⚠ **Long documents are truncated at 8 windows** and a truncated extraction currently looks identical
  to a complete one.
- ⚠ **Every turn pays the graph cost** (§ 8.4), and with logging withdrawn the benefit is not
  observable.
- ⚠ **A young ecosistema sees an empty graph** because of minimum support. Correct, and it must be
  explained in the UI rather than looking broken.
- 🔴 **Changing the extraction prompt invalidates existing entities.** `graphPromptVersion` makes stale
  rows findable and the backfill re-runs them, but a re-run of the whole corpus costs real money and
  changes what the view shows. It is a deliberate operation, not a deploy-time one.
- 🔴 **`contentKind` is a privacy control.** If a testimony is ever uploaded as `documento` by mistake,
  person nodes are extracted from it. The mitigation is that re-extraction after correcting the field
  removes them — but only if someone notices. When the `Investigador` role is built, the field must be
  set by the upload flow, not left to a default.

---

## 11. What I could not verify

Stated because the brief asks for it, and separated by why.

**Not verified because it needs a real run:**
- **Extraction quality in Spanish.** No extraction call has been made yet. Whether
  `deepseek/deepseek-chat-v3.1` returns clean Spanish labels, holds the type vocabulary, and produces
  useful rather than generic temas is unmeasured. It is the single biggest open risk in the design, and
  the first thing to look at after the first real run.
- **Whether `GRAPH_MIN_SUPPORT = 3` is the right number.** Chosen by reasoning, not by looking at a
  real corpus. Too high and the graph is empty; too low and the leak returns. It is an env var for
  exactly this reason.
- **Cost at corpus scale.** The $2–5 figure is arithmetic over ai-service's published per-tier
  estimates (`resolve.ts:99-145`), not a measured bill.
- **Whether entity string-matching against the query is good enough** to find the right entities without
  an LLM. Cheap and deterministic, but it will miss paraphrases.

**Not verified because it does not exist yet:**
- **Anything to do with real testimonies.** `contentKind = 'testimonio'` has no producer until the
  `Investigador` role is built. The person rule, the snippet suppression and the min-support threshold
  are therefore implemented and unit-tested but **never exercised against real data**. They are correct
  by construction, not by observation.
- The interaction with conversation ingestion (`conversacion`), which is unbuilt.

**Verified by reading, not by running:**
- The claim that `specDefault` is available on this ai-service deployment. `capabilityCheck.ts`
  requires only `ingestChunkCallback`; `specDefaultSlot` is not negotiated at boot. The retry-on-400
  pattern from `text-to-sql.ts:70-80` covers a deployment that lacks it.

---

## 12. Implementation notes — how this branch was built

Recorded because the circumstances shaped the work, and someone reading the diff later will otherwise
wonder.

### 12.1 It was built in an isolated worktree, and why

🔴 **Another session was editing this repo at the same time.** Partway through, a whole unrelated
feature appeared in the working tree — *"borradores por conversación"*, which takes
`documents.session` from one session to many (`plan/borradores-por-conversacion.md`) — touching 17
files, 12 of them in `apps/web`, and it applied its own migration to the shared dev database.

Those `apps/web` files (`lib/server/retrieval.ts`, `lib/server/engine/aiClient.ts`,
`lib/server/engine/adapter.ts`, `lib/types.ts`) are exactly the ones GraphRAG has to touch. Two
sessions editing them concurrently overwrite each other with no warning and no conflict marker.

So this work lives on branch `worktree-corpus-graph` in `.claude/worktrees/corpus-graph`, based on
`main`. The two changes are independent at the field level — `contentKind` and the graph tables versus
`session` going `hasMany` — so the merge is a real merge but not a fight.

⚠ **`documents.session` becomes `hasMany` on the other branch.** Nothing in the graph design reads
`documents.session`, so this ADR is unaffected. The list view's Payload query filters on
`organization` and `publicationStatus`, never on `session`. Whoever merges should confirm that.

### 12.2 The migration is written and verified but NOT applied to the dev database

The owner's call, and the right one while another session is working against `edc_backend`.

Verification ran against a **scratch database, `edc_backend_graph`**, created for this branch and
touching nothing shared: baseline then `media_prefix`, `rating_reason` and `content_kind` all applied
cleanly, and `payload generate:types` produced
`contentKind: 'documento' | 'testimonio' | 'conversacion'` in `src/payload-types.ts`.

To apply for real, once the other branch has landed:

```bash
cd apps/backend && pnpm exec payload migrate     # DATABASE_URI -> edc_backend
```

🔴 **Migration ORDER matters and is not automatic.** The other branch's
`20260828_080049_documents_session_hasmany` carries a hand-written `INSERT … SELECT` that copies every
existing `documents.session_id` into the new `documents_rels` join table *before* dropping the column.
Payload runs migrations in name order, each in its own transaction, so either ordering is safe here —
but only because `content_kind` touches no column that migration moves. Re-check that if either
migration is edited before landing.

---

## 13. 🔴 Extraction does not currently run, and this is what was measured

§ 11 named "extraction quality in Spanish" as the biggest open risk and said it needed a real run.
Four real calls were made against the local ai-service on 2026-08-28. The risk is no longer
unmeasured — it is **blocked**, for a reason that is not in this repository.

### The measurements

One window, an 809-character Spanish asamblea fragment, `contentKind: 'documento'` (the widest
schema, so the slowest case):

| Tier | Schema caps | Result |
| --- | --- | --- |
| `deep` | 40 / 60, with `fragmento` | **120,008 ms**, no `parsed` |
| `standard` | 40 / 60, with `fragmento` | 82,378 ms, well-formed Spanish, **cut off mid-array** |
| `standard` | 25 / 30, no `fragmento` | 84,819 ms, **cut off mid-array** |
| `standard` | 15 / 20, no `fragmento` | 96,236 ms, **cut off mid-array** |

`120,008 ms` is ai-service's own `LLM_REQUEST_TIMEOUT_MS` default (`config/env.ts:208`) firing
mid-generation. The three `standard` runs never hit the clock — they hit the 800-token output cap.

### What this rules out

⚠ **Shrinking the schema does not help.** 40 → 25 → 15 entities changed nothing. The model generates
until it is cut off rather than honouring `maxItems`, which is a validation constraint and not a
generation one.

⚠ **Shrinking `GRAPH_EXTRACT_WINDOW_CHARS` does not help either**, and § 5.2's framing of it as a
lever was wrong. The document that failed was 809 characters — already far below any window size.
Halving an input that was never the bottleneck buys nothing and doubles the call count.

🔴 **The binding constraint is the model's speed on this deployment: roughly 8 tokens/second.** A
complete answer needs the ~3500-token `deep` budget. 3500 tokens at 8 tok/s is about 440 seconds,
against a 120-second cap. No prompt, schema or window change closes a 3.7× gap.

### The levers, all outside this code

1. Raise ai-service's `LLM_REQUEST_TIMEOUT_MS` to ~600 s.
2. Point extraction at a faster model (`modelOverride` on the spec).
3. Run it against a deployment that is not this one.

The default tier stays `deep` **deliberately, even though it currently fails**, and
`GRAPH_EXTRACT_EFFORT` exists to change it. `deep` is the only tier whose token budget can hold a
complete answer, and it starts working the moment lever 1 is pulled. `standard` fails too — and would
keep failing *after* the timeout was raised, because its ceiling is tokens rather than seconds. That
is a far more confusing thing to debug, so shipping it as the default would be a trap.

### ✅ The one genuinely good thing these calls showed

Every response was **well-formed Spanish with the right vocabulary and the right types** —
`acceso al agua potable` (tema), `San Juan Copala` (lugar), `sequía de 2023` (evento),
`construcción del acueducto` (evento), `consulta previa` (tema). No English drift, no invented
entities, no type confusion. The prompt and the schema are sound; only the budget is wrong. That
retires the *other* half of § 11's biggest risk.

### 13.1 `fragmento` is gone from the schema — § 5.4 and § 7.3.4 amended

The response schema asked each entity for `fragmento`, a literal quotation justifying it, which the
writer stored as `graph_mentions.snippet` for a `documento` and dropped for a `testimonio`.

**It is now not requested at all, in any variant.** The output-budget argument for removing it did not
survive measurement (removing it changed nothing). The privacy argument did, and it was always the
stronger one:

> § 7.3.4 refused to *store* a quotation for a testimonio because a verbatim quotation is the most
> direct re-identification surface in the design. Not *asking* for one is the same rule without the
> conditional — and a conditional is a thing a later change can get backwards. Nothing to leak, by
> construction.

⚠ **The cost, and it is real:** the graph can no longer show "why is this entity here" for an ordinary
document either. That was a genuine affordance for an analysis tool. `graph_mentions.snippet` and the
writer's content-kind gate are kept as belt-and-braces, and the queries layer still asserts NULL for
anything that is not a `documento` — so restoring it later is a schema change, not a redesign.

Array caps came down to 15 entities / 20 relations in the same pass. Not because it fixed anything,
but because it is the right shape: prompt rule 8 already asks in words for few good entities over
many generic ones, and the schema now says the same thing.

---

## 14. ✅ Extraction WORKS — § 13 is resolved, and this is what changed

§ 13 recorded extraction as blocked: the model runs at roughly 8 tokens/second on this deployment,
and a complete `deep` answer needs about 440 s against ai-service's 120 s default cap. The owner
pulled lever 1.

### The change

```
infra/.env    LLM_REQUEST_TIMEOUT_MS=600000     # was commented out, i.e. the 120000 default
```

`ai-service` reads `.env` through compose's `env_file:`, so this needed only a container recreate —
no compose edit.

🔴 **And the client had to move with it.** `graphRequestTimeoutMs()` went from 180 s to **660 s**.
`lib/graph/client.ts` already carried the rule — *"this timeout must stay ABOVE ai-service's"* — and
it would have been violated the moment the server cap went to 600 s: the client would have aborted at
180 s, the server's answer would never have been seen, and every failure would have looked like a
network fault instead of a timeout. The 60 s of headroom covers request queueing and the response
trip, neither of which the server's generation clock counts. There is now a test asserting the
ordering rather than the number.

### The measurement, after

Same 809-character Spanish asamblea fragment, `contentKind: 'documento'`, default `deep` tier:

| Run | Wall clock | Result |
| --- | --- | --- |
| 1 | **96,051 ms** | `windows: 1`, `windowsFailed: 0`, `truncated: false`, **15 entities**, 15 relations |
| 2 | **72,428 ms** | `windows: 1`, `windowsFailed: 0`, `truncated: false`, **14 entities**, 11 relations |

✅ **The Spanish is correct and the types are right**, which is what § 11 flagged as the biggest open
risk and § 13 could only half-answer:

```
tema          acceso al agua potable          lugar   San Juan Copala
tema          consulta previa                 lugar   Sierra Norte
tema          desabasto de agua               lugar   Juxtlahuaca
evento        sequía de 2023                  organizacion  Comisión Nacional del Agua
evento        desplazamiento forzado          organizacion  Secretaría de Medio Ambiente
```

No English drift, no invented entities, no type confusion. **The risk § 11 named is retired.**

⚠ **Relations resolve.** `mergeWindows` drops any edge whose endpoints do not resolve to an extracted
entity (`if (!from || !to) continue` — ADR § 5.4's "a dangling edge is worse than a missing one"), so
the 11–15 relations that survived are real edges, not orphans. Confirmed by reading the resolver
rather than by spending a further call.

⚠ **Still one document, one window, one deployment.** ~85 s per window means a full corpus pass over
hundreds of documents is measured in hours, not minutes, and it is sequential per document with a
concurrency cap of 2. That is a backfill you start and leave, not one you wait for.

---

## 15. Rate limiting on the graph routes

§ 13's companion gap, now closed. Two buckets, and one deliberate omission that matters more than
either of them.

| Bucket | Default | Env |
| --- | --- | --- |
| per user, browsing (`view` + `entity`) | 120/min | `GRAPH_RATELIMIT_VIEW_USER_MAX` |
| per user, `retrieve` (the GraphRAG leg) | 60/min | `GRAPH_RATELIMIT_RETRIEVE_USER_MAX` |
| per ecosistema, all routes | 600/min | `GRAPH_RATELIMIT_ORG_MAX` |

### 🔴 There is NO per-IP bucket, and adding one would be an outage

`/token`, `/me` and `/resolve` all have one, so "add a per-IP bucket for consistency" is the obvious
next change. It would take the product down.

Every graph request arrives from the **web BFF**, not from a browser.
`apps/web/src/lib/server/auth.ts` → `backendFetch` sets `Authorization` and `Content-Type` and
nothing else — no `X-Forwarded-For`, no `X-Real-IP`. So `clientIp(req)` falls through to the literal
string `'unknown'` for **every caller**, and a per-IP bucket would be one global counter shared by
every user of every ecosistema. The first busy tenant would 429 everybody else.

The identity routes are different, and that is why they can have one: they are hit by browsers and by
service clients directly, so their `clientIp` resolves to something real.

The reasoning is written on the buckets in `lib/rateLimit.ts`, because that is the file someone adding
"one more bucket" would be looking at. A test asserts two different users do not share a bucket, so
the mistake fails loudly rather than in production.

### ⚠ A defect the tests caught in this very change

The first implementation used ONE key, `graph:user:{id}`, and passed a different `limit` per route.
That is not two allowances — it is **one counter read against whichever number the current route
passed**, so browsing `/grafo` spent the chat path's budget.

The failure mode would have been the worst available: GraphRAG dropping its context mid-conversation
because the person had been clicking around the graph beforehand, and dropping it **silently**,
because the fallback is silent by design (§ 8.2). Keys are now namespaced by route kind.

The tenant ceiling stays deliberately shared across both routes: it exists to bound total
aggregate-SQL work for one ecosistema, and that cost does not care which route asked.

### What it does and does not protect

Limits are counted **after** authorisation, like `/me` and `/token`, so a bucket is keyed on a verified
user and a verified ecosistema rather than on anything a caller can assert. A request that fails
authorisation is not counted — tested.

⚠ Inherited from `lib/rateLimit.ts` and unchanged here: the counters are **in-process**, so N replicas
allow N× every limit above. That module's header explains the seam for a shared store. This app runs
one replica.

---

## 16. § 13.1 REVERSED — `fragmento` is back, and § 7.2's edge documents are real

Two owner decisions of 2026-08-29, and the defects each one turned up.

### 16.1 `fragmento` returns, documento-only

§ 13.1 removed the per-entity quotation. The owner has asked for it back, and § 13.1 is **superseded**:
the schema asks for `fragmento` again, capped at **120 characters** rather than the original 300.

✅ **No migration.** `graph_mentions.snippet` was deliberately kept when the field was removed, exactly
so this reversal would be a schema change and not a redesign. That decision paid.

The privacy rule is unchanged and still enforced in three places — `mergeWindows`, the writer, and a
SQL `CASE` in `queries.ts`: **a snippet is stored only for a `documento`**, never for a `testimonio` or
a `conversacion`. What § 13.1 got wrong was not the rule but the conclusion; refusing to *ask* for a
quotation was a stronger version of the rule than the product needed, and it cost the analysis view
its "why is this entity here" affordance for ordinary documents too.

⚠ `GRAPH_PROMPT_VERSION` is now **`v2`**. Every `v1` row has a NULL snippet even where one is allowed,
and the stamp is the only thing that can find them for re-extraction.

### 16.2 🔴 Three defects the reversal exposed, all mine, all in the § 13.1 removal pass

Recorded because two of them were live for a day and neither was visible from any test:

1. **The prompt's rules were numbered 1–6, then two rule 8s and no rule 7.** Removing `fragmento`
   deleted rule 6 and renumbered by hand, badly. The model was handed a numbered list that
   contradicted itself about its own length. Now 1–9, contiguous, with a test.
2. **Rule 9 said "60 relaciones" while `maxItems` said 20** — the pre-§ 13.1 number, left behind.
   🔴 This one was worse than cosmetic. § 13's measurement showed this model **generates until it is
   cut off rather than honouring `maxItems`**, so the *words* are the effective cap and the wrong
   number was the one actually in charge.
3. **No test ever asserted a snippet ARRIVES.** Every existing snippet test asserted one does *not*
   reach somewhere it should not. So the whole feature could have gone silently dead — schema stops
   asking, model stops answering, parser drops the field — with the suite still green. There is now a
   positive test.

⚠ The general lesson, worth more than the three bugs: **a suite made entirely of negative assertions
cannot tell "correctly suppressed" from "never produced".** Every privacy rule in this design is a
negative assertion. Each one needs a positive counterpart proving the thing it suppresses exists in
the first place.

### 16.3 § 7.2's supporting documents are now real, not an intersection

The graph view showed an edge's supporting documents by **intersecting the two entities' document
lists**, and the UI said so honestly — *"documentos en los que aparecen los dos"*, not *"los que
sustentan esta conexión"*. `graph_relations` has always held one row per `(document, from, to, type)`,
so the true answer was one query away.

`entityEdgeDocumentsQuery` returns it for the whole ego-network in a single statement: an `edges` CTE
reusing the same aggregation `entityNeighboursQuery` does (so the two cannot disagree about which
edges exist), an `evidence` CTE over the real relation rows, and a
`ROW_NUMBER() OVER (PARTITION BY neighbour, type)` per-edge cap — a plain `LIMIT` would have spent the
whole budget on the first edge.

**It extends `GET /api/graph/entity/:id` rather than adding a `/graph/edge/…` route**, for a reason
worth keeping: a fourth route would be a fourth place § 6's three gates are written, and the audit
loop catches a *missing* clause but cannot catch two correct queries drifting apart. It is also 20
round-trips saved on a panel that draws ≤20 edges.

🟡 **The precise list is narrower than the intersection it replaces, and therefore more identifying in
principle.** It is safe for one reason and it is worth naming: minimum support means the shortest list
this can ever return is `GRAPH_MIN_SUPPORT` documents. It cannot point at one testimony.

⚠ No snippet on the edge list, and not merely because a test forbids it: `graph_mentions.snippet` is
keyed on `(document, entity)`, so an edge has two candidate quotations and neither is evidence *of the
edge*.
