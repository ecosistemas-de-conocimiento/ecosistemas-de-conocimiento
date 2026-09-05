# 04 — Generic words are becoming the biggest nodes

**Blocked on:** nothing to start. 🟡 owner should approve the re-extraction cost.
**Owns:** `apps/backend/src/lib/graph/prompt.ts`, `extract.ts`, their tests.
**Supersedes task 05** — fold those 11 documents into this re-run rather than paying twice.
**Run after task 01**, which needs the current graph as its baseline.

## The problem, measured

| Label | Type | Documents |
| --- | --- | --- |
| `barranca` | lugar | 49 |
| `español` | tema | 46 |
| `escuela` | **organizacion** | 22 |
| `discapacidad` | tema | 27 |

These are common nouns, not entities. `escuela` typed as an `organizacion` is
plainly wrong — it is not a named organisation.

## Why it matters

A hub node that means nothing connects documents that have nothing to do with
each other. In a view whose entire purpose is finding real patterns across
testimonies, the highest-degree nodes being generic words is the failure mode
that makes the whole surface untrustworthy — a reader cannot tell a meaningful
cluster from an artefact of vocabulary.

⚠ It also inflates support counts, which is what `GRAPH_MIN_SUPPORT` gates on. A
generic label clears the privacy threshold easily and a specific one may not.

## The prompt already says not to do this

Rule 3 in `graphPromptTemplate`: *"Usa la forma más CORTA que siga siendo
específica. 'agua' es demasiado vago; 'acceso al agua potable' es útil."*

So this is not a missing instruction. It is an instruction the model does not
follow reliably. Consider which of these is the real fix:

- sharpen rule 3 with the observed failures as explicit counter-examples
- a post-filter: reject single common nouns with no qualifier
- a stop-list, which is the crudest option and will not generalise to a new corpus

Prefer something checkable in code over something asked of the model. The person
rule is enforced twice for exactly this reason.

## Contract

- Bump `GRAPH_PROMPT_VERSION` to `v3`. It is what makes stale rows findable.
- Re-extract the whole corpus: `payload run src/lib/graph/backfill.cli.ts`.
  ⚠ ~261 documents at 70–95s each, concurrency 2 — about 3 hours and ~$1.
- Re-run the evaluation in task 01 afterwards and compare. 🔴 If hub quality
  improves but entity recall drops, that is a trade the owner decides, not you.

## Watch out

- ⚠ Do not shrink `maxItems` as a fix. It was tried: 40 → 25 → 15 changed
  nothing, because this model generates until cut off rather than honouring it.
  The **prose** cap in rule 9 is what it actually reads.
- ⚠ Keep rule numbering contiguous. It has been wrong twice — once with two rule
  8s and no rule 7, once with a stale "60 relaciones" against a `maxItems` of 20.
  There is a test for this now; do not remove it.
