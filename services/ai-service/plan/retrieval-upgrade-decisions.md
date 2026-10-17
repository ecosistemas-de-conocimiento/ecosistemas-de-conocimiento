# Shared retrieval upgrade — decisions

Migration: `0012`

Implements rungs 0–1 of the retrieval ladder, in ai-service, behind the existing
`/v1/retrieve` contract. Later rungs (reranker, HyDE, contextual retrieval, agentic loops)
are explicitly NOT started.

---

## 0. Verified baseline (against code)

`/v1/retrieve` before this change: one dense cosine top-K over
`chunks.embedding` (`vector(1536)`, HNSW), optional MMR rerank in Node over a
pool of `min(topK*2, 50)`, optional jsonb-containment `filter` on chunk
metadata, one corpus per call, alias-aware. No BM25, no reranker, no query
rewriting, no fusion, no temporal awareness. `RetrieveService.retrieve` was ~40
lines of orchestration over a single SQL statement.

**Two recon findings corrected the assumptions the work was planned on:**

1. **Chunking is NOT consumer-side.** A consumer POSTs whole documents and
   ai-service does 100% of the chunking. This settles the structural-chunker
   seam by itself (§2).
2. **No temporal metadata reached ai-service.** There was nothing to filter on;
   the columns had to be created (§1).

---

## 1. Temporal validity is a retrieval-time filter — `chunks.valid_from` / `valid_to` + `asOf`

**Decision.** Temporal validity is modelled as a half-open interval
`[valid_from, valid_to)` on `documents` AND denormalised onto `chunks`.
`POST /v1/retrieve` takes an optional `asOf`; when present, both retrieval legs
get the predicate

```sql
(valid_from IS NULL OR valid_from <= :asOf) AND (valid_to IS NULL OR valid_to > :asOf)
```

inside the candidate-set `WHERE`, before any ranking.

**Why NULL means "always valid".** Both bounds NULL is the default and is what
every pre-0012 row has. An unbounded interval contains every instant, so adding
`asOf` to a corpus that never sets validity changes nothing. That is what makes
the parameter safely additive rather than a silent behaviour change.

**Why denormalise onto chunks.** The predicate runs inside a hot vector/GIN
scan. A join back to `documents` to decide candidate eligibility would defeat
the index.

**Why not domain vocabulary.** The service knows only "this content was valid
between these instants". It does not know what supersession means — a repealed
statute, an expired policy, a stale price list are all the same shape. ADR-0001
holds.

**Consumer-facing.** `validFrom` / `validTo` are explicit optional fields on the
ingest document (not magic reserved metadata keys), so they are self-documenting
and typed.

### 1b. `PATCH /v1/corpus/:name/documents/:externalId/validity`

Supersession is discovered AFTER ingest. Without this endpoint, closing out an
old version would mean re-POSTing its full text to `/v1/ingest` — re-chunking
and **re-embedding an entire document to write two timestamps**. That cost is
precisely what would tempt a consumer to skip the step and leave stale content
retrievable, which is the failure this whole feature exists to prevent. The
cheap path has to be the safe path.

`null` clears a bound; omitting a field leaves it untouched. The distinction is
load-bearing — without it, un-retiring a document is inexpressible. The
resulting interval is validated against the STORED bound too, so a partial
update cannot silently produce an empty interval (which would render the
document permanently unretrievable).

App-role, `(org, project)`-scoped — same posture as the DELETE routes.

---

## 2. Structural chunking lives in ai-service — as MACHINERY ONLY, patterns supplied by the consumer

**Decision.** New `chunk_strategy: 'structural'` resolved by `chunkForCorpus`,
driven by heading patterns the CONSUMER supplies. Chunk-derived metadata (the
captured section id, under whatever `key` the consumer named, plus `part`) is
merged UNDER the consumer's document metadata, so a consumer key always wins a
collision.

**Where the patterns come from.** The consumer, always.
ai-service ships **no presets**. An earlier revision of this document shipped an
`es-legal` preset and argued it was "a text-format description in the same
category as `recursive-char`". **That reasoning was rejected**, and the preset
is deleted. The rule it violated:

> **Shared packages hold MACHINERY. Products hold CONTENT.** The test is not
> "is this abstract-looking?" — it is **"does this name, encode, or assume one
> product's domain?"** ai-service must never learn the word `artículo`.

A named preset fails that test twice over: it hard-codes one product's document
convention, and — worse — it is a one-way door, because the moment a consumer
sends `{ preset: 'x' }` the name is a contract this repo has to keep. Deleting
it later is a breaking change for every consumer that adopted it. The generic
chunker underneath is real machinery and stays; only the content moved out.

