"""Live transcription — partial text while someone is still speaking.

The browser records with MediaRecorder and sends the WebM/Opus stream in small
slices. Only the FIRST slice carries the WebM header, so a later slice cannot be
decoded on its own. Each session therefore keeps the whole byte stream so far,
decodes it, and transcribes only the WINDOW since the last committed point:

    |---- committed text ----|------ window (re-transcribed each slice) ------|
                             ^ committed_samples

Once the window passes `COMMIT_AFTER_S`, everything before the last segment
that starts a word is committed, and the window moves to that segment's start. A window that reaches `MAX_WINDOW_S` without a second
segment is committed whole, so one call never decodes more than that much.

🔴 PARTIAL TEXT IS RAW, PRE-GATE TESTIMONY. It lives in this process's memory
only, it goes back only in the HTTP response to the session's own caller, and it
is never logged, written to disk or Redis, or sent anywhere except the Whisper
server. The real document is the whole recording, uploaded on stop through the
normal `/v1/transcribe` path, where the anonymisation gate runs. Nothing here is
an input to that.

⚠ IN-PROCESS STATE. Sessions do not survive a restart, and they are not shared
between API replicas. One replica is what runs today; a second one would need
sticky routing by session id.

⚠ The whole buffer is decoded on every slice. Opus decodes far faster than real
time, so this stays small next to the Whisper call (inferred, not measured).
"""

from __future__ import annotations

import asyncio
import io
import logging
import re
import time
import wave
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from .config import Settings

log = logging.getLogger("audio-service.live")

SAMPLE_RATE = 16000
BYTES_PER_SAMPLE = 2

#: Commit all but the last segment once the window is this long.
COMMIT_AFTER_S = 12.0
#: Commit the window whole once it is this long, segments or not.
MAX_WINDOW_S = 25.0
#: A window shorter than this is not worth a Whisper call.
MIN_WINDOW_S = 0.8
#: Drop a session nobody has touched for this long.
IDLE_TTL_S = 120.0
#: A recording past this many bytes stops growing (~35 min of 64 kbit/s Opus,
#: inferred from the bitrate). Sized with `MAX_SESSIONS` against the API
#: container's 512m limit (infra/docker-compose.yml): one decode of a full
#: buffer is ~65 MB of PCM.
MAX_SESSION_BYTES = 16 * 1024 * 1024
#: One slice is ~2–3 s of Opus (a few tens of KB); anything near this is wrong.
MAX_SLICE_BYTES = 4 * 1024 * 1024
#: Concurrent live sessions across all callers.
MAX_SESSIONS = 8
#: A live call that waits longer than this is no longer "live".
LIVE_TIMEOUT_S = 60.0

SESSION_ID = re.compile(r"^[A-Za-z0-9._-]{1,160}$")


class LiveError(RuntimeError):
    def __init__(self, status: int, code: str, message: str) -> None:
        self.status = status
        self.code = code
        super().__init__(message)


@dataclass
class LiveSession:
    buffer: bytearray = field(default_factory=bytearray)
    committed: List[str] = field(default_factory=list)
    committed_samples: int = 0
    tentative: str = ""
    seconds: float = 0.0
    touched: float = field(default_factory=time.monotonic)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def snapshot(self) -> Dict[str, object]:
        return {
            # Pieces keep Whisper's leading space (see `_to_part`), so a plain
            # concatenation joins words and mid-word splits correctly. The
            # tentative tail keeps its leading space for the same reason.
            "committed": "".join(self.committed).strip(),
            "tentative": self.tentative if self.committed else self.tentative.lstrip(),
            "seconds": round(self.seconds, 2),
            "received": len(self.buffer),
        }


class LiveStore:
    """Sessions keyed by `<api key id>:<session id>`, so one key never reads
    another's session even if the ids collide."""

    def __init__(self) -> None:
        self._sessions: Dict[str, LiveSession] = {}

    def _sweep(self) -> None:
        cutoff = time.monotonic() - IDLE_TTL_S
        for key in [k for k, s in self._sessions.items() if s.touched < cutoff]:
            del self._sessions[key]

    def get_or_create(self, key: str, offset: int = 0) -> LiveSession:
        self._sweep()
        session = self._sessions.get(key)
        if session is None:
            # An unknown session mid-stream (expired, restarted, other key) is a
            # gap: the caller starts over from 0 rather than leaving an orphan.
            if offset > 0:
                raise LiveError(409, "live_gap", "Expected offset 0")
            if len(self._sessions) >= MAX_SESSIONS:
                raise LiveError(503, "live_busy", "Too many live sessions")
            session = self._sessions[key] = LiveSession()
        session.touched = time.monotonic()
        return session

    def drop(self, key: str) -> bool:
        return self._sessions.pop(key, None) is not None

    def __len__(self) -> int:
        return len(self._sessions)


