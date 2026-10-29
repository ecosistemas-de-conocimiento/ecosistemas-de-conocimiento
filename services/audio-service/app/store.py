"""Redis-backed job + callback-delivery store.

Why Redis and not Postgres: ADR-0002 §A says audio-service does not persist
audio and does not own transcripts — it hands them to the consumer. So every
row here is transient job state with a TTL. Redis gives us that with no
migration story, no second stateful volume, and no schema to coordinate with the
four other services in this monorepo.

The consequence, stated plainly so nobody is surprised by it: **the signed
callback is the durable handoff, and `GET /v1/transcribe/:id` is a convenience
that stops answering after `JOB_TTL_SECONDS`.** If a job's callback dead-letters
AND the TTL expires, that transcript is gone and the audio must be re-uploaded.
That is an acceptable v1 trade because the consumer (`apps/backend`) persists
the transcript as a Document the moment it receives it.

Key layout (all prefixed `audio:`):
    audio:job:{id}            hash    status row
    audio:transcript:{id}     string  JSON transcript payload
    audio:idem:{org}:{project}:{key}  string  -> transcribe id
    audio:dlq:transcribe      list    dead-lettered transcription jobs
    audio:dlq:callback        list    dead-lettered callback deliveries
    audio:callback:{id}       hash    one delivery attempt row
    audio:worker:ready        string  worker heartbeat, TTL-refreshed
"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional

from redis.asyncio import Redis

JOB_PREFIX = "audio:job:"
TRANSCRIPT_PREFIX = "audio:transcript:"
IDEM_PREFIX = "audio:idem:"
CALLBACK_PREFIX = "audio:callback:"
DLQ_TRANSCRIBE = "audio:dlq:transcribe"
DLQ_CALLBACK = "audio:dlq:callback"
WORKER_HEARTBEAT_KEY = "audio:worker:ready"
INFLIGHT_SET = "audio:inflight"

#: Bounded so a pathological failure loop cannot fill Redis.
DLQ_MAX_ENTRIES = 1000

STATUS_QUEUED = "queued"
STATUS_PROCESSING = "processing"
STATUS_COMPLETED = "completed"
STATUS_FAILED = "failed"
STATUS_DEAD_LETTER = "dead_letter"

TERMINAL_JOB_STATUSES = {STATUS_COMPLETED, STATUS_FAILED, STATUS_DEAD_LETTER}


def new_transcribe_id() -> str:
    return str(uuid.uuid4())


def now_iso(ts: Optional[float] = None) -> str:
    """ISO-8601 UTC with a trailing Z — the same shape ai-service emits."""
    import datetime as _dt

    moment = _dt.datetime.fromtimestamp(
        ts if ts is not None else time.time(), tz=_dt.timezone.utc
    )
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _encode(value: Any) -> str:
    """Redis hashes are flat string maps; nested values are JSON."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def _decode_mapping(raw: Mapping[Any, Any]) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for key, value in raw.items():
        k = key.decode("utf-8") if isinstance(key, (bytes, bytearray)) else str(key)
        v = value.decode("utf-8") if isinstance(value, (bytes, bytearray)) else str(value)
        out[k] = v
    return out


@dataclass
class JobRow:
    """A transcription job's status row. Field names are the wire names."""

    transcribeId: str
    org: str
    project: str
    apiKeyId: str
    status: str
    createdAt: str
    updatedAt: str
    filename: Optional[str] = None
    contentType: Optional[str] = None
    bytes: int = 0
    language: Optional[str] = None
    callbackUrl: Optional[str] = None
    externalId: Optional[str] = None
    title: Optional[str] = None
    idempotencyKey: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None
    sourcePath: Optional[str] = None
    durationSeconds: Optional[float] = None
    chunksTotal: int = 0
    chunksDone: int = 0
    attempts: int = 0
    startedAt: Optional[str] = None
    completedAt: Optional[str] = None
    errorCode: Optional[str] = None
    errorMessage: Optional[str] = None
    lastProgressAt: Optional[float] = None

    @classmethod
    def from_redis(cls, raw: Mapping[Any, Any]) -> "JobRow":
        data = _decode_mapping(raw)

        def opt(key: str) -> Optional[str]:
            value = data.get(key)
            return value if value else None

        def num(key: str, default: float = 0.0) -> float:
            value = data.get(key)
            try:
                return float(value) if value else default
            except ValueError:
                return default

        metadata_raw = data.get("metadata")
        metadata: Optional[Dict[str, Any]] = None
        if metadata_raw:
            try:
                parsed = json.loads(metadata_raw)
                metadata = parsed if isinstance(parsed, dict) else None
            except json.JSONDecodeError:
                metadata = None

        return cls(
            transcribeId=data.get("transcribeId", ""),
            org=data.get("org", ""),
            project=data.get("project", ""),
            apiKeyId=data.get("apiKeyId", ""),
            status=data.get("status", STATUS_QUEUED),
            createdAt=data.get("createdAt", ""),
            updatedAt=data.get("updatedAt", ""),
            filename=opt("filename"),
            contentType=opt("contentType"),
            bytes=int(num("bytes")),
            language=opt("language"),
            callbackUrl=opt("callbackUrl"),
            externalId=opt("externalId"),
            title=opt("title"),
            idempotencyKey=opt("idempotencyKey"),
            metadata=metadata,
            sourcePath=opt("sourcePath"),
            durationSeconds=num("durationSeconds") if data.get("durationSeconds") else None,
            chunksTotal=int(num("chunksTotal")),
            chunksDone=int(num("chunksDone")),
            attempts=int(num("attempts")),
            startedAt=opt("startedAt"),
            completedAt=opt("completedAt"),
            errorCode=opt("errorCode"),
            errorMessage=opt("errorMessage"),
            lastProgressAt=num("lastProgressAt") if data.get("lastProgressAt") else None,
        )

    def to_redis(self) -> Dict[str, str]:
        out: Dict[str, str] = {}
        for key, value in self.__dict__.items():
            if value is None:
                continue
            out[key] = _encode(value)
        return out


