"""`/v1/transcribe` — the async file-upload surface.

Mirrors ai-service's `/v1/ingest` exactly in shape:

    POST /v1/transcribe            -> 202 {"transcribeId": "...", ...}
    GET  /v1/transcribe/{id}       -> status snapshot (+ transcript when ready)

and in the two rules that matter:

  - **`org` and `project` come from the API key, never from the request.**
    A caller cannot transcribe into an organization its key does not map to.
  - **The route does no work.** It validates, writes the audio to disk, writes a
    status row, enqueues, and returns. Everything expensive happens on the
    queue.

Tenant scoping on read is enforced by returning **404, not 403**, when the job
exists but belongs to another `(org, project)`. A 403 would confirm the id
exists, which is a cross-tenant existence oracle over guessable-adjacent ids.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, File, Form, Query, Request, UploadFile
from fastapi.responses import JSONResponse

from ..audio import ffmpeg
from ..audio.formats import is_accepted, safe_extension
from ..auth import AuthContext, require_auth
from ..config import Settings, get_settings
from ..queue import enqueue_transcribe
from ..store import (
    JobRow,
    JobStore,
    STATUS_COMPLETED,
    STATUS_QUEUED,
    new_transcribe_id,
    now_iso,
)

log = logging.getLogger("audio-service.routes.transcribe")

router = APIRouter()

#: Read the upload in 1 MiB slices so a 500 MB file never lands in RAM whole.
#:
#: ⚠ This is the SECOND line of defence, not the first. FastAPI parses a
#: multipart body BEFORE it resolves dependencies, so by the time this loop
#: runs, Starlette has already spooled the upload to a temp file and
#: `require_auth` has not run. `app/limits.py` is the gate that runs early
#: enough to matter; the count below only guards against a lying
#: `Content-Length`.
UPLOAD_CHUNK_BYTES = 1024 * 1024


def _error(status: int, code: str, message: str) -> JSONResponse:
    """ai-service's error body shape: `{error, message}`."""
    return JSONResponse(status_code=status, content={"error": code, "message": message})


