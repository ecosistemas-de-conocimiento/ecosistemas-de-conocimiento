# Does GraphRAG improve answers? — measured, 2026-09-05

> 🔴 **Correction, 2026-10-16: every "citation precision" below is RETRIEVAL precision.**
> The scorer read chat-engine's `provenance`, which holds every retrieved chunk (topK 5),
> not the ones the answer cites with `[n]`. So local 0.38 / 0.364 means "of the ~5 documents
> put in the prompt, about 2 contain a fact" — its floor is 1/5 = 0.20. It says nothing
> about what the model cited. `score.ts` now reports both: `retrievalPrecision` (the old
> number, renamed) and true `citationPrecision` / `citationRecall` from the answer's `[n]`
> markers, and `results.json` now stores each arm's sources in prompt order. True citation
> numbers are **pending a re-run**; these two runs cannot be re-scored because they stored
> document ids sorted, not in prompt order.

Run `20260905060010`. **120 real generations** (20 questions × 2 arms × 3 repetitions)
against the live corpus, `asOf` 2026-09-05, `GRAPH_MIN_SUPPORT` 3, 191 corpus documents.

> ⚠ Scoring is **mechanical** — expected labels are string-matched in the answer text, and
> the expected sets are computed from `corpus-generativo`'s `MANIFEST.csv`, not judged.
> This is a weaker instrument than an LLM judge and deliberately so: a model grading a
> graph built by the same family of model, on a task defined by the people who built it, is
> the wrong instrument. Mechanical scoring understates both arms equally.

---

## The headline

**The graph changed the answer on 2 of 20 questions.** It was better on one local question
and worse on one global question. On the other 18 the two arms scored identically.

| class | arm | mean recall | citation precision | mean latency |
| --- | --- | --- | --- | --- |
| local | plain | 0.967 | 0.380 | 8.5 s |
| local | **graph** | **0.978** | 0.380 | 7.4 s |
| global | plain | **0.430** | **0.680** | 14.0 s |
| global | **graph** | 0.414 | 0.649 | 15.4 s |

On global questions — the class it exists for — it scored
**slightly worse on both recall and citation precision**. Neither difference is larger than
the noise at this sample size.

🔴 **Stated plainly, as the task required: there is no measured global gain.**

## Why there is no gain, which is the useful part

The result above is not "graph fusion was tried and did not help". It is **"graph fusion
almost never ran"**.

| | global | local |
| --- | --- | --- |
| questions where the graph found **zero** seed entities | **6 of 10** | 0 of 10 |
| maximum seed entities ever matched, any question | **1** | 1 |
| questions contributing any graph chunks to the prompt | **2 of 10** | 0 of 10 |

`MAX_RETRIEVE_SEEDS` is **8**. The matcher never reached 2.

### The mechanism

`matchEntitiesToQuery` (`lib/graph/queries.ts:876`) is pure literal containment — the
entity's canonical key must appear, on token boundaries, inside the user's question text.
No embedding, no fuzzy match, no synonym expansion. That is a deliberate design (ADR §8.1
wanted it pure and synchronous, with no model call), and it has a consequence nobody had
measured:

- A **local** question names its subject literally — *"¿qué lengua habla Efrén Peralta
  Guzmán…"*. The entity is in the string. 10 of 10 matched.
- A **global** question names a **category**, not an entity — *"¿qué centros de salud y
  hospitales aparecen en varios documentos?"*. `Centro de Salud de Tlayacapan` is nowhere
  in that sentence. 6 of 10 matched nothing at all.

The four global questions that did seed only did so by accident of phrasing: they happened
to contain the literal strings `PILARES`, `dengue`, or `escuela`.

🔴 **So the retrieval path cannot fire on the question class it was built for.** The graph
is asked to find what recurs across documents, using a matcher that requires the asker to
already name the thing that recurs.

### The sharpest single case

**G05 — *"¿Qué lenguas indígenas hablan las personas que aparecen en los documentos?"***
Eleven expected answers. **Zero seeds.** Recall 0.36 in both arms.

