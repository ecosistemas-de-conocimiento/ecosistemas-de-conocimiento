"""The transcription pipeline: bytes on disk -> transcript.

Deliberately free of arq, FastAPI and Redis-key knowledge: it takes a source
path and a progress callback and returns a transcript. That keeps the expensive,
subtle part of the service testable with a real audio file and no infrastructure
at all (see `tests/test_pipeline.py`).

Flow:

    upload (any container)
      -> ffmpeg: 16 kHz mono PCM WAV                 [one decode, not N]
      -> ffprobe: authoritative duration             [containers lie]
      -> ffmpeg silencedetect: silent intervals      [best-effort]
      -> plan_chunks: cut points at silences         [pure, tested]
      -> per chunk: ffmpeg slice -> whisper -> shift timestamps
      -> merge

Everything is written into a per-job scratch directory that the caller removes,
including on failure.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, List, Optional

from .audio import ffmpeg
from .audio.chunking import Chunk, join_text, merge_segments, plan_chunks
from .config import Settings
from .transcriber import Transcriber

log = logging.getLogger("audio-service.pipeline")

ProgressCallback = Callable[[int, int], Awaitable[None]]


class PipelineError(RuntimeError):
    def __init__(self, message: str, *, code: str) -> None:
        self.code = code
        super().__init__(message)


@dataclass
class TranscriptionResult:
    text: str
    segments: List[Dict[str, Any]]
    language: str
    language_probability: float
    duration_seconds: float
    chunk_count: int
    audio: Dict[str, Any] = field(default_factory=dict)


async def run_pipeline(
    *,
    source_path: str,
    scratch_dir: str,
    settings: Settings,
    transcriber: Transcriber,
    language: Optional[str] = None,
    on_progress: Optional[ProgressCallback] = None,
) -> TranscriptionResult:
    os.makedirs(scratch_dir, exist_ok=True)
    wav_path = os.path.join(scratch_dir, "source.wav")

    # ── 1. Probe the original ────────────────────────────────────────────────
    probe = await ffmpeg.probe(
        source_path,
        ffprobe_bin=settings.FFPROBE_BIN,
        timeout=float(settings.FFMPEG_TIMEOUT_SECONDS),
    )
    if not probe.has_audio:
        raise PipelineError(
            "The uploaded file contains no audio stream we can decode",
            code="no_audio_stream",
        )

    # ── 2. Normalise to 16 kHz mono PCM ──────────────────────────────────────
    await ffmpeg.to_wav16k_mono(
        source_path,
        wav_path,
        ffmpeg_bin=settings.FFMPEG_BIN,
        timeout=float(settings.FFMPEG_TIMEOUT_SECONDS),
    )

    # Re-probe the WAV: the container's declared duration is frequently absent
    # (a MediaRecorder `.webm`) or wrong (a VBR mp3 with a bad Xing header), and
    # every downstream decision keys off duration.
    wav_probe = await ffmpeg.probe(
        wav_path,
        ffprobe_bin=settings.FFPROBE_BIN,
        timeout=float(settings.FFMPEG_TIMEOUT_SECONDS),
    )
    duration = wav_probe.duration_seconds
    if duration <= 0:
        raise PipelineError(
            "Decoded audio has zero duration — the file is empty or corrupt",
            code="empty_audio",
        )
    if duration > settings.MAX_DURATION_SECONDS:
        raise PipelineError(
            f"Recording is {duration / 3600:.1f}h, over the "
            f"{settings.MAX_DURATION_SECONDS / 3600:.1f}h limit",
            code="too_long",
        )

    # ── 3. Plan the chunks ───────────────────────────────────────────────────
    silences: List[tuple[float, float]] = []
    if duration > settings.CHUNK_MAX_SECONDS:
        silences = await ffmpeg.detect_silences(
            wav_path,
            total_duration=duration,
            noise_db=settings.SILENCE_NOISE_DB,
            min_duration=settings.SILENCE_MIN_DURATION_SECONDS,
            ffmpeg_bin=settings.FFMPEG_BIN,
            timeout=float(settings.FFMPEG_TIMEOUT_SECONDS),
        )

    chunks = plan_chunks(
        duration,
        silences,
        target_seconds=settings.CHUNK_TARGET_SECONDS,
        max_seconds=settings.CHUNK_MAX_SECONDS,
        search_window_seconds=settings.CHUNK_SILENCE_SEARCH_SECONDS,
    )
    log.info(
        "planned %d chunk(s) over %.1fs (%d silence intervals detected)",
        len(chunks),
        duration,
        len(silences),
    )

    # ── 4. Transcribe ────────────────────────────────────────────────────────
    part_texts: List[str] = []
    part_segments: List[List[Dict[str, Any]]] = []
    detected_language = language or settings.WHISPER_LANGUAGE
    language_probability = 0.0

    for chunk in chunks:
        chunk_path = _chunk_path(scratch_dir, chunk, len(chunks), wav_path)
        if chunk_path != wav_path:
            await ffmpeg.slice_wav(
                wav_path,
                chunk_path,
                chunk.start,
                chunk.end,
                ffmpeg_bin=settings.FFMPEG_BIN,
                timeout=float(settings.FFMPEG_TIMEOUT_SECONDS),
            )

        started = time.monotonic()
        # `Transcriber.transcribe` is blocking CPU work. `asyncio.to_thread`
        # keeps the event loop free so the heartbeat refresher and the callback
        # deliveries running in the same worker process are not starved.
        part = await asyncio.to_thread(transcriber.transcribe, chunk_path, language)
        log.info(
            "chunk %d/%d (%.1fs of audio) decoded in %.1fs",
            chunk.index + 1,
            len(chunks),
            chunk.duration,
            time.monotonic() - started,
        )

        part_texts.append(part.text)
        part_segments.append(part.segments)
        if chunk.index == 0:
            detected_language = part.language or detected_language
            language_probability = part.language_probability

        # Free the slice immediately — a 15-minute PCM slice is ~29 MB and a
        # 6-hour recording would otherwise accumulate ~700 MB of them.
        if chunk_path != wav_path:
            _unlink_quietly(chunk_path)

        if on_progress is not None:
            await on_progress(chunk.index + 1, len(chunks))

    merged_segments = merge_segments(part_segments, chunks)
    text = join_text(part_texts)

    if not text.strip():
        raise PipelineError(
            "Transcription produced no text — the recording appears to contain "
            "no intelligible speech",
            code="empty_transcript",
        )

    # The summary describes the ORIGINAL container (codec, sample rate, …) but
    # its duration must be the DECODED one: a `.webm` from MediaRecorder often
    # declares no duration at all, and a VBR mp3 with a bad Xing header declares
    # a wrong one. Reporting two different durations in one callback envelope is
    # exactly the kind of thing a consumer builds a bug on.
    audio_summary = ffmpeg.summarise_probe(probe)
    audio_summary["durationSeconds"] = round(duration, 3)
    audio_summary["containerDurationSeconds"] = round(probe.duration_seconds, 3)

    return TranscriptionResult(
        text=text,
        segments=merged_segments,
        language=detected_language,
        language_probability=language_probability,
        duration_seconds=round(duration, 3),
        chunk_count=len(chunks),
        audio=audio_summary,
    )


def _chunk_path(scratch_dir: str, chunk: Chunk, total: int, wav_path: str) -> str:
    """Single-chunk jobs decode the normalised WAV directly — no slice, no copy."""
    if total == 1:
        return wav_path
    return os.path.join(scratch_dir, f"chunk-{chunk.index:04d}.wav")


def _unlink_quietly(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:  # pragma: no cover - best effort
        pass


def cleanup_scratch(scratch_dir: str) -> None:
    shutil.rmtree(scratch_dir, ignore_errors=True)


def stale_entries(
    root: str, max_age_seconds: float, now: Optional[float] = None
) -> List[os.DirEntry]:
    """Entries under `root` older than `max_age_seconds`. Pure listing, no I/O."""
    current = now if now is not None else time.time()
    if not os.path.isdir(root):
        return []
    out: List[os.DirEntry] = []
    for entry in os.scandir(root):
        try:
            age = current - entry.stat().st_mtime
        except OSError:  # pragma: no cover - raced with our own cleanup
            continue
        if age >= max_age_seconds:
            out.append(entry)
    return out


def remove_entry(entry: os.DirEntry) -> None:
    if entry.is_dir():
        shutil.rmtree(entry.path, ignore_errors=True)
    else:
        _unlink_quietly(entry.path)


def sweep_stale_files(
    root: str,
    max_age_seconds: float,
    now: Optional[float] = None,
    is_protected: Optional[Callable[[str], bool]] = None,
) -> int:
    """Delete anything under `root` older than `max_age_seconds`.

    Crash insurance. Normal cleanup happens in the worker's `finally`, but a
    SIGKILL (an OOM, a `docker kill`) skips that, and audio we were told not to
    keep must not survive indefinitely on a volume.

    ⚠ `is_protected(name) -> bool` is how the caller keeps a still-wanted file
    alive. Age alone is NOT sufficient: a queued upload can easily be older than
    the retention window on a backlog, and deleting it fails its job with the
    non-retryable `source_missing`. The worker passes a predicate that asks the
    store whether a live job still owns the file.

    Returns the count removed.
    """
    removed = 0
    for entry in stale_entries(root, max_age_seconds, now):
        if is_protected is not None and is_protected(entry.name):
            continue
        remove_entry(entry)
        removed += 1
    return removed


async def sweep_stale_files_async(
    root: str,
    max_age_seconds: float,
    is_protected: Callable[[str], Awaitable[bool]],
    now: Optional[float] = None,
) -> int:
    """`sweep_stale_files` with an async protection predicate.

    Separate entry point because the worker's predicate reads Redis, and making
    the sync version take a coroutine would be a trap for any other caller.
    """
    removed = 0
    for entry in stale_entries(root, max_age_seconds, now):
        if await is_protected(entry.name):
            continue
        remove_entry(entry)
        removed += 1
    return removed
