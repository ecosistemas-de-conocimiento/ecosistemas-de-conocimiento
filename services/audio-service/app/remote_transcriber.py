"""Remote Whisper backend — POST each chunk to a whisper.cpp `whisper-server`.

Selected with `WHISPER_BACKEND=remote`. Same interface and same `TranscriptPart`
as the local `Transcriber`, so `pipeline.py` and `worker.py` cannot tell them
apart. Queue, chunking, Redis and callbacks all stay on the app box; only the
model call crosses the network (to the DGX Spark running large-v3 on GPU).

## Wire contract (whisper.cpp `examples/server/server.cpp`, master @ 231638a071,
## read 2026-10-21)

Request: multipart POST `{base}/inference` with `file` plus form fields. Every
field we send is parsed by `get_req_parameters()` there.

Response (`response_format=verbose_json`)::

    {"task": "transcribe",
     "language": "spanish",          # ⚠ FULL NAME (whisper_lang_str_full), not "es"
     "duration": 12.3,               # seconds, from the decoded PCM length
     "text": "...",
     "segments": [{"id", "text", "start", "end", "tokens", "words",
                   "temperature", "avg_logprob", "no_speech_prob"}],
     # only when no_language_probabilities is false (the default):
     "detected_language": "spanish",
     "detected_language_probability": 0.98,
     "language_probabilities": {"es": 0.98, ...}}   # keyed by SHORT code

Segment `text` carries Whisper's leading space; `start`/`end` are seconds.

Audio: the server decodes the upload with miniaudio, resampling to 16 kHz mono.
Our chunks are ALREADY 16 kHz mono `pcm_s16le` WAV (`audio/ffmpeg.py`
`slice_wav` / `to_wav16k_mono`), so nothing is converted here and the server
does not need `--convert`.

⚠ The Spark's whisper-server sits behind a token proxy (coordinator, measured
2026-10-21): `/inference` needs `Authorization: Bearer`, a missing/wrong token
is 401 (permanent), the proxy answers 502 when upstream fails (retryable), and
it rejects chunked uploads with 411 — so the body must carry Content-Length.

Errors the server itself produces: 400 (no `file`, unreadable audio), 500
(inference failed, ffmpeg convert failed), 499 (it noticed we hung up), 503 on
`/health` while the model loads, 404 for an unknown path.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional

import httpx

from .config import Settings
from .transcriber import TranscriptPart

log = logging.getLogger("audio-service.transcriber.remote")

# The worker retries any code NOT in `worker.NON_RETRYABLE_CODES`.
# `whisper_remote_unavailable` is deliberately absent from that set;
# `whisper_remote_rejected` is in it.
CODE_UNAVAILABLE = "whisper_remote_unavailable"
CODE_REJECTED = "whisper_remote_rejected"

# 4xx statuses that are still worth a retry: request timeout, rate limit, and
# whisper-server's own 499 ("client disconnected" — i.e. our side hung up).
_RETRYABLE_4XX = {408, 425, 429, 499}


class RemoteTranscriberError(RuntimeError):
    """Carries a `code` the worker classifies, same as `PipelineError`.

    Not a `PipelineError` subclass only because `pipeline.py` imports the
    transcriber module — importing back would be circular. The worker reads
    `exc.code` via `getattr`, so the duck type is all it needs.
    """

    def __init__(self, message: str, *, code: str, status: Optional[int] = None) -> None:
        self.code = code
        self.status = status
        super().__init__(message)


class RemoteTranscriber:
    """Talks to whisper-server over HTTP. One instance per worker process.

    `transcribe` is blocking (sync httpx) because the pipeline already runs it
    via `asyncio.to_thread` — same contract as the local backend.
    """

    def __init__(self, settings: Settings, *, transport: Optional[httpx.BaseTransport] = None) -> None:
        self.settings = settings
        self._base = settings.WHISPER_REMOTE_URL.rstrip("/")
        headers = {}
        if settings.WHISPER_REMOTE_TOKEN:
            headers["Authorization"] = f"Bearer {settings.WHISPER_REMOTE_TOKEN}"
        # Short connect timeout (an unreachable Spark should fail in seconds and
        # retry), long read timeout (a 15-min chunk decodes for a while, and the
        # server's single inference mutex may queue us behind another caller).
        self._client = httpx.Client(
            headers=headers,
            timeout=httpx.Timeout(settings.WHISPER_REMOTE_TIMEOUT_S, connect=10.0),
            transport=transport,
        )
        self._loaded = False

    # ── Lifecycle ───────────────────────────────────────────────────────────
    @property
    def loaded(self) -> bool:
        # True once `load()` ran, reachable or not. /health/ready means "a worker
        # is up and configured"; a briefly-down Spark shows up as retried jobs,
        # not as the whole service going unready.
        return self._loaded

    def load(self) -> None:
        """No model to load. Probe `/health` once and WARN — never raise.

        ⚠ A crash here would put the worker in a restart loop for as long as
        the Spark is down (reboot, Tailscale blip). Jobs already retry on
        `whisper_remote_unavailable`, so the worker is more useful up.
        """
        if not self.settings.WHISPER_REMOTE_TOKEN:
            # ⚠ Bare whisper-server ignores auth, so this is not fatal — but the
            # Spark sits behind a token proxy and every job would 401 (permanent).
            log.warning("WHISPER_REMOTE_TOKEN is empty — the Spark's proxy will answer 401")
        url = f"{self._base}/health"
        try:
            response = self._client.get(url, timeout=5.0)
        except httpx.HTTPError as exc:
            log.warning("remote whisper %s unreachable at boot (%s) — jobs will retry", url, exc)
        else:
            if response.status_code == 200:
                log.info("remote whisper ready at %s", self._base)
            else:
                # 503 = whisper-server still loading its model.
                log.warning(
                    "remote whisper %s answered %d at boot (%s) — jobs will retry",
                    url, response.status_code, response.text[:200],
                )
        self._loaded = True

    def warmup(self, wav_path: str) -> None:
        """No-op. Nothing local to page in, and a warmup decode against a down
        Spark would block worker startup for the full read timeout."""

    def describe(self) -> Dict[str, Any]:
        # No URL here: this dict goes into consumer callbacks.
        return {
            "name": self.settings.WHISPER_REMOTE_MODEL,
            "device": "remote",
            "computeType": "remote",
            "backend": "whisper.cpp/remote",
        }

    def close(self) -> None:
        self._client.close()

    # ── Inference ───────────────────────────────────────────────────────────
    def transcribe(self, wav_path: str, language: Optional[str] = None) -> TranscriptPart:
        """Decode one 16 kHz mono WAV on the remote server. BLOCKING."""
        if not self._loaded:
            raise RuntimeError("RemoteTranscriber.load() was never called")
        # 🔴 Read into BYTES, not a streamed handle. The token proxy in front of
        # the Spark answers 411 to a chunked upload; bytes guarantee httpx sets
        # Content-Length. A 15-min 16 kHz s16 chunk is ~29 MB — fine in RAM.
        with open(wav_path, "rb") as handle:
            audio = handle.read()
        return self.transcribe_bytes(audio, os.path.basename(wav_path), language)

    def transcribe_bytes(
        self,
        audio: bytes,
        filename: str = "audio.wav",
        language: Optional[str] = None,
        *,
        keep_spacing: bool = False,
    ) -> TranscriptPart:
        """Same as `transcribe`, for a WAV already in memory (the live route).

        `keep_spacing` leaves each segment's leading space on its `text`, so a
        caller re-joining segments can tell a word start from a mid-word split.
        """

        settings = self.settings
        resolved_language = language if language is not None else settings.WHISPER_LANGUAGE
        autodetect = resolved_language in ("", "auto")

        data = {
            "response_format": "verbose_json",
            # whisper.cpp spells autodetect "auto" (faster-whisper uses None).
            "language": "auto" if autodetect else resolved_language,
            "temperature": "0.0",
            "temperature_inc": "0.2",
            # Parity with the local backend's decode settings.
            "beam_size": str(settings.WHISPER_BEAM_SIZE),
            # Language probabilities cost the server a second encoder pass over
            # the first 30 s. Only worth it when we actually autodetect.
            "no_language_probabilities": "false" if autodetect else "true",
        }
        if settings.WHISPER_INITIAL_PROMPT:
            data["prompt"] = settings.WHISPER_INITIAL_PROMPT
        # ⚠ VAD is NOT sent: whisper-server only does VAD when started with
        # `--vad-model`. Enable it server-side if hallucinations over silence
        # become a problem.

        url = f"{self._base}/inference"
        try:
            response = self._client.post(
                url,
                data=data,
                files={"file": (filename, audio, "audio/wav")},
            )
        except httpx.TimeoutException as exc:
            raise RemoteTranscriberError(
                f"remote whisper timed out after {settings.WHISPER_REMOTE_TIMEOUT_S:.0f}s: {exc!r}",
                code=CODE_UNAVAILABLE,
            ) from exc
        except httpx.HTTPError as exc:
            raise RemoteTranscriberError(
                f"remote whisper unreachable: {exc!r}", code=CODE_UNAVAILABLE
            ) from exc

        status = response.status_code
        if status != 200:
            body = response.text[:300]
            retryable = status >= 500 or status in _RETRYABLE_4XX
            raise RemoteTranscriberError(
                f"remote whisper HTTP {status}: {body}",
                code=CODE_UNAVAILABLE if retryable else CODE_REJECTED,
                status=status,
            )

        try:
            payload = response.json()
        except ValueError as exc:
            # A 200 that is not JSON is a proxy/server glitch, not our input.
            raise RemoteTranscriberError(
                f"remote whisper returned non-JSON: {response.text[:200]!r}",
                code=CODE_UNAVAILABLE,
                status=status,
            ) from exc
        return _to_part(
            payload,
            requested=None if autodetect else resolved_language,
            keep_spacing=keep_spacing,
        )


def _to_part(
    payload: Dict[str, Any], *, requested: Optional[str], keep_spacing: bool = False
) -> TranscriptPart:
    """Map whisper.cpp verbose_json onto the local backend's `TranscriptPart`.

    ⚠ Whisper marks a word start with a LEADING SPACE on the segment text, and
    it does split segments mid-word ("pu" + "ertas", measured 2026-10-24 on the
    Spark with SIM_0015). So the joined `text` keeps those spaces instead of
    putting one between every pair of segments.
    """
    segments: List[Dict[str, Any]] = []
    pieces: List[str] = []
    for raw in payload.get("segments") or []:
        raw_text = (raw.get("text") or "").rstrip()
        text = raw_text.strip()
        # Drop empty AND punctuation-only segments: large-v3 on the Spark was
        # seen emitting a stray "," as the last segment (measured, coordinator).
        if not any(ch.isalnum() for ch in text):
            continue
        segments.append(
            {
                "id": len(segments),
                "start": round(float(raw.get("start", 0.0) or 0.0), 3),
                "end": round(float(raw.get("end", 0.0) or 0.0), 3),
                "text": raw_text if keep_spacing else text,
                "noSpeechProb": round(float(raw.get("no_speech_prob", 0.0) or 0.0), 4),
            }
        )
        pieces.append(raw_text)

    if requested:
        # Forced language: faster-whisper reports probability 1.0 here too.
        language, probability = requested, 1.0
    else:
        # `language` is a full name ("spanish"); the short ISO code we report
        # everywhere else only appears as a key of `language_probabilities`.
        probs = payload.get("language_probabilities") or {}
        if probs:
            language = max(probs, key=lambda key: probs[key])
        else:
            language = payload.get("detected_language") or payload.get("language") or ""
        probability = float(payload.get("detected_language_probability", 0.0) or 0.0)

    return TranscriptPart(
        text="".join(pieces).strip(),
        segments=segments,
        language=language,
        language_probability=probability,
        duration=float(payload.get("duration", 0.0) or 0.0),
    )
