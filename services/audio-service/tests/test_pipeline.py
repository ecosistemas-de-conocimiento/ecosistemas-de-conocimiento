"""The full pipeline with REAL ffmpeg and a stub model.

This is the test that proves the plumbing: transcode, probe, silence-detect,
chunk, slice, decode each slice, shift timestamps, merge, clean up. The only
thing faked is the model itself — which `test_transcribe_e2e.py` covers
separately when the weights are available.

Faking only the model is the right seam: everything that has ever been subtly
wrong here (an off-by-one in the chunk plan, a slice that drops a second of
audio, timestamps that stay chunk-relative) lives on THIS side of it.
"""

from __future__ import annotations

import os

import pytest

from app.audio.ffmpeg import probe
from app.config import Settings
from app.pipeline import PipelineError, cleanup_scratch, run_pipeline, sweep_stale_files
from app.transcriber import TranscriptPart
from .conftest import make_tone, make_tone_with_silences, requires_ffmpeg, transcode

pytestmark = requires_ffmpeg


class StubTranscriber:
    """Reports the duration of whatever WAV it is handed.

    Returning a segment that spans the real chunk makes the timestamp-shifting
    assertions below meaningful: if `merge_segments` failed to offset, the
    second chunk's segment would still start near zero.
    """

    def __init__(self) -> None:
        self.calls: list[str] = []

    def transcribe(self, wav_path: str, language=None) -> TranscriptPart:
        self.calls.append(wav_path)
        import wave

        with wave.open(wav_path, "rb") as handle:
            duration = handle.getnframes() / float(handle.getframerate())
        index = len(self.calls)
        return TranscriptPart(
            text=f"parte {index}",
            segments=[
                {"id": 0, "start": 0.0, "end": round(duration, 3), "text": f"parte {index}"}
            ],
            language="es",
            language_probability=0.99,
            duration=duration,
        )

    def describe(self):
        return {"name": "stub", "device": "cpu", "computeType": "int8"}


def _settings(tmp_path, **overrides) -> Settings:
    base = dict(
        AUDIO_WORK_DIR=str(tmp_path / "work"),
        CHUNK_TARGET_SECONDS=3.0,
        CHUNK_MAX_SECONDS=4.0,
        CHUNK_SILENCE_SEARCH_SECONDS=1.5,
        SILENCE_MIN_DURATION_SECONDS=0.3,
        MAX_DURATION_SECONDS=3600,
    )
    base.update(overrides)
    return Settings(**base)


async def test_a_short_recording_is_a_single_chunk_with_no_slicing(tmp_path):
    source = make_tone(str(tmp_path / "short.wav"), seconds=2.0)
    transcriber = StubTranscriber()
    result = await run_pipeline(
        source_path=source,
        scratch_dir=str(tmp_path / "scratch"),
        settings=_settings(tmp_path),
        transcriber=transcriber,
    )
    assert result.chunk_count == 1
    assert result.text == "parte 1"
    # A single-chunk job decodes the normalised WAV directly — no slice file.
    assert len(transcriber.calls) == 1
    assert transcriber.calls[0].endswith("source.wav")


@pytest.mark.parametrize("suffix", [".mp3", ".m4a", ".ogg", ".opus", ".flac"])
async def test_every_advertised_container_reaches_the_model(tmp_path, suffix):
    wav = make_tone(str(tmp_path / "tone.wav"), seconds=2.0)
    source = transcode(wav, str(tmp_path / f"input{suffix}"))
    result = await run_pipeline(
        source_path=source,
        scratch_dir=str(tmp_path / f"scratch{suffix}"),
        settings=_settings(tmp_path),
        transcriber=StubTranscriber(),
    )
    assert result.text == "parte 1"
    assert result.duration_seconds == pytest.approx(2.0, abs=0.3)


