"""`plan_chunks` — the pure core of long-recording handling."""

from __future__ import annotations

import pytest

from app.audio.chunking import Chunk, join_text, merge_segments, plan_chunks


def _assert_tiles(chunks, duration):
    """Every plan must tile [0, duration) exactly, with no gap and no overlap."""
    assert chunks
    assert chunks[0].start == pytest.approx(0.0)
    assert chunks[-1].end == pytest.approx(duration)
    for previous, following in zip(chunks, chunks[1:]):
        assert previous.end == pytest.approx(following.start)
        assert previous.end > previous.start
    assert [c.index for c in chunks] == list(range(len(chunks)))


def test_short_recording_is_one_chunk():
    chunks = plan_chunks(120.0, [], target_seconds=600, max_seconds=900)
    assert chunks == [Chunk(index=0, start=0.0, end=120.0)]


def test_recording_exactly_at_the_ceiling_is_one_chunk():
    chunks = plan_chunks(900.0, [], target_seconds=600, max_seconds=900)
    assert len(chunks) == 1


def test_zero_duration_yields_nothing():
    assert plan_chunks(0.0, []) == []


def test_long_recording_without_silences_hard_cuts_at_the_ceiling():
    duration = 3600.0
    chunks = plan_chunks(duration, [], target_seconds=600, max_seconds=900)
    _assert_tiles(chunks, duration)
    # No silence anywhere -> cut at the ceiling, minimising the number of
    # imperfect seams.
    assert all(c.duration <= 900.0 + 1e-6 for c in chunks)
    assert chunks[0].end == pytest.approx(900.0)


def test_boundary_snaps_to_the_nearest_silence():
    duration = 2000.0
    # A silence whose midpoint is 620s — well inside the ±60s search window
    # around the 600s target.
    silences = [(615.0, 625.0)]
    chunks = plan_chunks(
        duration, silences, target_seconds=600, max_seconds=900,
        search_window_seconds=60,
    )
    _assert_tiles(chunks, duration)
    assert chunks[0].end == pytest.approx(620.0)


def test_silence_outside_the_search_window_is_ignored():
    duration = 2000.0
    # Midpoint 300s: 300s away from the 600s target, far outside ±60s.
    silences = [(295.0, 305.0)]
    chunks = plan_chunks(
        duration, silences, target_seconds=600, max_seconds=900,
        search_window_seconds=60,
    )
    assert chunks[0].end == pytest.approx(900.0)


def test_closest_silence_wins_when_several_qualify():
    duration = 2000.0
    silences = [(560.0, 564.0), (596.0, 600.0), (640.0, 650.0)]
    chunks = plan_chunks(
        duration, silences, target_seconds=600, max_seconds=900,
        search_window_seconds=60,
    )
    # Midpoints are 562, 598, 645 -> 598 is nearest 600.
    assert chunks[0].end == pytest.approx(598.0)


def test_no_chunk_ever_exceeds_the_ceiling():
    duration = 4 * 3600.0
    # Silences only ever available late, past the ceiling.
    silences = [(t, t + 2.0) for t in range(1000, int(duration), 1000)]
    chunks = plan_chunks(duration, silences, target_seconds=600, max_seconds=900)
    _assert_tiles(chunks, duration)
    assert max(c.duration for c in chunks) <= 900.0 + 1e-6


def test_final_chunk_is_never_degenerate():
    # A duration just past the ceiling used to be the classic off-by-one: a
    # 900s chunk plus a 0.5s tail.
    duration = 900.5
    chunks = plan_chunks(duration, [], target_seconds=600, max_seconds=900)
    _assert_tiles(chunks, duration)
    assert all(c.duration >= 0.5 for c in chunks)


def test_unsorted_and_degenerate_silences_are_tolerated():
    duration = 2000.0
    silences = [(650.0, 640.0), (620.0, 620.0), (615.0, 625.0), (1200.0, 1210.0)]
    chunks = plan_chunks(
        duration, silences, target_seconds=600, max_seconds=900,
        search_window_seconds=60,
    )
    _assert_tiles(chunks, duration)
    assert chunks[0].end == pytest.approx(620.0)


def test_max_below_target_is_rejected():
    with pytest.raises(ValueError):
        plan_chunks(1000.0, [], target_seconds=900, max_seconds=600)


# ---------------------------------------------------------------------------
# Timestamp merging
# ---------------------------------------------------------------------------

def test_merge_segments_shifts_to_absolute_time():
    chunks = [Chunk(0, 0.0, 600.0), Chunk(1, 600.0, 1000.0)]
    parts = [
        [{"id": 0, "start": 1.0, "end": 4.0, "text": "hola"}],
        [{"id": 0, "start": 2.0, "end": 5.0, "text": "adiós"}],
    ]
    merged = merge_segments(parts, chunks)
    assert [s["start"] for s in merged] == [1.0, 602.0]
    assert [s["end"] for s in merged] == [4.0, 605.0]
    # Ids are re-numbered across the whole recording, not per chunk.
    assert [s["id"] for s in merged] == [0, 1]


def test_join_text_does_not_leak_chunk_boundaries():
    # A chunk boundary is an artefact of our memory budget. Emitting it as a
    # newline would make the downstream RAG chunker split on a fiction.
    assert join_text(["hola", "  ", "qué tal"]) == "hola qué tal"
    assert "\n" not in join_text(["a", "b"])
