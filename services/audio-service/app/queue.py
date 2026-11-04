"""arq queue plumbing.

## Why arq and not BullMQ

ai-service uses BullMQ, and mirroring its conventions is the standing rule for
this service. BullMQ is Node-only, though, and this service is Python (see
`README.md` §"Why Python"). arq is the closest analogue in the Python ecosystem:
Redis-backed, asyncio-native (so it composes with FastAPI and httpx rather than
fighting them), with per-job retry counts, deferred re-enqueue, job timeouts and
deterministic job ids.

What arq does NOT give us out of the box is a dead-letter queue. That is
implemented explicitly in `worker.py`: on the final failed attempt the job is
pushed onto a bounded Redis list (`audio:dlq:transcribe` /
`audio:dlq:callback`) with its error, and the job row moves to `dead_letter`.
`GET /v1/admin/dead-letters` reads them back. The retry policy itself
(`RETRY_SCHEDULE_SECONDS`, and the 4xx/5xx/network branch table) is the same as
ai-service, so the two services fail identically from a consumer's
point of view.

Job ids are deterministic — `transcribe:{transcribeId}` — which gives us BullMQ's
`jobId` de-duplication semantics: enqueuing the same transcription twice is a
no-op while the first is in flight.
"""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any, Optional

from arq import create_pool
from arq.connections import ArqRedis, RedisSettings

from .config import Settings

log = logging.getLogger("audio-service.queue")

TRANSCRIBE_TASK = "transcribe_job"
CALLBACK_TASK = "deliver_callback"


def redis_settings(settings: Settings) -> RedisSettings:
    return RedisSettings.from_dsn(settings.REDIS_URL)


async def create_queue_pool(settings: Settings) -> ArqRedis:
    return await create_pool(
        redis_settings(settings),
        default_queue_name=settings.QUEUE_NAME,
    )


def transcribe_job_id(transcribe_id: str) -> str:
    return f"transcribe:{transcribe_id}"


def callback_job_id(delivery_id: str, attempt: int, nonce: str = "") -> str:
    """Deterministic per-attempt id, with an optional nonce for replays.

    The attempt number is in the id so a scheduled retry is never deduped
    against the attempt that scheduled it. The nonce exists because an admin
    replay restarts the chain at attempt 1: without it, the replay's attempt-2
    job would collide with the ORIGINAL run's attempt-2 id, arq would dedupe it
    away, and the replay would silently die after one attempt.
    """
    suffix = f":{nonce}" if nonce else ""
    return f"callback:{delivery_id}:{attempt}{suffix}"


async def enqueue_transcribe(pool: ArqRedis, transcribe_id: str) -> bool:
    """Enqueue a transcription. Returns False if it was already queued.

    arq returns `None` from `enqueue_job` when a job with the same `_job_id` is
    already present — the same de-duplication BullMQ gives us via `jobId`.
    """
    job = await pool.enqueue_job(
        TRANSCRIBE_TASK,
        transcribe_id,
        _job_id=transcribe_job_id(transcribe_id),
    )
    if job is None:
        log.info("transcribe job already queued transcribeId=%s", transcribe_id)
        return False
    return True


async def enqueue_callback_delivery(
    pool: ArqRedis,
    delivery_id: str,
    attempt: int,
    *,
    defer_seconds: float = 0.0,
    nonce: str = "",
    queue_name: Optional[str] = None,
) -> None:
    """Enqueue (or re-enqueue) one callback delivery attempt.

    ⚠ `queue_name` is not optional in practice — deliveries MUST land on the
    callback queue, not the transcription queue. See `Settings.CALLBACK_QUEUE_NAME`
    for why (head-of-line blocking behind a multi-hour decode).
    """
    kwargs: dict[str, Any] = {"_job_id": callback_job_id(delivery_id, attempt, nonce)}
    if defer_seconds > 0:
        kwargs["_defer_by"] = timedelta(seconds=defer_seconds)
    if queue_name:
        kwargs["_queue_name"] = queue_name
    await pool.enqueue_job(CALLBACK_TASK, delivery_id, attempt, **kwargs)


async def close_pool(pool: Optional[ArqRedis]) -> None:
    """Close the pool across redis-py versions.

    `aclose()` landed in redis-py 5.0.1 and `close()` is deprecated there but is
    the only option on 4.x. arq's pin spans both, so try the new name first.
    """
    if pool is None:
        return
    closer = getattr(pool, "aclose", None) or getattr(pool, "close", None)
    if closer is None:  # pragma: no cover - defensive
        return
    await closer()