The graph holds all eleven languages as entities. It cannot retrieve them, because
"lenguas indígenas" is not one of their labels. This is the exact question the `lengua`
column added on 2026-09-05 (ADR §18.5) answers directly and the graph cannot.

## Where the graph did fire, it did not help

Only two questions produced graph chunks at all:

- **G06** (dengue tools) — 5 graph chunks per repetition. Recall **fell**, 0.92 → 0.75.
- **G10** (dengue ∩ escuela crossover) — 5 graph chunks per repetition. Recall unchanged at
  0.17 in both arms.

So on the only two occasions the fusion had material to fuse, it was neutral once and
harmful once. n=2; this is a hint, not a finding.

## What this does and does not license

**Does:** it rules out the optimistic case. Whatever GraphRAG is worth here, it is not
currently delivering a measurable improvement.

**Does not:** it does not show that graph fusion is worthless. It shows that *this seeding
strategy* starves it. A matcher that could turn "centros de salud" into the three hospital
entities — an embedding lookup over entity labels, or an entity-type filter — would be
testing a different system, and this evaluation says nothing about that system.

⚠ **The honest reading is that the experiment measured the seeder, not the fusion.**

## Limitations, stated rather than buried

- **20 questions, 10 per class.** Enough to see a large effect; nowhere near enough to
  resolve a small one. A 0.016 recall difference is noise.
- **Mechanical string matching** penalises a correct answer phrased differently. It does so
  in both arms, so the comparison holds even though the absolute numbers are pessimistic.
- **Citation precision on local questions is 0.38 in both arms.** That is low and it is not
  a graph problem — it is the same in the plain arm and deserves its own investigation.
- **Global recall is 0.43 at best.** The system answers global questions poorly regardless
  of the graph. That ceiling, not the graph delta, is the bigger finding for anyone deciding
  what to build next.
- Retrieval sees **published documents only** — 216 of 285. The 61 gate-held testimonios are
  invisible by design, and their absence is correct, not a bug.
- Three repetitions per arm smooth sampling noise in the model, not in the question set.

## Reproducing

```
payload run src/eval/run.ts        # writes results.json
payload run src/eval/diagnose.ts   # seed-matching diagnostic
```

`results.fake.json` is the fake-client dry run used to prove the harness before spending
real money. `results.json` carries `fake: false`.

---

# Second measurement, 2026-09-08 — the seeder fix works

Run `20260908091626`. Same harness, same 20 questions, same 3 repetitions, 120 real
generations. The only change is `seedEntitiesForQuery` in `lib/graph/queries.ts`.

⚠ **Compare within a run, not across runs.** The plain arm scored 0.430 global in the first
run and 0.461 here on identical questions — that gap is model sampling, not a change. Only
the plain-versus-graph contrast inside one run is evidence.

## The numbers

| class | arm | mean recall | citation precision | latency |
| --- | --- | --- | --- | --- |
| local | plain | 0.978 | 0.380 | 8.5 s |
| local | graph | 0.989 | 0.364 | 11.4 s |
| global | plain | 0.461 | 0.680 | 12.6 s |
| global | **graph** | **0.733** | **0.691** | 17.2 s |

**Global recall rose from 0.461 to 0.733** — a 59% relative improvement, against a first
measurement where the graph was slightly *worse* on this class.

Paired per question: **graph better on 5, worse on 2, identical on 13.** The first
measurement was better on 1, worse on 1, identical on 18.

| question | plain | graph | seeds |
| --- | --- | --- | --- |
| G04 — people named in several documents | 0.00 | **1.00** | 8 |
| G03 — events in more than one document | 0.22 | **1.00** | 8 |
| G01 — health centres and hospitals | 0.44 | **1.00** | 8 |
| G10 — dengue ∩ escuela crossover | 0.17 | **0.67** | 6 |
| G09 — recurring underlying concerns | 0.22 | 0.11 | 1 |
| L04 — one person's language and origin | 1.00 | 0.89 | 3 |

The four large gains are exactly the questions that previously seeded **zero** entities and
now seed the full eight. The mechanism did what it was built to do.

## Citation precision held

