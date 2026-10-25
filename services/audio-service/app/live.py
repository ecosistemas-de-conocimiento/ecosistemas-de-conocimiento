"""Live transcription — partial text while someone is still speaking.

The browser records with MediaRecorder and sends the WebM/Opus stream in small
slices. Only the FIRST slice carries the WebM header, so a later slice cannot be
decoded on its own. Each session therefore runs ONE ffmpeg for its whole life,
fed slice by slice on stdin, and keeps only the decoded PCM of the WINDOW since
the last committed point, which is re-transcribed on each slice:

    |---- committed text ----|------ window (re-transcribed each slice) ------|
                             ^ committed_samples

Once the window passes `COMMIT_AFTER_S`, everything before the last segment
that starts a word is committed, and the window moves to that segment's start.
A window that reaches `MAX_WINDOW_S` is committed whole. A window that grows
past it anyway (Whisper failing) is cut to its last `MAX_WINDOW_S`, so one call
never sends more than that much audio.

⚠ ffmpeg emits nothing for the first ~7–10 s it is fed through a pipe, while it
probes the input (measured 2026-10-24, ffmpeg 7.1.1, `-f matroska`,
`-probesize`, `-analyzeduration 0` and `-flush_packets 1` did not shorten it).
Until it starts, the session keeps the raw bytes (`head`, capped at
`MAX_HEAD_BYTES`) and decodes them in one pass. That pass is small and stops as
soon as the streaming decoder has output.

🔴 PARTIAL TEXT IS RAW, PRE-GATE TESTIMONY. It lives in this process's memory
only, it goes back only in the HTTP response to the session's own caller, and it
is never logged, written to disk or Redis, or sent anywhere except the Whisper
server. Audio moves through pipes, never temp files. The real document is the
whole recording, uploaded on stop through the normal `/v1/transcribe` path,
where the anonymisation gate runs. Nothing here is an input to that.

⚠ IN-PROCESS STATE. Sessions do not survive a restart, and they are not shared
between API replicas. One replica is what runs today; a second one would need
sticky routing by session id.
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

#: Commit all but the last word-starting segment once the window is this long.
COMMIT_AFTER_S = 12.0
#: Commit the window whole once it is this long; never send Whisper more.
MAX_WINDOW_S = 25.0
#: A window shorter than this is not worth a Whisper call.
MIN_WINDOW_S = 0.8
#: Drop a session nobody has touched for this long.
IDLE_TTL_S = 120.0
#: Raw bytes kept until the streaming decoder starts (~4 min of 64 kbit/s Opus).
MAX_HEAD_BYTES = 2 * 1024 * 1024
#: A recording past this many bytes stops getting live text (~2 h at 64 kbit/s).
MAX_SESSION_BYTES = 64 * 1024 * 1024
#: One slice is ~2–3 s of Opus (a few tens of KB); anything near this is wrong.
MAX_SLICE_BYTES = 4 * 1024 * 1024
#: Concurrent live sessions across all callers. Each holds one ffmpeg (50 MB
#: RSS including shared libraries, measured 2026-10-24 on a dev laptop with
#: SIM_0015) plus at most a window of PCM (~1 MB). 6 keeps the API container
#: well inside its 512m limit (infra/docker-compose.yml).
MAX_SESSIONS = 6
#: Sessions per owner (the part of the session id before the first "."; the
#: backend puts the user id there). A new one evicts that owner's oldest, so a
#: crashed tab never blocks the next recording and one user cannot fill the
#: global cap.
MAX_PER_OWNER = 2
#: A live call that waits longer than this is no longer "live".
LIVE_TIMEOUT_S = 60.0
#: How long to wait for ffmpeg to emit what a slice decodes to.
SETTLE_S = 0.5

SESSION_ID = re.compile(r"^[A-Za-z0-9._-]{1,160}$")


class LiveError(RuntimeError):
    def __init__(self, status: int, code: str, message: str) -> None:
        self.status = status
        self.code = code
        super().__init__(message)


class StreamDecoder:
    """One ffmpeg per session: WebM/MP4 in on stdin, 16 kHz s16le PCM out.

    `pcm` holds decoded samples from `base` (absolute sample index) onward;
    `trim()` drops what the session has committed.
    """

    def __init__(self, ffmpeg_bin: str = "ffmpeg") -> None:
        self.ffmpeg_bin = ffmpeg_bin
        self.proc: Optional[asyncio.subprocess.Process] = None
        self.pcm = bytearray()
        self.base = 0
        self._reader: Optional[asyncio.Task] = None

    @property
    def end(self) -> int:
        """Absolute index one past the last decoded sample."""
        return self.base + len(self.pcm) // BYTES_PER_SAMPLE

    @property
    def alive(self) -> bool:
        return self.proc is not None and self.proc.returncode is None

    async def start(self) -> None:
        self.proc = await asyncio.create_subprocess_exec(
            self.ffmpeg_bin, "-nostdin", "-hide_banner", "-loglevel", "error",
            "-i", "pipe:0", "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE),
            "-f", "s16le", "pipe:1",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        self._reader = asyncio.create_task(self._read())

    async def _read(self) -> None:
        assert self.proc and self.proc.stdout
        while True:
            data = await self.proc.stdout.read(65536)
            if not data:
                return
            self.pcm.extend(data)

    async def feed(self, data: bytes) -> None:
        if not self.alive or not self.proc or not self.proc.stdin:
            raise LiveError(422, "live_undecodable", "Audio stream could not be decoded")
        try:
            self.proc.stdin.write(data)
            await self.proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            raise LiveError(422, "live_undecodable", "Audio stream could not be decoded") from None

    async def settle(self, timeout: float = SETTLE_S) -> None:
        """Wait until decoded output stops growing, or `timeout`."""
        deadline = time.monotonic() + timeout
        last = -1
        while time.monotonic() < deadline:
            await asyncio.sleep(0.04)
            if len(self.pcm) == last:
                return
            last = len(self.pcm)

    def trim(self, upto: int) -> None:
        drop = max(0, min(upto, self.end) - self.base)
        if drop:
            del self.pcm[: drop * BYTES_PER_SAMPLE]
            self.base += drop

    def close(self) -> None:
        """Kill ffmpeg and reap it in the background (no zombies)."""
        if self.alive and self.proc:
            self.proc.kill()
            try:
                asyncio.get_running_loop().create_task(self.proc.wait())
            except RuntimeError:
                pass  # no running loop: the process is reaped at interpreter exit
        if self._reader:
            self._reader.cancel()

    async def aclose(self) -> None:
        if self.alive and self.proc:
            self.proc.kill()
        if self.proc:
            await self.proc.wait()
        if self._reader:
            self._reader.cancel()


@dataclass
class LiveSession:
    owner: str = ""
    received: int = 0
    #: Raw bytes, kept only until the streaming decoder has output.
    head: Optional[bytearray] = field(default_factory=bytearray)
    decoder: Optional[StreamDecoder] = None
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
            "received": self.received,
        }

    def close(self) -> None:
        if self.decoder:
            self.decoder.close()
        self.head = None


def owner_of(key: str) -> str:
    """`<api key id>:<owner>.<rest>` → `<api key id>:<owner>`. No "." ⇒ the key."""
    api, _, sid = key.partition(":")
    owner, dot, _rest = sid.partition(".")
    return f"{api}:{owner}" if dot else key


class LiveStore:
    """Sessions keyed by `<api key id>:<session id>`, so one key never reads
    another's session even if the ids collide."""

    def __init__(self) -> None:
        self._sessions: Dict[str, LiveSession] = {}
        self._closing: List[StreamDecoder] = []

    def _remove(self, key: str) -> None:
        session = self._sessions.pop(key, None)
        if session:
            session.close()
            # Kept until reaped, so shutdown can wait for them too.
            self._closing = [d for d in self._closing if d.proc and d.proc.returncode is None]
            if session.decoder:
                self._closing.append(session.decoder)

    def _sweep(self) -> None:
        cutoff = time.monotonic() - IDLE_TTL_S
        for key in [k for k, s in self._sessions.items() if s.touched < cutoff]:
            self._remove(key)

    def get_or_create(self, key: str, offset: int = 0) -> LiveSession:
        self._sweep()
        session = self._sessions.get(key)
        if session is None:
            # An unknown session mid-stream (expired, restarted, other key) is a
            # gap: the caller starts over from 0 rather than leaving an orphan.
            if offset > 0:
                raise LiveError(409, "live_gap", "Expected offset 0")
            owner = owner_of(key)
            mine = sorted(
                (k for k, s in self._sessions.items() if s.owner == owner),
                key=lambda k: self._sessions[k].touched,
            )
            for old in mine[: max(0, len(mine) - MAX_PER_OWNER + 1)]:
                self._remove(old)
            if len(self._sessions) >= MAX_SESSIONS:
                raise LiveError(503, "live_busy", "Too many live sessions")
            session = self._sessions[key] = LiveSession(owner=owner)
        session.touched = time.monotonic()
        return session

    def drop(self, key: str) -> bool:
        present = key in self._sessions
        self._remove(key)
        return present

    async def aclose(self) -> None:
        """Kill every session's ffmpeg and wait for it (shutdown)."""
        sessions, self._sessions = list(self._sessions.values()), {}
        closing, self._closing = self._closing, []
        for decoder in closing + [s.decoder for s in sessions if s.decoder]:
            await decoder.aclose()

    def __len__(self) -> int:
        return len(self._sessions)


