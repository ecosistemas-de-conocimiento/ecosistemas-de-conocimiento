"""arq worker: transcription jobs + callback deliveries.

Run with::

    arq app.worker.WorkerSettings

This process, not the API process, is the one that holds the model in RAM. That
split is what lets the fleet scale the two independently — API replicas are a
few hundred MB, worker replicas are the ones that want the GPU.

Retry policy is managed explicitly rather than delegated to arq's own counter,
so that "retry" means the same thing here as it does in ai-service:

  - **infrastructure failures retry** (ffmpeg timed out, the model failed to
    load, the box ran out of memory) on `JOB_RETRY_BACKOFF_SECONDS`;
  - **content failures do not** (no audio stream, zero-length audio, over the
    duration cap, nothing intelligible said). Retrying those produces the same
    answer three times and delays the consumer's error by minutes;
  - the final failure of either kind pushes onto the dead-letter list AND emits
    a `transcribe.failed` callback, so the consumer never has to poll to
    discover a job died.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any, Dict, Optional

from arq.connections import ArqRedis, RedisSettings
from arq.worker import Retry
from redis.asyncio import Redis

from . import pipeline
from .callbacks import completed_envelope, failed_envelope, progress_envelope
from .config import Settings, get_settings, validate_callback_secrets
from .delivery import attempt_delivery, enqueue_callback
from .pipeline import PipelineError
from .queue import create_queue_pool, redis_settings as build_redis_settings
from .store import (
    DLQ_TRANSCRIBE,
    JobRow,
    JobStore,
    STATUS_COMPLETED,
    STATUS_DEAD_LETTER,
    STATUS_FAILED,
    STATUS_PROCESSING,
    TERMINAL_JOB_STATUSES,
    now_iso,
)
from .transcriber import Transcriber

log = logging.getLogger("audio-service.worker")

#: Failures where a second attempt cannot plausibly succeed.
NON_RETRYABLE_CODES = {
    "no_audio_stream",
    "empty_audio",
    "too_long",
    "empty_transcript",
    "undecodable",
    "decode_failed",
    "source_missing",
}


# ---------------------------------------------------------------------------
# Tasks
# ---------------------------------------------------------------------------

async def transcribe_job(ctx: Dict[str, Any], transcribe_id: str) -> Dict[str, Any]:
    settings: Settings = ctx["settings"]
    store: JobStore = ctx["store"]
    transcriber: Transcriber = ctx["transcriber"]
    pool: ArqRedis = ctx["pool"]
    attempt = int(ctx.get("job_try", 1))

    row = await store.get_job(transcribe_id)
    if row is None:
        log.warning("transcribe job %s has no status row (expired?); dropping", transcribe_id)
        return {"transcribeId": transcribe_id, "status": "missing"}
    if row.status in TERMINAL_JOB_STATUSES:
        return {"transcribeId": transcribe_id, "status": row.status}

    scratch_dir = os.path.join(settings.scratch_dir, transcribe_id)
    started_wall = time.monotonic()
    await store.update_job(
        transcribe_id,
        status=STATUS_PROCESSING,
        attempts=attempt,
        startedAt=row.startedAt or now_iso(),
    )
    # Register as in-flight. The heartbeat loop touches this row while we hold
    # it, and the reconciler fails it if nothing touches it for long enough —
    # which is how a `job_timeout` cancellation or a SIGKILL becomes a real
    # terminal state instead of a row stuck at `processing` forever.
    await store.mark_in_flight(transcribe_id)

    try:
        if not row.sourcePath or not os.path.exists(row.sourcePath):
            raise PipelineError(
                "The uploaded audio is no longer on disk — it was swept or the "
                "worker restarted onto a different volume",
                code="source_missing",
            )

        async def on_progress(done: int, total: int) -> None:
            await _report_progress(
                store=store,
                pool=pool,
                settings=settings,
                row=row,
                done=done,
                total=total,
            )

        result = await pipeline.run_pipeline(
            source_path=row.sourcePath,
            scratch_dir=scratch_dir,
            settings=settings,
            transcriber=transcriber,
            language=row.language,
            on_progress=on_progress,
        )

    except Exception as exc:
        code = getattr(exc, "code", None) or type(exc).__name__
        message = str(exc)
        retryable = code not in NON_RETRYABLE_CODES
        can_retry = retryable and attempt < settings.JOB_MAX_TRIES

        if can_retry:
            backoff = _backoff_for(settings, attempt)
            log.warning(
                "transcribe %s attempt %d/%d failed (%s: %s); retrying in %ds",
                transcribe_id, attempt, settings.JOB_MAX_TRIES, code, message, backoff,
            )
            await store.update_job(
                transcribe_id,
                attempts=attempt,
                errorCode=code,
                errorMessage=message,
            )
            # NB: the SOURCE upload is deliberately kept — the retry needs it.
            # The scratch tree is removed by the `finally` below.
            raise Retry(defer=backoff) from exc

        terminal = STATUS_DEAD_LETTER if retryable else STATUS_FAILED
        log.error(
            "transcribe %s failed permanently (%s: %s) after %d attempt(s) -> %s",
            transcribe_id, code, message, attempt, terminal,
        )
        await store.update_job(
            transcribe_id,
            status=terminal,
            attempts=attempt,
            errorCode=code,
            errorMessage=message,
            completedAt=now_iso(),
        )
        if terminal == STATUS_DEAD_LETTER:
            await store.dead_letter(
                DLQ_TRANSCRIBE,
                {
                    "transcribeId": transcribe_id,
                    "org": row.org,
                    "project": row.project,
                    "externalId": row.externalId,
                    "filename": row.filename,
                    "attempts": attempt,
                    "errorCode": code,
                    "errorMessage": message,
                },
            )
        # Terminal: the audio will never be used again. ADR-0002 says this
        # service does not persist audio, so delete it now rather than leaving
        # it for the sweeper's retention window.
        _remove_source(row.sourcePath)
        await _emit_failed(
            store=store, pool=pool, settings=settings, row=row,
            code=code, message=message, attempts=attempt,
        )
        return {"transcribeId": transcribe_id, "status": terminal, "error": code}

    finally:
        pipeline.cleanup_scratch(scratch_dir)
        # Covers every exit — success, terminal failure, and the `Retry` path
        # (a retrying job is queued, not running, so it must not look in-flight
        # to the reconciler while it waits out its backoff).
        await store.clear_in_flight(transcribe_id)

    # ── Success ─────────────────────────────────────────────────────────────
    duration_ms = int((time.monotonic() - started_wall) * 1000)
    transcript_payload = {
        "text": result.text,
        "segments": result.segments,
        "language": result.language,
        "languageProbability": result.language_probability,
        "durationSeconds": result.duration_seconds,
        "segmentCount": len(result.segments),
        "chunkCount": result.chunk_count,
        "model": transcriber.describe(),
        "audio": result.audio,
    }
    await store.put_transcript(transcribe_id, transcript_payload)
    await store.update_job(
        transcribe_id,
        status=STATUS_COMPLETED,
        attempts=attempt,
        durationSeconds=result.duration_seconds,
        chunksTotal=result.chunk_count,
        chunksDone=result.chunk_count,
        completedAt=now_iso(),
    )
    # A failed earlier attempt left an errorCode on the row. `update_job` can
    # set a field but never unset one, so without this the status endpoint
    # returns a `completed` job still carrying an `error` block.
    await store.clear_job_fields(transcribe_id, "errorCode", "errorMessage")
    # The audio has served its purpose. ADR-0002: audio-service does not persist
    # audio. Delete it now rather than waiting for the sweeper.
    _remove_source(row.sourcePath)

    await _emit_completed(
        store=store,
        pool=pool,
        settings=settings,
        row=row,
        result=result,
        transcriber=transcriber,
        duration_ms=duration_ms,
    )
    return {
        "transcribeId": transcribe_id,
        "status": STATUS_COMPLETED,
        "characters": len(result.text),
        "chunks": result.chunk_count,
    }


async def deliver_callback(ctx: Dict[str, Any], delivery_id: str, attempt: int) -> str:
    """One HTTP delivery attempt. Never raises — the retry loop is explicit."""
    try:
        return await attempt_delivery(
            delivery_id,
            attempt,
            store=ctx["store"],
            pool=ctx["pool"],
            settings=ctx["settings"],
            client=ctx.get("http"),
        )
    except Exception as exc:  # pragma: no cover - belt and braces
        log.exception("callback delivery %s attempt %d crashed: %s", delivery_id, attempt, exc)
        return "error"


# ---------------------------------------------------------------------------
# Emission helpers
# ---------------------------------------------------------------------------

def _backoff_for(settings: Settings, attempt: int) -> int:
    schedule = settings.JOB_RETRY_BACKOFF_SECONDS or [30]
    return int(schedule[min(attempt - 1, len(schedule) - 1)])


def _remove_source(path: Optional[str]) -> None:
    if not path:
        return
    try:
        os.unlink(path)
    except OSError:
        pass


async def _report_progress(
    *, store: JobStore, pool: ArqRedis, settings: Settings,
    row: JobRow, done: int, total: int,
) -> None:
    await store.update_job(row.transcribeId, chunksDone=done, chunksTotal=total)
    if total <= 1 or not row.callbackUrl:
        return
    # Throttle: at most one progress callback per
    # CALLBACK_PROGRESS_MIN_INTERVAL_SECONDS, mirroring ai-service's
    # `ingest.progress` throttle. The final chunk never emits progress — the
    # `transcribe.completed` event follows immediately.
    if done >= total:
        return
    now = time.time()
    last = row.lastProgressAt or 0.0
    if now - last < settings.CALLBACK_PROGRESS_MIN_INTERVAL_SECONDS:
        return
    row.lastProgressAt = now
    await store.update_job(row.transcribeId, lastProgressAt=now)
    await enqueue_callback(
        envelope=progress_envelope(
            transcribe_id=row.transcribeId,
            org=row.org,
            project=row.project,
            emitted_at=now_iso(now),
            external_id=row.externalId,
            chunks_done=done,
            chunks_total=total,
        ),
        url=row.callbackUrl,
        api_key_id=row.apiKeyId,
        org=row.org,
        project=row.project,
        source_id=row.transcribeId,
        store=store,
        pool=pool,
        settings=settings,
    )


async def _emit_completed(
    *, store: JobStore, pool: ArqRedis, settings: Settings, row: JobRow,
    result: pipeline.TranscriptionResult, transcriber: Transcriber, duration_ms: int,
) -> None:
    if not row.callbackUrl:
        return
    await enqueue_callback(
        envelope=completed_envelope(
            transcribe_id=row.transcribeId,
            org=row.org,
            project=row.project,
            emitted_at=now_iso(),
            external_id=row.externalId,
            title=row.title,
            audio={
                "filename": row.filename,
                "contentType": row.contentType,
                "bytes": row.bytes,
                "chunks": result.chunk_count,
                **result.audio,
            },
            transcript_text=result.text,
            transcript_meta={
                "language": result.language,
                "languageProbability": round(result.language_probability, 4),
                "segmentCount": len(result.segments),
                "durationSeconds": result.duration_seconds,
            },
            model=transcriber.describe(),
            duration_ms=duration_ms,
            metadata=row.metadata,
            max_transcript_chars=settings.CALLBACK_MAX_TRANSCRIPT_CHARS,
        ),
        url=row.callbackUrl,
        api_key_id=row.apiKeyId,
        org=row.org,
        project=row.project,
        source_id=row.transcribeId,
        store=store,
        pool=pool,
        settings=settings,
    )


async def _emit_failed(
    *, store: JobStore, pool: ArqRedis, settings: Settings, row: JobRow,
    code: str, message: str, attempts: int,
) -> None:
    if not row.callbackUrl:
        return
    await enqueue_callback(
        envelope=failed_envelope(
            transcribe_id=row.transcribeId,
            org=row.org,
            project=row.project,
            emitted_at=now_iso(),
            external_id=row.externalId,
            title=row.title,
            error_code=code,
            error_message=message,
            attempts=attempts,
            metadata=row.metadata,
        ),
        url=row.callbackUrl,
        api_key_id=row.apiKeyId,
        org=row.org,
        project=row.project,
        source_id=row.transcribeId,
        store=store,
        pool=pool,
        settings=settings,
    )


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------

async def _heartbeat_loop(ctx: Dict[str, Any]) -> None:
    """Publish "a worker with a loaded model is alive" for the API's /ready.

    A plain asyncio task rather than an arq cron job: fewer moving parts, and it
    keeps ticking even while a 4-hour transcription is running (the decode
    itself lives in a thread, so the loop stays responsive).
    """
    settings: Settings = ctx["settings"]
    store: JobStore = ctx["store"]
    transcriber: Transcriber = ctx["transcriber"]
    # TTL is 3x the interval so one slow tick does not flap readiness.
    ttl = max(5, settings.WORKER_HEARTBEAT_SECONDS * 3)
    while True:
        try:
            await store.set_worker_heartbeat(
                ttl,
                {
                    "at": now_iso(),
                    "modelLoaded": transcriber.loaded,
                    "model": transcriber.describe(),
                },
            )
        except Exception as exc:  # pragma: no cover
            log.warning("heartbeat write failed: %s", exc)
        await asyncio.sleep(settings.WORKER_HEARTBEAT_SECONDS)


async def _sweeper_loop(ctx: Dict[str, Any]) -> None:
    """Delete orphaned scratch/upload files a SIGKILL left behind.

    🔴 It must NOT delete the source audio of a job that is merely waiting.
    With one worker, a job timeout measured in hours and retry backoff on top,
    a QUEUED upload routinely outlives `AUDIO_RETENTION_SECONDS`. Deleting it
    would fail that job with `source_missing`, which is non-retryable — so a
    backlog would silently destroy the work it was queuing. `is_protected`
    below asks the store whether a live job still owns the file.
    """
    settings: Settings = ctx["settings"]
    store: JobStore = ctx["store"]
    interval = max(60, settings.AUDIO_RETENTION_SECONDS // 6)

    async def is_protected(name: str) -> bool:
        # Uploads are named `{transcribeId}{ext}`; scratch dirs are named
        # `{transcribeId}`. Both yield the id by stripping any extension.
        transcribe_id = os.path.splitext(name)[0]
        if not transcribe_id:
            return False
        try:
            return await store.has_live_job(transcribe_id)
        except Exception:  # pragma: no cover - Redis blip: fail SAFE, keep it
            return True

    while True:
        await asyncio.sleep(interval)
        try:
            removed = 0
            for root in (settings.upload_dir, settings.scratch_dir):
                removed += await pipeline.sweep_stale_files_async(
                    root, settings.AUDIO_RETENTION_SECONDS, is_protected=is_protected
                )
            if removed:
                log.info("swept %d stale audio artefact(s)", removed)
        except Exception as exc:  # pragma: no cover
            log.warning("sweeper failed: %s", exc)


async def _reconcile_loop(ctx: Dict[str, Any]) -> None:
    """Turn abandoned `processing` rows into real terminal failures.

    The gap this closes: arq enforces `job_timeout` by CANCELLING the task, and
    `asyncio.CancelledError` is a `BaseException` — no `except Exception` in
    `transcribe_job` can catch it. A SIGKILL has no handler at all. In both
    cases the row would sit at `processing` until its TTL, no dead-letter entry
    would exist, and no `transcribe.failed` callback would be sent — so a
    consumer that (correctly) relies on callbacks instead of polling would wait
    forever.

    Given `JOB_TIMEOUT_SECONDS` is 4h by default and CPU transcription runs at
    roughly real time, timing out is a likely path, not a corner case.

    Liveness is measured by `updatedAt`, which this same loop refreshes for
    every job THIS worker is running. So a row goes stale only when the process
    holding it has stopped touching it.
    """
    settings: Settings = ctx["settings"]
    store: JobStore = ctx["store"]
    pool: ArqRedis = ctx["pool"]
    inflight: set[str] = ctx["_inflight"]
    stale_after = settings.JOB_TIMEOUT_SECONDS + settings.STALE_JOB_GRACE_SECONDS

    while True:
        await asyncio.sleep(settings.WORKER_HEARTBEAT_SECONDS)
        try:
            # 1. Prove our own jobs are alive.
            for transcribe_id in list(inflight):
                await store.update_job(transcribe_id)

            # 2. Fail anyone else's abandoned ones.
            for transcribe_id in await store.list_in_flight():
                if transcribe_id in inflight:
                    continue
                row = await store.get_job(transcribe_id)
                if row is None:
                    await store.clear_in_flight(transcribe_id)
                    continue
                if row.status in TERMINAL_JOB_STATUSES:
                    await store.clear_in_flight(transcribe_id)
                    continue
                if _age_seconds(row.updatedAt) < stale_after:
                    continue

                log.error(
                    "transcribe %s abandoned (no progress for %ds) -> dead_letter",
                    transcribe_id, stale_after,
                )
                message = (
                    f"The job was abandoned: no worker touched it for {stale_after}s. "
                    f"It most likely exceeded JOB_TIMEOUT_SECONDS "
                    f"({settings.JOB_TIMEOUT_SECONDS}s) or its worker was killed."
                )
                await store.update_job(
                    transcribe_id,
                    status=STATUS_DEAD_LETTER,
                    errorCode="abandoned",
                    errorMessage=message,
                    completedAt=now_iso(),
                )
                await store.dead_letter(
                    DLQ_TRANSCRIBE,
                    {
                        "transcribeId": transcribe_id,
                        "org": row.org,
                        "project": row.project,
                        "externalId": row.externalId,
                        "filename": row.filename,
                        "attempts": row.attempts,
                        "errorCode": "abandoned",
                        "errorMessage": message,
                    },
                )
                _remove_source(row.sourcePath)
                await _emit_failed(
                    store=store, pool=pool, settings=settings, row=row,
                    code="abandoned", message=message, attempts=row.attempts,
                )
                await store.clear_in_flight(transcribe_id)
        except Exception as exc:  # pragma: no cover
            log.warning("reconciler failed: %s", exc)


def _age_seconds(iso_timestamp: Optional[str]) -> float:
    """Seconds since an ISO-8601 stamp. Unparseable ⇒ 0 (treat as fresh).

    Failing SAFE matters here: a parse bug must not mass-fail live jobs.
    """
    if not iso_timestamp:
        return 0.0
    import datetime as _dt

    try:
        moment = _dt.datetime.fromisoformat(iso_timestamp.replace("Z", "+00:00"))
    except ValueError:
        return 0.0
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=_dt.timezone.utc)
    return max(0.0, (_dt.datetime.now(_dt.timezone.utc) - moment).total_seconds())


async def _base_startup(ctx: Dict[str, Any]) -> Settings:
    """Shared by both worker roles: config, Redis, store, pool, HTTP client.

    Deliberately does NOT load the model — the callback worker must not, and
    the transcription worker does it separately in `startup`.
    """
    import httpx

    settings = get_settings()
    logging.basicConfig(level=settings.LOG_LEVEL)
    for warning in validate_callback_secrets(settings):
        log.warning(
            "API_KEYS entry %s has no callbackSecret; its callbacks cannot be signed",
            warning,
        )

    os.makedirs(settings.upload_dir, exist_ok=True)
    os.makedirs(settings.scratch_dir, exist_ok=True)

    redis = Redis.from_url(settings.REDIS_URL, decode_responses=True)
    ctx["settings"] = settings
    ctx["redis_client"] = redis
    ctx["store"] = JobStore(
        redis,
        job_ttl=settings.JOB_TTL_SECONDS,
        transcript_ttl=settings.TRANSCRIPT_TTL_SECONDS,
        idempotency_ttl=settings.IDEMPOTENCY_TTL_SECONDS,
        callback_ttl=settings.CALLBACK_TTL_SECONDS,
    )
    ctx["pool"] = await create_queue_pool(settings)
    ctx["http"] = httpx.AsyncClient(timeout=settings.CALLBACK_TIMEOUT_SECONDS)
    ctx["_tasks"] = []
    ctx["_inflight"] = set()
    return settings


async def startup(ctx: Dict[str, Any]) -> None:
    """Transcription worker. Holds the model; the only heavy process."""
    settings = await _base_startup(ctx)

    transcriber = Transcriber(settings)
    ctx["transcriber"] = transcriber
    # Load off the event loop: it is several seconds of CPU-bound work and
    # blocking here would stall arq's own startup handshake.
    await asyncio.to_thread(transcriber.load)
    await _warmup(settings, transcriber)

    ctx["_tasks"] = [
        asyncio.create_task(_heartbeat_loop(ctx)),
        asyncio.create_task(_sweeper_loop(ctx)),
        asyncio.create_task(_reconcile_loop(ctx)),
    ]
    log.info("audio-service transcription worker ready (queue=%s)", settings.QUEUE_NAME)


async def callback_startup(ctx: Dict[str, Any]) -> None:
    """Callback worker. Pure I/O — never loads the model, starts in seconds."""
    settings = await _base_startup(ctx)
    log.info(
        "audio-service callback worker ready (queue=%s)", settings.CALLBACK_QUEUE_NAME
    )


async def _warmup(settings: Settings, transcriber: Transcriber) -> None:
    """Decode half a second of generated tone so the first real job is honest.

    Generated with ffmpeg's `sine` source rather than shipped as a fixture: it
    keeps the image free of binary blobs and proves ffmpeg works at boot too.
    """
    path = os.path.join(settings.scratch_dir, "_warmup.wav")
    try:
        process = await asyncio.create_subprocess_exec(
            settings.FFMPEG_BIN, "-nostdin", "-hide_banner", "-loglevel", "error",
            "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.5",
            "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", path,
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            await asyncio.wait_for(process.wait(), timeout=30)
        except asyncio.TimeoutError:
            # `wait_for` cancels the WAIT, not the child. Without this kill the
            # ffmpeg process outlives the worker's startup — the same bug
            # `audio/ffmpeg.py::_run` already guards against.
            process.kill()
            await asyncio.gather(process.wait(), return_exceptions=True)
            raise
        if process.returncode == 0:
            await asyncio.to_thread(transcriber.warmup, path)
    except Exception as exc:  # pragma: no cover - best effort
        log.warning("warmup skipped: %s", exc)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


async def shutdown(ctx: Dict[str, Any]) -> None:
    for task in ctx.get("_tasks", []):
        task.cancel()
    tasks = ctx.get("_tasks", [])
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
    http = ctx.get("http")
    if http is not None:
        await http.aclose()
    pool = ctx.get("pool")
    if pool is not None:
        from .queue import close_pool

        await close_pool(pool)
    redis = ctx.get("redis_client")
    if redis is not None:
        closer = getattr(redis, "aclose", None) or getattr(redis, "close", None)
        if closer is not None:
            await closer()
    log.info("audio-service worker stopped")


class WorkerSettings:
    """Transcription worker: ``arq app.worker.WorkerSettings``.

    ⚠ `functions` deliberately does NOT include `deliver_callback`. This queue
    runs one job at a time with a job timeout measured in hours; a delivery
    sharing it would wait behind a running decode. Deliveries belong to
    `CallbackWorkerSettings` below.
    """

    functions = [transcribe_job]
    on_startup = startup
    on_shutdown = shutdown

    _settings = get_settings()
    queue_name = _settings.QUEUE_NAME
    # `build_redis_settings` is aliased on import precisely so this assignment
    # does not shadow the helper it calls.
    redis_settings: RedisSettings = build_redis_settings(_settings)
    max_jobs = _settings.MAX_CONCURRENT_JOBS
    job_timeout = _settings.JOB_TIMEOUT_SECONDS
    # Our own retry bookkeeping stops one short of this; arq's counter is only a
    # backstop for a crash that bypasses the handler entirely.
    max_tries = _settings.JOB_MAX_TRIES + 1
    keep_result = 3600
    health_check_interval = 30


class CallbackWorkerSettings:
    """Callback worker: ``arq app.worker.CallbackWorkerSettings``.

    Same image, different command. Never loads the model, so it starts in
    seconds and can be restarted freely. Wide (`max_jobs`) because a delivery is
    a single bounded HTTP POST.

    Running it is NOT optional: without this process, callbacks are enqueued and
    never delivered, and the consumer never learns a transcription finished.
    """

    functions = [deliver_callback]
    on_startup = callback_startup
    on_shutdown = shutdown

    _settings = get_settings()
    queue_name = _settings.CALLBACK_QUEUE_NAME
    redis_settings: RedisSettings = build_redis_settings(_settings)
    max_jobs = _settings.CALLBACK_WORKER_MAX_JOBS
    # One POST plus a little slack. Nothing here should ever take minutes.
    job_timeout = int(_settings.CALLBACK_TIMEOUT_SECONDS) + 30
    # `deliver_callback` never raises — it owns its own retry chain — so arq's
    # counter is only a backstop for a hard crash.
    max_tries = 2
    keep_result = 300
    health_check_interval = 30