async def test_a_long_recording_is_chunked_and_timestamps_are_absolute(tmp_path):
    # 4 tones of 2s + 3 gaps of 1s = 11s; chunk target 3s, ceiling 4s.
    source = make_tone_with_silences(
        str(tmp_path / "long.wav"), tone_seconds=2.0, gap_seconds=1.0, repeats=4
    )
    transcriber = StubTranscriber()
    result = await run_pipeline(
        source_path=source,
        scratch_dir=str(tmp_path / "scratch"),
        settings=_settings(tmp_path),
        transcriber=transcriber,
    )
    assert result.chunk_count > 1
    assert len(transcriber.calls) == result.chunk_count
    # Chunk boundaries are an artefact, not a paragraph break.
    assert result.text == " ".join(f"parte {i + 1}" for i in range(result.chunk_count))
    assert "\n" not in result.text

    starts = [segment["start"] for segment in result.segments]
    assert starts == sorted(starts)
    assert starts[0] == pytest.approx(0.0)
    # The decisive assertion: the last segment must be near the END of the
    # recording, not near the start of its own chunk.
    assert result.segments[-1]["end"] == pytest.approx(result.duration_seconds, abs=0.5)
    assert [segment["id"] for segment in result.segments] == list(
        range(len(result.segments))
    )


async def test_chunk_slices_are_deleted_as_soon_as_they_are_decoded(tmp_path):
    """A 6-hour recording would otherwise accumulate ~700 MB of PCM slices."""
    source = make_tone_with_silences(
        str(tmp_path / "long.wav"), tone_seconds=2.0, gap_seconds=1.0, repeats=4
    )
    scratch = str(tmp_path / "scratch")
    result = await run_pipeline(
        source_path=source, scratch_dir=scratch,
        settings=_settings(tmp_path), transcriber=StubTranscriber(),
    )
    assert result.chunk_count > 1
    leftovers = [name for name in os.listdir(scratch) if name.startswith("chunk-")]
    assert leftovers == []


async def test_a_video_only_file_fails_with_a_precise_code(tmp_path):
    video = str(tmp_path / "silent.mp4")
    os.system(  # noqa: S605 - fixture generation, test-only
        f'ffmpeg -nostdin -hide_banner -loglevel error -y -f lavfi '
        f'-i testsrc=size=64x64:rate=10:duration=2 -c:v libx264 '
        f'-pix_fmt yuv420p "{video}"'
    )
    if not os.path.exists(video):
        pytest.skip("this ffmpeg build cannot encode h264")
    with pytest.raises(PipelineError) as excinfo:
        await run_pipeline(
            source_path=video, scratch_dir=str(tmp_path / "scratch"),
            settings=_settings(tmp_path), transcriber=StubTranscriber(),
        )
    # The worker keys its retry decision off this code: a content error must
    # never be retried three times.
    assert excinfo.value.code == "no_audio_stream"


async def test_an_over_long_recording_fails_with_too_long(tmp_path):
    source = make_tone(str(tmp_path / "long.wav"), seconds=5.0)
    with pytest.raises(PipelineError) as excinfo:
        await run_pipeline(
            source_path=source, scratch_dir=str(tmp_path / "scratch"),
            settings=_settings(tmp_path, MAX_DURATION_SECONDS=2),
            transcriber=StubTranscriber(),
        )
    assert excinfo.value.code == "too_long"


async def test_a_silent_transcript_fails_rather_than_ingesting_nothing(tmp_path):
    """An empty transcript must not become an empty RAG document."""

    class SilentTranscriber(StubTranscriber):
        def transcribe(self, wav_path, language=None):
            return TranscriptPart("", [], "es", 0.0, 0.0)

    source = make_tone(str(tmp_path / "short.wav"), seconds=2.0)
    with pytest.raises(PipelineError) as excinfo:
        await run_pipeline(
            source_path=source, scratch_dir=str(tmp_path / "scratch"),
            settings=_settings(tmp_path), transcriber=SilentTranscriber(),
        )
    assert excinfo.value.code == "empty_transcript"


