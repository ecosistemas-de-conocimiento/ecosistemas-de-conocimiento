"""ffmpeg/ffprobe helpers, exercised against REAL generated audio.

Not mocked. These run actual ffmpeg processes over files whose properties we
control exactly, which is the only way to catch the class of bug that matters
here: an argv ordering that silently produces the wrong thing (e.g. `-ss` after
`-i` on a WAV, which changes the seek semantics), or a regex that stops matching
after an ffmpeg release changes its log wording.
"""

from __future__ import annotations

import os

import pytest

from app.audio.chunking import plan_chunks
from app.audio.ffmpeg import (
    FfmpegError,
    detect_silences,
    parse_probe,
    parse_silencedetect,
    probe,
    slice_wav,
    summarise_probe,
    to_wav16k_mono,
)
from .conftest import make_tone, requires_ffmpeg, transcode

pytestmark = requires_ffmpeg


# ---------------------------------------------------------------------------
# Pure parsers
# ---------------------------------------------------------------------------

def test_parse_silencedetect_pairs_starts_and_ends():
    stderr = """
[silencedetect @ 0x55] silence_start: 12.345
[silencedetect @ 0x55] silence_end: 13.901 | silence_duration: 1.556
[silencedetect @ 0x55] silence_start: 40.1
[silencedetect @ 0x55] silence_end: 41.0 | silence_duration: 0.9
"""
    assert parse_silencedetect(stderr, 100.0) == [(12.345, 13.901), (40.1, 41.0)]


def test_parse_silencedetect_closes_a_trailing_silence_at_eof():
    stderr = "[silencedetect @ 0x55] silence_start: 58.0\n"
    assert parse_silencedetect(stderr, 60.0) == [(58.0, 60.0)]


def test_parse_silencedetect_clamps_a_negative_start():
    stderr = (
        "[silencedetect @ 0x55] silence_start: -0.012\n"
        "[silencedetect @ 0x55] silence_end: 2.0 | silence_duration: 2.0\n"
    )
    assert parse_silencedetect(stderr, 10.0) == [(0.0, 2.0)]


def test_parse_silencedetect_ignores_unrelated_output():
    assert parse_silencedetect("Stream #0:0: Audio: pcm_s16le\n", 10.0) == []


def test_parse_probe_prefers_the_audio_stream_duration():
    result = parse_probe(
        '{"streams":[{"codec_type":"video","duration":"99.0"},'
        '{"codec_type":"audio","duration":"12.5","codec_name":"aac",'
        '"sample_rate":"44100","channels":2}],'
        '"format":{"format_name":"mov,mp4","duration":"99.0","bit_rate":"128000"}}'
    )
    assert result.has_audio is True
    assert result.duration_seconds == 12.5
    assert result.codec_name == "aac"
    assert result.sample_rate == 44100
    assert result.channels == 2


def test_parse_probe_falls_back_to_the_container_duration():
    result = parse_probe(
        '{"streams":[{"codec_type":"audio","codec_name":"opus"}],'
        '"format":{"format_name":"webm","duration":"7.25"}}'
    )
    assert result.duration_seconds == 7.25


def test_parse_probe_reports_a_video_only_file_as_having_no_audio():
    result = parse_probe(
        '{"streams":[{"codec_type":"video","duration":"5.0"}],'
        '"format":{"format_name":"mp4","duration":"5.0"}}'
    )
    assert result.has_audio is False


def test_parse_probe_survives_a_missing_duration():
    # A growing MediaRecorder .webm reports none. We must not crash; the worker
    # re-probes the transcoded WAV, which always has one.
    result = parse_probe('{"streams":[{"codec_type":"audio"}],"format":{}}')
    assert result.duration_seconds == 0.0


def test_parse_probe_rejects_garbage():
    with pytest.raises(FfmpegError):
        parse_probe("not json")


# ---------------------------------------------------------------------------
# Real ffmpeg
# ---------------------------------------------------------------------------

async def test_probe_reads_a_real_file(tone_wav):
    result = await probe(tone_wav)
    assert result.has_audio
    assert result.duration_seconds == pytest.approx(3.0, abs=0.05)
    assert result.sample_rate == 16000
    assert result.channels == 1
    assert summarise_probe(result)["durationSeconds"] == pytest.approx(3.0, abs=0.05)


async def test_probe_rejects_a_non_media_file(tmp_path):
    junk = tmp_path / "not-audio.mp3"
    junk.write_bytes(b"%PDF-1.7\nthis is definitely not audio\n")
    with pytest.raises(FfmpegError) as excinfo:
        await probe(str(junk))
    assert excinfo.value.code == "undecodable"


