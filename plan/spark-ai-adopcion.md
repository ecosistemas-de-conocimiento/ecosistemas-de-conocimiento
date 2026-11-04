# Self-hosting EDC's AI on the Spark — adoption plan (draft)

Draft, 2026-10-17. For Rodrigo. Planning only: nothing was deployed, installed or bought.

**Why this exists.** Raw testimony must not reach a hosted model once real participant data
exists (Rodrigo, 2026-10-17, quoted from `plan/auditoria-ia-2026-10-17.md`, I-13/I-14). Today
it does: stage 3 of the anonymisation gate sends raw text to a hosted model to learn what to
hide (`apps/backend/src/lib/anonymise/types.ts:190-204`). EDC can self-host, with its own box. This plan says which AI modules move, in what order, and how we prove
each move did not make things worse.

**Provenance tags used below.**
- `measured`: read or run by me on 2026-10-17, on the local box (`torre`), local stack, unless
  said otherwise. DB numbers come from read-only SQL on the local `edc_ai` database
  (`traces`, `usage_logs`), covering 2026-08-15 to 2026-10-17. This is **dev and test traffic,
  not production volume**.
- `read`: read in code, with file:line.
- `quoted`: from a document or web page, linked.
- `inferred`: my arithmetic or judgement, with what it is based on.
- `ASSUMED`: not confirmed. The hardware model is CONFIRMED (2026-10-17, Rodrigo: NVIDIA DGX Spark, version 7.5.0, presumably DGX OS 7.5.0). Its location is still ASSUMED (open question 1).

---

## 0. The hardware we are planning for

