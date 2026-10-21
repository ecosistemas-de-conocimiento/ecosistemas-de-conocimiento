"""Environment configuration — Zod-equivalent, validated once at import.

Mirrors `services/ai-service/src/config/env.ts`: every knob is an env var, the
whole surface is validated at boot, and an invalid value aborts the process
BEFORE the HTTP listener binds (or before the worker claims a job). Defaults
shown here are the code's own defaults; `.env.example` documents each one.

The two knobs that matter most for the "same image on CPU locally, GPU on the
fleet" promise are `WHISPER_DEVICE` and `WHISPER_COMPUTE_TYPE`. Nothing else in
this service reads `device`; the transcriber passes both straight through to
CTranslate2. Flipping them is the ENTIRE GPU migration.
"""

from __future__ import annotations

import json
import os
from functools import lru_cache
from typing import Dict, List, Literal, Optional

from pydantic import BaseModel, Field, ValidationError, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class ApiKeyEntry(BaseModel):
    """One entry of the `API_KEYS` JSON map.

    Byte-compatible with ai-service's `apiKeyEntry` zod schema so a deployment
    can literally reuse the same JSON blob (with a different key) for both
    services. `role` exists for parity; audio-service has no admin-only routes
    in v1 beyond the callback dead-letter listing.
    """

    org: str = Field(min_length=1)
    project: str = Field(min_length=1)
    role: Literal["app", "admin"] = "app"
    # 32-char floor, matching ai-service. Without it we can record but not SIGN
    # callbacks, and the consumer's verifier will (correctly) reject them.
    callbackSecret: Optional[str] = Field(default=None, min_length=32)
    previousCallbackSecrets: Optional[List[str]] = None


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", ".env.local"),
        env_file_encoding="utf-8",
        extra="ignore",
        # `WHISPER_MODEL` etc. are read verbatim — no prefix, no aliasing.
        case_sensitive=True,
    )

    # ── Runtime ──────────────────────────────────────────────────────────────
    NODE_ENV: Literal["development", "test", "production"] = "development"
    HOST: str = "0.0.0.0"
    # 8080 matches `plan/deploy-and-local-demo.md` and the image default.
    PORT: int = 8080
    LOG_LEVEL: str = "INFO"

    # ── Datastore ────────────────────────────────────────────────────────────
    # Redis is the ONLY datastore. Deliberate: per ADR-0002 §A audio-service
    # does not persist audio, and transcripts are handed to the consumer rather
    # than owned here. Everything this service stores is transient job state
    # with a TTL, which is exactly what Redis is for — and it spares us a
    # Postgres dependency, a migration story, and a second stateful volume.
    REDIS_URL: str = "redis://localhost:6379"

    # ── Auth ─────────────────────────────────────────────────────────────────
    # JSON map of apiKey -> {org, project, role?, callbackSecret?, ...}.
    # Same shape and same semantics as ai-service's API_KEYS.
    API_KEYS: str = "{}"

    # ── Whisper backend ──────────────────────────────────────────────────────
    # "local"  : faster-whisper in THIS process (everything under "Whisper /
    #            CTranslate2" below applies).
    # "remote" : POST each chunk to a whisper.cpp `whisper-server` elsewhere
    #            (the DGX Spark). Queue, chunking, Redis and callbacks stay here;
    #            only the model call moves. faster-whisper is never imported.
    WHISPER_BACKEND: Literal["local", "remote"] = "local"
    # Base URL of whisper-server, e.g. <spark-url>. We POST to
    # `{WHISPER_REMOTE_URL}/inference` and probe `{WHISPER_REMOTE_URL}/health`.
    WHISPER_REMOTE_URL: str = ""
    # Per-chunk read timeout. Generous on purpose: a chunk is up to
    # CHUNK_MAX_SECONDS (15 min) of audio, and whisper-server holds ONE mutex
    # around inference, so our request may queue behind another caller's.
    WHISPER_REMOTE_TIMEOUT_S: float = 1800.0
    # Sent as `Authorization: Bearer …` when set. whisper-server ignores it
    # today; it exists for a future auth proxy in front of the Spark.
    WHISPER_REMOTE_TOKEN: str = ""
    # Label only — reported in describe()/callbacks. The real model is whatever
    # whisper-server was started with; we cannot ask it.
    WHISPER_REMOTE_MODEL: str = "large-v3"

    # ── Whisper / CTranslate2 (WHISPER_BACKEND=local only) ───────────────────
    # Model id or local path. `large-v3-turbo` is the CPU-viable default (see
    # README §"Model choice"). Any faster-whisper shorthand ("small", "medium",
    # "large-v3", "large-v3-turbo") or an explicit HF repo id works.
    WHISPER_MODEL: str = "large-v3-turbo"
    # "cpu" | "cuda" | "auto". THE GPU switch. Nothing else changes.
    WHISPER_DEVICE: str = "cpu"
    # "int8" on CPU, "float16" on GPU. "int8_float16" is the GPU low-VRAM mode.
    WHISPER_COMPUTE_TYPE: str = "int8"
    # CTranslate2 intra-op threads. 0 -> CTranslate2 picks (all cores).
    WHISPER_CPU_THREADS: int = 0
    # Parallel model replicas inside ONE process. Each replica is a full copy of
    # the weights in RAM — leave at 1 and scale with worker containers instead.
    WHISPER_NUM_WORKERS: int = 1
    # Default transcription language. "es" for this product; set "" to
    # autodetect (slower, and mis-detects short Spanish clips as Portuguese
    # often enough to matter).
    WHISPER_LANGUAGE: str = "es"
    WHISPER_BEAM_SIZE: int = 5
    # Silero VAD trims non-speech before decode. Big win on real recordings:
    # fewer decoded windows AND far fewer hallucinated segments over silence.
    WHISPER_VAD_FILTER: bool = True
    WHISPER_VAD_MIN_SILENCE_MS: int = 500
    # Feeding the previous window's text back into the decoder is Whisper's
    # classic repetition-loop trigger on long recordings. Off by default.
    WHISPER_CONDITION_ON_PREVIOUS_TEXT: bool = False
    # Domain hint prepended to the decoder. Spanish by default so the model
    # commits to Spanish orthography (accents, ¿¡) from the first window.
    WHISPER_INITIAL_PROMPT: str = "Transcripción en español."
    # Where CTranslate2/HF cache the weights. Baked into the image at this path.
    WHISPER_DOWNLOAD_ROOT: str = "/opt/whisper-cache"

    # ── Audio handling ───────────────────────────────────────────────────────
    # Scratch space. MUST be writable and SHOULD be a container-local volume:
    # everything here is transient and is swept on a timer.
    AUDIO_WORK_DIR: str = "/var/lib/audio-service"
    # Hard cap on an upload. Enforced in THREE places, because the obvious one
    # is not sufficient on its own:
    #   1. An ASGI middleware ahead of routing rejects an oversized
    #      `Content-Length` before Starlette parses the multipart body. This is
    #      the one that matters: FastAPI parses the form BEFORE it resolves
    #      dependencies, so without it an UNAUTHENTICATED caller could spool
    #      gigabytes into the container's temp dir and only then receive a 401.
    #   2. The same middleware counts bytes when no `Content-Length` is sent
    #      (chunked transfer encoding).
    #   3. The route counts again while copying to `AUDIO_WORK_DIR`, as a
    #      belt-and-braces check against a lying header.
    # 512 MiB ≈ 9h of 128 kbps mp3.
    MAX_UPLOAD_BYTES: int = 512 * 1024 * 1024
    # Hard cap on decoded duration, enforced after ffprobe.
    MAX_DURATION_SECONDS: int = 6 * 60 * 60
    # Long-recording chunking. A chunk is cut at a real silence near the target
    # so no word is split across chunks; `MAX` is the hard ceiling when no
    # silence is found.
    CHUNK_TARGET_SECONDS: float = 600.0
    CHUNK_MAX_SECONDS: float = 900.0
    # How far either side of the target boundary we look for a silence.
    CHUNK_SILENCE_SEARCH_SECONDS: float = 60.0
    # ffmpeg `silencedetect` parameters.
    SILENCE_NOISE_DB: float = -32.0
    SILENCE_MIN_DURATION_SECONDS: float = 0.45
    # Wall-clock cap on any single ffmpeg/ffprobe invocation.
    FFMPEG_TIMEOUT_SECONDS: int = 1800
    FFMPEG_BIN: str = "ffmpeg"
    FFPROBE_BIN: str = "ffprobe"
    # Files older than this in AUDIO_WORK_DIR are deleted by the sweeper even if
    # no job owns them (crash-loop insurance).
    AUDIO_RETENTION_SECONDS: int = 6 * 60 * 60

    # ── Queue ────────────────────────────────────────────────────────────────
    QUEUE_NAME: str = "audio:transcribe"
    # 🔴 Callback deliveries live on their OWN queue, worked by their OWN
    # process. They must not share the transcription queue: that queue runs at
    # MAX_CONCURRENT_JOBS=1 with a job timeout measured in hours, so a delivery
    # enqueued behind a running transcription would wait for it to finish. That
    # would make `transcribe.progress` useless by construction (its whole point
    # is to report DURING a job) and would delay one job's completion callback
    # behind another job's decode.
    CALLBACK_QUEUE_NAME: str = "audio:callbacks"
    # Deliveries are pure I/O, so the callback worker can be wide and cheap. It
    # never loads the model.
    CALLBACK_WORKER_MAX_JOBS: int = 8
    # Jobs processed concurrently in ONE worker process. 1 is right on CPU:
    # a single transcription already saturates every core.
    MAX_CONCURRENT_JOBS: int = 1
    # Per-attempt wall clock. Must exceed the worst-case transcription of a
    # MAX_DURATION_SECONDS file on the slowest target.
    JOB_TIMEOUT_SECONDS: int = 4 * 60 * 60
    # Attempts before a job is dead-lettered. Matches ai-service's BullMQ
    # `attempts: 3` on the ingest queue.
    JOB_MAX_TRIES: int = 3
    # Backoff between transcription attempts, seconds, indexed by attempt.
    JOB_RETRY_BACKOFF_SECONDS: List[int] = [30, 120]
    WORKER_HEARTBEAT_SECONDS: int = 20
    # Grace added to JOB_TIMEOUT_SECONDS before the reconciler declares an
    # in-flight job abandoned. A job is abandoned when nothing has touched its
    # row for that long — which happens when arq's job_timeout cancels the task
    # (an `asyncio.CancelledError`, which no `except Exception` can catch) or
    # when the worker is SIGKILLed. Without the reconciler such a job sits at
    # `processing` until its TTL and the consumer is never told it died.
    STALE_JOB_GRACE_SECONDS: int = 600

    # ── Job store TTLs ───────────────────────────────────────────────────────
    # Status rows and transcripts expire. The CALLBACK is the durable handoff;
    # the GET endpoint is a convenience + a fallback, not a system of record.
    JOB_TTL_SECONDS: int = 24 * 60 * 60
    TRANSCRIPT_TTL_SECONDS: int = 24 * 60 * 60
    IDEMPOTENCY_TTL_SECONDS: int = 24 * 60 * 60

    # ── Callbacks ────────────────────────────────────────────────────────────
    CALLBACK_TIMEOUT_SECONDS: float = 20.0
    # Transcripts above this many characters are NOT inlined in the callback —
    # the envelope carries `transcript.truncated: true` and the consumer must
    # GET /v1/transcribe/:id for the full text. Keeps a 6h recording from
    # POSTing a multi-MB webhook body.
    CALLBACK_MAX_TRANSCRIPT_CHARS: int = 200_000
    # Minimum gap between `transcribe.progress` emissions on a chunked job.
    CALLBACK_PROGRESS_MIN_INTERVAL_SECONDS: float = 30.0
    CALLBACK_TTL_SECONDS: int = 7 * 24 * 60 * 60

    @field_validator("LOG_LEVEL")
    @classmethod
    def _upper(cls, v: str) -> str:
        return v.upper()

    @field_validator("WHISPER_DEVICE")
    @classmethod
    def _device(cls, v: str) -> str:
        v = v.strip().lower()
        if v not in {"cpu", "cuda", "auto"}:
            raise ValueError("WHISPER_DEVICE must be one of: cpu, cuda, auto")
        return v

    @field_validator("WHISPER_COMPUTE_TYPE")
    @classmethod
    def _compute(cls, v: str) -> str:
        v = v.strip().lower()
        allowed = {
            "int8",
            "int8_float32",
            "int8_float16",
            "int8_bfloat16",
            "int16",
            "float16",
            "bfloat16",
            "float32",
            "default",
            "auto",
        }
        if v not in allowed:
            raise ValueError(
                "WHISPER_COMPUTE_TYPE must be a CTranslate2 compute type: "
                + ", ".join(sorted(allowed))
            )
        return v

    @field_validator("WHISPER_REMOTE_URL")
    @classmethod
    def _remote_url(cls, v: str) -> str:
        return v.strip().rstrip("/")

    @model_validator(mode="after")
    def _remote_needs_url(self) -> "Settings":
        # Fail at boot, not at the first job's first chunk.
        if self.WHISPER_BACKEND == "remote" and not self.WHISPER_REMOTE_URL:
            raise ValueError("WHISPER_BACKEND=remote requires WHISPER_REMOTE_URL")
        return self

    # ── Derived ──────────────────────────────────────────────────────────────
    @property
    def api_keys(self) -> Dict[str, ApiKeyEntry]:
        return _parse_api_keys(self.API_KEYS)

    @property
    def is_prod(self) -> bool:
        return self.NODE_ENV == "production"

    @property
    def upload_dir(self) -> str:
        return os.path.join(self.AUDIO_WORK_DIR, "uploads")

    @property
    def scratch_dir(self) -> str:
        return os.path.join(self.AUDIO_WORK_DIR, "work")


