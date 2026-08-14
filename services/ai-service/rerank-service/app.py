"""CPU reranker HTTP service — production-hardened.

Serves BAAI/bge-reranker-v2-m3 (Apache-2.0, multilingual cross-encoder) behind a
Cohere/Voyage/Jina-style ``POST /rerank`` endpoint. The served model is fixed by
the ``RERANK_MODEL`` env var; the incoming ``model`` field is echoed back but does
not swap the loaded weights.

Production posture (see README):
  - Model is loaded ONCE at boot (FastAPI lifespan) — never per request. There is
    no lazy first-request penalty and no unlocked double-init race.
  - ``/health`` (and ``/ready``) return 200 ONLY after the model is loaded, so an
    orchestrator never routes traffic to a cold container.
  - Inference runs in a bounded thread pool with a wall-clock backstop, so a
    request never hangs the process indefinitely and CPU threads are not
    oversubscribed.
  - Errors are returned in the ``{"error": {"message", "code"}}`` envelope the
    ai-service rerank client parses (src/services/ai/rerank/rerank-client.ts).
"""

import asyncio
import logging
import os
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from typing import List, Optional

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper())
log = logging.getLogger("rerank-service")

# ── Config (env-driven, sane defaults, no secrets) ────────────────────────────
RERANK_MODEL = os.getenv("RERANK_MODEL", "BAAI/bge-reranker-v2-m3")
PORT = int(os.getenv("PORT", "8000"))
MAX_DOCUMENTS = int(os.getenv("MAX_DOCUMENTS", "100"))
# Max token sequence length for a (query, document) pair. FlagReranker's own
# default is 512, which SILENTLY truncates documents longer than that — and this
# system's default chunk size is ~800 tokens (corpora.chunkSize=800), so 512
# would clip real RAG chunks. Default 1024 fits an ~800-token chunk plus a query
# with headroom; raise toward the model's 8192 ceiling if your chunks are larger
# (CPU latency scales with this).
RERANK_MAX_LENGTH = int(os.getenv("RERANK_MAX_LENGTH", "1024"))
RERANK_BATCH_SIZE = int(os.getenv("RERANK_BATCH_SIZE", "16"))
# Bounded concurrent inferences. Default 1: one request at a time, each using all
# CPU threads (TORCH_NUM_THREADS) — best per-request latency and no thread
# oversubscription. If you raise this, LOWER TORCH_NUM_THREADS so
# INFERENCE_CONCURRENCY * TORCH_NUM_THREADS stays ≈ core count.
INFERENCE_CONCURRENCY = int(os.getenv("INFERENCE_CONCURRENCY", "1"))
# CPU threads for torch. Default (0) → all cores. Set explicitly to tune.
TORCH_NUM_THREADS = int(os.getenv("TORCH_NUM_THREADS", "0")) or (os.cpu_count() or 1)
# Server-side wall-clock backstop per request (seconds). The consumer sets its
# OWN, shorter timeout (RERANK_TIMEOUT_MS, default 5s); this is only a guard
# against a pathological hang, generous so it never fires on bounded input.
REQUEST_TIMEOUT_S = float(os.getenv("REQUEST_TIMEOUT_S", "120"))

# ── Module state ──────────────────────────────────────────────────────────────
_reranker = None
_ready = False
_executor: Optional[ThreadPoolExecutor] = None


def load_reranker():
    """Construct the FlagReranker singleton. Imported lazily so the module stays
    cheap to import (bake script / tooling) while the heavy torch/transformers
    import happens exactly once, at boot."""
    global _reranker
    if _reranker is None:
        import torch
        from FlagEmbedding import FlagReranker

        torch.set_num_threads(TORCH_NUM_THREADS)
        log.info(
            "loading reranker model=%s max_length=%d torch_threads=%d",
            RERANK_MODEL, RERANK_MAX_LENGTH, TORCH_NUM_THREADS,
        )
        # use_fp16=False forces the CPU fp32 path (fp16 matmul is a GPU thing).
        _reranker = FlagReranker(RERANK_MODEL, use_fp16=False)
    return _reranker