class JobStore:
    """All Redis access lives here so nothing else in the service knows keys."""

    def __init__(self, redis: Redis, *, job_ttl: int, transcript_ttl: int,
                 idempotency_ttl: int, callback_ttl: int) -> None:
        self.redis = redis
        self.job_ttl = job_ttl
        self.transcript_ttl = transcript_ttl
        self.idempotency_ttl = idempotency_ttl
        self.callback_ttl = callback_ttl

    # ── Jobs ────────────────────────────────────────────────────────────────
    async def create_job(self, row: JobRow) -> None:
        key = JOB_PREFIX + row.transcribeId
        pipe = self.redis.pipeline()
        pipe.hset(key, mapping=row.to_redis())
        pipe.expire(key, self.job_ttl)
        await pipe.execute()

    async def get_job(self, transcribe_id: str) -> Optional[JobRow]:
        raw = await self.redis.hgetall(JOB_PREFIX + transcribe_id)
        if not raw:
            return None
        return JobRow.from_redis(raw)

    async def update_job(self, transcribe_id: str, **fields: Any) -> None:
        """Partial update. Always refreshes `updatedAt` and the TTL.

        Refreshing the TTL on every write means a long transcription cannot
        expire mid-flight just because it started 24h ago.
        """
        key = JOB_PREFIX + transcribe_id
        mapping = {k: _encode(v) for k, v in fields.items() if v is not None}
        mapping["updatedAt"] = now_iso()
        pipe = self.redis.pipeline()
        pipe.hset(key, mapping=mapping)
        pipe.expire(key, self.job_ttl)
        await pipe.execute()

    async def clear_job_fields(self, transcribe_id: str, *fields: str) -> None:
        """Delete hash fields outright.

        `update_job` drops `None` values (a Redis hash cannot hold one), so it
        can set a field but never unset it. Without this, an `errorCode` written
        by a failed attempt survives a later successful retry, and the status
        endpoint then returns a `completed` job carrying an `error` block.
        """
        if fields:
            await self.redis.hdel(JOB_PREFIX + transcribe_id, *fields)

    # ── In-flight registry ──────────────────────────────────────────────────
    # A job is registered here for as long as a worker is actively running it.
    # Two things depend on it:
    #   · the reconciler, which turns abandoned `processing` rows into real
    #     terminal failures (a `job_timeout` cancellation is an
    #     `asyncio.CancelledError` — a BaseException no `except Exception` can
    #     catch — and a SIGKILL has no handler at all);
    #   · the sweeper, which must NOT delete the source audio of a job that is
    #     merely queued or waiting out a retry backoff.
    async def mark_in_flight(self, transcribe_id: str) -> None:
        await self.redis.sadd(INFLIGHT_SET, transcribe_id)

    async def clear_in_flight(self, transcribe_id: str) -> None:
        await self.redis.srem(INFLIGHT_SET, transcribe_id)

    async def list_in_flight(self) -> List[str]:
        members = await self.redis.smembers(INFLIGHT_SET)
        return [
            m.decode("utf-8") if isinstance(m, (bytes, bytearray)) else str(m)
            for m in members
        ]

    async def has_live_job(self, transcribe_id: str) -> bool:
        """True when a job row exists and has not reached a terminal state.

        The sweeper asks this before deleting an upload. A queued job can easily
        outlive `AUDIO_RETENTION_SECONDS` on a backlog — one worker, a job
        timeout measured in hours, plus retry backoff — and deleting its source
        would fail it permanently with `source_missing`.
        """
        status = await self.redis.hget(JOB_PREFIX + transcribe_id, "status")
        if status is None:
            return False
        if isinstance(status, (bytes, bytearray)):
            status = status.decode("utf-8")
        return status not in TERMINAL_JOB_STATUSES

    # ── Transcripts ─────────────────────────────────────────────────────────
    async def put_transcript(self, transcribe_id: str, payload: Mapping[str, Any]) -> None:
        await self.redis.set(
            TRANSCRIPT_PREFIX + transcribe_id,
            json.dumps(payload, ensure_ascii=False),
            ex=self.transcript_ttl,
        )

    async def get_transcript(self, transcribe_id: str) -> Optional[Dict[str, Any]]:
        raw = await self.redis.get(TRANSCRIPT_PREFIX + transcribe_id)
        if raw is None:
            return None
        if isinstance(raw, (bytes, bytearray)):
            raw = raw.decode("utf-8")
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return None

    # ── Idempotency ─────────────────────────────────────────────────────────
    async def claim_idempotency_key(
        self, org: str, project: str, key: str, transcribe_id: str
    ) -> Optional[str]:
        """SET NX. Returns the EXISTING id if the key was already claimed.

        Scoped by `(org, project)` so two tenants cannot collide — and so one
        tenant cannot probe another's key space.
        """
        redis_key = f"{IDEM_PREFIX}{org}:{project}:{key}"
        claimed = await self.redis.set(
            redis_key, transcribe_id, nx=True, ex=self.idempotency_ttl
        )
        if claimed:
            return None
        existing = await self.redis.get(redis_key)
        if isinstance(existing, (bytes, bytearray)):
            existing = existing.decode("utf-8")
        return existing

    async def release_idempotency_key(self, org: str, project: str, key: str) -> None:
        """Undo a claim when the request is rejected AFTER claiming it."""
        await self.redis.delete(f"{IDEM_PREFIX}{org}:{project}:{key}")

    # ── Dead-letter ─────────────────────────────────────────────────────────
    async def dead_letter(self, queue: str, entry: Mapping[str, Any]) -> None:
        pipe = self.redis.pipeline()
        pipe.lpush(queue, json.dumps({**entry, "deadLetteredAt": now_iso()},
                                     ensure_ascii=False))
        pipe.ltrim(queue, 0, DLQ_MAX_ENTRIES - 1)
        await pipe.execute()

    async def list_dead_letters(self, queue: str, limit: int = 50) -> List[Dict[str, Any]]:
        raw_entries = await self.redis.lrange(queue, 0, max(0, limit - 1))
        out: List[Dict[str, Any]] = []
        for raw in raw_entries:
            if isinstance(raw, (bytes, bytearray)):
                raw = raw.decode("utf-8")
            try:
                out.append(json.loads(raw))
            except json.JSONDecodeError:
                continue
        return out

    async def dead_letter_depth(self, queue: str) -> int:
        return int(await self.redis.llen(queue))

    # ── Callback deliveries ─────────────────────────────────────────────────
    async def create_delivery(self, delivery_id: str, fields: Mapping[str, Any]) -> None:
        key = CALLBACK_PREFIX + delivery_id
        pipe = self.redis.pipeline()
        pipe.hset(key, mapping={k: _encode(v) for k, v in fields.items()})
        pipe.expire(key, self.callback_ttl)
        await pipe.execute()

    async def get_delivery(self, delivery_id: str) -> Optional[Dict[str, str]]:
        raw = await self.redis.hgetall(CALLBACK_PREFIX + delivery_id)
        if not raw:
            return None
        return _decode_mapping(raw)

    async def update_delivery(self, delivery_id: str, **fields: Any) -> None:
        key = CALLBACK_PREFIX + delivery_id
        pipe = self.redis.pipeline()
        pipe.hset(key, mapping={k: _encode(v) for k, v in fields.items()})
        pipe.expire(key, self.callback_ttl)
        await pipe.execute()

    async def expire_after_delivery(self, delivery_id: str, source_id: str, ttl: int) -> None:
        """Shorten a delivered callback's row and its job's transcript to `ttl`.

        `lt=True`: only ever SHORTENS. A key already closer to expiry keeps its
        TTL, and a missing key (no transcript yet, e.g. a progress event) is a
        no-op rather than a key created with no value.
        """
        pipe = self.redis.pipeline()
        pipe.expire(CALLBACK_PREFIX + delivery_id, ttl, lt=True)
        if source_id:
            pipe.expire(TRANSCRIPT_PREFIX + source_id, ttl, lt=True)
        await pipe.execute()

    # ── Worker heartbeat ────────────────────────────────────────────────────
    async def set_worker_heartbeat(self, ttl_seconds: int, payload: Mapping[str, Any]) -> None:
        await self.redis.set(
            WORKER_HEARTBEAT_KEY,
            json.dumps(payload, ensure_ascii=False),
            ex=ttl_seconds,
        )

    async def get_worker_heartbeat(self) -> Optional[Dict[str, Any]]:
        raw = await self.redis.get(WORKER_HEARTBEAT_KEY)
        if raw is None:
            return None
        if isinstance(raw, (bytes, bytearray)):
            raw = raw.decode("utf-8")
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return None

    async def ping(self) -> bool:
        return bool(await self.redis.ping())