**CONFIRMED (Rodrigo, 2026-10-17): "the Spark" is an NVIDIA DGX Spark, version 7.5.0.** The specs below are quoted from public sources, not measured on the box. Confirm first
(open question 1). Specs, all `quoted` from
[NVIDIA's product page](https://www.nvidia.com/en-us/products/workstations/dgx-spark/) unless noted:

| Item | Value |
|---|---|
| Chip | GB10 Grace Blackwell; 20 Arm cores (10 × X925, 10 × A725) |
| Memory | 128 GB LPDDR5x **unified** (CPU and GPU share it), 256-bit, **273 GB/s** |
| Compute | up to 1 PFLOP FP4 — sparse FP4, per [LMSYS, 2025-10-13](https://www.lmsys.org/blog/2025-10-13-nvidia-dgx-spark) |
| GPU arch | compute capability sm_121, needs CUDA 13 ([Rafay blog](https://docs.rafay.co/blog/category/arm/)) |
| CPU arch | **ARM64** (aarch64). DGX OS, Ubuntu-based |
| Storage | up to 4 TB NVMe, self-encrypting |
| Network | 1 × 10 GbE, ConnectX-7 200 Gb/s, Wi-Fi 7 |
| Power | 240 W PSU; chip draws about 140 W |
| Price | Founders Edition $4,699 after a 2026-02-23 rise ([NVIDIA forum](https://forums.developer.nvidia.com/t/2-23-2026-price-change-announcement/361713)) |

**What matters for us.** Decode speed (writing tokens) is limited by memory bandwidth, and
273 GB/s is modest. A dense 8B model at FP8 decodes about 20 tok/s at batch 1 (`quoted`, LMSYS
above). Mixture-of-experts models, which read only a small active part per token, decode
much faster: Qwen3-30B-A3B at Q8 gives 61 tok/s and gpt-oss-120b gives 59 tok/s (`quoted`,
[llama.cpp DGX Spark bench, ~2026-02-05](https://github.com/ggml-org/llama.cpp/blob/master/benches/dgx-spark/dgx-spark.md)).
The 128 GB is the Spark's strength: many models fit at once.

**Second candidate host: the RTX 5070 dev server** (`plan/servidor-desarrollo.md`, not bought).
x86_64, 12 GB GDDR7 at 672 GB/s (`quoted`,
[Guru3D](https://www.guru3d.com/review/geforce-rtx-5070-founders-edition-review/)). It decodes small
models faster than the Spark (2.5× the bandwidth, `inferred`), but 12 GB holds only small ones.
Being x86_64 also avoids most ARM64 packaging pain (section 4).

---

## 1. Inventory: every AI call EDC makes

Model today: **every chat-style call uses `deepseek/deepseek-chat-v3.1` on OpenRouter**, all four
tiers (`read`: `services/ai-service/src/services/registry/resolve.ts:113-158`; `measured`: every
row in `traces`). Tiers differ only in output cap: quick 400, standard 800, deep 3,500, maximum
6,000 tokens (`read`, same lines). No registry rows override this locally (`measured`:
`registry_entries` is empty).

Sensitivity scale: **RAW** = unredacted testimony or audio of a participant · **USER** = a
member's own typed text, unredacted · **REDACTED** = gate output · **DOC** = `documento` kind,
never gated (reference material).

| # | Call | Code (read) | Tier / model / provider | Input sensitivity | Volume (measured, local) | Cost (measured, local) | Latency (measured p50 / p95) and need | Quality bar |
|---|---|---|---|---|---|---|---|---|
| 1 | Gate stage 3 — **detect** | `apps/backend/src/lib/anonymise/detector.ts:351-373`, from `gate.ts:269` | quick, 400 out; ~250-word chunks, 3 in flight, 90 s timeout (`detector.ts:46,56,62`) | **RAW** testimony and raw conversation turns | 259 completed + 1 aborted calls (`label=sync:anonymise-detect`, detect and verify share the label); avg 1,391 in / 119 out tokens; max out 400 | $0.151 total; avg $0.00058/call | 3.8 s / 16.4 s per call. Need: async, minutes are fine | Must find every name. A miss leaks a person; over-redaction only costs readability |
| 2 | Gate stage 4 — **verify** | `gate.ts:302`, same detector | same | REDACTED (re-scans the output) | inside #1 | inside #1 | same | Must catch survivors; today it also holds on titles like "el [Persona E]" (`measured`, gate log below) |
| 3 | Embeddings — ingest | `apps/backend/src/lib/publishDocument.ts:450`, `collections/Documents.ts:1694`, `lib/conversationIngest.ts:604` → ai-service ingest worker | `baai/bge-m3`, 1,024 dims, OpenRouter (`services/ai-service/src/config/env.ts:190,198-199`) | REDACTED for testimony and conversations; DOC raw | 393 ingest calls, 188,203 tokens | $0.0019 total | async, no user waiting | Same vectors as today, or a measured retrieval win |
| 4 | Embeddings — query | `packages/chat-engine/src/core/retrieve.ts:143` → `/v1/retrieve` | same | USER (the condensed question) | not separated in `usage_logs` (4 `/v1/embed` rows only) | ≈ $0 | in the chat path; well under 1 s needed (`inferred`) | Same as #3 |
| 5 | Rerank | `apps/web/src/lib/server/engine/rerank.ts:55-91` → `rerank: true` on retrieve | `Qwen/Qwen3-Reranker-0.6B` on **DeepInfra**, on a borrowed non-EDC key (`infra/docker-compose.yml:717-720`; audit T-6) | USER question + REDACTED/DOC chunks | 0 rows: rerank is off locally (`measured`: `RERANK_ENABLED=false` in the ai-service container) and is not written to the usage tables | not recorded | 8 s timeout; falls back to un-reranked order on error | No measured win yet (audit C-8: rerank arms never measured) |
| 6 | Condense follow-up | `packages/chat-engine/src/core/condense.ts:42-56` | quick (`maxTokens: 80` set but never sent; audit note) | USER chat history | 5 calls (`sync:chat`, quick), avg 222 in / 44 out | $0.0004 | in the chat path; ~1–2 s | Standalone question keeps the user's intent |
| 7 | Query expansion | `apps/web/src/lib/server/engine/expand.ts:188-197` | quick; 5 s timeout, ≤ 3 variants | USER | inside #6 | inside #6 | must beat its 5 s timeout | No measured win yet (C-8) |
| 8 | Chat answer | `apps/web/src/routes/api/generate/+server.ts:539-569` (stream), `:586` (sync) | standard, 800 out (the engine's 1,800 never reaches ai-service; `chat-engine/core/config.ts:157-158`) | REDACTED/DOC chunks + USER question | 250 sync + 24 stream; avg 3,192 in / 234 out; max out 800 = the cap | $0.306 | sync 8.8 s / 24.6 s; stream 5.1 s / 7.8 s. Need: streaming, first token fast | High: cited, faithful Spanish answers |
| 9 | Graph extraction | `apps/backend/src/lib/graph/extract.ts:1001-1013` | deep (`GRAPH_EXTRACT_EFFORT`), prompt v4; 12,000-char windows, 2 at once, 660 s timeout | REDACTED (testimony) / DOC | 570 calls (deep) + 3 (standard); avg 2,798 in / 811 out; max 2,401 out | $1.640 + $0.006; avg $0.0029/call | 72 s / 190 s. Need: background, hours are fine | Valid JSON matching the schema; 27 of 1,114 traces flagged invalid JSON or schema mismatch (`measured`, `traces.metadata.flags`) |
| 10 | Transcription | `apps/backend/src/lib/audioClient.ts:261,353` → `services/audio-service` | faster-whisper on CPU, `small`, `int8` (`infra/docker-compose.audio.yml:104,130,132`); code default `large-v3-turbo` (`services/audio-service/app/config.py:76-80`) | **RAW audio** (voice) | not deployed on edc-1 (audit I-13) | $0, already self-hosted | 4 h job timeout; async | Spanish word accuracy; names spelled so the gate can find them |
| 11 | Eval | `apps/backend/src/eval/engine.ts:256-269` | standard (same as #8) | DOC/REDACTED eval corpus | ~40 calls per run (`run.ts:5`) | inside #8 | offline | **There is no LLM judge.** Scoring is mechanical by design (`eval/score.ts`; `quoted` from `eval/RESULTS.md`) |

**Totals** (`measured`, local, two months): router calls $2.10; embeddings $0.002. Money is
not the driver. Privacy, and the borrowed rerank key, are.

**The gate at document scale** (`measured`, 2026-10-17, gate harness `measure4.ts` run 4,
host `torre`, load 2.4–3.0, real hosted model):

| Synthetic transcript | Calls | Cost | Wall time | Planted names found |
|---|---|---|---|---|
| 1,195 words | 11 | $0.0065–0.0077 | 18–33 s | 20/20 (both runs) |
| 4,866 words | 42 | $0.024 | 82 s | 20/20 |

The audit's wave-3 run gave 4,862 words → ready in 75 s, $0.022 (`quoted`, audit doc). A
60-minute interview is roughly 8,000–9,000 words, so about 70–80 calls and $0.04 (`inferred`
from ~140 spoken words per minute and the rows above).

**Where raw text leaves today** (`read`): gate detect (#1, raw testimony and raw conversation
turns), condense and expansion (#6–7, the member's own text), and every `documento` (never
gated). Only #1 carries participant testimony. Section 7, question 6 asks whether the rule
covers the others.

---

## 2. Verdict per module

Footprints are weights only unless said otherwise; add context memory (KV cache) on top.
Footprints and speeds are `inferred` from parameter counts and the `quoted` benchmarks in
section 0 unless a source is given. **None of the inferred speeds is a reason to buy or move by
itself; Phase 0 measures them.**

| Module | Verdict | Why |
|---|---|---|
| Gate detect + verify (#1–2) | **Move first** | The only call with raw testimony. The privacy rule requires it |
| Rerank (#5) | **Move first** | Same open weights as today; easy parity; ends the borrowed DeepInfra key |
| Embeddings ingest + query (#3–4) | **Move later** (Phase 2) | Input already redacted. Same weights, so low risk; removes a dependency |
| Transcription (#10) | **Move later** (Phase 3) | Already self-hosted (CPU). The GPU is an accuracy and speed upgrade |
| Condense + expansion (#6–7) | **Move later** (Phase 4) | Needs an ai-service change; small win |
| Graph extraction (#9) | **Move later, optional** | Redacted input; slow hosted (72 s p50); needs a big model and JSON parity |
| Chat answer (#8), eval (#11) | **Keep hosted** | Highest quality bar; redacted input; streaming latency |

### 2.1 Gate detector — move first

- **Candidates.**
  - Small instruct LLM with today's prompt (`DETECT_SYSTEM_PROMPT`, `detector.ts:91`): Qwen3-30B-A3B
    (MoE, ~30 GiB at Q8, `quoted` llama.cpp bench file size), Qwen3-8B/14B, Gemma 3 12B/27B,
    gpt-oss-20b (~11 GiB MXFP4).
  - NER-based detectors (they tag spans; no generation): GLiNER PII
    ([urchade/gliner_multi_pii-v1](https://huggingface.co/urchade/gliner_multi_pii-v1), Apache-2.0;
    [knowledgator/gliner-pii-base-v1.0](https://huggingface.co/knowledgator/gliner-pii-base-v1.0),
    Apache-2.0, ~330 MB ONNX), the open-weights
    [OpenAI Privacy Filter](https://openai.com/index/introducing-openai-privacy-filter/)
    (Apache-2.0, 1.5B total / 50M active, 128K context), spaCy `es_core_news_lg`
    ([GPL-3.0](https://huggingface.co/spacy/es_core_news_lg), entity F 0.897). Spanish quality of
    the GLiNER and Privacy Filter models is **unconfirmed**.
- **Recommended shape** (`inferred`): an LLM detector as the main stage, so the gate keeps its
  prompt and its parity test; an NER model as a cheap second opinion in the verify stage later.
  NER alone misses descriptive identifiers ("la hija del comisario"), which the LLM prompt targets.
- **Footprint.** Qwen3-30B-A3B Q8 ≈ 30 GiB + ~8 GB context for 3–8 parallel chunks (`inferred`).
  Fits the Spark easily. On 12 GB: an 8B at Q4–Q8 or Gemma 3 4B–12B at Q4 (`inferred`).
- **Throughput** (`inferred`). Per chunk: 1,391 prompt tokens ÷ 2,987 tok/s ≈ 0.5 s, plus
  119 output tokens ÷ 61 tok/s ≈ 2 s, so ≈ 2.5 s per call for Qwen3-30B-A3B on the Spark
  (from the `quoted` llama.cpp numbers and the `measured` token averages). The 42-call document
  would take 35–105 s depending on how well parallel calls batch. Hosted takes 82 s (`measured`).
- **Quality risk.** A smaller model misses names, especially nicknames, titles and place names;
  smaller models also break JSON more often. Results vary run to run even hosted (audit,
  wave 3).
- **Parity measurement.** The gate harness (`measure4.ts` with `run4.sh`) drives the real code
  path (`runAnonymisationGate` + detector) over synthetic transcripts with 20 planted
  identifiers, and records found/missing names, survivors at verify, invalid JSON, max output,
  cost and time. **Footgun:** it lives in a session scratchpad and imports from a worktree path;
  commit it to the repo (for example `apps/backend/scripts/measure-gate/`) with its data before
  Phase 0, or it is lost.
- **Hard parts.**
  - The 5-minute prompt cache in ai-service can answer a re-run from cache (`detector.ts:359-364`);
    the harness adds a nonce for this. A local detector that bypasses ai-service has no cache.
  - The verify stage holds "el [Persona E]"-style survivors today (`measured`, run 4). Fix or
    accept that before comparing, or both arms just hold.

### 2.2 Rerank — move first

- **Candidates.** `Qwen/Qwen3-Reranker-0.6B` (the model in use today, so identical weights);
  Qwen3-Reranker-4B (multilingual rerank score 72.7 vs 66.4 for 0.6B); `bge-reranker-v2-m3`
  (58.4). Scores `quoted` from [Qwen3-Embedding repo](https://github.com/QwenLM/Qwen3-Embedding).
  ai-service already ships a CPU sidecar for `bge-reranker-v2-m3`
  (`services/ai-service/rerank-service/`), but that is a different, weaker model (`inferred`
  from the scores).
- **Footprint.** 0.6B at FP16 ≈ 1.2 GB; 4B ≈ 8 GB (`inferred`). Both fit 12 GB.
- **Throughput** (`inferred`, weak). A rerank call scores up to 50 candidates
  (`min(topK×4, 50)`) of ~430 tokens each (`measured`: 138,179 tokens over 324 local chunks), so
  ~21K tokens of prompt processing per chat turn. A 0.6B model should do that in well under a
  second on either GPU. Measure it.
- **Quality risk.** Low with the same weights. Score scale may differ between DeepInfra and the
  local server; EDC only uses the order, after fusion (audit C-5), so check order, not raw scores.
- **Parity.** Record DeepInfra's top-5 order for the retrieval eval's 189 questions (audit C-4
  set), then the local order. Pass: single-doc MRR@5 within 0.01 of the hosted arm and the same
  top-1 on ≥ 95% of questions (threshold `inferred`, Rodrigo to confirm). This also gives the
  missing rerank-on vs rerank-off arm (audit C-8).

### 2.3 Embeddings — move later

- **Candidates.** `BAAI/bge-m3` (today's model, 1,024 dims, 8K context, MIT); Qwen3-Embedding-0.6B
  (1,024 dims, multilingual MTEB 64.3 vs 59.6 for bge-m3), -4B (2,560 dims, 69.5), -8B
  (4,096 dims, 70.6). Scores `quoted` from the Qwen3-Embedding repo. Spanish-only scores: not found.
- **Footprint.** bge-m3 ≈ 1.1 GB FP16; Qwen3-Embedding-4B ≈ 8 GB (`inferred`). Throughput:
  re-embedding the whole local corpus (138K tokens) is minutes at most (`inferred`).
- **Quality risk.** None if the weights are the same, apart from small float differences.
- **🔴 Hard parts — read before changing the model.**
  - `chunks.embedding` is **`vector(1024)`**, one column for **every** corpus, with an HNSW cosine
    index (`measured`: `\d chunks`; `read`: `services/ai-service/drizzle/0000_baseline.sql:65,368`).
    Any model with another size needs a migration, a rebuilt index, `EMBEDDING_DIM`, and a
    re-embed of every chunk in every corpus at once (`read`:
    `services/ai-service/src/services/rag/embedding-models.ts:59-62`).
  - pgvector's HNSW index takes at most **2,000 dims for `vector`** and 4,000 for `halfvec`
    (`quoted`, [pgvector README](https://github.com/pgvector/pgvector)). Qwen3-Embedding-4B
    (2,560) and -8B (4,096) do not fit `vector` with HNSW. Either use `halfvec`, or cut the
    output to 1,024 dims (Qwen3-Embedding supports shorter outputs; `quoted`, its model card).
  - `chunks.sparse_embedding` is `sparsevec(250002)`, bge-m3's vocabulary (`measured`). A
    different model ends the sparse leg. It is off today (`SPARSE_ENABLED=false`, `read`).
  - The query embedding (#4) must use the same model as the stored chunks. Switch both together.
- **Parity.** With bge-m3 on both sides: embed every chunk locally and compare with the stored
  vectors. Pass: cosine ≥ 0.999 on every chunk (threshold `inferred`) → no re-embed needed. Then
  run the retrieval eval: dense single-doc MRR@5 within 0.01 of **0.936** (`quoted`, audit wave 3,
  189 questions). A model change instead needs a full re-embed and must beat 0.936.

### 2.4 Transcription — move later

- **Candidates.** faster-whisper with `large-v3-turbo` (4 decoder layers instead of 32;
  [model card](https://huggingface.co/openai/whisper-large-v3-turbo)); plain openai-whisper
  large-v3 on PyTorch; NVIDIA Parakeet 1.1B RNNT multilingual via the ASR NIM, which lists Spark
  support ([support matrix](https://docs.nvidia.com/nim/speech/latest/reference/support-matrix/asr.html)).
- **Footprint.** large-v3-turbo ≈ 1.6 GB at FP16 (`inferred` from ~0.8B params). Fits 12 GB.
- **Throughput.** openai-whisper large-v3 ran about 9.5× realtime on GB10 (`quoted`, one user
  report, [speaches #620](https://github.com/speaches-ai/speaches/issues/620)). A 60-minute
  interview would take ~6–7 minutes (`inferred`). Today's CPU `small` speed is not measured.
- **🔴 Hard part.** faster-whisper runs on CTranslate2, which ships **no CUDA wheel for linux/arm64**;
  on the Spark it silently falls back to CPU (`quoted`, speaches #620, open 2026-03-11). Options:
  build CTranslate2 from source for sm_121 ([example](https://github.com/rappdw/transcribe-dgx)),
  or switch engines. On the x86_64 RTX 5070 box, CTranslate2's CUDA wheels should work; Blackwell
  (sm_120) support there is **unconfirmed**.
- **Quality risk.** Low: large-v3-turbo is more accurate than `small` (`inferred`, general
  knowledge of the model family). Names matter most, since the gate must find them.
- **Parity.** There is no word-error-rate set today. Build one: 30–60 minutes of Spanish
  recordings with human transcripts, including names. Pass: word error rate ≤ the CPU `small`
  baseline and names spelled at least as often correctly.

### 2.5 Condense and query expansion — move later

- **Candidates.** Qwen3-4B/8B, Gemma 3 4B (`quoted` Spark speed for Gemma 3 4B Q4: 5,949 tok/s
  prompt, 81 tok/s output). ≤ 8 GB; fits 12 GB.
- **Throughput** (`inferred`). 222 in / 44 out tokens → under 1 s per call on either host.
- **Quality risk.** A weak rewrite drops the user's intent and retrieval misses. Neither feature
  has a measured win yet (C-8), so measure that first: if expansion does not help, turn it off
  rather than move it.
- **Parity.** Retrieval eval with expansion on: local arm within 0.01 MRR@5 of the hosted arm.
- **Blocker.** Needs per-tier routing in ai-service (section 3), because these are `quick`-tier calls
  that share the router's one global URL with chat.

### 2.6 Graph extraction — move later, optional

- **Candidates.** Qwen3-30B-A3B (~30 GiB Q8), gpt-oss-120b (~59 GiB MXFP4; 58.7 tok/s output,
  `quoted` llama.cpp bench). Only the Spark fits these.
- **Throughput** (`inferred`). 811 output tokens ÷ ~60 tok/s ≈ 14 s per window, against 72 s p50
  hosted (`measured`). Faster per call, single box, so a corpus backfill is still hours.
- **Quality risk.** High: schema-valid JSON in Spanish with the v4 entity rules. Hosted already
  fails ~2.4% of traces (27 of 1,114, `measured`).
- **Parity.** Re-extract 20 documents both ways; compare entity sets (overlap) and the invalid-JSON
  rate; then the GraphRAG eval (`apps/backend/src/eval`). Input is redacted, so this move is about
  cost and dependency, not privacy.

### 2.7 Chat answer and eval — keep hosted

The answer model today is a large hosted model; no Spark-sized model is likely to match it on
cited Spanish answers (`inferred`). Input is redacted chunks plus the member's question. Revisit
with gpt-oss-120b only if the privacy rule is extended to member questions (question 6). Eval has
no judge; its generation calls follow wherever the chat answer runs.

### 2.8 What fits where

| Module | 12 GB (RTX 5070) | 128 GB (Spark) |
|---|---|---|
| Gate detector | 8B Q4–Q8 or Gemma 3 12B Q4 | up to Qwen3-30B-A3B Q8 or gpt-oss-120b |
| Reranker | 0.6B, 4B | any |
| Embeddings (bge-m3) | yes | yes |
| Whisper large-v3-turbo | yes (x86_64, easier) | yes (ARM64 build work) |
| Condense / expansion | 4–8B | any |
| Graph extraction | no | yes |
| Everything at once | no — pick gate + rerank + embeddings | yes: ≈ 30 + 2 + 2 + 2 + 8 (context) ≈ 45 GB without a graph model, ≈ 105 GB with gpt-oss-120b (`inferred`) |

---

## 3. Integration with ai-service

**Short answer** (`read`, file:line below): a self-hosted OpenAI-compatible endpoint can replace
OpenRouter **for the whole service at once** by env, but **not per tier**. Per-tier needs ai-service
changes. Embeddings and rerank can move by env alone.

| Seam | Today (read) | Self-host by env only? |
|---|---|---|
| Chat completions (all tiers) | one global `CHAT_COMPLETIONS_URL`, read once at module load (`config/env.ts:197`; `router/adapters/openrouter.ts:44`) | Yes, but every tier moves, chat answers included. Not what we want |
| Provider per tier | `ProviderKey` has `openrouter|openai|anthropic|local` (`router/types.ts:162`), but the router hard-codes `openrouter` (`router.ts:92`); `llm_configs.base_url` exists and is never read | **No** |
| Fallback | no cross-model or cross-provider fallback; same-call retry only (`resilience.ts:131`) | n/a — good: nothing silently falls back to hosted today |
| Embeddings | `EMBEDDINGS_URL`, `EMBEDDING_MODEL`, `EMBEDDING_DIM`, OpenAI `/embeddings` shape (`env.ts:190,198-199`; `embeddings/openrouter.ts:117-128`) | **Yes** — TEI or vLLM serve that shape |
| Rerank | `RERANK_PROVIDER=rerank-api` speaks Cohere/Jina shape (`rerank/rerank-client.ts:298-332`) | **Likely yes with vLLM**, whose `/rerank` is Jina- and Cohere-compatible (`quoted`, [vLLM docs](https://docs.vllm.ai/en/latest/serving/online_serving/)). TEI's shape differs and needs an adapter (`inferred`). TEI does not list Qwen3-Reranker (`quoted`, TEI README) |
| PII NER server | `PII_NER_URL|MODEL|…` and a `ModelServerAdapter` interface exist but are inert (`env.ts:340-376`; `pii/model-server.ts:1-59`) | No — nothing installs it |
| Cost | unknown model → $0 (`task-profiles.ts:133-134`) | Works; local calls record $0 |

**🔴 Footgun: the hosted key travels to the new URL.** The embeddings client sends
`OPENROUTER_API_KEY` as a bearer token to whatever `EMBEDDINGS_URL` is
(`embeddings/openrouter.ts:79-80`); the chat adapter does the same and refuses to run without it
(`adapters/openrouter.ts:220-223`). Pointed at the Spark, ai-service would hand the OpenRouter key
to the Spark on every call. Needs a per-endpoint key in ai-service, or the Spark's servers must never
log headers.

**The gate does not need ai-service at all.** The detector is an EDC interface built for this
swap: "SAME CALL, different base URL" (`apps/backend/src/lib/anonymise/types.ts:190-217`). Two
ways to make it local:

| Option | Change | Pros | Cons |
|---|---|---|---|
| A. EDC detector adapter (recommended for Phase 1, `inferred`) | New `PersonDetector` in `apps/backend` calling the Spark's OpenAI-compatible endpoint directly; selected by env | app-only code, no ai-service change; raw text never enters ai-service | No ai-service traces, cache or budget; must log its own timings |
| B. ai-service per-tier endpoint with a local-only flag | See list below | One routing system; traces kept | Waits on the ai-service change |

**ai-service changes needed for per-tier self-hosting** (`inferred` from the code above):
1. A provider/endpoint field (URL + key) on the effort profile or registry row, replacing the
   module-level URL (`adapters/openrouter.ts:44`); allow keyless endpoints.
2. Stamp the real provider instead of `openrouter` (`router.ts:92`); one circuit breaker per
   endpoint, not one shared (`resilience.ts:498`).
3. Send OpenRouter-only request fields (`usage.include`, `provider.require_parameters`, `models`)
   only to OpenRouter (`adapters/openrouter.ts:100,284-288`). Whether vLLM and llama.cpp ignore
   them is untested.
4. A `localOnly` tier mode: refuse (fail closed) unless the resolved URL is on a private
   allowlist; never set a fallback list; forbid caller overrides of model or endpoint
   (`resolve.ts:433`).
5. Separate API keys per endpoint (the footgun above).
6. Record local cost as an explicit $0 decision, not a pricing-table miss.
7. A TEI rerank adapter in `rerank-client.ts`, only if we choose TEI over vLLM for rerank.

**audio-service on a GPU** (`read`): set `WHISPER_DEVICE=cuda` and `WHISPER_COMPUTE_TYPE=float16`
(`services/audio-service/app/config.py:76-80,197-202`); build a CUDA image (today's base is
`python:3.11.11-slim-bookworm`; the comment at `Dockerfile:21-23` describes the switch); bake
`WHISPER_MODEL=large-v3-turbo` at build time, the same value as the env
(`infra/docker-compose.audio.yml:82-104`). The backend points `AUDIO_SERVICE_URL` at the GPU host
over the tunnel (`apps/backend/src/lib/audioClient.ts:53-75`). audio-service needs its own Redis
there, and its callback to edc-1 must reach back through the tunnel. On the Spark, add the
CTranslate2 ARM64 build (section 2.4).

---

## 4. Serving stacks on ARM64 + Blackwell (GB10)

Status as found on 2026-10-17; all `quoted` from the linked pages.

| Stack | Spark status | Use for | Notes |
|---|---|---|---|
| **vLLM** | NVIDIA container `nvcr.io/nvidia/vllm` and a [Spark playbook](https://build.nvidia.com/spark/vllm/overview) (updated 2026-09-14) | gate LLM, rerank, small generation | pip wheels target CUDA 12; sm_121 needs CUDA 13. The 26.04 container needs host driver ≥ 595.58 and fails on 580.173 ([forum](https://forums.developer.nvidia.com/t/vllm-26-04-py3-compatibility-mode-is-unavailable-on-driver-580-173-02-no-dgx-dashboard-path-to-595-58/379168)). Pin container + driver together |
| **llama.cpp** | native CUDA build; official [Spark bench](https://github.com/ggml-org/llama.cpp/blob/master/benches/dgx-spark/dgx-spark.md) | gate LLM (simplest), small generation | OpenAI-compatible `llama-server`; GGUF quantised models; JSON grammar for strict output |
| **TensorRT-LLM** | [Spark playbook](https://build.nvidia.com/spark/trt-llm), `release:1.3.0rc13` | fastest LLM serving | Heavier to operate; release candidates |
| **SGLang** | [Spark playbook](https://build.nvidia.com/spark/sglang), `lmsysorg/sglang:spark` | LLM serving | Alternative to vLLM |
| **Ollama** | official Spark support since Oct 2025 ([blog](https://registry.ollama.ai/blog/nvidia-spark)) | quick trials only | One report of slow Docker image; native install faster ([forum](https://forums.developer.nvidia.com/t/very-poor-performance-with-ollama-on-dgx-spark-looking-for-help/353456)) |
| **TEI** | experimental `text-embeddings-inference:121-1.9` for GB10 ([README](https://github.com/huggingface/text-embeddings-inference)) | embeddings (bge-m3 dense, Qwen3-Embedding) | Experimental tag; bge-m3 sparse not supported (keep the bge-m3-service sidecar if sparse is ever turned on) |
| **NIM** | Spark NIMs exist (Llama 3.1 8B, Qwen3 32B) ([catalog](https://build.nvidia.com/spark/nim-llm)) | — | Spark Llama NIM lacks guided decoding; some NIMs crash on sm_121 ([forum](https://forums.developer.nvidia.com/t/nim-llm-containers-fail-on-dgx-spark-gb10-triton-vllm-crash-on-sm-121-and-ngc-permission-errors/353346)) |
| **faster-whisper** | no arm64 CUDA wheel for CTranslate2 → CPU fallback | transcription | Build from source, or use PyTorch whisper |

**Suggested starting stack** (`inferred`): llama.cpp `llama-server` for the gate LLM (simple,
measured on Spark, grammar-constrained JSON), vLLM for rerank (Jina/Cohere-compatible `/rerank`
matches `rerank-api`), TEI for embeddings. Phase 0 confirms each runs.

---

## 5. Network and operations

**Topology.** The apps run on edc-1 (Hetzner). The Spark sits on-prem (location ASSUMED,
question 1). Raw testimony and raw audio would travel edc-1 → Spark → edc-1.

- **Tunnel.** WireGuard (or Tailscale, which runs WireGuard) with the Spark dialling **out** to
  edc-1. No inbound port on the campus network, works behind institutional NAT (`inferred`).
  Spark services bind only to the tunnel interface. Needs the institution's OK (question 2).
- **TLS and auth.** WireGuard encrypts the link. Add a bearer token per service on top (llama.cpp,
  vLLM and TEI each take an API key flag; audio-service has its own key map). Never expose any
  port to the internet. Watch the hosted-key footgun in section 3.
- **🔴 Failure mode: fail closed for PII.** If the Spark is down, the gate must **hold**, never call
  a hosted model with raw text. The detector contract already says "MUST THROW" and a throw
  becomes a hold (`types.ts:211-214`). Add, in Phase 1:
  - a boot check that refuses to start if the gate detector is hosted outside dev (audit I-14);
  - no hosted detector code path selectable in production once real data exists;
  - a sweep that retries held-for-unavailability uploads when the Spark returns (stuck-row
    sweeps are audit I-3).
  Rerank and embeddings may fail open: rerank already falls back to un-reranked order;
  embeddings can wait in the ingest queue.
- **Monitoring.** Health probes from edc-1 over the tunnel every minute; alert on gate holds whose
  reason is "detector unreachable"; GPU memory and temperature from `nvidia-smi` (DCGM support on
  GB10 unconfirmed); log per-call latency in the EDC detector adapter.
- **Power and backup.** 240 W; put it on a UPS and set the firmware to power on after an outage.
  Keep the Spark **stateless**: model weights and configs only, configs committed under
  `infra/` in this repo, no testimony at rest (process in memory, discard). Then backup means
  "re-pull weights and redeploy".
- **Upgrades.** Pin driver, CUDA, container and model versions together; the vLLM driver
  mismatch above shows why. Re-run the parity checks after any upgrade.
- **Who maintains it.** Open (question 3). Someone must have physical access for reboots.

---

## 6. Phased rollout

Each phase has an entry gate (numbers that must hold before production traffic) and a rollback.
Thresholds marked `inferred` are my proposals for Rodrigo to confirm.

| Phase | Scope | Entry gate | Rollback |
|---|---|---|---|
| **0. Measure** | Confirm hardware and network. Commit the gate harness and its data to the repo. Install nothing in production. On the Spark (or the 5070), benchmark candidates with `llama-bench` and the gate harness pointed at a local endpoint. Record hosted baselines: gate harness ×3 runs per size; rerank on/off arms on the 189-question retrieval eval (needs the EDC DeepInfra key); export chunk vectors | none | n/a |
| **1. PII detector + rerank** | EDC detector adapter (option A) → local LLM; boot guard (I-14); hold-and-retry sweep. Rerank → local Qwen3-Reranker-0.6B via `RERANK_PROVIDER=rerank-api` | Gate: planted names found ≥ hosted on every size (20/20 today), 3 runs each; survivors at verify ≤ hosted; 0 invalid JSON; 0 truncated replies; 4,866-word doc ≤ 120 s (`inferred`). Over-redaction counted on the control transcript (`transcript-ctrl.txt`), within a bound Rodrigo sets (question 8). Rerank: MRR@5 within 0.01 of hosted, same top-1 on ≥ 95% (`inferred`). Spark down → gate holds (tested by stopping the server) | Rerank: env flip back to DeepInfra (or off). Gate: **never back to hosted once real data exists** — rollback means holding gated uploads until the local detector is fixed |
| **2. Embeddings** | `EMBEDDINGS_URL` → TEI with bge-m3; ai-service per-endpoint key first | Cosine ≥ 0.999 local vs stored on every chunk (`inferred`); dense single-doc MRR@5 within 0.01 of 0.936 | Env flip back. If a re-embed happened, restore the `chunks` table from a dump taken just before |
| **3. Transcription** | audio-service CUDA image, `large-v3-turbo`, `AUDIO_SERVICE_URL` over the tunnel | Word error rate ≤ CPU `small` on the reference set (question 9); ≥ 5× realtime (`inferred`); a 60-min file completes | Point `AUDIO_SERVICE_URL` back at the CPU service |
| **4. Small generation** | ai-service per-tier endpoint + `localOnly` mode. Then condense and expansion → local 4–8B. Graph extraction optional, after its own eval | Retrieval eval with expansion: within 0.01 MRR@5 of hosted. Graph: entity overlap and invalid-JSON rate ≤ hosted on 20 docs | Registry or env flip back to hosted tier |

Chat answers stay hosted throughout.

---

## 7. Open questions for Rodrigo

1. **Hardware: answered (NVIDIA DGX Spark, version 7.5.0). Still open: where it sits, its host driver version (vLLM 26.04 needs ≥ 595.58), and whether "7.5.0" is the DGX OS release.** Is it an NVIDIA DGX Spark (or an OEM GB10 box)
   with 128 GB, and how much disk? Which building, which network, who has physical access?
   Everything in this plan ASSUMES the specs in section 0.
2. Will the institution allow an outbound VPN tunnel (WireGuard/Tailscale) from that network to
   edc-1?
3. Who maintains the box: OS and driver updates, reboots, alerts?
4. Is the RTX 5070 dev server still planned? Both hosts, or only the Spark?
5. What is the date of the first real participant Voz? That is Phase 1's deadline.
6. Does "no raw text to hosted models" also cover members' chat questions (condense, expansion,
   chat answer) and ungated `documento` uploads, or only participant testimony?
7. How long may the gate take per testimony? (Async; minutes seem fine.)
8. How much over-redaction is acceptable (names of public figures, places hidden)?
9. Can we build a Spanish reference audio set with human transcripts, including names, for the
   transcription parity test?
10. May we add the per-tier endpoint and `localOnly` changes to ai-service?
11. Is there a UPS where the Spark sits?
12. Model licences: is the Gemma licence acceptable? spaCy's Spanish model is GPL-3.0.

---

## Not verified

- The hardware itself (question 1).
- That any stack in section 4 runs on this particular box; versions change monthly.
- vLLM's `/rerank` response against `rerank-client.ts`'s parser, and whether vLLM and llama.cpp
  ignore OpenRouter-only request fields. No live calls were made.
- Spanish quality of every candidate model; no Spanish benchmarks were found.
- Production volumes: all volumes above are local dev and test traffic.

## Summary

1. Driver: raw testimony reaches a hosted model only in the gate's detect stage.
2. Move first: gate detector (detect + verify), via an app-only detector adapter.
3. Move first: rerank — same Qwen3-Reranker-0.6B weights; ends the borrowed key.
4. Move later: embeddings (bge-m3, env flip); a new model forces a full re-embed.
5. Move later: transcription on GPU; CTranslate2 has no ARM64 CUDA wheel.
6. Move later: condense, expansion, graph extraction; they need per-tier routing in ai-service.
7. Keep hosted: chat answers and eval (eval has no LLM judge).
8. Fail closed: Spark down means the gate holds; never fall back to hosted.
9. Local spend measured at $2.10 in two months; privacy, not money, drives this.
10. Open: confirm the hardware and its location first; then network, maintainer, data date.
