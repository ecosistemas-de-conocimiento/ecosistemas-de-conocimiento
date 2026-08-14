"""Health and readiness — the fleet's convention, copied from ai-service.

    GET /health        liveness. Process is up. Touches nothing.
    GET /health/ready  readiness. Dependencies reachable. 200 or 503.

Both are unauthenticated, exactly as in ai-service, so a load balancer or a
Docker `HEALTHCHECK` can call them without holding a key.

`/ready` on the API container is deliberately NOT just "Redis answers". It also
requires a live worker heartbeat, which is only published once that worker has
the Whisper model in RAM. Without that check the API would report ready while
every job it accepts sits in the queue forever — the exact failure a readiness
probe exists to prevent. `/ready/aliases`-style extras are not needed; the two
paths below are what the fleet's compose healthchecks call.
"""

from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..store import DLQ_CALLBACK, DLQ_TRANSCRIBE, JobStore

router = APIRouter()


@router.get("/health")
async def health() -> Dict[str, Any]:
    return {"status": "ok", "service": "audio-service"}


@router.get("/health/ready")
async def ready(request: Request) -> Any:
    store: JobStore = request.app.state.store
    checks: Dict[str, Any] = {}

    try:
        await store.ping()
        checks["redis"] = {"ok": True}
    except Exception as exc:
        checks["redis"] = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

    heartbeat = None
    try:
        heartbeat = await store.get_worker_heartbeat()
    except Exception as exc:
        checks["worker"] = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

    if "worker" not in checks:
        if heartbeat is None:
            checks["worker"] = {
                "ok": False,
                "error": "no worker heartbeat — no transcription worker is running, "
                "or it has not finished loading the model",
            }
        elif not heartbeat.get("modelLoaded"):
            checks["worker"] = {"ok": False, "error": "worker up, model not loaded"}
        else:
            checks["worker"] = {"ok": True, "model": heartbeat.get("model")}

    ok = all(check.get("ok") for check in checks.values())
    return JSONResponse(
        status_code=200 if ok else 503,
        content={"status": "ok" if ok else "degraded", "checks": checks},
    )


@router.get("/health/queues")
async def queues(request: Request) -> Dict[str, Any]:
    """Dead-letter depths. Unauthenticated on purpose — it leaks two integers
    and is what a monitoring scrape wants without a credential."""
    store: JobStore = request.app.state.store
    return {
        "deadLetters": {
            "transcribe": await store.dead_letter_depth(DLQ_TRANSCRIBE),
            "callback": await store.dead_letter_depth(DLQ_CALLBACK),
        }
    }
