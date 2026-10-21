# syntax=docker/dockerfile:1
#
# audio-service — production image. ONE image, two roles:
#
#   API     : uvicorn app.main:app          (the default CMD)
#   worker  : arq app.worker.WorkerSettings (override `command:` in compose)
#
# ⚠ BUILD CONTEXT IS THIS DIRECTORY, not the repo root — unlike
#   services/ai-service/Dockerfile, which needs the root for pnpm-lock.yaml.
#   This service is Python and has no workspace dependency, so:
#
#     docker build -t edc-audio-service services/audio-service
#
#   or, from the root docker-compose.yml:
#
#     build:
#       context: ./services/audio-service
#
# CPU-ONLY BY DEFAULT AND ON PURPOSE. There is no CUDA in this image and none is
# needed: CTranslate2's CPU backend runs the same weights. To use a GPU on the
# fleet, switch the base image to `nvidia/cuda:12.*-cudnn-runtime-ubuntu22.04`,
# install the same requirements, and set WHISPER_DEVICE=cuda +
# WHISPER_COMPUTE_TYPE=float16. NO APPLICATION CODE CHANGES — see README
# §"Running on a GPU".
#
# Single stage on purpose: the image size is dominated by the Python deps and
# the baked model weights, both of which must exist in the final layer, so a
# builder stage would buy nothing.

FROM python:3.11.11-slim-bookworm

ARG WHISPER_MODEL=large-v3-turbo

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    WHISPER_MODEL=${WHISPER_MODEL} \
    WHISPER_DOWNLOAD_ROOT=/opt/whisper-cache \
    AUDIO_WORK_DIR=/var/lib/audio-service

WORKDIR /app

# ffmpeg  : transcode, slice and silence-detect every upload (the whole point).
# libgomp1: CTranslate2's OpenMP runtime — python:slim does not ship it and the
#           import fails at runtime without it, which is a miserable thing to
#           debug.
# curl    : backs the HEALTHCHECK below.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg \
        libgomp1 \
        curl \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 app \
    && mkdir -p /opt/whisper-cache /var/lib/audio-service/uploads /var/lib/audio-service/work \
    && chown -R app:app /opt/whisper-cache /var/lib/audio-service /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY scripts/ ./scripts/

# ── Bake the weights ──────────────────────────────────────────────────────────
# Download ONCE, at build. Docker's layer cache reuses this across every rebuild
# where requirements.txt and this script are unchanged, so an app-code edit is a
# 5-second rebuild rather than an 800 MB download.
#
# Needs ~2 GB of RAM and network access at build time. Change the model with
# `--build-arg WHISPER_MODEL=small` (~250 MB) for a leaner demo image.
#
# `--build-arg WHISPER_BAKE=0` skips the bake — for WHISPER_BACKEND=remote,
# where the model runs on the Spark and these weights would be dead weight.
# ⚠ An image built that way CANNOT run WHISPER_BACKEND=local (offline, no weights).
ARG WHISPER_BAKE=1
RUN if [ "$WHISPER_BAKE" = "1" ]; then python scripts/bake_model.py; \
    else echo "[bake] skipped (WHISPER_BAKE=$WHISPER_BAKE)"; fi \
    && chown -R app:app /opt/whisper-cache

# Runtime is provably offline: the weights are present, so never phone home.
# Set AFTER the bake so the bake itself can download. A typo in WHISPER_MODEL
# now fails loudly at boot instead of silently downloading a second model into
# the container's ephemeral layer.
ENV HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1

COPY app/ ./app/

USER app

# Documentation only — the actual port comes from `PORT` (see CMD below).
EXPOSE 8080

# Liveness only — /health touches no dependency, so a Redis blip does not
# restart the container. /health/ready is what an orchestrator should gate
# traffic on; it additionally requires a worker with the model loaded.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT:-8080}/health" || exit 1

# Shell form so `PORT` is honoured — the root compose sets it (8080 per
# `plan/deploy-and-local-demo.md`), and hardcoding 8000 here would silently
# ignore it and break that stack's healthcheck. `exec` keeps uvicorn as PID 1
# so SIGTERM reaches it and shutdown is graceful.
#
# Exactly ONE uvicorn worker. The API process is I/O-bound (it writes an upload
# to disk and enqueues), so a second worker buys nothing; scale with replicas.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8080} --workers 1 --timeout-keep-alive 75"]