@lru_cache(maxsize=8)
def _parse_api_keys(raw: str) -> Dict[str, ApiKeyEntry]:
    try:
        decoded = json.loads(raw or "{}")
    except json.JSONDecodeError as exc:  # pragma: no cover - message only
        raise ValueError(
            "API_KEYS must be a JSON object of apiKey -> {org, project, role?, "
            f"callbackSecret?}}: {exc}"
        ) from exc
    if not isinstance(decoded, dict):
        raise ValueError("API_KEYS must be a JSON OBJECT, not %s" % type(decoded).__name__)
    out: Dict[str, ApiKeyEntry] = {}
    for key, value in decoded.items():
        out[key] = ApiKeyEntry.model_validate(value)
    return out


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    try:
        settings = Settings()
    except ValidationError as exc:  # pragma: no cover - boot path
        raise SystemExit(f"Invalid environment configuration:\n{exc}") from exc
    # Fail fast on a malformed API_KEYS blob rather than at the first request.
    settings.api_keys
    return settings


def validate_callback_secrets(settings: Settings) -> List[str]:
    """Boot probe, mirroring ai-service's `validateCallbackSecrets`.

    Returns a list of human-readable warnings (fingerprint, never the raw key)
    for every `app`-role entry without a `callbackSecret`. Such a key can enqueue
    transcriptions but can never receive a verifiable completion callback.
    Warn, don't crash — dev setups legitimately run without callbacks.
    """
    warnings: List[str] = []
    for key, entry in settings.api_keys.items():
        if entry.role == "app" and not entry.callbackSecret:
            fingerprint = f"{key[:6]}…{key[-4:]}" if len(key) > 10 else "…"
            warnings.append(f"{fingerprint} (org={entry.org}, project={entry.project})")
    return warnings
