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
