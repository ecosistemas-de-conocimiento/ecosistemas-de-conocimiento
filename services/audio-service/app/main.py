"""FastAPI application — the HTTP half of audio-service.

This process never loads the Whisper model. It validates, stores the upload,
writes a status row and enqueues; `app/worker.py` does the transcription. The
split is deliberate:

  - the API container stays small and starts in a second, so it can be scaled
    for concurrency and restarted freely;
  - the worker container is the heavy one, and it is the only thing that has to
    move to a GPU host on the fleet.

Both come from the SAME image — only the command differs. See the README.

Route layout mirrors ai-service:
    /health, /health/ready          unauthenticated
    /v1/*                           bearer token required
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from redis.asyncio import Redis

from .auth import AuthError, auth_error_response
from .config import get_settings, validate_callback_secrets
from .limits import BodySizeLimitMiddleware
from .queue import close_pool, create_queue_pool
from .routes import admin as admin_routes
from .routes import health as health_routes
from .routes import transcribe as transcribe_routes
from .store import JobStore

log = logging.getLogger("audio-service")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    logging.basicConfig(level=settings.LOG_LEVEL)

    for warning in validate_callback_secrets(settings):
        log.warning(
            "API_KEYS entry %s has no callbackSecret. Async callbacks for this key "
            "cannot be signed and the consumer will reject them. Add a 32+ char "
            "`callbackSecret` matching the consumer's CALLBACK_SECRET.",
            warning,
        )
    if not settings.api_keys:
        log.warning(
            "API_KEYS is empty — every /v1 request will 401. This is only correct "
            "for a smoke test of /health."
        )

    os.makedirs(settings.upload_dir, exist_ok=True)
    os.makedirs(settings.scratch_dir, exist_ok=True)

    redis = Redis.from_url(settings.REDIS_URL, decode_responses=True)
    app.state.settings = settings
    app.state.redis = redis
    app.state.store = JobStore(
        redis,
        job_ttl=settings.JOB_TTL_SECONDS,
        transcript_ttl=settings.TRANSCRIPT_TTL_SECONDS,
        idempotency_ttl=settings.IDEMPOTENCY_TTL_SECONDS,
        callback_ttl=settings.CALLBACK_TTL_SECONDS,
    )
    app.state.pool = await create_queue_pool(settings)
    log.info(
        "audio-service API listening; queue=%s model=%s device=%s",
        settings.QUEUE_NAME,
        settings.WHISPER_MODEL,
        settings.WHISPER_DEVICE,
    )
    try:
        yield
    finally:
        await close_pool(app.state.pool)
        closer = getattr(redis, "aclose", None) or getattr(redis, "close", None)
        if closer is not None:
            await closer()


def create_app() -> FastAPI:
    app = FastAPI(
        title="audio-service",
        version="0.1.0",
        description=(
            "Async audio transcription for the Ecosistemas de Conocimiento "
            "knowledge repository. Upload an audio file, get a Spanish "
            "transcript back via an HMAC-signed callback, hand it to "
            "ai-service's /v1/ingest."
        ),
        lifespan=lifespan,
    )

    @app.exception_handler(AuthError)
    async def _auth_handler(_: Request, exc: AuthError) -> JSONResponse:
        return auth_error_response(exc)

    @app.exception_handler(RequestValidationError)
    async def _validation_handler(
        _: Request, exc: RequestValidationError
    ) -> JSONResponse:
        # Only loc/msg/type. FastAPI's `exc.errors()` also carries an `input`
        # key holding the offending VALUE, and echoing that back reflects
        # caller-supplied data — including, on a mis-sent header or form field,
        # data the caller did not mean to expose.
        details = [
            {
                "loc": [str(part) for part in err.get("loc", [])],
                "msg": err.get("msg", ""),
                "type": err.get("type", ""),
            }
            for err in exc.errors()
        ]
        return JSONResponse(
            status_code=400,
            content={
                "error": "bad_request",
                "message": "; ".join(
                    f"{'.'.join(d['loc'])}: {d['msg']}" for d in details
                )
                or "invalid request",
                "details": details,
            },
        )

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, exc: Exception) -> JSONResponse:
        # Never leak an internal message to a consumer; the type is enough to
        # correlate with the log line we just wrote.
        log.exception("unhandled error")
        return JSONResponse(
            status_code=500,
            content={
                "error": "internal_error",
                "message": f"Internal error ({type(exc).__name__})",
            },
        )

    app.include_router(health_routes.router)
    app.include_router(transcribe_routes.router, prefix="/v1/transcribe", tags=["transcribe"])
    app.include_router(admin_routes.router, prefix="/v1/admin", tags=["admin"])

    # 🔴 MUST be added AFTER the routers and OUTSIDE the lifespan, and it must
    # be raw ASGI. FastAPI parses a multipart body BEFORE it resolves
    # dependencies, so a size check inside the route (or in a
    # BaseHTTPMiddleware, which buffers) runs only after an unauthenticated
    # caller has already spooled the whole upload to disk. See `app/limits.py`.
    boot_settings = get_settings()
    app.add_middleware(
        BodySizeLimitMiddleware,
        max_bytes=boot_settings.MAX_UPLOAD_BYTES,
        guarded_prefixes=("/v1/",),
    )
    return app


app = create_app()


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    settings = get_settings()
    uvicorn.run(app, host=settings.HOST, port=settings.PORT)