This was the predicted cost and it did not appear. Global citation precision went **0.680 →
0.691** — flat, marginally up. More seeds put more material in the prompt without the model
citing more loosely. Local precision fell slightly, 0.380 → 0.364, on a number that is poor in
both arms and is not a graph problem.

## What it now costs in latency

🔴 **Latency went up with the benefit.**

- **Global latency 12.6 s → 17.2 s**, roughly +37%.
- 🔴 **The graph leg itself got 5x slower: `graphMs` median 78 ms → 388 ms, max 4.0 s.** The
  pure matching function is still microseconds (124 µs → 257 µs benchmarked over the real 221
  candidates) and adds no new SQL statement, but the tiers now return up to 8 seeds instead of
  1, so the two expansion queries that follow do far more work. Most of the added latency is
  there and in the larger prompt, not in the matcher.

So the trade is **about four seconds for a 59% relative gain on the question class the graph
exists for**, and no measurable harm elsewhere.

## What is still not fixed

**G05 and G07 seed exactly one entity and did not move.** "¿Qué lenguas indígenas hablan las
personas…" and "¿De qué comunidades o pueblos de origen vienen…" — no entity label contains
*lengua* or *comunidad de origen*, no relation types them, and their support sits mid-
distribution. There is a test asserting this so nobody reads the new tiers as a fix for it.

Those two are answered by `documents.lengua`, added 2026-09-05 (ADR §18.5), which is the right
place for an axis the corpus declares rather than one the graph must infer.