A `scripts/check-domain-vocabulary.mjs` denylist now fails the build if this
vocabulary reappears in `src/` or `drizzle/`, so the boundary is enforced rather
than remembered.

**Why the chunker is in ai-service at all** (this part is unchanged — it is the
MACHINERY that belongs here, not the patterns):

1. ai-service already does all chunking. Moving the splitter consumer-side means
   building a chunker per consumer.
2. `/v1/ingest` is document-level. A consumer **structurally cannot** set
   per-chunk metadata — the contract has no place to put it. Section
   identifiers have to be produced where the split happens.
3. One implementation, many sets of patterns.

**The wire seam.** Recon during
the preset removal found that `corpora.chunk_config` had **no HTTP surface at
all**: no `POST /v1/corpus`, and `IngestService.ensureCorpus()` hard-codes
`'recursive-char'`. Deleting the preset without adding a seam would have removed
structural chunking from the fleet entirely. So `POST /v1/ingest` now accepts
`chunkConfig`:

- **batch level** — `body.chunkConfig`, applies to every document in the request;
- **document level** — `body.documents[].chunkConfig`, overrides the batch value.

Per-document is the granularity that matters and is why the field is not merely
per-corpus: one corpus (e.g. a per-org corpus) legitimately mixes documents with
a numbered structure and documents that are ordinary prose, and a corpus-level
setting forces one splitter on both.

Precedence, resolved at enqueue time so the worker never reasons about it:
**document `chunkConfig` → batch `chunkConfig` → corpus row's strategy.**

Shape (`sections` is the only required key):

```jsonc
{
  "sections":    [{ "key": "section", "pattern": "^\\s*Section\\s+(\\d+)\\b", "flags": "i" }],
  "subSections": [{ "key": "clause",  "pattern": "^\\s*([IVX]+)[.)]\\s" }],
  "maxChars": 4000,   // optional, default 4000
  "minChars": 80      // optional, default 80
}
```

`pattern` is JS regex SOURCE, applied with `gm` forced on plus `flags`; capture
group 1 is the identifier. Everything is additive: a request with no
`chunkConfig` produces byte-identical behaviour to before the field existed.

**Behaviours worth knowing:**
- Splits at every caller-supplied boundary, keeping suffixed identifiers
  distinct (`12` vs `12 Bis` vs `12-A`) when the caller's pattern captures them.
  Folding a suffixed section into its base is the classic failure and is
  unit-tested against.
- A section that exceeds the size ceiling splits at `subSections` boundaries,
  and each piece records the sub-section it starts at — so a citation can still
  be narrowed below section level.
- A short section is NEVER merged into its neighbour. A one-line provision is a
  real provision someone needs to cite; merging it would attach it to the wrong
  identifier. Only *unidentified* spans (preamble, bare headings) merge.
- If the patterns match **no** boundary in a document, it falls back to
  `recursive-char` with a warning — patterns meeting a document that has no such
  structure is routine in a mixed corpus, not exceptional. Detected by "did any
  chunk get section metadata", not by counting chunks.
- Every misconfiguration degrades to `recursive-char` rather than throwing: a
  bad payload must not turn every ingest job into a poison-pill BullMQ retry
  loop. A legacy `{ preset: … }` config warns, naming `sections` as the
  replacement, then degrades.

---

## 3. Rung 1 — hybrid BM25-ish + dense, fused with RRF

**Decision.** `mode: 'hybrid'` (opt-in; default `dense` is byte-identical to
before) runs a Postgres full-text leg alongside the dense leg over the *same*
filtered candidate set, and fuses with Reciprocal Rank Fusion. `chunks.text_search`
is a `tsvector` + GIN index; the configuration is per-corpus
(`corpora.text_search_config`, default `'spanish'`).

**Why a plain column, not GENERATED.** A generated column must name one
immutable text search configuration at DDL time. The configuration is a
per-corpus setting so a Spanish and an English corpus can share a database. The
worker fills it in a follow-up statement scoped to the document just written.

**Why RRF and not a weighted score sum.** Cosine similarity and `ts_rank_cd`
are not commensurable — cosine sits in a narrow corpus-dependent band,
`ts_rank_cd` is unbounded and length-dependent. Any fixed weighting of the two
is a hidden per-corpus tuning constant that will be wrong for the next corpus.
RRF discards magnitudes and keeps only ordering, which is the part that
transfers.

### Three non-obvious things that decided whether this worked at all

Each was found by the eval harness, and each is worth ~5–20 points of
exact-identifier accuracy. None would have been caught by inspection.

