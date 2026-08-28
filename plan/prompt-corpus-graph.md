# Prompt — corpus graph for Ecosistemas de Conocimiento

Copy everything below into a fresh Claude Code session, run from
`~/chamba/cide/ecosistemas-de-conocimiento`.

---

You are designing and building a **corpus graph** for "Ecosistemas de Conocimiento", a
multitenant Spanish-language knowledge repository. Read this whole brief before proposing anything.

## The product, in one paragraph

An **organization IS an "ecosistema"** — a group of people who together build a corpus. One level
of tenancy. People upload documents (PDF, DOCX) and **audio, which is transcribed automatically**.
Everything lands as a private **draft**; **publishing** shares it with the ecosistema. People chat
over the corpus with RAG and rate the answers. A planned role, **Investigador**, uploads documents
and **testimonies ("Voces")** on behalf of other people — so *who uploaded* and *whose words these
are* are different fields.

## What already exists — read it before designing

- `services/ai-service` — Fastify + Drizzle + BullMQ + pgvector. Chunks with embeddings and
  metadata, hybrid retrieval (dense + BM25 with Spanish stemming), per-corpus isolation by NAME.
- `apps/backend` — Next.js + Payload. Documents, sessions, messages, ratings, memberships. Also the
  identity provider.
- `packages/chat-engine` — the RAG turn: condense → summary → retrieve → assemble.
  ⚠ `src/core/corpus-sync.ts` already syncs **structured entities** into a second corpus. That is
  the closest existing seam to a graph. Read it before inventing a parallel mechanism.
- `plan/anonimizacion-y-voces.md` — **read this first.** The anonymisation gate and the Voces model
  constrain everything here.

**There is no entity extraction, no relation store and no graph today.** This is new construction.

## Decisions already made — do not relitigate

| Decision | Value |
| --- | --- |
| Purpose | **Analysis** — find patterns across testimonies |
| Audience | Members of one ecosistema, **and** an internal team view |
| Scale | **Hundreds** of documents |
| Node types | Themes/topics · Places/territories · Events, dates, processes · Organisations |
| Person nodes | **Only from non-testimonial sources** (see below) |
| Extraction timing | **On ingest**, per document |
| Where the model call runs | **Same decision as the anonymisation scrub** — one place, one policy |

### 🔴 The person rule, and why it is shaped this way

- **Organisations** are always extracted. Naming an institution does not identify a participant.
- **People** are extracted **only from non-testimonial documents** — a cited author, an official
  named in a public report. Think Foucault in a bibliography, not a participant in a Voz.
- **A testimony never produces person nodes.** Not pseudonymous ones either.

⚠ The rule keys off **document type**, not off a model's judgement about whether someone is
"public". Asking an LLM "is this person public?" is unreliable and fails open. Asking "is this
document a testimony?" is a column lookup. Build it that way; it is the difference between a
privacy rule you can audit and one you have to trust.

## Scope: BOTH the graph view and GraphRAG

Two deliverables over one extraction layer.

1. **A graph you look at** — analysis and navigation.
2. **GraphRAG** — the graph feeds retrieval. Decided and in scope now.

**Owner's decisions on the retrieval half:**

- **Always use both paths and fuse the results.** No routing, no per-question decision. Every answer
  pays the graph cost, including "what does this PDF say".
- **Silent fallback.** If the graph yields nothing, normal search answers and the user is not told.
- **No formal evaluation.** Shipping on judgement rather than a measured comparison.

🔴 **One thing you must build anyway, because those three together hide their own outcome:**
always-on + silent fallback + no evaluation means the cost is certain and the benefit is invisible.
**Log which path produced the context for each answer** — graph, vector, or both — and how many
chunks each contributed. No UX change, negligible cost, and it is the only way anyone can later
check whether the graph earns its place. Do not skip this on the grounds that no evaluation was
asked for; it is what makes the decision reversible.

⚠ Also state honestly in your ADR: GraphRAG wins on **global** questions ("what themes recur across
testimonies") and adds latency and cost to **local** ones ("what does this document say"), which are
most of what people actually ask. Fusing on every turn means local questions subsidise global ones.
That is the owner's call; your job is to make the trade visible, not to relitigate it.

## Every ingested chunk carries a `kind`

`documento` · `testimonio` · `conversacion`. Assume it exists; if it does not yet, it is a
prerequisite, not an optional extra. The graph's person rule keys off it (§ the person rule), views
filter on it, and citations use it to say "this came from a previous answer" instead of presenting
one as a source.

## What to design

1. **Extraction** — one pass per document at ingest, producing typed entities and the relations
   between them. Decide the schema, the prompt, and how you keep it stable across re-runs.
2. **Storage** — at hundreds of documents you do **not** need a graph database. Postgres tables
   (`entities`, `mentions`, `relations`) are almost certainly right. If you disagree, argue it.
3. **Two views** — a member view inside one ecosistema, and an internal one. State plainly what
   differs and why.
4. **A list view of documents and testimonies** — the owner asked for this alongside the graph, and
   it is useful on its own. ⚠ **Ship it before the graph.** It reads the same data and gives value
   on day one.

## Hard constraints

- 🔴 **Tenancy.** Isolation is by corpus NAME (`eco-{orgId}`). ai-service cannot tell tenants apart.
  A graph MUST never span ecosistemas. Scope every query explicitly by organization; do not rely on
  access control — `visibleToCaller` returns bare `true` for a platform admin.
- 🔴 **Drafts.** A draft's promise is *"solo tú lo ves"*. Extraction may run on drafts, but nothing
  derived from an unpublished draft may appear in any shared view.
- 🔴 **A graph is a re-identification engine.** Even with no person nodes, "the testimony that
  mentions both place X and event Y" narrows to one person fast in a small ecosistema. Say how your
  design handles this. A minimum-cluster-size threshold before showing a connection is one answer;
  there are others. Do not skip this.
- ⚠ **Re-extraction.** Changing the extraction prompt invalidates existing entities. Design for
  re-running over the whole corpus without duplicating nodes.
- ⚠ **Spanish.** All content and all UI copy. Entity labels must not drift into English.

## How to work

- Propose the design **before** writing code. Use the ADR shape: context, decision, consequences.
- Prefer boring technology. Postgres over a graph DB at this size, unless you can show why not.
- The stack runs locally: web `:45400`, backend `:45402`, ai-service `:45401`, Postgres `:45432`.
  Credentials are in `infra/.env` — read them at runtime, never hardcode or commit.
- ⚠ Real inference is enabled and costs money per call. Do not loop over generation while iterating.
- Tests run with `pnpm test` (currently ~1,866 passing, 0 failing). Do not regress them.
- `pnpm` may not be on PATH; fall back to
  `node ~/.cache/node/corepack/v1/pnpm/9.15.4/bin/pnpm.cjs`.

## What to deliver

1. An ADR for the graph: schema, storage, extraction contract, and how the two views differ.
2. The **list view** of documents and testimonies, shipped first.
3. Then extraction + storage, with the graph view last.
4. Say explicitly what you could not verify.

Start by reading `plan/anonimizacion-y-voces.md` and `packages/chat-engine/src/core/corpus-sync.ts`,
then propose the design. Ask before building if anything above conflicts with what you find.
