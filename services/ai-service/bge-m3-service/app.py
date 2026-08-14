"""CPU bge-m3 embedding service — dense + learned-sparse, production-hardened.

Serves the open-source multilingual embedder **BAAI/bge-m3** (MIT) on CPU,
returning BOTH the dense vector AND the learned-sparse (lexical) vector from a
single forward pass. This is the piece OpenRouter's OpenAI-compatible
``/embeddings`` endpoint cannot provide — that endpoint returns dense floats
only, with no wire field for bge-m3's ``lexical_weights`` output.

The served model is fixed by the ``BGE_M3_MODEL`` env var; the incoming ``model``
field is echoed back but does not swap the loaded weights.

Production posture (see README) mirrors ``rerank-service/``:
  - Model loaded ONCE at boot (FastAPI lifespan), never per request — no lazy
    first-request penalty, no unlocked double-init race.
  - ``/health`` / ``/ready`` return 200 ONLY after the model is loaded.
  - Bounded thread pool + wall-clock backstop.
  - Errors returned in the ``{"error": {"message", "code"}}`` envelope the
    ai-service sparse client parses (src/services/ai/embeddings/sparse-embed.ts).

DENSE vs SPARSE (adversarial-review finding #6): every current ai-service caller
uses ONLY the sparse leg (dense comes from the OpenRouter EMBEDDINGS_URL seam),
so the ``dense`` field looks "wasted". It is kept ON by default anyway because
(a) the wire contract and sparse-embed.ts declare ``dense: number[][]`` and a
documented dense-consistency / forward-compat promise depends on it, and (b) the
cost is negligible: dense and sparse fall out of the SAME transformer forward
pass (the pooling/projection head is tiny next to the encoder that sparse also
requires). ``BGE_M3_RETURN_DENSE=false`` drops it to empty arrays for the
compute-conscious; the client tolerates that (it never reads dense today), but it
breaks the forward-compat promise — leave it ``true`` unless you know why.
"""

import asyncio
import logging
import os
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from typing import List, Optional, Union

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper())
log = logging.getLogger("bge-m3-service")

# ── Config (env-driven, sane defaults, no secrets) ────────────────────────────
BGE_M3_MODEL = os.getenv("BGE_M3_MODEL", "BAAI/bge-m3")
PORT = int(os.getenv("PORT", "8000"))
MAX_INPUTS = int(os.getenv("MAX_INPUTS", "256"))
# bge-m3's max sequence length. Longer inputs are truncated by the model.
MAX_LENGTH = int(os.getenv("MAX_LENGTH", "8192"))
BGE_M3_BATCH_SIZE = int(os.getenv("BGE_M3_BATCH_SIZE", "12"))
# See module docstring. Keep dense ON unless you have a reason not to.
RETURN_DENSE = os.getenv("BGE_M3_RETURN_DENSE", "true").lower() != "false"
# Bounded concurrent inferences. Default 1: one request at a time, each using all
# CPU threads (TORCH_NUM_THREADS). If raised, LOWER TORCH_NUM_THREADS so
# INFERENCE_CONCURRENCY * TORCH_NUM_THREADS stays ≈ core count.
INFERENCE_CONCURRENCY = int(os.getenv("INFERENCE_CONCURRENCY", "1"))
# CPU threads for torch. Default (0) → all cores. Set explicitly to tune.
TORCH_NUM_THREADS = int(os.getenv("TORCH_NUM_THREADS", "0")) or (os.cpu_count() or 1)
# Server-side wall-clock backstop per request (seconds). The consumer sets its
# OWN, shorter timeout; this only guards against a pathological hang.
REQUEST_TIMEOUT_S = float(os.getenv("REQUEST_TIMEOUT_S", "180"))

# ── Module state ──────────────────────────────────────────────────────────────
_model = None
_ready = False
_executor: Optional[ThreadPoolExecutor] = None


def load_model():
    """Construct the BGEM3FlagModel singleton. Heavy torch/transformers import is
    lazy so the module stays cheap to import; the load happens once, at boot."""
    global _model
    if _model is None:
        import torch
        from FlagEmbedding import BGEM3FlagModel

        torch.set_num_threads(TORCH_NUM_THREADS)
        log.info(
            "loading embedder model=%s max_length=%d torch_threads=%d return_dense=%s",
            BGE_M3_MODEL, MAX_LENGTH, TORCH_NUM_THREADS, RETURN_DENSE,
        )
        # use_fp16=False forces the CPU fp32 path (fp16 matmul is a GPU thing).
        _model = BGEM3FlagModel(BGE_M3_MODEL, use_fp16=False)
    return _model


