# EDC AI-stack audit — 2026-10-17

Scope: everything AI in EDC, implemented or planned — ingest, anonymisation gate, chat/retrieval,
corpus graph, eval, tests, deploy wiring. Four read-only audit lanes
(auditor, Opus at high effort). Agent-facing: full precision, file:line evidence.

Fix-location tags: **EDC** = apps/, infra/, scripts/, services/audio-service.
**AI-STACK** = services/ai-service, packages/*. **NEEDS-RODRIGO** = a decision, money or credentials.

Provenance: `measured` (local box, 2026-10-17, load avg 2.7–12, another agent's PG container
running) · `read` (read in code) · `assumed`.

## Baseline (measured)

- Unit suites: web 1349/1349, backend 1536/1536 (1 of 3 full runs failed on B-7), chat-engine 211/211.
- E2E suites NOT run: the local stack calls a paid model, and its images predate HEAD (C-7).
- No mock or fake LLM can reach production (read: `MOCK_*` refuses boot at
  `services/ai-service/src/config/env.ts:927-935`; fake-provider only under compose profile `fake`).

## Status after the fix wave (2026-10-17, EDC local main, nothing pushed)

The per-row `status` columns below record the lane assignments at audit time. This list supersedes them.

- **Fixed and landed:** G-1, G-5 (eval part), G-7, G-8, I-1, I-2, I-3, I-4, I-5, I-7, I-8, I-9, I-12, C-1 and C-2 (written), C-3 (script only, not applied), C-5, C-6, C-11, C-12, C-14, C-15, T-3, T-7, T-9, T-10, T-11, T-12, T-14.
- **I-6:** done. Fail-closed, approval, gate-pass and span-redaction e2e all pass (anonymisation 6/6 ×3, measured). They use the fake-provider `[[FAKE_REPLY:<base64>]]` directive.
- **G-9, T-4, C-7:** done. Graph-status badge and retry in Mis documentos; `TESTING.md` and plan docs refreshed; local org-SQL runbook added.
- **Found during the fix wave:**
  - A full-row Payload write clobbered `ingest_status`. Fixed with narrow column writes (`lib/documentColumns.ts`).
  - Prompt leak of an attached testimony's filename. Fixed.
  - An adversarial audit of the I-1 fix found filename leaks L1–L6: uppercase `OR`, `sort=name`, `document.name` from reviews, `graphError`, `ingestError` paths, and unknown kinds in `titleFor`. All fixed.
  - It also found that the I-1 unit tests did not check the collection config wiring. A wiring test now covers that.
- **E2E (fake provider, isolated stack):** anonymisation 3/3, holds 20/20, tenancy 22/22, grafo 3/3, documents plus testimonyRead 22/22 (measured).
  - Not run: `retrieval.spec.ts` and the hard cite step in `journey.spec.ts`. The fake provider's embeddings are random, so they need a real-model stack.
  - Failing, assumed pre-existing: audio, identity, ratings e2e.
- **Owned by another session:** /grafo lists testimonios under language `tema` entities (not covered by this audit).
- **Still open (NEEDS-RODRIGO):** G-2, G-3, G-11, C-3 (apply), C-4, C-8, I-11, I-13, I-14, T-6, T-16.
  - Also open: whether `uploadedBy`/`session` should stay readable on a published testimonio, and whether audio uploaded before I-2 needs re-gating.
  - Also open: I-10 (deferred while another session owns Documents.ts) and T-13.
- **Handed to another EDC session:** flaky hold approval (holds.e2e 1/3), and a model reply logged with a person name on graph-extraction failure.

## Decisions (Rodrigo, 2026-10-17)

- G-2 purge: approved in every env. Local: done. Deleted 648 mentions, 386 relations and 66 orphan entities; published documentos unchanged (same md5, measured). Dev: the other session ran it (0 rows) and re-runs it after its backfill. Staging: not needed. The infra session ran the dry run there, with 0 unscrubbed rows; its graph holds only 6 smoke-test documento entities (quoted).
- G-3 / C-3 / C-8 paid runs: approved. Dev's v4 re-extraction and eval run in the other session. Dev needs no lengua backfill: all 163 published docs carry `lengua` (quoted from that session).
- C-4 hybrid: chosen. Built behind a switch, default dense. Flip only if the eval beats dense. Baseline quoted from the other session (2026-10-16, eco-1, 39 queries): dense+spanish keyword dropped single-doc MRR from 0.95 to 0.50 versus dense-only.
- I-14: dropped; environments stay alike. Self-hosting is not near-term. EDC has a Spark box that could host it, but AI adoption there needs a thorough plan first (open, planning with Rodrigo).
- Titles: an honorific before a name is part of the name. "Don Fernando Vázquez" → "[Persona F]", never "Don [Persona F]" (lane running).
- C-4: dense stays the chat default (confirmed).
- Rerank arms, full journey e2e: approved (lane running). Rerank key: swap to the EDC DeepInfra key, delegated to the infra session; dev waits for the other session's backfill.
- Uploader/session hidden on published testimonios: approved, lane running.
- Pre-fix audio data: no action. Dev holds generated fixtures only (assumed).
- G-11: keep `evento` nodes, and keep extracting `tema`.
- Citation e2e: deterministic fake embeddings (lane running).
- I-11 CONFIRMED and worse than assumed (measured, 12 real calls, $0.03): ai-service caps `quick` replies at 400 tokens, so the findings list is cut off after 15–23 items, and every multi-paragraph testimonio (≥1,191 words) is held. One 4,862-word call hit the 30 s client timeout. Fix lane: chunked detection plus an explicit timeout.
- I-10 streaming, audio/identity/ratings e2e: approved, lanes running.

## Wave 3 results (2026-10-17, local main aaec3f4, nothing pushed)

- I-11 fixed: chunked detection (~250 words, concurrency 3, 90 s timeout, fail-closed). Re-measured with the real model: no truncated replies; 19–20 of 20 planted names caught; a 4,862-word text reached ready in 75 s ($0.022). Open: the verify stage still holds "Don [Persona F]"-style titles, and results vary run to run.
- uploadedBy/session hidden on gated rows, including where/sort/count and `document.*` paths; e2e plus a wiring test go red without it.
- I-10 fixed: audio upload streams. Peak RSS for 200 MB fell from 1,213 MB to 147 MB (measured).
- Node 22/24 `Readable.toWeb` bug: a cancelled upload threw an uncaught "Controller is already closed" (would crash the backend, whose runtime is Node 22). Fixed with `lib/nodeToWeb.ts`. Suite green on Node 22, 24 and 26.
- C-4 measured: dense beats hybrid. Single-doc MRR@5 0.936 vs 0.503 (189 questions); local 0.950 vs 0.475; global 0.720 vs 0.733 (10 questions). The switch `CHAT_RETRIEVAL_MODE` ships, default dense. Rerank arms not measured (no local key).
- ai-service: `$in` + `corpusFilters`, bag-of-words fake embeddings, `[[FAKE_REPLY]]`, test containers on tmpfs; all accepted.
- e2e: audio 9/9, identity 15/15, ratings 13/13 (test/setup fixes, not product bugs); retrieval.spec 2/2; journey rating locator fixed.

## Blockers

| id | finding | evidence | fix | status |
|---|---|---|---|---|
| G-1 | `/api/graph/retrieve` returns 500 for any query that matches an entity → GraphRAG silently gives nothing in chat | measured: "dengue"/"Morelos" → 500; PG `cannot cast type record to integer[]`. read: drizzle array expansion at `apps/backend/src/lib/graph/queries.ts:1242,1292`; tests miss it (`queries.test.ts:72-84` custom renderer; `endpoints/graph.test.ts` canned). Eval works around it (`eval/graph.ts`), so ADR §19.3's recall gain measures the design, not what ships | EDC: bind as one param; real-PG test; warn on non-2xx in `apps/web/src/lib/server/graph.ts:251`; drop eval workaround | lane: graph-fix |
| I-1 | A published testimonio shows its unredacted `extractedText` and raw filename to every member | read: no field `read` access on `Documents.ts:2597-2604`; Biblioteca renders it (`apps/web/src/lib/server/biblioteca.ts:71,196,214-219,376`). measured: 3 published approved testimonios where extracted ≠ redacted | EDC: field access + Biblioteca uses `redactedText`/`titleFor` | lane: privacy |
| G-2 | Graph rows from unscrubbed testimonio text still at rest: 648 mentions, 386 relations | measured (`edc_backend`). `apps/backend/scripts/purge-unscrubbed-graph-rows.ts` exists, never run (`b2be52f`) | EDC, NEEDS-RODRIGO: dry run → `PURGE_APPLY=1` in every env that extracted before `b2be52f` | open |

## Ingest and anonymisation (lane I)

| id | sev | finding | evidence | fix | status |
|---|---|---|---|---|---|
| I-2 | gap | UI upload never sends `contentKind`, so the gate never runs from the product. Biblioteca checks `kind === 'testimonio'` (file format), not `contentKind` | read: `apps/web/src/routes/api/sessions/[id]/documents/+server.ts:153-196`; `biblioteca.ts:193,233`; `lib/biblioteca.ts:40-45` | EDC: content-kind choice for `voces:upload` holders; read `contentKind` | lane: privacy |
| I-3 | warn | Stuck rows with no sweep: `extracting`, gated `pending`, `transcribed`, message `embedding` | read: `embeddingJanitor.ts:126-133,547-554`; `planIngestRetry` only `failed` (`Documents.ts:2806`). measured: 8 testimonios pending since 09-08 (ids 285,294,317,341,342,346,349,351); 3 messages embedding since 08-28 | EDC: sweeps per state | lane: pipeline |
| I-4 | warn | A transcription callback that throws is answered 200 after dedupe, so it is lost; the gate and enqueue run inside the 20 s callback window | read: `app/api/ai-service/callback/route.ts`; `services/audio-service/app/config.py:182`. assumed: Next keeps running after hang-up | EDC: callback only persists + `transcribed`; sweep runs gate; error → delete dedupe, 500 | lane: pipeline |
| I-5 | warn | Ecosistema budget provisioned once, fire-and-forget → 402 forever on failure | read: `Organizations.ts:50-61`, `provisionEcosystem.ts` | EDC: idempotent provision at boot / on 402 | lane: pipeline |
| I-6 | gap | Gate never runs in e2e; holds e2e asserts what it seeded | read: `documents.e2e.ts:87-91`, `audio.e2e.ts:103-107` no contentKind; `holds.e2e.ts:96-121,197,222,347` | EDC: fake-provider fail-closed e2e; approval fixture as pdf → poll ready; paid opt-in run NEEDS-RODRIGO | lane: e2e |
| I-7 | warn | `Documents.callbackRace.test.ts:96` fixed 150 ms wait — flaky under load | measured: 1/3 full runs failed; it does go red without fix `7bf0622` | EDC: `vi.waitFor` | lane: infra |
| I-8 | gap | Deleting a document only hides it; chunks stay. `ai-client` now has `deleteDocument` | read: `packages/ai-client/src/admin.ts:96`; `publishDocument.ts:245` | EDC: delete from both corpora | lane: privacy |
| I-9 | minor | Late document callback from an older ingest can overwrite status (no `ingestId` compare) | read: `callback/route.ts` | EDC: compare ids, keep `7bf0622` race case | lane: pipeline |
| I-10 | minor | Audio upload buffered whole ×3 (~600 MB at 200 MB cap, inferred) | read: `Documents.ts:1909-1949` | EDC: stream | open |
| I-11 | warn (assumed) | Gate sends a whole transcript in one `quick` call; long JSON answers may truncate → always held | read: `gate.ts`, `detector.ts:239-249` | EDC: measure on a 60-min transcript first | open, needs a paid measurement |
| I-12 | minor | Editing an approved testimonio's transcript re-ingests the old redacted text | read: `routes/api/documents/[id]/transcript/+server.ts:165-176`; `Documents.ts:1515` | EDC: reset gate on edit | lane: privacy |
| I-13 | NEEDS-RODRIGO | Plan §7 open: gate model still hosted (must change before first real Voz); no notice that conversations feed the corpus; no review screen for `held-gate` turns (2 locally); edc-1 accepts audio uploads with audio not deployed | read: `plan/anonimizacion-y-voces.md` §7 | decisions | open |
| I-14 | NEEDS-RODRIGO | Raw testimony goes to a hosted model with no env guard; staging runs the same code. assumed: staging has no real participant data | read: `anonymise/types.ts:197-203`, `detector.ts` | EDC: refuse gated kinds outside dev unless detector is self-hosted | open |

## Chat and retrieval (lane C)

| id | sev | finding | evidence | fix | status |
|---|---|---|---|---|---|
| C-1 | gap | No e2e for any retrieval feature; the journey cite step cannot fail | read: `apps/web/e2e/journey.spec.ts:712-745` (`expect.soft` inside `if (isVisible)`) | EDC: hard cite assert; draft-isolation e2e; lengua e2e | lane: chat |
| C-2 | gap | `/api/generate` has no test: removing `retrievalFilter`/`retrievalPolicy`/`graphProvider` keeps web 1349/1349 | measured (mutation in scratch); `+server.ts:447-455` | EDC: route test at the fetch boundary | lane: chat |
| C-3 | warn | Lengua filter returns nothing: 0 of 253 `eco-1` chunks carry `metadata.lengua`; 191 docs have `lengua`. Under a filter, the graph leg is off too | measured (`edc_ai`, `edc_backend`) | EDC: backfill script (lane: chat); running it is NEEDS-RODRIGO (re-embed cost) | lane: chat (script) |
| C-4 | NEEDS-RODRIGO | Chat never uses hybrid/spanish keyword search: policy `mode:'dense'` (`rerank.ts:140`), `buildRetrieveBody` drops `mode` (`retrieval.ts:169-181`) | read | AI-STACK: `$in` on `docId` in ai-service `filter`, then EDC switches to hybrid — or record dense-only | open |
| C-5 | warn | Expansion/graph fusion merges reranker scores with cosine scores before the cap. Size of effect assumed | read: `retrieve.ts:284,343-361`, `expand.ts:224-240` | EDC: rank-derived score after fusion | lane: chat |
| C-6 | warn | Admin cost undercounted (condense + expansion not counted); budget never shown | read: `+server.ts:221-227,418-423,536-541`; `getBudget` no caller | EDC: show spent/limit; label "solo respuestas"; count expansion via `onExpansion` | lane: chat |
| C-7 | warn | Local stack images predate HEAD: `X-AI-Org: eco-2` returns eco-1's corpora; all 16 corpora in org `demo` | measured | EDC: local runbook — org SQL dry run → apply → rebuild | open (local op) |
| C-8 | NEEDS-RODRIGO | Rerank, expansion, GraphRAG all on by default with no measured win (GraphRAG changed 2/20 answers, ±1) | quoted: `apps/backend/src/eval/RESULTS.md` | paid eval with per-feature arms, after G-1 | open |
| C-11 | minor | Expansion `maxTokens: 220` never reaches ai-service | read: `expand.ts:193`, `aiClient.ts:181-190` | EDC: delete | lane: chat |
| C-12 | minor | Wrong comment: `rerank.ts:19-23` says multi does not take `asOf` | read: `contract/rag.ts` | EDC: fix comment | lane: chat |
| C-14 | minor | Failed answer save is silent; user cannot rate it, it is never ingested | read: `+server.ts:111-116` | EDC: log + warning code | lane: chat |
| C-15 | minor (assumed) | Uncited turn that names an attached draft's title can enter the shared corpus | read: `conversationIngest.ts:174-217` | EDC: hold when the session has any unpublished draft attached | lane: chat |

## Corpus graph and eval (lane G)

| id | sev | finding | evidence | fix | status |
|---|---|---|---|---|---|
| G-3 | gap | Prompt v4 written, never applied: 0 docs at v4 (ready v3 253, skipped v2 46, failed v3 19). `español` still 3rd-largest published node; 5 approved testimonios have no graph | measured | NEEDS-RODRIGO (paid): backfill dry run → small limit → full, after G-1 | open |
| G-4 | gap | No e2e for graph/grafo/GraphRAG/lengua; no test runs graph SQL on Postgres | read | EDC: real-PG test (lane: graph-fix); `/grafo` Playwright (lane: e2e) | lanes |
| G-5 | warn | Eval sends no `X-AI-Org` → reads the base org's empty corpora since the per-eco move; web graph functions are copied, pinned by strings; cites a nonexistent `graph.copy.test.ts` | read: `eval/engine.ts:140-144`, `harness.test.ts:108-160` | EDC: send header; import web functions. Re-run NEEDS-RODRIGO | lane: graph-fix |
| G-7 | warn | Deployed envs run extraction at ai-service's default 120 s timeout; ADR §13 measured deep-tier failing at 120 s (quoted) | read: `infra/.env.example:378`, `env-manifests.md:153` | EDC: document `LLM_REQUEST_TIMEOUT_MS=600000` + `GRAPH_EXTRACT_TIMEOUT_MS` | lane: infra |
| G-8 | minor | Every pdf/docx upload (e2e too) triggers paid extraction; no off switch | read: `Documents.ts:1272` | EDC: `GRAPH_EXTRACT=off`, set in e2e env | open (Documents.ts owned by privacy lane; next wave) |
| G-9 | minor | No UI for `graphStatus` / `graph-retry` | read: `Documents.ts:3033` no caller | EDC: badge + "reconstruir" | open (next wave) |
| G-11 | NEEDS-RODRIGO | `evento` in the graph (`trello.md:42`); keep extracting `tema` that duplicates `documents.tema` (ADR §18.5)? | read | decisions | open |

## Tests, mocks, deploy wiring (lane T)

| id | sev | finding | evidence | fix | status |
|---|---|---|---|---|---|
| T-3 | gap | No test checks per-ecosistema isolation inside ai-service; `tenancy.e2e.ts:208-261` asserts corpus-name strings only | read | EDC: B's `X-AI-Org` retrieve returns 0 of A's chunks | lane: e2e |
| T-4 | gap | No recorded e2e run since 2026-08-29 (before MOCK_* removal 10-02 and per-eco orgs 10-17). `TESTING.md` is stale | quoted: `TESTING.md` | EDC: run with `COMPOSE_PROFILES=fake`, refresh doc | lane: e2e (after lands) |
| T-6 | NEEDS-RODRIGO | Rerank runs on the temporary borrowed (non-EDC) DeepInfra key; since `7e137e2` `CHAT_RERANK` defaults on, so every turn uses it. Whether edc-1 runs `7e137e2` is unverified | read: `infra/fleet/edc-1.md:179-181,293-294`, `rerank.ts:54` | create EDC DeepInfra account; until then `CHAT_RERANK=off`? | open |
| T-7 | warn | `API_KEYS` falls back to the public `dev-key-admin` when `AI_SERVICE_ADMIN_API_KEY` is unset | read: `infra/docker-compose.yml` | EDC: `:?` | lane: infra |
| T-9 | minor | Env vars read but undeclared: `AI_ECOSYSTEM_BUDGET_USD`, 12 `GRAPH_*`, `SEED_CORPUS_SKIP_ABOVE`; manifest lacks `CHAT_RERANK`, `QUERY_EXPANSION`, `PROMPT_SOURCE` | read | EDC: manifest rows | lane: infra |
| T-10 | minor | `.env.example:362` ships `RERANK_ENABLED=false` uncommented → copied `.env` ignores the key | read | EDC: comment out | lane: infra |
| T-11 | minor | Stale docs: compose says backend ignores `AUDIO_SERVICE_URL`; `edc-1.md` §6 names org `demo` and `edc`; `edc-1.md:194-197` says chat does not rerank | read | EDC | lane: infra |
| T-12 | warn | Security fix in ai-service: `trustProxy: true` → `TRUSTED_PROXY_HOPS = 1`. With `true`, a client sets its own IP via `X-Forwarded-For` and dodges rate limits | measured; `src/server.ts:242` | AI-STACK | lane: ai-stack |
| T-13 | minor | Two test harnesses: `src/test/pg-container.ts`/`server-harness.ts` vs `docker-pg.ts` | measured | AI-STACK: converge on one | lane: ai-stack |
| T-14 | minor | Stale MOCK_LLM comment `router/router.ts:253` | read | AI-STACK | lane: ai-stack |

## Docs to refresh

`TESTING.md` (counts 08-29; lists the fixed `/api/messages` 400), `plan/handoff-fixtures-e2e.md`
("suites e2e no verificadas"), `plan/trello.md:40` (says the local graph is mock; measured: 672 real
entities), `plan/audio-ingest-integration.md:3`, `plan/deploy-and-local-demo.md:204`. Lane: e2e (with T-4).

## Verified complete

PDF/DOCX/audio ingest paths through the gate to the draft corpus and callback; gate only ends in
`ready`/`hold`; holds refused at the single choke point; approved hold re-enters with the reviewer's
text; graph and publish read `corpusTextFor`; testimonio chunks drop the title; every backend call
site passes the ecosistema org; prompt v4 code and the person rule; drafts scoped to their
conversation (a mutation goes red); `asOf` on every retrieve; rerank non-2xx fallback;
`delegateOrgPrefix: "edc-"` matches `edc-eco-<id>`; no runtime TODO/FIXME; fixture scripts parse and
match corpus HEAD.
