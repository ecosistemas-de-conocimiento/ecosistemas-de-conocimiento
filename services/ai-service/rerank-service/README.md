# rerank-service

A self-contained, **production-hardened** HTTP service that serves the
open-source reranker **`BAAI/bge-reranker-v2-m3`** (Apache-2.0, multilingual
cross-encoder) on **CPU**. It gives retrieval reranking a self-hostable home,
independent of any hosted rerank API. It is a **CPU-scale** sibling — it does
**not** need the GPU box — and reranking is **off by default** in ai-service.

Deploys as its own standalone container (separate from `bge-m3-service/`; see
[Resource footprint](#resource-footprint)).

The model is a **drop-in swap point**: if quality disappoints, **Jina Reranker
v2 (multilingual)** is the self-hostable fallback — change `RERANK_MODEL` (and,
if the load signature differs, the `FlagReranker` load in `app.py`).

## Wire contract

Cohere / Voyage / Jina-style rerank shape. Matches the ai-service rerank client
exactly (`src/services/ai/rerank/rerank-client.ts`).

### `POST /rerank`

Request:

```json
{
  "model": "baai/bge-reranker-v2-m3",
  "query": "how do I reset my password?",
  "documents": [
    "To reset your password, open Settings > Security.",
    "Our office is open Monday to Friday.",
    "Password recovery links expire after 24 hours."
  ],
  "top_n": 2
}
```

- `model` — echoed back verbatim. The **served** model is fixed by `RERANK_MODEL`;
  this field does not swap weights.
- `query` — the search query.
- `documents` — candidate strings. More than `MAX_DOCUMENTS` (default 100) → HTTP
  400. Empty array → `{ "results": [] }` (no inference).
- `top_n` *(optional)* — return only the top N; omitted → all documents, scored.

Response `200`:

```json
{
  "model": "baai/bge-reranker-v2-m3",
  "results": [
    { "index": 0, "relevance_score": 0.98 },
    { "index": 2, "relevance_score": 0.71 }
  ]
}
```

- `index` — 0-based position in the **request's** `documents` array.
- `relevance_score` — sigmoid-normalized cross-encoder score in `0..1`.
- `results` — sorted by `relevance_score` desc; truncated to `top_n` if given.

**Errors** use the envelope the client parses (HTTP 4xx/5xx):

```json
{ "error": { "message": "Too many documents: 200 > MAX_DOCUMENTS (100).", "code": "too_many_documents" } }
```

### `GET /health` and `GET /ready`

```json
{ "status": "ok", "model": "BAAI/bge-reranker-v2-m3", "ready": true }
```

Returns **200 only after the model is loaded**. While the model is still loading
at boot the service does not accept requests yet (the model loads in the FastAPI
lifespan, before serving begins), so an orchestrator never routes traffic to a
cold container. `/ready` is an alias with identical semantics.

### curl example

```bash
curl -s http://localhost:8000/rerank -H 'content-type: application/json' -d '{
  "model": "baai/bge-reranker-v2-m3",
  "query": "how do I reset my password?",
  "documents": ["To reset your password, open Settings > Security.", "Our office is open Monday to Friday."],
  "top_n": 2
}'
```

## Environment variables

| Var                     | Default                   | Meaning                                                                 |
| ----------------------- | ------------------------- | ----------------------------------------------------------------------- |
| `RERANK_MODEL`          | `BAAI/bge-reranker-v2-m3` | HF repo id of the served reranker.                                      |
| `PORT`                  | `8000`                    | Port (used when run directly; the container fixes 8000).                |
| `MAX_DOCUMENTS`         | `100`                     | Reject requests with more documents than this (400).                    |
| `RERANK_MAX_LENGTH`     | `1024`                    | Max tokens per (query, doc) pair. FlagReranker's own default (512) would silently truncate this system's ~800-token default chunks; 1024 fits them. Raise toward 8192 for larger chunks (slower). |
| `RERANK_BATCH_SIZE`     | `16`                      | Pair batch size for `compute_score`.                                    |
| `INFERENCE_CONCURRENCY` | `1`                       | Max concurrent inferences. See [Concurrency](#concurrency).             |
| `TORCH_NUM_THREADS`     | all cores                 | CPU threads for torch (`0` → all cores).                                |
| `REQUEST_TIMEOUT_S`     | `120`                     | Server-side wall-clock backstop per request.                            |
| `HF_HUB_OFFLINE`/`TRANSFORMERS_OFFLINE` | `1` (in image) | Runtime never phones home — weights are baked.                    |
| `LOG_LEVEL`             | `INFO`                    | Python log level.                                                       |

No secrets. The HF repo id casing is `BAAI/bge-reranker-v2-m3`; the ai-service
`RERANK_MODEL` client value (`baai/bge-reranker-v2-m3`) is only echoed and need
not match casing.

## Build & run

```bash
docker build -t rerank-service .        # weights are DOWNLOADED AT BUILD (baked in)
docker run -p 8000:8000 rerank-service  # no volume needed — first request is warm
python smoke_test.py http://localhost:8000
```

### Model weights: baked at build (default)

The Dockerfile runs `bake_model.py` during the build, downloading the ~2.2GB
weights into an image layer (`HF_HOME=/opt/hf-cache`) and warming the model.
Consequences:

- **No first-request download.** The prior version fetched weights lazily on the
  first `/rerank`; a restart with no cached volume meant the first request blocked
  for minutes and the consumer's `RERANK_TIMEOUT_MS` (5s) aborted it → silent
  fallback while `/health` still said ok. Baking + boot-load eliminates that.
- Runtime is **fully offline** (`HF_HUB_OFFLINE=1`) — deterministic, no network at
  boot. The build (not the run) needs internet and ~3GB RAM.
- The image is large (~5–6GB incl. torch + weights). Docker layer-caches the bake
  across rebuilds while deps + `bake_model.py` are unchanged.

### Alternative: volume-cache instead of baking

To keep the image small, delete the `RUN python bake_model.py` line and mount a
persistent volume at `HF_HOME` so the first-request download is paid once:

```bash
docker run -p 8000:8000 -e HF_HUB_OFFLINE=0 -v hf-cache:/opt/hf-cache rerank-service
```

Not recommended: the first request after a fresh volume still blocks,
and the non-root user (uid 10001) must own the volume. Baking is the default for a
reason.

## Concurrency

- **One uvicorn worker** (the `CMD` sets `--workers 1`). A second worker loads a
  second ~2.2GB model copy — scale with **replicas**, not workers.
- Inference runs in a bounded `ThreadPoolExecutor(max_workers=INFERENCE_CONCURRENCY)`;
  `/health` stays responsive during inference (torch releases the GIL).
- Default `INFERENCE_CONCURRENCY=1` + `TORCH_NUM_THREADS=all cores`: one request at
  a time, each using all cores — best per-request latency, no thread
  oversubscription. If you raise concurrency, **lower** `TORCH_NUM_THREADS` so
  `INFERENCE_CONCURRENCY × TORCH_NUM_THREADS ≈ cores`.

## Resource footprint

- **RAM:** ~2.2GB weights (fp32) + torch/runtime → budget **~3–3.5GB steady**, with
  a transient spike during boot load. A 2GB box **will OOM**; give it **≥4GB**.
- **Latency (CPU, fp32):** ~100–150ms per 16-pair batch at `max_length≈512`, scaling
  ~linearly with `RERANK_MAX_LENGTH` and pair count. The multi-corpus rerank pool
  is capped at 50 candidates, so a full rerank is well under the consumer's 5s
  timeout on a modern box. These are **slow on CPU** — set expectations accordingly.
- **Separate vs combined:** run rerank-service and bge-m3-service as **separate
  containers** (each ≥4GB). Combining both models in one container needs ~6–7GB
  and couples their lifecycles/scaling — not recommended. See bge-m3-service README.

## Dependency pinning

`requirements.txt` pins the direct deps AND the model-load-critical transitive set
(`transformers`, `tokenizers`, `huggingface-hub`, `safetensors`,
`sentence-transformers`, `numpy`) so a rebuild months later cannot pull an
incompatible `transformers`. For a fully reproducible image, capture a complete
lock from the first green build and commit it:

```bash
docker run --rm rerank-service pip freeze > requirements.lock
# then in the Dockerfile: pip install -r requirements.lock
```

## How ai-service consumes it

Reranking is **off by default**. To point ai-service at this service:

```bash
RERANK_ENABLED=true
RERANK_URL=http://rerank-service:8000/rerank
RERANK_MODEL=baai/bge-reranker-v2-m3
```

Use the service name (`rerank-service`) as the host when both run on the same
Docker network. `RERANK_TIMEOUT_MS` (default 5s) is the consumer's per-call cap.
