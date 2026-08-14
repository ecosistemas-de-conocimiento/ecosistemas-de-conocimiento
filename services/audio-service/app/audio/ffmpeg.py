"""ffmpeg / ffprobe wrappers.

Everything that touches a media file goes through here. Three rules:

- **Never `shell=True`.** Every invocation is an argv list via
  `asyncio.create_subprocess_exec`, so a filename can never become a command.
  Filenames are UUIDs anyway (see `formats.safe_extension`), but defence in
  depth is free here.
- **Always bounded.** Every invocation has a wall-clock timeout and the process
  is killed on expiry. A wedged ffmpeg would otherwise hold a worker slot
  forever.
- **Always `-nostdin`.** Without it ffmpeg can grab the parent's stdin and block
  indefinitely when it decides to ask a question.

The stdout/stderr PARSERS are pure functions (`parse_probe`,
`parse_silencedetect`) so they can be tested against captured fixture output
without spawning anything.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple


class FfmpegError(RuntimeError):
    """A non-zero exit, a timeout, or unparseable output."""

    def __init__(self, message: str, *, stderr: str = "", code: str = "ffmpeg_failed") -> None:
        self.stderr = stderr
        self.code = code
        super().__init__(message)


@dataclass(frozen=True)
class ProbeResult:
    has_audio: bool
    duration_seconds: float
    format_name: str
    codec_name: Optional[str]
    sample_rate: Optional[int]
    channels: Optional[int]
    bit_rate: Optional[int]


async def _run(
    argv: Sequence[str], *, timeout: float, capture_stdout: bool = True
) -> Tuple[int, str, str]:
    process = await asyncio.create_subprocess_exec(
        *argv,
        stdout=asyncio.subprocess.PIPE if capture_stdout else asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
        stdin=asyncio.subprocess.DEVNULL,
    )
    try:
        stdout_bytes, stderr_bytes = await asyncio.wait_for(
            process.communicate(), timeout=timeout
        )
    except asyncio.TimeoutError:
        process.kill()
        # Reap so we do not leave a zombie behind on a busy worker.
        await asyncio.gather(process.wait(), return_exceptions=True)
        raise FfmpegError(
            f"{os.path.basename(argv[0])} exceeded {timeout}s and was killed",
            code="ffmpeg_timeout",
        )
    stdout = (stdout_bytes or b"").decode("utf-8", errors="replace")
    stderr = (stderr_bytes or b"").decode("utf-8", errors="replace")
    return process.returncode or 0, stdout, stderr


# ---------------------------------------------------------------------------
# ffprobe
# ---------------------------------------------------------------------------

def parse_probe(stdout: str) -> ProbeResult:
    """Parse `ffprobe -print_format json -show_format -show_streams` output.

    Duration is taken from the first audio stream when it has one, falling back
    to the container's `format.duration`. Some containers (a growing `.webm`
    from MediaRecorder, most notably) report no duration at all; we return 0.0
    and let the caller decide — the transcoded WAV always has a real duration,
    so the worker re-probes after decoding.
    """
    try:
        payload: Mapping[str, Any] = json.loads(stdout or "{}")
    except json.JSONDecodeError as exc:
        raise FfmpegError(f"ffprobe returned unparseable JSON: {exc}", code="probe_failed")

    streams = payload.get("streams") or []
    audio_streams = [s for s in streams if s.get("codec_type") == "audio"]
    fmt = payload.get("format") or {}

    def as_float(value: Any) -> Optional[float]:
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    def as_int(value: Any) -> Optional[int]:
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    duration: Optional[float] = None
    codec = sample_rate = channels = None
    if audio_streams:
        first = audio_streams[0]
        duration = as_float(first.get("duration"))
        codec = first.get("codec_name")
        sample_rate = as_int(first.get("sample_rate"))
        channels = as_int(first.get("channels"))
    if duration is None:
        duration = as_float(fmt.get("duration"))

    return ProbeResult(
        has_audio=bool(audio_streams),
        duration_seconds=max(0.0, duration or 0.0),
        format_name=str(fmt.get("format_name") or ""),
        codec_name=codec,
        sample_rate=sample_rate,
        channels=channels,
        bit_rate=as_int(fmt.get("bit_rate")),
    )


async def probe(path: str, *, ffprobe_bin: str = "ffprobe", timeout: float = 60.0) -> ProbeResult:
    code, stdout, stderr = await _run(
        [
            ffprobe_bin,
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            path,
        ],
        timeout=timeout,
    )
    if code != 0:
        raise FfmpegError(
            "ffprobe could not read the file — it is not a media file we can decode",
            stderr=stderr,
            code="undecodable",
        )
    return parse_probe(stdout)


# ---------------------------------------------------------------------------
# Transcode
# ---------------------------------------------------------------------------

async def to_wav16k_mono(
    source: str,
    destination: str,
    *,
    ffmpeg_bin: str = "ffmpeg",
    timeout: float = 1800.0,
) -> None:
    """Normalise anything to 16 kHz mono signed-16 PCM.

    This is exactly what Whisper consumes, so doing it once up front means the
    per-chunk slices are a straight byte copy rather than N decodes of a
    compressed stream. `-vn` drops any video track, which is what makes "upload
    the mp4 of your meeting" work.
    """
    code, _stdout, stderr = await _run(
        [
            ffmpeg_bin,
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            source,
            "-vn",
            "-sn",
            "-dn",
            "-map",
            "0:a:0",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            "-f",
            "wav",
            destination,
        ],
        timeout=timeout,
    )
    if code != 0:
        raise FfmpegError(
            "ffmpeg could not decode an audio track from this file",
            stderr=stderr,
            code="decode_failed",
        )


async def slice_wav(
    source: str,
    destination: str,
    start: float,
    end: float,
    *,
    ffmpeg_bin: str = "ffmpeg",
    timeout: float = 600.0,
) -> None:
    """Cut `[start, end)` out of a PCM WAV into its own WAV.

    `-ss` before `-i` is input seeking: on uncompressed PCM it is both
    sample-accurate and O(1), because there are no inter-frame dependencies to
    resolve. (On a compressed source it would be neither, which is the other
    reason we transcode to WAV first.)
    """
    duration = max(0.0, end - start)
    code, _stdout, stderr = await _run(
        [
            ffmpeg_bin,
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-ss",
            f"{start:.3f}",
            "-t",
            f"{duration:.3f}",
            "-i",
            source,
            "-c:a",
            "pcm_s16le",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-f",
            "wav",
            destination,
        ],
        timeout=timeout,
    )
    if code != 0:
        raise FfmpegError(
            f"ffmpeg could not slice [{start:.1f}s, {end:.1f}s)",
            stderr=stderr,
            code="slice_failed",
        )


# ---------------------------------------------------------------------------
# Silence detection
# ---------------------------------------------------------------------------

_SILENCE_START = re.compile(r"silence_start:\s*(-?[\d.]+)")
_SILENCE_END = re.compile(r"silence_end:\s*(-?[\d.]+)")


def parse_silencedetect(stderr: str, total_duration: float) -> List[Tuple[float, float]]:
    """Parse `silencedetect`'s stderr log into `[(start, end), ...]`.

    ffmpeg emits, interleaved with everything else:

        [silencedetect @ 0x...] silence_start: 12.345
        [silencedetect @ 0x...] silence_end: 13.901 | silence_duration: 1.556

    A trailing silence that runs to EOF gets a `silence_start` with no matching
    `silence_end`; we close it at `total_duration`. Starts are clamped to >= 0
    because ffmpeg occasionally reports a small negative start on the first
    interval.
    """
    intervals: List[Tuple[float, float]] = []
    pending: Optional[float] = None
    for line in stderr.splitlines():
        start_match = _SILENCE_START.search(line)
        if start_match:
            pending = max(0.0, float(start_match.group(1)))
            continue
        end_match = _SILENCE_END.search(line)
        if end_match and pending is not None:
            end = float(end_match.group(1))
            if end > pending:
                intervals.append((pending, end))
            pending = None
    if pending is not None and total_duration > pending:
        intervals.append((pending, total_duration))
    return intervals


async def detect_silences(
    wav_path: str,
    *,
    total_duration: float,
    noise_db: float = -32.0,
    min_duration: float = 0.45,
    ffmpeg_bin: str = "ffmpeg",
    timeout: float = 1800.0,
) -> List[Tuple[float, float]]:
    """Run `silencedetect` over a WAV and return the silent intervals.

    Failure is NOT fatal: an empty list simply means `plan_chunks` falls back to
    hard cuts at the ceiling. Silence detection is an optimisation for seam
    quality, never a correctness gate, so it must not be able to fail a job.
    """
    code, _stdout, stderr = await _run(
        [
            ffmpeg_bin,
            "-nostdin",
            "-hide_banner",
            "-i",
            wav_path,
            "-af",
            f"silencedetect=noise={noise_db}dB:d={min_duration}",
            "-f",
            "null",
            "-",
        ],
        timeout=timeout,
        capture_stdout=False,
    )
    if code != 0:
        return []
    return parse_silencedetect(stderr, total_duration)


def summarise_probe(probe_result: ProbeResult) -> Dict[str, Any]:
    """Probe fields worth carrying on the job row and the callback envelope."""
    return {
        "format": probe_result.format_name,
        "codec": probe_result.codec_name,
        "sampleRate": probe_result.sample_rate,
        "channels": probe_result.channels,
        "bitRate": probe_result.bit_rate,
        "durationSeconds": round(probe_result.duration_seconds, 3),
    }