def warmup() -> None:
    """One tiny encode so every lazily-fetched file is resolved and the first real
    request pays no extra cost. Used at boot and at bake time."""
    load_model().encode(
        ["warmup"],
        batch_size=1,
        max_length=MAX_LENGTH,
        return_dense=True,
        return_sparse=True,
        return_colbert_vecs=False,
    )


@asynccontextmanager
async def lifespan(_: FastAPI):
    global _ready, _executor
    _executor = ThreadPoolExecutor(max_workers=INFERENCE_CONCURRENCY)
    # Load synchronously at startup (see rerank-service for rationale): serving
    # only begins once the model is in RAM; a load failure fails the process fast.
    load_model()
    warmup()
    _ready = True
    log.info("embedder ready")
    yield
    _ready = False
    if _executor is not None:
        _executor.shutdown(wait=False, cancel_futures=True)


app = FastAPI(title="bge-m3-service", version="1.1.0", lifespan=lifespan)


# ── Error envelope: match what the ai-service sparse client parses ────────────
class ServiceError(Exception):
    def __init__(self, status: int, message: str, code):
        self.status = status
        self.message = message
        self.code = code
        super().__init__(message)


def _err(status: int, message: str, code) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"message": message, "code": code}})


@app.exception_handler(ServiceError)
async def _service_error_handler(_: Request, exc: ServiceError):
    return _err(exc.status, exc.message, exc.code)


@app.exception_handler(RequestValidationError)
async def _validation_handler(_: Request, exc: RequestValidationError):
    return _err(400, f"invalid request: {exc.errors()}", "validation_error")


@app.exception_handler(Exception)
async def _unhandled_handler(_: Request, exc: Exception):
    log.exception("unhandled error")
    return _err(500, f"internal error: {type(exc).__name__}", "internal_error")


# ── Wire models ───────────────────────────────────────────────────────────────
class EmbedRequest(BaseModel):
    model: str
    # A single string or an array of strings. One (dense, sparse) pair per input.
    input: Union[str, List[str]]


class SparseVector(BaseModel):
    # Parallel arrays. `indices` are the model's 0-based token ids; `values` the
    # learned weights. ai-service shifts indices to 1-based when building the
    # pgvector sparsevec literal.
    indices: List[int]
    values: List[float]


class EmbedResponse(BaseModel):
    model: str
    dense: List[List[float]]
    sparse: List[SparseVector]


# ── Health / readiness: 200 only once the model is loaded ─────────────────────
@app.get("/health")
async def health():
    if not _ready:
        return _err(503, "model not loaded", "not_ready")
    return {"status": "ok", "model": BGE_M3_MODEL, "ready": True}


@app.get("/ready")
async def ready():
    return await health()


def _do_embed(inputs: List[str]):
    """Runs in the bounded executor thread."""
    # return_dense + return_sparse in one pass. return_colbert_vecs=False — we do
    # not use the colbert multi-vector output here.
    out = _model.encode(
        inputs,
        batch_size=BGE_M3_BATCH_SIZE,
        max_length=MAX_LENGTH,
        return_dense=RETURN_DENSE,
        return_sparse=True,
        return_colbert_vecs=False,
    )

    if RETURN_DENSE:
        dense = [list(map(float, v)) for v in out["dense_vecs"]]
    else:
        # Contract keeps the field; empty per input. Nothing reads dense today.
        dense = [[] for _ in inputs]

    # `lexical_weights` is a list of dicts { token_id(str) -> weight(float) }.
    # Normalise to the parallel-arrays wire shape ai-service expects.
    sparse: List[dict] = []
    for weights in out["lexical_weights"]:
        indices: List[int] = []
        values: List[float] = []
        for token_id, weight in weights.items():
            indices.append(int(token_id))
            values.append(float(weight))
        sparse.append({"indices": indices, "values": values})

    return dense, sparse


@app.post("/embed", response_model=EmbedResponse)
async def embed(req: EmbedRequest):
    if not _ready:
        raise ServiceError(503, "model not loaded", "not_ready")

    inputs = [req.input] if isinstance(req.input, str) else list(req.input)

    # Edge case: nothing to embed.
    if not inputs:
        return {"model": req.model, "dense": [], "sparse": []}

    if len(inputs) > MAX_INPUTS:
        raise ServiceError(
            400,
            f"Too many inputs: {len(inputs)} > MAX_INPUTS ({MAX_INPUTS}).",
            "too_many_inputs",
        )

    loop = asyncio.get_running_loop()
    try:
        dense, sparse = await asyncio.wait_for(
            loop.run_in_executor(_executor, _do_embed, inputs),
            timeout=REQUEST_TIMEOUT_S,
        )
    except asyncio.TimeoutError:
        raise ServiceError(503, f"inference exceeded {REQUEST_TIMEOUT_S}s", "timeout")

    return {"model": req.model, "dense": dense, "sparse": sparse}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORT)