**G09 lost 0.11** — the one real regression, on the vaguest question in the set ("preocupaciones
o temas de fondo"). One seed, 15 graph chunks, and the extra material appears to have crowded
out vector chunks that were carrying the answer. n=1; worth watching, not worth acting on.

## Limitations, unchanged

Twenty questions, ten per class, three repetitions. Mechanical string scoring, no LLM judge.
A 0.27 recall difference at this sample size is large enough to believe; the 0.011 citation
precision difference is not.

---

# Third measurement, 2026-10-17: dense or hybrid retrieval in chat? (audit C-4)

Retrieval only: no answer was generated, nothing was paid for but query embeddings.
`src/eval/retrieval.ts` sends the requests chat sends for the published corpus:
`dense` is `/v1/retrieve` (`CHAT_RETRIEVAL_MODE=dense`, today's default), `hybrid` is one
`/v1/retrieve/multi` call with `mode: 'hybrid'` (`CHAT_RETRIEVAL_MODE=hybrid`: cosine plus
the corpus's Spanish keyword search, fused by RRF). topK 5, what chat sends per corpus.

**Provenance (measured).** 2026-10-17, 19:34 to 20:15 UTC, on the dev workstation, against
the local `edc` stack's ai-service at `localhost:45401`, read-only. That image was built
2026-10-16 22:27 CST and predates `metadataFilterIn` and `orgDelegation`, so its corpora
sit in the key's own org (`demo`) and the `X-AI-Org` header is ignored. Corpus `eco-1`,
191 published documents. Load average 3.8 at start, 1.2 at end; other sessions were using
the box. Raw rows: `retrieval-results.topk5.json`. Rerun:
`EVAL_REPO_ROOT=<checkout with infra/.env> npx payload run src/eval/retrieval.ts`.

**Labels.** `harness` is the 20 questions of `questions.ts`, the labels `run.ts` scores.
Local (one target document): MRR = 1 / rank of the first chunk from the target, recall@k =
the target is in the top k. Global: recall@k = share of the expected facts named in the
top-k chunks' text; MRR = 1 / rank of the first chunk naming one. `local-all` applies the
local question template to every published document whose manifest name is unique and
appears in its own text: 189 single-document questions.

| labels | n | arm | MRR@5 | recall@1 | recall@3 | recall@5 | median request ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| harness local | 10 | dense | **0.950** | 0.900 | 1.000 | **1.000** | 4780 |
| harness local | 10 | hybrid | 0.475 | 0.400 | 0.500 | 0.600 | 464 |
| harness global | 10 | dense | 0.720 | 0.350 | 0.414 | 0.505 | 832 |
| harness global | 10 | hybrid | 0.733 | 0.308 | 0.515 | **0.623** | 595 |
| local-all | 189 | dense | **0.936** | 0.894 | 0.979 | **0.989** | 750 |
| local-all | 189 | hybrid | 0.503 | 0.386 | 0.598 | 0.698 | 645 |

- 🔴 **Hybrid halves single-document MRR, 0.94 → 0.50, on 189 questions.** Paired per
  question: hybrid better on 4, worse on 110, equal on 75. It reproduces the 2026-10-16
  baseline quoted in the audit (0.95 → 0.50 on 39 queries, another session) on a set
  five times larger. Likely cause (inferred, as that baseline said): the questions are
  long, the Spanish keyword leg matches their common words across many documents, and
  RRF gives that leg the same vote as the cosine leg.
- **Global questions gain a little: recall@5 0.505 → 0.623, n = 10.** Better on G01, G03,
  G05, G10; worse on G09; equal on 5. Ten questions cannot separate that from noise.
- **Latency: no decision-relevant difference.** The 4780 ms dense median on the 10 harness
  locals comes from the first requests of the run (inferred: a cold start), not a dense
  cost; on 189 questions dense is 750 ms and hybrid 645 ms.
- ⚠ **The two rerank arms did not run.** The local stack has `RERANK_ENABLED=false` and no
  `RERANK_API_KEY`; the probe's `legs` was `["dense"]`, so `rerank: true` would have been a
  silent no-op scored as "rerank". The script refuses those arms. Measuring them needs a
  stack with the reranker on (a throwaway ai-service on a copy of `edc_ai`, plus a
  DeepInfra key). Note how hybrid+rerank would differ: chat's multi call reranks once,
  over the fused list only, so with topK 5 it can only reorder the hybrid top 5. It
  cannot bring back a target hybrid ranked 6th or lower.
- ⚠ Not measured: topK 10, and dense with query expansion (chat's real dense path; the
  hybrid path skips expansion).

## Recommendation: keep `CHAT_RETRIEVAL_MODE=dense`

Hybrid loses about half the single-document MRR and 29 points of recall@5 on the
question chat gets most. Its global gain is small and rests on 10 questions. The default
stays `dense`; nothing here was flipped. Re-measure before flipping, with the rerank arms,
on a stack where rerank runs.

---

# Fourth measurement, 2026-10-17: the two rerank arms

Same script, same labels, same topK 5 as the third measurement, now on a stack where the
cross-encoder runs. Paid: the DeepInfra reranker plus query embeddings.

**Provenance (measured).** 2026-10-17, 20:56 to 21:11 UTC (wall 876 s), on the dev
workstation. ai-service built from this tree's `services/ai-service`, run as
a throwaway container with `RERANK_ENABLED=true`, `RERANK_PROVIDER=deepinfra`,
`RERANK_MODEL=Qwen/Qwen3-Reranker-0.6B`, an EDC-owned DeepInfra key, real OpenRouter query
embeddings. Its database was a `pg_dump` **copy** of the local `edc` stack's `edc_ai`,
restored into a throwaway Postgres on tmpfs; `scripts/ai-org-per-ecosystem.sql` was
applied to the copy (this ai-service resolves `X-AI-Org: eco-1` to org `edc-eco-1`). The
real `edc_ai` was only read by `pg_dump`. Corpus `eco-1`, 191 published documents. The
probe's `legs` was `["dense","rerank"]`. Load average 2.8 at start, 46 at end: another
session started a heavy job during the run, so the latency column is noisy and its last
minutes are inflated. Raw rows: `retrieval-results.topk5.rerank.json`. Rerun: as above,
plus `EVAL_AI_SERVICE_URL=<rerank-on ai-service>`. The stack was torn down after.

**Rerank calls and cost.** 420 `rerank ok` log lines, zero rerank errors: 209 dense+rerank
(pool 20 chunks each), 209 hybrid+rerank (pool 5, the fused list), 2 probes. One
representative pool-20 call, re-sent straight to DeepInfra after the run, cost
**$0.000123** for 12 307 input tokens (measured, `inference_status.cost`). So the run cost
about **$0.03** in reranking (inferred: 211 × $0.000123 plus 209 smaller pool-5 calls).
Query embeddings were not logged by ai-service; not measured, inferred under a cent.

| labels | n | arm | MRR@5 | recall@1 | recall@3 | recall@5 | median ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| harness local | 10 | dense | **0.950** | 0.900 | 1.000 | 1.000 | 574 |
| harness local | 10 | dense+rerank | 0.875 | 0.800 | 0.900 | 1.000 | 1299 |
| harness local | 10 | hybrid | 0.475 | 0.400 | 0.500 | 0.600 | 476 |
| harness local | 10 | hybrid+rerank | 0.600 | 0.600 | 0.600 | 0.600 | 790 |
| harness global | 10 | dense | 0.720 | 0.350 | 0.414 | 0.505 | 441 |
| harness global | 10 | dense+rerank | **0.925** | **0.458** | **0.624** | **0.718** | 2136 |
| harness global | 10 | hybrid | 0.733 | 0.308 | 0.515 | 0.623 | 453 |
| harness global | 10 | hybrid+rerank | 0.750 | 0.341 | 0.482 | 0.623 | 778 |
| local-all | 189 | dense | 0.936 | 0.894 | 0.979 | 0.989 | 452 |
| local-all | 189 | dense+rerank | **0.955** | **0.921** | **0.984** | **1.000** | 1363 |
| local-all | 189 | hybrid | 0.503 | 0.386 | 0.598 | 0.698 | 455 |
| local-all | 189 | hybrid+rerank | 0.688 | 0.677 | 0.698 | 0.698 | 797 |

- **The dense and hybrid rows reproduce the third measurement exactly** (every MRR and
  recall figure equal), on a different ai-service build and a copied database. The new
  rows are comparable to the old ones.
- **Dense+rerank is the best arm on 189 single-document questions: MRR 0.936 → 0.955,
  recall@5 0.989 → 1.000.** Paired: better on 18, worse on 13, equal on 158. Small, and
  in the right direction.
- **On the 10 harness globals, rerank lifts dense MRR 0.720 → 0.925 and recall@5 0.505 →
  0.718.** Ten questions; a hint, not a finding. On the 10 harness locals it costs a
  little (MRR 0.950 → 0.875: L04 and L05 drop from rank 1–2 to 2–4; recall@5 stays 1.0).
- **Rerank does not rescue hybrid.** Hybrid+rerank reaches 0.688 single-document MRR, still
  0.27 below dense. Its recall@5 is capped at hybrid's 0.698, as predicted: with topK 5 the
  reranker only reorders the fused top 5 and cannot bring back a target ranked 6th.
- **Latency: rerank adds roughly 0.3–0.9 s per retrieve** (median 452 → 1363 ms on 189
  questions, dense pool 20). Under the load noted above, so read the size, not the digits.

## Is chat's default still right? Yes: dense, with rerank on

Quoted from the brief for this run: chat's default is `CHAT_RETRIEVAL_MODE=dense` with
rerank on. That is the best arm measured here on the large set (dense+rerank, MRR 0.955)
and the best on global recall@5. Hybrid stays worse with or without rerank. Keep both
defaults. Nothing was flipped.

## Answer-level rerank arms on edc-1 dev (quoted, another session)

A separate session ran the answer-generation harness (`run.ts`, plain and graph arms, 3
repetitions, 19 questions) on **edc-1 dev**, 163 published documents, with rerank on, with
query expansion, and with `--no-rerank`. Quoted from
`/tmp/claude-1000/-home-furenku-chamba-cide-ecosistemas-de-conocimiento/c7f7a5cc-b1df-4fdd-8d33-4cd05b6448cb/scratchpad/eval-dev2/summary.txt`
(runs `20261017195542`, `20261017203514`; not re-measured here):

| class | arm | rerank on: recall | rerank off: recall |
| --- | --- | --- | --- |
| local | plain | 0.951 | 0.963 |
| global | plain | **0.598** | 0.472 |
| global | graph | **0.720** | 0.669 |

It measures a different thing (mechanical answer recall, not retrieval rank), on a
different corpus size and environment, and it covers no hybrid arm, so it does not replace
the table above. It points the same way: rerank helps global questions and does not
matter much on local ones.
