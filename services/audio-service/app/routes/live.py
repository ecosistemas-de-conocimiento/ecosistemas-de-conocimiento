"""`/v1/live` — partial text while a recording is still going. See `app/live.py`.

    POST   /v1/live/{sid}/chunk?offset=N   raw audio bytes -> 200 {committed, tentative, seconds, received}
    DELETE /v1/live/{sid}                  -> 204

The body is the raw slice (no multipart), so nothing is spooled to disk.
🔴 Responses carry the partial text; it is never logged here.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.responses import JSONResponse

from ..auth import AuthContext, require_auth
from ..config import Settings, get_settings
from ..live import SESSION_ID, LiveError, LiveTranscriber

router = APIRouter()

_live: LiveTranscriber | None = None


def get_live(settings: Settings = Depends(get_settings)) -> LiveTranscriber:
    global _live
    if _live is None:
        _live = LiveTranscriber(settings)
    return _live


def _key(auth: AuthContext, sid: str) -> str:
    if not SESSION_ID.match(sid):
        raise LiveError(400, "bad_session_id", "Invalid session id")
    return f"{auth.api_key_id}:{sid}"


def _fail(exc: LiveError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status,
        content={"error": exc.code, "message": str(exc)},
        headers={"cache-control": "no-store"},
    )


@router.post("/{sid}/chunk")
async def push_chunk(
    sid: str,
    request: Request,
    offset: int = Query(0, ge=0),
    auth: AuthContext = Depends(require_auth),
    live: LiveTranscriber = Depends(get_live),
):
    try:
        key = _key(auth, sid)
        data = await request.body()
        state = await live.push(key, offset, data)
    except LiveError as exc:
        return _fail(exc)
    return JSONResponse(state, headers={"cache-control": "no-store"})


@router.delete("/{sid}")
async def drop_session(
    sid: str,
    auth: AuthContext = Depends(require_auth),
    live: LiveTranscriber = Depends(get_live),
):
    try:
        live.drop(_key(auth, sid))
    except LiveError as exc:
        return _fail(exc)
    return Response(status_code=204)