def new_bytes(session: LiveSession, offset: int, data: bytes) -> bytes:
    """Idempotent append: `offset` is where `data` starts in the full stream.

    Returns only the bytes not seen before. A resent slice (same offset) yields
    nothing, an overlapping one only its new tail, and a gap is refused so the
    caller resends from `received`.
    """
    have = session.received
    if offset > have:
        raise LiveError(409, "live_gap", f"Expected offset {have}")
    tail = data[have - offset:]
    if have + len(tail) > MAX_SESSION_BYTES:
        raise LiveError(413, "live_too_long", "Recording too long for live text")
    return tail


async def decode_pcm(data: bytes, *, ffmpeg_bin: str = "ffmpeg", timeout: float = 30.0) -> bytes:
    """Any container on stdin → raw 16 kHz mono s16le on stdout. No temp files."""
    proc = await asyncio.create_subprocess_exec(
        ffmpeg_bin, "-nostdin", "-hide_banner", "-loglevel", "error",
        "-i", "pipe:0", "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE),
        "-f", "s16le", "pipe:1",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
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
    # ⚠ And only at a start strictly inside the window: 0 would commit the text
    # without moving the window (committed twice), and past the end would skip
    # audio nobody has heard yet.
    def inside(k: int) -> bool:
        start = float(segments[k].get("start", 0.0) or 0.0)
        return 0.0 < start < window_s

    cut = next(
        (k for k in range(len(texts) - 1, 0, -1) if texts[k][:1].isspace() and inside(k)), 0
    )
    if window_s >= COMMIT_AFTER_S and cut:
        session.committed.extend(texts[:cut])
        cut_start = float(segments[cut].get("start", 0.0) or 0.0)
        session.committed_samples += int(cut_start * SAMPLE_RATE)
        session.tentative = "".join(texts[cut:])
    elif window_s >= MAX_WINDOW_S:
        # ⚠ May cut a word in two if no segment in 25 s starts one (rare).
        session.committed.extend(texts)
        session.committed_samples = total_samples
        session.tentative = ""
    else:
        session.tentative = "".join(texts)


def cap_window(session: LiveSession, total_samples: int) -> None:
    """Never let the window outgrow `MAX_WINDOW_S` (Whisper failing, or slow).

    Keeps the last tentative text as committed (best effort) and skips the
    audio before the last `MAX_WINDOW_S`. Live text is a preview; the uploaded
    recording is transcribed whole, so nothing is lost from the document.
    """
    limit = int(MAX_WINDOW_S * SAMPLE_RATE)
    if total_samples - session.committed_samples > limit:
        if session.tentative:
            session.committed.append(session.tentative)
            session.tentative = ""
        session.committed_samples = total_samples - limit


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

    async def _window(self, session: LiveSession, tail: bytes) -> tuple[bytes, int]:
        """Feed `tail`; return (window PCM, total decoded samples)."""
        if session.decoder is None:
            session.decoder = StreamDecoder(self.settings.FFMPEG_BIN)
            await session.decoder.start()
        decoder = session.decoder
        if tail:
            await decoder.feed(tail)
            # Counted the moment ffmpeg has them: a resend must never feed the
            # same bytes twice, even if a later step of this call fails.
            session.received += len(tail)
            if session.head is not None:
                session.head.extend(tail)
        await decoder.settle()

        if decoder.end == 0 and session.head is not None:
            # Streaming decoder still probing: decode the short head in one pass.
            if len(session.head) > MAX_HEAD_BYTES:
                raise LiveError(422, "live_undecodable", "Audio stream could not be decoded")
            pcm = await decode_pcm(bytes(session.head), ffmpeg_bin=self.settings.FFMPEG_BIN)
            total = len(pcm) // BYTES_PER_SAMPLE
            cap_window(session, total)
            return pcm[session.committed_samples * BYTES_PER_SAMPLE:], total

        session.head = None
        total = decoder.end
        cap_window(session, total)
        decoder.trim(session.committed_samples)
        start = max(0, session.committed_samples - decoder.base)
        return bytes(decoder.pcm[start * BYTES_PER_SAMPLE:]), total

    async def push(self, key: str, offset: int, data: bytes) -> Dict[str, object]:
        if not self.available:
            raise LiveError(503, "live_unavailable", "Live transcription is not configured")
        if len(data) > MAX_SLICE_BYTES:
            raise LiveError(413, "live_slice_too_large", "Slice too large")
        session = self.store.get_or_create(key, offset)
        async with session.lock:
            tail = new_bytes(session, offset, data)
            window, total = await self._window(session, tail)
            session.seconds = total / SAMPLE_RATE
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
            advance(session, part.segments, window_s, total)
            session.touched = time.monotonic()
            return session.snapshot()

    def drop(self, key: str) -> bool:
        return self.store.drop(key)
