# 01 — Does GraphRAG actually improve answers?

**Blocked on:** 🟡 owner approving ~40 real LLM calls (~30 min, under $1).
**Owns:** `apps/backend/src/eval/**` (new). Touches no product code.
**Run before task 04** — 04 re-extracts and destroys the baseline this measures.

## Why

The ADR records this as unmeasured, deliberately: the owner chose always-on
fusion with a silent fallback and no evaluation, and later dropped the per-answer
path logging too. So the graph's cost is certain and its benefit is invisible.

We now have something we did not have then: a corpus with **seeded ground truth**
(`MANIFEST.csv`), so the answer can be computed rather than judged.

Extraction recall is already measured — 93% of named people, 100% of family
links, 70% of anchor places. **That is not the same question.** It proves the
graph holds the right facts, not that those facts reach a better answer.

## Design

**Two question classes, which should behave oppositely.**

- **Local** — "¿qué dice el documento X sobre Y?" The graph should not help.
  Success is that it does not make things worse, and the latency cost is visible.
- **Global** — "¿qué lugares se repiten entre los testimonios de traducción en
  salud?" This is the case the graph exists for.

**Ground truth is computed, not judged.** For a global question the expected
answer is a set derivable from `MANIFEST.csv` — e.g. every `sitio_ancla`
appearing in ≥3 published documents of that ecosistema.

**Scoring is mechanical, deliberately.** String-match expected labels in the
answer text. 🔴 Do not use an LLM judge: a model grading a graph built by the
same family of model, on a task defined by the people who built it, is the wrong
instrument. Mechanical scoring is weaker and unbiased; say so in the report.

**Both arms, same everything else.** Call the chat-engine turn directly with and
without `graphProvider`. Same corpora, same `asOf`, same condensed query. Do not
add a feature flag to product code for this.

## Measure per arm

- expected facts present in the answer (recall)
- citation precision — do the cited documents actually contain the fact
- latency
- prompt + completion tokens, and cost

## Report

Split local vs global. 🔴 **If global shows no gain, say so plainly.** That is a
valid and valuable result — it is the evidence needed to decide whether to keep
paying for fusion on every turn. Do not soften it.

## Watch out

- ⚠ Retrieval only sees **published** documents. 216 of 285 are published; the
  61 gate-held testimonios are invisible and their absence is correct, not a bug.
- ⚠ `asOf` is mandatory. `buildRetrieveBody()` returns null without it and the
  caller silently yields zero chunks.
- ⚠ Corpus names come from the backend, never composed locally. An unauthorised
  name returns empty **with no network call**, which looks like a graph miss.
- ⚠ 20 questions × 2 arms is enough to see a large effect and not enough to
  resolve a small one. State the limitation rather than over-reading the result.