@pytest.mark.parametrize("suffix", [".mp3", ".m4a", ".ogg", ".opus", ".flac", ".wav"])
async def test_every_advertised_format_transcodes(tmp_path, tone_wav, suffix):
    """The formats people actually upload, end to end through ffmpeg.

    This is the test that would catch "we said we accept .opus but the image
    ships an ffmpeg without libopus".
    """
    source = transcode(tone_wav, str(tmp_path / f"input{suffix}"))
    destination = str(tmp_path / "out.wav")
    await to_wav16k_mono(source, destination)
    result = await probe(destination)
    assert result.sample_rate == 16000
    assert result.channels == 1
    assert result.duration_seconds == pytest.approx(3.0, abs=0.2)


async def test_transcode_extracts_the_audio_track_of_a_video(tmp_path, tone_wav):
    """"Upload the mp4 of your meeting" must work."""
    video = str(tmp_path / "meeting.mp4")
    os.system(  # noqa: S605 - fixture generation, fixed argv, test-only
        f'ffmpeg -nostdin -hide_banner -loglevel error -y -f lavfi '
        f'-i testsrc=size=64x64:rate=10:duration=3 -i "{tone_wav}" '
        f'-c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "{video}"'
    )
    if not os.path.exists(video):
        pytest.skip("this ffmpeg build cannot mux h264+aac into mp4")
    result = await probe(video)
    assert result.has_audio
    destination = str(tmp_path / "from-video.wav")
    await to_wav16k_mono(video, destination)
    assert (await probe(destination)).duration_seconds == pytest.approx(3.0, abs=0.3)


async def test_transcode_fails_loudly_on_a_video_only_file(tmp_path):
    silent_video = str(tmp_path / "silent.mp4")
    os.system(  # noqa: S605 - fixture generation, test-only
        f'ffmpeg -nostdin -hide_banner -loglevel error -y -f lavfi '
        f'-i testsrc=size=64x64:rate=10:duration=2 -c:v libx264 '
        f'-pix_fmt yuv420p "{silent_video}"'
    )
    if not os.path.exists(silent_video):
        pytest.skip("this ffmpeg build cannot encode h264")
    result = await probe(silent_video)
    assert result.has_audio is False
    with pytest.raises(FfmpegError):
        await to_wav16k_mono(silent_video, str(tmp_path / "nope.wav"))


async def test_slice_cuts_the_requested_window(tmp_path):
    source = make_tone(str(tmp_path / "long.wav"), seconds=10.0)
    destination = str(tmp_path / "slice.wav")
    await slice_wav(source, destination, 2.0, 5.0)
    result = await probe(destination)
    assert result.duration_seconds == pytest.approx(3.0, abs=0.05)


async def test_slices_of_a_plan_reconstruct_the_whole_recording(tmp_path):
    """The chunk plan and the slicer must agree, or audio goes missing.

    Cuts a 10s file on a 3s/4s plan and asserts the slice durations sum back to
    the original — the property that guarantees no speech is dropped between
    chunks.
    """
    source = make_tone(str(tmp_path / "long.wav"), seconds=10.0)
    duration = (await probe(source)).duration_seconds
    chunks = plan_chunks(duration, [], target_seconds=3.0, max_seconds=4.0)
    assert len(chunks) > 1

    total = 0.0
    for chunk in chunks:
        piece = str(tmp_path / f"c{chunk.index}.wav")
        await slice_wav(source, piece, chunk.start, chunk.end)
        total += (await probe(piece)).duration_seconds
    assert total == pytest.approx(duration, abs=0.1)


async def test_detect_silences_finds_the_gaps_we_inserted(gapped_wav):
    duration = (await probe(gapped_wav)).duration_seconds
    silences = await detect_silences(
        gapped_wav, total_duration=duration, noise_db=-32.0, min_duration=0.3
    )
    # Fixture: 4 tones of 2s with 1s gaps -> silences at [2,3], [5,6], [8,9].
    midpoints = sorted((s + e) / 2 for s, e in silences)
    assert len(midpoints) >= 3
    for expected in (2.5, 5.5, 8.5):
        assert any(abs(m - expected) < 0.4 for m in midpoints), (
            f"no detected silence near {expected}s; got {midpoints}"
        )


async def test_chunk_boundaries_land_on_real_silences(gapped_wav):
    """The whole point of silence-aware chunking, verified end to end."""
    duration = (await probe(gapped_wav)).duration_seconds
    silences = await detect_silences(
        gapped_wav, total_duration=duration, noise_db=-32.0, min_duration=0.3
    )
    chunks = plan_chunks(
        duration, silences,
        target_seconds=5.0, max_seconds=7.0, search_window_seconds=2.0,
    )
    assert len(chunks) > 1
    boundary = chunks[0].end
    assert any(start <= boundary <= end for start, end in silences), (
        f"boundary {boundary} is not inside any detected silence {silences}"
    )


async def test_a_timeout_kills_the_process(tone_wav):
    with pytest.raises(FfmpegError) as excinfo:
        await probe(tone_wav, timeout=0.0001)
    assert excinfo.value.code == "ffmpeg_timeout"