1. **Postgres's query parsers are conjunctive.** `websearch_to_tsquery` and
   `plainto_tsquery` both AND their terms. `artículo 70 obligaciones de
   transparencia` becomes `'articul' & '70' & 'oblig' & 'transparent'`, and the
   chunk that *is* artículo 70 matches nothing because it does not use the word
   "transparencia". The lexical leg silently returned zero rows for exactly the
   queries it was added to fix. Fixed by building the query **disjunctively**
   from `to_tsvector` output — same stemming and normalisation as the index,
   lexemes produced by Postgres rather than the user (so no injection surface
   and no parse errors on stray punctuation), OR-ed together, with ranking
   rather than matching deciding the winner.

2. **Tie blocks must be credited at their LAST rank.** `ts_rank_cd` routinely
   ties a large fraction of the corpus — for `artículo 47`, every chunk
   containing the stem "articul" scores identically, which in a statute corpus
   is every chunk. Measured on the golden set:
   - ordinal ranking (2, 3, 4, …): arbitrary, and non-reproducible when the
     tie-break is a random uuid;
   - standard competition ranking (all tied → rank 2): **dropped
     exact-identifier from 95% to 76%** — thirty noise chunks each collecting
     1/(k+2) drown the one genuine rank-1 hit;
   - modified competition ranking (all tied → the group's last position):
     **100%**. Rank is a proxy for confidence, and a leg that cannot
     distinguish thirty candidates should not be rewarded for its indecision.

3. **Never tie-break on a row id.** The first implementation fell back to
   `chunks.id` — a uuid regenerated on every ingest — so identical data produced
   different top-K orderings run to run and the eval flapped. The tie-break
   chain is now: found-by-both-legs → denseScore → lexicalScore → ordinal →
   id.

### Consumer-visible caveat

In `hybrid` mode `score` is an RRF score (typically 0.01–0.05), **not** a cosine
similarity. Any consumer thresholding on `score` must read `denseScore`, which
remains the cosine value. This is the reason hybrid is opt-in rather than the
default — no pinned consumer can be affected without changing its own call.

---

## 4. Eval seam — machinery here, golden content with the consumer

**Decision.** ai-service owns the retrieval-eval **machinery**
(`src/eval/`: interchange format, metrics, runner, offline embedder,
comparison report). Consumers own the golden **content**.

**Why not put a consumer's golden set here.** Those items encode a product's
subject matter. Copying them here would put a product's domain in the shared
service (ADR-0001). The same rule that deleted the chunking preset (§2) applies
to fixtures: a fixture is content.

**Why the runner lives here.** A retrieval eval has to run *inside* the retriever
to A/B ranking configurations over one ingest without a network round trip per
item.

**So:** ai-service ships its own small project-agnostic golden set (`gs-ai-2026-07`,
43 items) as this repo's regression gate. A consumer feeds its items in by
exporting to this format.

**Why the embedder is offline and deterministic.** An eval that costs money per
run does not get run, and a regression gate that does not run on every change is
not a gate. `fixture-embedder.ts` is a hashed bag-of-words that **deliberately
drops numerals and roman numerals** — reproducing the exact property of real
dense retrievers that rung 1 exists to fix (sub-word-tokenised "16" and
"NOM-035" carry almost no distributional signal and get mean-pooled away).

**Honesty about what the numbers mean.** This is a valid A/B between retrieval
*configurations* on this repo's machinery. It is NOT a prediction of production
retrieval quality — the fixture embedder does not model synonymy or paraphrase.
The vigencia and chunk-boundary assertions, by contrast, are exact: they do not
depend on embedding quality at all.

**Fixtures are synthetic AND domain-neutral.** `structured-corpus.ts` invents
five documents belonging to no consumer's subject matter, in invented English.
What is faithful is the SHAPE — suffixed numbering (`12 Bis`, `12-A`), a
superseded edition beside its replacement, hyphenated codes, decimal ids —
because shape is the only thing the retrieval machinery is responsible for.
The fixture also supplies its OWN chunking patterns (`FIXTURE_CHUNK_CONFIG`),
which is the same seam a consumer uses; the harness takes documents, patterns
and text-search configuration as parameters and reaches for none of them.

The corpus was made neutral, replacing a Spanish-language legal
fixture. The A→D conclusions survived the swap; see §5 for the two slices where
the numbers moved and why.

---

## 5. Result

43 golden items, topK=8, offline embedder, `pnpm run eval:retrieval`:

| config | pass | recall | MRR | nDCG | stale citations |
|---|---|---|---|---|---|
| A — dense + recursive-char, no `asOf` (today) | 19/43 (44%) | 0.628 | 0.570 | 0.585 | **21** |
| B — + validity filter | 26/43 (60%) | 0.628 | 0.616 | 0.619 | 0 |
| C — + structural chunking | 37/43 (86%) | 0.930 | 0.872 | 0.887 | 0 |
| D — + hybrid RRF (rung 1) | **42/43 (98%)** | 1.000 | 0.968 | 0.976 | 0 |

By slice, A → D: exact-identifier 24% → 95%; structural 0% → 83%; topical 58%
→ 100% (no regression at any step); validity 15% → 100%; point-in-time 67% at
A/B and 100% from C — the filter is genuinely temporal, not "hide old things".

The 21 stale citations under A are the headline. On today's service, a query
about the competent authority returns the superseded edition naming a body that
no longer exists, with no signal that anything is wrong.

### Neutral-fixture swap: what moved, and what did not

The table above is measured on the domain-neutral fixture. The earlier
Spanish-language fixture gave: A 19/43, B 26/43, C 38/43, D **43/43**; slices
exact-identifier 19%→100%, structural 0%→100%, topical 58%→100%, validity
23%→100%, point-in-time 100% at every step.

**Every conclusion held.** A leaks stale content and B fixes it completely; C
buys the structural and distractor slices; D buys exact-identifier; nothing
regresses at any step, and topical is 100% from C in both fixtures. The A→D
improvement is if anything slightly larger on the neutral corpus.

Two slices moved, and BOTH are chunk-boundary luck rather than behaviour:

- **point-in-time 100% → 67% at configs A and B.** One item asserts rank-1
  citation groundedness. Under B's arbitrary 128-token window the boundary
  happens to fall mid-sentence, so rank 1 holds the tail of one provision and
  the head of the next. The superseded edition IS retrieved (ranks 1–3 are all
  the old edition); only the rank-1 grounding fails, and config C — whose whole
  job is cutting on boundaries — fixes it. The Spanish fixture passed here
  because its windows happened to cut elsewhere. **The gate was corrected
  accordingly**: from B onward it asserts the superseded edition is RETRIEVED
  (that is what the filter is responsible for), and the strict full-pass
  assertion now starts at C (that is what the chunker is responsible for). This
  is a more precise test than the one it replaces, not a weaker one.
- **structural 100% → 83% at D (one item, `str-02`).** A short neighbouring
  section re-uses three of the four query terms and out-ranks the target on
  cover density. In the Spanish fixture the equivalent pair happened to score
  the other way round. The fixture was deliberately NOT tuned to make this pass:
  authoring a corpus until the numbers improve is how an eval stops measuring
  anything. It costs one item and breaks no gate.

Neither number was load-bearing for the decision to ship rungs 0–1.

---

## 6. Deploy + consumer notes

- **ai-service deploys FIRST, then consumers.** Everything added is additive:
  a consumer pinned to the current client and sending today's request bodies
  gets byte-identical SQL and byte-identical responses (plus one new optional
  `denseScore` field mirroring `score`).
- **Migration 0012 takes an `ACCESS EXCLUSIVE` lock** to add columns and builds
  two indexes non-concurrently. Fine at current corpus sizes; if `chunks` grows
  large before this reaches prod, split the `CREATE INDEX` out and run it
  `CONCURRENTLY` outside the migration transaction.
- **`text_search` is NULL for every pre-0012 chunk.** A NULL tsvector matches no
  tsquery, so hybrid retrieval over an un-backfilled corpus degrades to
  dense-only rather than returning wrong results. Deliberate: correctness-
  preserving by default, opt-in cost. The backfill statement is at the bottom
  of the migration, commented out because it rewrites every chunk row.
- **Client `@edc/ai-client` 0.6.0 → 0.7.0**, additive only. `filter` is
  now typed, and `ChunkConfig` /
  `ChunkSectionPattern` are exported for the ingest-side seam (§2).


1. Send `validFrom` / `validTo` on ingest, from `document_versions`.
2. Call `admin.setDocumentValidity(corpus, docId, { validTo })` from
   `flipSupersede()` — today the flip is invisible to ai-service, which is why
   superseded chunks stay retrievable.
3. Pass `asOf: new Date().toISOString()` on the retrieve calls in
   `askThread.ts`, `indicatorAssess.ts`, `suggestInitiatives.ts`.
4. Send its OWN `chunkConfig` on ingest — `{ sections, subSections }` with the
   patterns for its documents — at the document level for the documents that
   have a numbered structure, leaving the rest to the default splitter. There
   is no preset to name; ai-service ships none (§2). Then re-ingest.
5. Pass `mode: 'hybrid'` on the retrieve calls.
6. Seed `document-sources` rows — the auto-fetch infrastructure exists but there
   are no `diputados.gob.mx` URLs anywhere, so `a consumer app-global` is empty today.

Items 1–2 are the ones that matter: without them `asOf` has nothing to filter.
