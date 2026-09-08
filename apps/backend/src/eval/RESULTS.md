# Does GraphRAG improve answers? — measured, 2026-09-05

Run `20260905060010`. **120 real generations** (20 questions × 2 arms × 3 repetitions)
against the live corpus, `asOf` 2026-09-05, `GRAPH_MIN_SUPPORT` 3, 191 corpus documents.
Total spend **$0.14**.

> ⚠ Scoring is **mechanical** — expected labels are string-matched in the answer text, and
> the expected sets are computed from `corpus-generativo`'s `MANIFEST.csv`, not judged.
> This is a weaker instrument than an LLM judge and deliberately so: a model grading a
> graph built by the same family of model, on a task defined by the people who built it, is
> the wrong instrument. Mechanical scoring understates both arms equally.

---

## The headline

**The graph changed the answer on 2 of 20 questions.** It was better on one local question
and worse on one global question. On the other 18 the two arms scored identically.

| class | arm | mean recall | citation precision | mean latency | cost |
| --- | --- | --- | --- | --- | --- |
| local | plain | 0.967 | 0.380 | 8.5 s | $0.0325 |
| local | **graph** | **0.978** | 0.380 | 7.4 s | $0.0355 |
| global | plain | **0.430** | **0.680** | 14.0 s | $0.0329 |
| global | **graph** | 0.414 | 0.649 | 15.4 s | $0.0371 |

Graph costs **+11% per call**. On global questions — the class it exists for — it scored
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
currently delivering a measurable improvement, and it is charging 11% per turn for that.

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

| class | arm | mean recall | citation precision | latency | cost |
| --- | --- | --- | --- | --- | --- |
| local | plain | 0.978 | 0.380 | 8.5 s | $0.0324 |
| local | graph | 0.989 | 0.364 | 11.4 s | $0.0339 |
| global | plain | 0.461 | 0.680 | 12.6 s | $0.0332 |
| global | **graph** | **0.733** | **0.691** | 17.2 s | $0.0488 |

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

## What it now costs

🔴 **The price went up with the benefit.**

- **+26% per call**, against +11% in the first measurement.
- **Global latency 12.6 s → 17.2 s**, roughly +37%.
- 🔴 **The graph leg itself got 5x slower: `graphMs` median 78 ms → 388 ms, max 4.0 s.** The
  pure matching function is still microseconds (124 µs → 257 µs benchmarked over the real 221
  candidates) and adds no new SQL statement, but the tiers now return up to 8 seeds instead of
  1, so the two expansion queries that follow do far more work. Most of the added latency is
  there and in the larger prompt, not in the matcher.

So the honest trade is no longer "11% for nothing". It is **26% and four seconds for a 59%
relative gain on the question class the graph exists for**, and no measurable harm elsewhere.

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
