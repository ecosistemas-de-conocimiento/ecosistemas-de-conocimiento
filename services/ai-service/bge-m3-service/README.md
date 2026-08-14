# bge-m3-service

A self-contained, **production-hardened** HTTP service that serves the
open-source multilingual embedder **`BAAI/bge-m3`** (MIT) on **CPU**, returning
BOTH the **dense** vector and the **learned-sparse** (lexical) vector from a
single forward pass.

Deploys as its own standalone container (separate from `rerank-service/`; see
[Resource footprint](#resource-footprint)).

## Why this exists

OpenRouter's `/embeddings` endpoint is OpenAI-compatible and returns **dense
vectors only** — no wire field for bge-m3's sparse (`lexical_weights`) output. To
use bge-m3's learned-sparse vector as a language-agnostic lexical retrieval leg
(an alternative to the Postgres `tsvector` leg), ai-service needs bge-m3 served
through **FlagEmbedding with `return_sparse=True`**. That is this service.

CPU-scale sibling of `rerank-service/` — no GPU. ai-service calls it only when
`SPARSE_ENABLED=true` (**off by default**); when off, nothing hits this service
and the `tsvector` lexical leg stays the default.

## Wire contract

Matches the ai-service sparse client exactly
(`src/services/ai/embeddings/sparse-embed.ts`).

### `POST /embed`

Request:

```json
{ "model": "baai/bge-m3", "input": ["Section 16 disclosure duties", "office hours"] }
```

- `model` — echoed back verbatim. The **served** model is fixed by `BGE_M3_MODEL`.
- `input` — a single string OR an array of strings. More than `MAX_INPUTS`
  (default 256) → HTTP 400. Empty array → empty arrays (no inference).

Response `200`:

```json
{
  "model": "baai/bge-m3",
  "dense": [[0.01, -0.02, "..."], ["..."]],
  "sparse": [
    { "indices": [5, 100, 250001], "values": [0.31, 0.12, 0.04] },
    { "indices": [7], "values": [0.5] }
  ]
}
```

- `dense[i]` — the 1024-dim dense vector for input `i`.
- `sparse[i]` — the learned-sparse vector as parallel arrays. `indices` are the
  model's **0-based token ids**; `values` the learned weights. ai-service shifts
  to **1-based** for the pgvector `sparsevec` literal (`indices` start at 1) and
  drops zero weights (`toSparsevecLiteral`). Token ids stay within
  `[0, SPARSE_DIM)` where `SPARSE_DIM=250002` (the bge-m3 vocab + the +1 shift).
- `dense` and `sparse` are aligned index-for-index with the request `input`.

**Errors** use the envelope the client parses (HTTP 4xx/5xx):

```json
{ "error": { "message": "Too many inputs: 300 > MAX_INPUTS (256).", "code": "too_many_inputs" } }
```

### `GET /health` and `GET /ready`

```json
{ "status": "ok", "model": "BAAI/bge-m3", "ready": true }
```

Returns **200 only after the model is loaded** (loaded in the FastAPI lifespan
before serving begins), so an orchestrator never routes traffic to a cold
container. `/ready` is an alias with identical semantics.

### curl example

```bash
curl -s http://localhost:8000/embed -H 'content-type: application/json' \
  -d '{ "model": "baai/bge-m3", "input": ["Section 16 disclosure duties", "office hours"] }'
```

## Environment variables

| Var                     | Default        | Meaning                                                          |
| ----------------------- | -------------- | ---------------------------------------------------------------- |
| `BGE_M3_MODEL`          | `BAAI/bge-m3`  | HF repo id of the served embedder.                               |
| `PORT`                  | `8000`         | Port (used when run directly; the container fixes 8000).         |
| `MAX_INPUTS`            | `256`          | Reject requests with more inputs than this (400).                |
| `MAX_LENGTH`            | `8192`         | Max token sequence length; longer inputs truncate.              |
| `BGE_M3_BATCH_SIZE`     | `12`           | Encode batch size.                                               |
| `BGE_M3_RETURN_DENSE`   | `true`         | Keep the dense field populated (see [Dense](#dense-vector)).     |
| `INFERENCE_CONCURRENCY` | `1`            | Max concurrent inferences. See [Concurrency](#concurrency).      |
| `TORCH_NUM_THREADS`     | all cores      | CPU threads for torch (`0` → all cores).                         |
| `REQUEST_TIMEOUT_S`     | `180`          | Server-side wall-clock backstop per request.                     |
| `HF_HUB_OFFLINE`/`TRANSFORMERS_OFFLINE` | `1` (in image) | Runtime never phones home — weights are baked.       |
| `LOG_LEVEL`             | `INFO`         | Python log level.                                                |

No secrets. HF repo id casing is `BAAI/bge-m3`; the ai-service `SPARSE_EMBED_MODEL`
value (`baai/bge-m3`) is only echoed and need not match casing. `SPARSE_DIM` lives
on the ai-service side (the `chunks.sparse_embedding` column width) — this service
just emits raw token ids.

## Build & run

```bash
docker build -t bge-m3-service .        # weights are DOWNLOADED AT BUILD (baked in)
docker run -p 8000:8000 bge-m3-service  # no volume needed — first request is warm
python smoke_test.py http://localhost:8000
```

### Model weights: baked at build (default)

The Dockerfile runs `bake_model.py` during the build, downloading the ~2.3GB
weights into an image layer (`HF_HOME=/opt/hf-cache`) and warming the model. This
eliminates the prior lazy first-request download — a restart with no cached volume
used to block the first `/embed` for minutes, tripping the consumer's sparse
timeout and silently half-indexing. Runtime is **fully offline**
(`HF_HUB_OFFLINE=1`). The build (not the run) needs internet and ~3GB RAM. Image is
large (~5–6GB); Docker layer-caches the bake across rebuilds.

### Alternative: volume-cache instead of baking

Delete the `RUN python bake_model.py` line and mount a persistent volume at
`HF_HOME` (`-e HF_HUB_OFFLINE=0 -v hf-cache:/opt/hf-cache`) to keep the image
small at the cost of a one-time first-request download. The non-root user (uid
10001) must own the volume. Baking is the default.

## Dense vector

Every current ai-service caller uses **only** the sparse leg (dense comes from the
OpenRouter `EMBEDDINGS_URL` seam), so the dense forward pass looks "wasted"
(adversarial-review finding #6). It is kept **on by default** anyway:

- The wire contract and `sparse-embed.ts` declare `dense: number[][]`, and the
  README's dense-consistency / forward-compat promise depends on it.
- The cost is **negligible**: dense and sparse come from the **same** transformer
  forward pass; the dense pooling head is tiny next to the encoder that sparse
  already requires. (This is why the docs say sparse adds negligible cost over a
  dense-only encode — the reverse framing.)

`BGE_M3_RETURN_DENSE=false` drops dense to empty arrays for the compute-conscious;
the client tolerates it (never reads dense today) but it breaks the forward-compat
promise. Leave it `true` unless you know why.

## Concurrency

- **One uvicorn worker** (`--workers 1`); scale with **replicas**, not workers (a
  second worker = a second ~2.3GB model copy).
- Inference runs in a bounded `ThreadPoolExecutor(max_workers=INFERENCE_CONCURRENCY)`;
  `/health` stays responsive during inference.
- Default `INFERENCE_CONCURRENCY=1` + `TORCH_NUM_THREADS=all cores`: one request at
  a time, each using all cores. If you raise concurrency, **lower**
  `TORCH_NUM_THREADS` so `INFERENCE_CONCURRENCY × TORCH_NUM_THREADS ≈ cores`.

## Resource footprint

- **RAM:** ~2.3GB weights (fp32) + torch/runtime → budget **~3–3.5GB steady**, plus
  a transient boot spike. A 2GB box **will OOM**; give it **≥4GB**.
- **Latency (CPU, fp32):** slow, like all CPU transformer inference. Dense + sparse
  come from one pass so sparse adds negligible marginal cost. Ingest batches chunk
  texts (`BGE_M3_BATCH_SIZE`); keep the calling pool modest.
- **Separate vs combined:** run this and rerank-service as **separate
  apps** (each ≥4GB). Combining both models in one container needs ~6–7GB and
  couples their independent enable-gates (`SPARSE_ENABLED` vs `RERANK_ENABLED`),
  lifecycles, and scaling. **Separate is the recommendation.**

## Dependency pinning

`requirements.txt` pins the direct deps AND the model-load-critical transitive set
(same as rerank-service, kept in lockstep). For a fully reproducible image, capture
a `pip freeze` lock from the first green build and commit it as `requirements.lock`
(see rerank-service README → Dependency pinning).

## How ai-service consumes it

The sparse leg is **off by default**. To point ai-service at this service:

```bash
SPARSE_ENABLED=true
SPARSE_EMBED_URL=http://bge-m3-service:8000/embed
SPARSE_EMBED_MODEL=baai/bge-m3
```

Use the service name (`bge-m3-service`) as the host on the same Docker network.
With the gate on, ingest populates `chunks.sparse_embedding` and `mode: 'hybrid'`
retrieves fuse the dense leg with the **sparse** lexical leg (pgvector `sparsevec`
max-inner-product) instead of the `tsvector` leg.
