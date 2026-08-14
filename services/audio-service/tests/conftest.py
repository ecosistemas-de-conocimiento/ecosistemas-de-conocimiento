"""Shared fixtures.

Audio fixtures are GENERATED with ffmpeg rather than committed as binaries:
no blobs in git, no licensing question, and the generation itself proves ffmpeg
is present and working before any test relies on it.

What we cannot generate offline is *Spanish speech* — that needs a TTS engine
(espeak-ng / piper), which is not a dependency of this service. The one test
that needs real speech (`test_transcribe_e2e.py`) is therefore opt-in and skips
loudly rather than pretending. See its docstring.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from typing import List

import pytest

FFMPEG = os.environ.get("FFMPEG_BIN", "ffmpeg")
FFPROBE = os.environ.get("FFPROBE_BIN", "ffprobe")

requires_ffmpeg = pytest.mark.skipif(
    shutil.which(FFMPEG) is None or shutil.which(FFPROBE) is None,
    reason="ffmpeg/ffprobe not on PATH",
)


def _run(argv: List[str]) -> None:
    subprocess.run(argv, check=True, capture_output=True)


def make_tone(path: str, seconds: float, frequency: int = 440) -> str:
    """A continuous sine tone — no silences anywhere."""
    _run([
        FFMPEG, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", f"sine=frequency={frequency}:duration={seconds}",
        "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", path,
    ])
    return path


def make_tone_with_silences(
    path: str, tone_seconds: float, gap_seconds: float, repeats: int
) -> str:
    """`repeats` tones separated by `gap_seconds` of true digital silence.

    Exercises the silence-detection + chunk-planning path against a signal whose
    silence positions we know exactly, which is what makes the assertions in
    `test_ffmpeg.py` meaningful rather than tautological.
    """
    inputs: List[str] = []
    filters: List[str] = []
    index = 0
    for repeat in range(repeats):
        inputs += ["-f", "lavfi", "-i", f"sine=frequency=440:duration={tone_seconds}"]
        filters.append(f"[{index}:a]")
        index += 1
        if repeat < repeats - 1:
            inputs += ["-f", "lavfi", "-i", f"anullsrc=r=16000:cl=mono:d={gap_seconds}"]
            filters.append(f"[{index}:a]")
            index += 1
    graph = "".join(filters) + f"concat=n={index}:v=0:a=1[out]"
    _run([
        FFMPEG, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        *inputs,
        "-filter_complex", graph, "-map", "[out]",
        "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", path,
    ])
    return path


def transcode(source: str, destination: str) -> str:
    """Re-encode a WAV into whatever container `destination`'s suffix implies."""
    _run([
        FFMPEG, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-i", source, destination,
    ])
    return destination


@pytest.fixture
def tone_wav(tmp_path) -> str:
    return make_tone(str(tmp_path / "tone.wav"), seconds=3.0)


@pytest.fixture
def gapped_wav(tmp_path) -> str:
    # 4 tones of 2s separated by 3 gaps of 1s -> silences centred at 3, 6, 9.
    return make_tone_with_silences(
        str(tmp_path / "gapped.wav"), tone_seconds=2.0, gap_seconds=1.0, repeats=4
    )