def append_slice(session: LiveSession, offset: int, data: bytes) -> None:
    """Idempotent append: `offset` is where `data` starts in the full stream.

    A resent slice (same offset) is a no-op, an overlapping one adds only its
    new tail, and a gap is refused so the caller resends from `received`.
    """
    have = len(session.buffer)
    if offset > have:
        raise LiveError(409, "live_gap", f"Expected offset {have}")
    tail = data[have - offset:]
    if len(session.buffer) + len(tail) > MAX_SESSION_BYTES:
        raise LiveError(413, "live_too_long", "Recording too long for live text")
    session.buffer.extend(tail)


async def decode_pcm(data: bytes, *, ffmpeg_bin: str = "ffmpeg", timeout: float = 30.0) -> bytes:
    """Any container on stdin → raw 16 kHz mono s16le on stdout. No temp files."""
    proc = await asyncio.create_subprocess_exec(
        ffmpeg_bin, "-nostdin", "-hide_banner", "-loglevel", "error",
        "-i", "pipe:0", "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE),
        "-f", "s16le", "pipe:1",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, _stderr = await asyncio.wait_for(proc.communicate(data), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise LiveError(504, "live_decode_timeout", "Decoding took too long")
    # ⚠ A stream cut mid-frame makes ffmpeg exit non-zero AFTER emitting every
    # whole frame. That is the normal case here, so keep whatever came out.
    if not stdout:
        raise LiveError(422, "live_undecodable", "No audio decoded yet")
    return stdout[: len(stdout) - len(stdout) % BYTES_PER_SAMPLE]


def wav_bytes(pcm: bytes) -> bytes:
    out = io.BytesIO()
    with wave.open(out, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(BYTES_PER_SAMPLE)
        handle.setframerate(SAMPLE_RATE)
        handle.writeframes(pcm)
    return out.getvalue()


def advance(session: LiveSession, segments: List[Dict[str, object]], window_s: float, total_samples: int) -> None:
    """Apply the commit rule (module docstring) to one fresh window result."""
    texts = [str(s.get("text", "")).rstrip() for s in segments]
    # Cut only where a segment STARTS a word (leading space). Cutting before a
    # mid-word piece commits half a word, and the next window says it again
    # ("porque du" + "Que duelen", measured 2026-10-24 with SIM_0015).
    cut = next((k for k in range(len(texts) - 1, 0, -1) if texts[k][:1].isspace()), 0)
    if window_s >= COMMIT_AFTER_S and cut:
        session.committed.extend(texts[:cut])
        cut_start = float(segments[cut].get("start", 0.0) or 0.0)
        session.committed_samples += int(cut_start * SAMPLE_RATE)
        session.tentative = "".join(texts[cut:])
    elif window_s >= MAX_WINDOW_S:
        session.committed.extend(texts)
        session.committed_samples = total_samples
        session.tentative = ""
    else:
        session.tentative = "".join(texts)


class LiveTranscriber:
    """Owns the store and a short-timeout RemoteTranscriber for live calls."""

    def __init__(self, settings: Settings, transcriber: Optional[object] = None) -> None:
        self.settings = settings
        self.store = LiveStore()
        self._transcriber = transcriber

    @property
    def available(self) -> bool:
        return self._transcriber is not None or self.settings.WHISPER_BACKEND == "remote"

    def _get_transcriber(self):
        if self._transcriber is None:
            from .remote_transcriber import RemoteTranscriber

            live_settings = self.settings.model_copy(update={"WHISPER_REMOTE_TIMEOUT_S": LIVE_TIMEOUT_S})
            transcriber = RemoteTranscriber(live_settings)
            transcriber.load()
            self._transcriber = transcriber
        return self._transcriber

    async def push(self, key: str, offset: int, data: bytes) -> Dict[str, object]:
        if not self.available:
            raise LiveError(503, "live_unavailable", "Live transcription is not configured")
        if len(data) > MAX_SLICE_BYTES:
            raise LiveError(413, "live_slice_too_large", "Slice too large")
        session = self.store.get_or_create(key, offset)
        async with session.lock:
            append_slice(session, offset, data)
            pcm = await decode_pcm(bytes(session.buffer), ffmpeg_bin=self.settings.FFMPEG_BIN)
            total_samples = len(pcm) // BYTES_PER_SAMPLE
            session.seconds = total_samples / SAMPLE_RATE
            window = pcm[session.committed_samples * BYTES_PER_SAMPLE:]
            window_s = len(window) / BYTES_PER_SAMPLE / SAMPLE_RATE
            if window_s < MIN_WINDOW_S:
                return session.snapshot()
            transcriber = await asyncio.to_thread(self._get_transcriber)
            try:
                part = await asyncio.to_thread(
                    transcriber.transcribe_bytes, wav_bytes(window), "live.wav", None, keep_spacing=True
                )
            except Exception as exc:  # noqa: BLE001 — classify, never echo text
                log.warning("live whisper call failed (%s)", getattr(exc, "code", type(exc).__name__))
                raise LiveError(502, "live_whisper_failed", "Whisper did not answer") from None
            advance(session, part.segments, window_s, total_samples)
            session.touched = time.monotonic()
            return session.snapshot()

    def drop(self, key: str) -> bool:
        return self.store.drop(key)