@router.post("")
@router.post("/")
async def create_transcription(
    request: Request,
    file: UploadFile = File(..., description="The audio file to transcribe"),
    callbackUrl: Optional[str] = Form(
        None, description="HMAC-signed completion webhook; same contract as ai-service"
    ),
    language: Optional[str] = Form(
        None, description="ISO code, default 'es'. Empty string forces autodetect."
    ),
    externalId: Optional[str] = Form(
        None, description="Consumer's own id, echoed back on every callback"
    ),
    title: Optional[str] = Form(None),
    idempotencyKey: Optional[str] = Form(None),
    metadata: Optional[str] = Form(None, description="JSON object, echoed back verbatim"),
    auth: AuthContext = Depends(require_auth),
    settings: Settings = Depends(get_settings),
) -> Any:
    store: JobStore = request.app.state.store
    pool = request.app.state.pool

    # ── Cheap rejections, before a byte touches disk ─────────────────────────
    accepted, reason = is_accepted(file.filename, file.content_type)
    if not accepted:
        return _error(415, "unsupported_media_type", reason)

    parsed_metadata: Optional[Dict[str, Any]] = None
    if metadata:
        try:
            candidate = json.loads(metadata)
        except json.JSONDecodeError as exc:
            return _error(400, "bad_request", f"metadata must be valid JSON: {exc}")
        if not isinstance(candidate, dict):
            return _error(400, "bad_request", "metadata must be a JSON object")
        parsed_metadata = candidate

    if callbackUrl and not callbackUrl.lower().startswith(("http://", "https://")):
        return _error(400, "bad_request", "callbackUrl must be an absolute http(s) URL")

    transcribe_id = new_transcribe_id()

    # ── Idempotency ──────────────────────────────────────────────────────────
    # Claimed BEFORE the upload is read: a client retrying a timed-out POST
    # must not get a second transcription (each one costs real CPU minutes).
    if idempotencyKey:
        existing = await store.claim_idempotency_key(
            auth.org, auth.project, idempotencyKey, transcribe_id
        )
        if existing:
            row = await store.get_job(existing)
            return JSONResponse(
                status_code=200,
                content={
                    "transcribeId": existing,
                    "status": row.status if row else "unknown",
                    "org": auth.org,
                    "project": auth.project,
                    "deduplicated": True,
                },
            )

    # ── Stream to disk ───────────────────────────────────────────────────────
    os.makedirs(settings.upload_dir, exist_ok=True)
    destination = os.path.join(
        settings.upload_dir, f"{transcribe_id}{safe_extension(file.filename)}"
    )
    written = 0
    try:
        with open(destination, "wb") as sink:
            while True:
                block = await file.read(UPLOAD_CHUNK_BYTES)
                if not block:
                    break
                written += len(block)
                if written > settings.MAX_UPLOAD_BYTES:
                    raise _TooLarge()
                sink.write(block)
    except _TooLarge:
        _cleanup(destination)
        if idempotencyKey:
            await store.release_idempotency_key(auth.org, auth.project, idempotencyKey)
        return _error(
            413,
            "payload_too_large",
            f"Upload exceeds the {settings.MAX_UPLOAD_BYTES // (1024 * 1024)} MiB limit",
        )
    except OSError as exc:
        _cleanup(destination)
        if idempotencyKey:
            await store.release_idempotency_key(auth.org, auth.project, idempotencyKey)
        log.error("could not write upload to %s: %s", destination, exc)
        return _error(500, "storage_error", "Could not store the uploaded audio")
    finally:
        await file.close()

    if written == 0:
        _cleanup(destination)
        if idempotencyKey:
            await store.release_idempotency_key(auth.org, auth.project, idempotencyKey)
        return _error(400, "bad_request", "Uploaded file is empty")

    # ── Authoritative format check ───────────────────────────────────────────
    # Done inline rather than on the queue so a caller uploading a PDF gets a
    # synchronous 415 instead of a webhook five minutes later.
    try:
        probe = await ffmpeg.probe(
            destination, ffprobe_bin=settings.FFPROBE_BIN, timeout=60.0
        )
    except ffmpeg.FfmpegError as exc:
        _cleanup(destination)
        if idempotencyKey:
            await store.release_idempotency_key(auth.org, auth.project, idempotencyKey)
        return _error(415, "unsupported_media_type", str(exc))

    if not probe.has_audio:
        _cleanup(destination)
        if idempotencyKey:
            await store.release_idempotency_key(auth.org, auth.project, idempotencyKey)
        return _error(
            415, "unsupported_media_type", "The file contains no audio stream"
        )
    if probe.duration_seconds > settings.MAX_DURATION_SECONDS:
        _cleanup(destination)
        if idempotencyKey:
            await store.release_idempotency_key(auth.org, auth.project, idempotencyKey)
        return _error(
            413,
            "payload_too_large",
            f"Recording is {probe.duration_seconds / 3600:.1f}h, over the "
            f"{settings.MAX_DURATION_SECONDS / 3600:.1f}h limit",
        )

    # ── Persist + enqueue ────────────────────────────────────────────────────
    # An explicitly-empty `language` means "autodetect". It is stored as the
    # sentinel `"auto"` rather than "" because the Redis hash cannot tell an
    # empty string from an absent field, and an absent field would silently
    # fall back to WHISPER_LANGUAGE — i.e. the opposite of what was asked for.
    resolved_language = (
        settings.WHISPER_LANGUAGE if language is None else (language.strip() or "auto")
    )
    row = JobRow(
        transcribeId=transcribe_id,
        org=auth.org,
        project=auth.project,
        apiKeyId=auth.api_key_id,
        status=STATUS_QUEUED,
        createdAt=now_iso(),
        updatedAt=now_iso(),
        filename=file.filename,
        contentType=file.content_type,
        bytes=written,
        language=resolved_language,
        callbackUrl=callbackUrl,
        externalId=externalId,
        title=title,
        idempotencyKey=idempotencyKey,
        metadata=parsed_metadata,
        sourcePath=destination,
        durationSeconds=round(probe.duration_seconds, 3),
    )
    await store.create_job(row)
    queued = await enqueue_transcribe(pool, transcribe_id)
    if not queued:
        # arq de-duplicated against a job id already on the queue. With a fresh
        # UUID this should be impossible, so it means Redis state is stranger
        # than we think. Say so rather than returning a 202 that promises work
        # nobody scheduled.
        log.error(
            "transcribe %s was NOT enqueued (arq de-duplicated a fresh job id)",
            transcribe_id,
        )

    return JSONResponse(
        status_code=202,
        content={
            "transcribeId": transcribe_id,
            "status": STATUS_QUEUED,
            "org": auth.org,
            "project": auth.project,
            "bytes": written,
            "queued": queued,
            "durationSeconds": round(probe.duration_seconds, 3),
            "audio": ffmpeg.summarise_probe(probe),
        },
    )


@router.get("/{transcribe_id}")
async def get_transcription(
    request: Request,
    transcribe_id: str,
    includeSegments: bool = Query(
        False,
        description="Include per-segment timestamps. Off by default: a 2-hour "
        "recording is thousands of segments and most consumers only want text.",
    ),
    includeText: bool = Query(True),
    auth: AuthContext = Depends(require_auth),
) -> Any:
    store: JobStore = request.app.state.store
    row = await store.get_job(transcribe_id)

    # 404 (not 403) on a cross-tenant read — see the module docstring.
    if row is None or row.org != auth.org or row.project != auth.project:
        return _error(
            404,
            "not_found",
            "No transcription with that id in this scope (it may have expired)",
        )

    body: Dict[str, Any] = {
        "transcribeId": row.transcribeId,
        "status": row.status,
        "org": row.org,
        "project": row.project,
        "externalId": row.externalId,
        "title": row.title,
        "createdAt": row.createdAt,
        "updatedAt": row.updatedAt,
        "startedAt": row.startedAt,
        "completedAt": row.completedAt,
        "attempts": row.attempts,
        "audio": {
            "filename": row.filename,
            "contentType": row.contentType,
            "bytes": row.bytes,
            "durationSeconds": row.durationSeconds,
        },
        "progress": {"chunksDone": row.chunksDone, "chunksTotal": row.chunksTotal},
        "error": (
            {"code": row.errorCode, "message": row.errorMessage}
            if row.errorCode
            else None
        ),
        "transcript": None,
    }

    if row.status == STATUS_COMPLETED:
        transcript = await store.get_transcript(transcribe_id)
        if transcript is not None:
            payload = dict(transcript)
            if not includeSegments:
                payload.pop("segments", None)
            if not includeText:
                payload.pop("text", None)
            body["transcript"] = payload

    return body


class _TooLarge(Exception):
    """Internal control-flow signal for the streaming size cap."""


def _cleanup(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass
