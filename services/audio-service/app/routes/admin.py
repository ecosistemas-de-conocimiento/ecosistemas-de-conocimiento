"""`/v1/admin/*` — dead-letter inspection and manual replay.

Mirrors ai-service's `/v1/admin/callbacks` surface: admin-role keys only, and
its only job is to let an operator see what fell out of the retry loop and
re-fire it once the cause is fixed.
"""

from __future__ import annotations

import uuid
from typing import Any, Dict

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse

from ..auth import AuthContext, require_auth
from ..config import Settings, get_settings
from ..delivery import attempt_delivery
from ..store import DLQ_CALLBACK, DLQ_TRANSCRIBE, JobStore

router = APIRouter()


def _forbidden() -> JSONResponse:
    return JSONResponse(
        status_code=403,
        content={"error": "forbidden", "message": "Admin role required"},
    )


@router.get("/dead-letters")
async def list_dead_letters(
    request: Request,
    queue: str = Query("transcribe", pattern="^(transcribe|callback)$"),
    limit: int = Query(50, ge=1, le=200),
    auth: AuthContext = Depends(require_auth),
) -> Any:
    if auth.role != "admin":
        return _forbidden()
    store: JobStore = request.app.state.store
    key = DLQ_TRANSCRIBE if queue == "transcribe" else DLQ_CALLBACK
    entries = await store.list_dead_letters(key, limit)
    # Scoped on BOTH org and project. An admin key is bound to one
    # (org, project) pair — there is no cross-tenant operator role in v1 — so
    # scoping on org alone would let an admin for (acme, projectA) read and
    # replay (acme, projectB)'s deliveries.
    scoped = [
        entry
        for entry in entries
        if entry.get("org") == auth.org and entry.get("project") == auth.project
    ]
    return {"queue": queue, "depth": await store.dead_letter_depth(key), "entries": scoped}


@router.post("/callbacks/{delivery_id}/replay")
async def replay_callback(
    request: Request,
    delivery_id: str,
    auth: AuthContext = Depends(require_auth),
    settings: Settings = Depends(get_settings),
) -> Any:
    """Re-sign the STORED body bytes with a fresh timestamp and re-POST once.

    The body is never re-serialised — the original bytes are replayed verbatim,
    which is the whole reason `delivery.py` stores them base64-encoded.
    """
    if auth.role != "admin":
        return _forbidden()
    store: JobStore = request.app.state.store
    row = await store.get_delivery(delivery_id)
    if row is None:
        return JSONResponse(
            status_code=404,
            content={"error": "not_found", "message": "No such delivery (it may have expired)"},
        )
    if row.get("org") != auth.org or row.get("project") != auth.project:
        return JSONResponse(
            status_code=404,
            content={"error": "not_found", "message": "No such delivery in this scope"},
        )

    # A fresh nonce per replay. Without it the replay's attempt-2 job id would
    # collide with the ORIGINAL run's attempt-2 id, arq would dedupe it away,
    # and the replay would die silently after one attempt with the row stuck at
    # `pending`.
    nonce = uuid.uuid4().hex[:8]
    await store.update_delivery(
        delivery_id, status="pending", lastError="", replayNonce=nonce, attempt=0
    )
    status = await attempt_delivery(
        delivery_id,
        1,
        store=store,
        pool=request.app.state.pool,
        settings=settings,
    )
    return {"deliveryId": delivery_id, "status": status, "replayNonce": nonce}


@router.get("/callbacks/{delivery_id}")
async def get_delivery(
    request: Request,
    delivery_id: str,
    auth: AuthContext = Depends(require_auth),
) -> Any:
    if auth.role != "admin":
        return _forbidden()
    store: JobStore = request.app.state.store
    row = await store.get_delivery(delivery_id)
    if row is None or row.get("org") != auth.org or row.get("project") != auth.project:
        return JSONResponse(
            status_code=404,
            content={"error": "not_found", "message": "No such delivery in this scope"},
        )
    # `body` is the signed payload; it can be large and is not what an operator
    # is looking at here. Report its size instead.
    redacted: Dict[str, Any] = {k: v for k, v in row.items() if k != "body"}
    redacted["bodyBytes"] = len(row.get("body", ""))
    return redacted