def warmup() -> None:
    """Run one tiny inference so every lazily-fetched file is resolved and the
    first real request pays no extra cost. Used at boot and at bake time."""
    load_reranker().compute_score(
        [["warmup query", "warmup document"]],
        normalize=True,
        max_length=RERANK_MAX_LENGTH,
        batch_size=RERANK_BATCH_SIZE,
    )


@asynccontextmanager
async def lifespan(_: FastAPI):
    global _ready, _executor
    _executor = ThreadPoolExecutor(max_workers=INFERENCE_CONCURRENCY)
    # Load synchronously at startup: uvicorn does not accept requests until this
    # returns, so by the time /health can answer, the model is in RAM. A load
    # failure raises here → the process exits → the orchestrator restarts it
    # (fail-fast) rather than serving a permanently-cold container.
    load_reranker()
    warmup()
    _ready = True
    log.info("reranker ready")
    yield
    _ready = False
    if _executor is not None:
        _executor.shutdown(wait=False, cancel_futures=True)


app = FastAPI(title="rerank-service", version="1.1.0", lifespan=lifespan)


# ── Error envelope: match what the ai-service rerank client parses ────────────
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
    # Log the real cause; hand the client the parseable envelope (the detail is
    # otherwise lost because the TS clients only read {error:{message,code}}).
    log.exception("unhandled error")
    return _err(500, f"internal error: {type(exc).__name__}", "internal_error")


# ── Wire models ───────────────────────────────────────────────────────────────
class RerankRequest(BaseModel):
    model: str
    query: str
    documents: List[str]
    top_n: Optional[int] = Field(default=None, ge=1)


class RerankResult(BaseModel):
    index: int
    relevance_score: float


class RerankResponse(BaseModel):
    model: str
    results: List[RerankResult]


# ── Health / readiness: 200 only once the model is loaded ─────────────────────
@app.get("/health")
async def health():
    if not _ready:
        return _err(503, "model not loaded", "not_ready")
    return {"status": "ok", "model": RERANK_MODEL, "ready": True}


# /ready is an explicit alias for orchestrators that separate liveness from
# readiness; identical semantics here (model-loaded gate).
@app.get("/ready")
async def ready():
    return await health()


def _do_rerank(query: str, documents: List[str]) -> List[float]:
    """Runs in the bounded executor thread. torch releases the GIL during the
    native forward pass, so /health stays responsive while this runs."""
    # normalize=True applies a sigmoid so scores land in 0..1.
    scores = _reranker.compute_score(
        [[query, doc] for doc in documents],
        normalize=True,
        max_length=RERANK_MAX_LENGTH,
        batch_size=RERANK_BATCH_SIZE,
    )
    # compute_score returns a bare float for a single pair; normalize to a list.
    if not isinstance(scores, list):
        scores = [scores]
    return scores


@app.post("/rerank", response_model=RerankResponse)
async def rerank(req: RerankRequest):
    if not _ready:
        raise ServiceError(503, "model not loaded", "not_ready")

    # Edge case: nothing to score. No inference, no executor round-trip.
    if not req.documents:
        return {"model": req.model, "results": []}

    if len(req.documents) > MAX_DOCUMENTS:
        raise ServiceError(
            400,
            f"Too many documents: {len(req.documents)} > MAX_DOCUMENTS ({MAX_DOCUMENTS}).",
            "too_many_documents",
        )

    loop = asyncio.get_running_loop()
    try:
        scores = await asyncio.wait_for(
            loop.run_in_executor(_executor, _do_rerank, req.query, req.documents),
            timeout=REQUEST_TIMEOUT_S,
        )
    except asyncio.TimeoutError:
        raise ServiceError(503, f"inference exceeded {REQUEST_TIMEOUT_S}s", "timeout")

    results = [
        {"index": i, "relevance_score": float(score)} for i, score in enumerate(scores)
    ]
    results.sort(key=lambda r: r["relevance_score"], reverse=True)
    if req.top_n is not None:
        results = results[: req.top_n]

    return {"model": req.model, "results": results}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORT)
