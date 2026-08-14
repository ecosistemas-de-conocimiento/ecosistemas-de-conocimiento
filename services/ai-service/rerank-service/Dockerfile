# CPU-only reranker service (bge-reranker-v2-m3). No CUDA — a CPU-scale sibling,
# not a GPU box. Single-stage on purpose: the image size is dominated by the deps
# + the baked model weights (both unavoidable in the final image), so a build
# stage would not meaningfully shrink it. All deps ship manylinux cp311 wheels,
# so no compiler/build-essential is needed.
#
# Base pinned to a specific patch + Debian release for reproducibility. A digest
# pin (python:3.11.9-slim-bookworm@sha256:<digest>) is stronger still.
FROM python:3.11.9-slim-bookworm

# HF_HOME is set before the bake step (weights land here) and baked into the
# image; the non-root runtime user owns it.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HOME=/opt/hf-cache

WORKDIR /app

# curl for the HEALTHCHECK; a non-root runtime user; an HF cache dir it owns.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 app \
    && mkdir -p /opt/hf-cache \
    && chown -R app:app /opt/hf-cache /app

COPY requirements.txt .

# torch FIRST from the CPU wheel index so a CUDA build is never resolved; the
# rest (incl. the same torch==2.4.1, already satisfied) from PyPI.
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch==2.4.1 \
    && pip install -r requirements.txt

COPY app.py bake_model.py smoke_test.py ./

# Bake weights into an image layer: download ONCE, at build — never on first
# request. Docker's layer cache reuses this across rebuilds while deps + the bake
# script are unchanged. Build needs ~3GB RAM for the model construction.
RUN python bake_model.py \
    && chown -R app:app /opt/hf-cache

# Runtime is fully offline: the weights are already present, so never phone home
# (faster, deterministic, no network dependency at boot). Set AFTER the bake so
# the bake itself can download.
ENV HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1

USER app

EXPOSE 8000

# /health returns 200 only AFTER the model is loaded. The model loads from the
# baked cache into RAM at boot (before serving begins), so start-period is
# generous; the retries×interval window after it catches a genuine hang.
HEALTHCHECK --interval=15s --timeout=5s --start-period=240s --retries=3 \
    CMD curl -fsS http://localhost:8000/health || exit 1

# Exactly ONE worker: a second would load a second ~2.2GB model copy into RAM.
# Scale with container replicas, not workers.
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--timeout-keep-alive", "30"]