async def test_progress_is_reported_once_per_chunk(tmp_path):
    source = make_tone_with_silences(
        str(tmp_path / "long.wav"), tone_seconds=2.0, gap_seconds=1.0, repeats=4
    )
    reported: list[tuple[int, int]] = []

    async def on_progress(done: int, total: int) -> None:
        reported.append((done, total))

    result = await run_pipeline(
        source_path=source, scratch_dir=str(tmp_path / "scratch"),
        settings=_settings(tmp_path), transcriber=StubTranscriber(),
        on_progress=on_progress,
    )
    assert reported == [(i + 1, result.chunk_count) for i in range(result.chunk_count)]


async def test_the_normalised_wav_is_16k_mono(tmp_path):
    stereo = str(tmp_path / "stereo.wav")
    os.system(  # noqa: S605 - fixture generation, test-only
        f'ffmpeg -nostdin -hide_banner -loglevel error -y -f lavfi '
        f'-i "sine=frequency=440:duration=2" -ac 2 -ar 44100 "{stereo}"'
    )
    scratch = str(tmp_path / "scratch")
    await run_pipeline(
        source_path=stereo, scratch_dir=scratch,
        settings=_settings(tmp_path), transcriber=StubTranscriber(),
    )
    normalised = await probe(os.path.join(scratch, "source.wav"))
    assert normalised.sample_rate == 16000
    assert normalised.channels == 1


# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------

def test_cleanup_removes_the_whole_scratch_tree(tmp_path):
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    (scratch / "chunk-0000.wav").write_bytes(b"x")
    cleanup_scratch(str(scratch))
    assert not scratch.exists()


def test_cleanup_is_idempotent(tmp_path):
    cleanup_scratch(str(tmp_path / "never-existed"))  # must not raise


def test_the_sweeper_never_deletes_a_file_a_live_job_owns(tmp_path):
    """Regression: age alone is NOT a safe deletion criterion.

    On a backlog — one worker, a job timeout in hours, retry backoff on top — a
    QUEUED upload routinely outlives the retention window. Deleting it fails
    that job with `source_missing`, which is non-retryable, so the backlog would
    silently destroy the work it was queuing.
    """
    root = tmp_path / "uploads"
    root.mkdir()
    live = root / "job-alive.wav"
    dead = root / "job-finished.wav"
    live.write_bytes(b"x")
    dead.write_bytes(b"x")
    old = os.stat(live).st_mtime - 10_000
    os.utime(live, (old, old))
    os.utime(dead, (old, old))

    def is_protected(name: str) -> bool:
        return name.startswith("job-alive")

    removed = sweep_stale_files(str(root), max_age_seconds=3600, is_protected=is_protected)
    assert removed == 1
    assert live.exists()
    assert not dead.exists()


def test_the_sweeper_removes_only_stale_artefacts(tmp_path):
    """Crash insurance: a SIGKILL skips the worker's `finally`.

    Audio we promised not to keep must not survive on the volume indefinitely.
    """
    root = tmp_path / "uploads"
    root.mkdir()
    fresh = root / "fresh.wav"
    stale = root / "stale.wav"
    stale_dir = root / "stale-job"
    fresh.write_bytes(b"x")
    stale.write_bytes(b"x")
    stale_dir.mkdir()
    (stale_dir / "chunk.wav").write_bytes(b"x")

    old = os.stat(stale).st_mtime - 10_000
    os.utime(stale, (old, old))
    os.utime(stale_dir, (old, old))

    removed = sweep_stale_files(str(root), max_age_seconds=3600)
    assert removed == 2
    assert fresh.exists()
    assert not stale.exists()
    assert not stale_dir.exists()


def test_the_sweeper_tolerates_a_missing_directory(tmp_path):
    assert sweep_stale_files(str(tmp_path / "gone"), max_age_seconds=1) == 0
