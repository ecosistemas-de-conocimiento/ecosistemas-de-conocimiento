"""Long-recording chunk planning — pure, deterministic, no I/O.

## Why chunk at all

Two independent reasons, and only one of them is the obvious one:

1. **Memory.** faster-whisper decodes a file by loading the whole waveform as
   float32 mono 16 kHz. That is ~230 MB per hour of audio, before the model's
   own working set. A 6-hour lecture is ~1.4 GB of array on top of ~1 GB of
   weights — enough to OOM a modest container. Chunking bounds the resident
   waveform to `CHUNK_MAX_SECONDS`.
2. **Progress and blast radius.** A single 4-hour decode is an opaque, all-or-
   nothing unit: no progress to report, and a crash at minute 230 throws away
   everything. Chunks give us per-chunk progress callbacks and a natural place
   to checkpoint.

(The HTTP timeout is NOT one of the reasons — transcription runs on the queue,
so no client is holding a socket open. The upload itself is streamed to disk.)

## Why cut at silences instead of on a fixed grid

A fixed cut lands mid-word roughly always. Whisper then hallucinates the end of
one chunk and the start of the next, and you get duplicated or mangled words at
every seam. The usual workaround is overlapping windows plus fuzzy de-duplication
at the join — which is fiddly, lossy, and hard to test.

Cutting at a real silence removes the problem instead of patching it: no word
spans the boundary, so no overlap and no de-duplication are needed. ffmpeg's
`silencedetect` gives us the silence intervals; this module picks which ones to
cut at.

Fallback: if no silence exists near the target boundary (continuous speech, or a
noisy recording where nothing crosses the threshold), we hard-cut at
`CHUNK_MAX_SECONDS`. That seam may be imperfect — a hard cut in continuous
speech is unavoidable and the alternative (an unbounded chunk) is worse.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Sequence, Tuple

#: A silence, as `(start_seconds, end_seconds)`.
Silence = Tuple[float, float]


@dataclass(frozen=True)
class Chunk:
    index: int
    start: float
    end: float

    @property
    def duration(self) -> float:
        return self.end - self.start


def plan_chunks(
    duration: float,
    silences: Sequence[Silence] = (),
    *,
    target_seconds: float = 600.0,
    max_seconds: float = 900.0,
    search_window_seconds: float = 60.0,
    min_chunk_seconds: float = 1.0,
) -> List[Chunk]:
    """Split `[0, duration)` into contiguous, non-overlapping chunks.

    Guarantees, all asserted by the test suite:
      - chunks tile the whole recording exactly: `chunks[0].start == 0`,
        `chunks[-1].end == duration`, and `chunks[i].end == chunks[i+1].start`;
      - every chunk except possibly a degenerate final one is longer than
        `min_chunk_seconds`;
      - no chunk is longer than `max_seconds`;
      - the boundary is placed at the midpoint of a detected silence whenever
        one falls within `±search_window_seconds` of the target boundary.

    `silences` need not be sorted; entries that are inverted or zero-length are
    ignored.
    """
    if duration <= 0:
        return []
    if max_seconds < target_seconds:
        raise ValueError("max_seconds must be >= target_seconds")
    if target_seconds <= 0:
        raise ValueError("target_seconds must be > 0")

    # Normalise: drop degenerate intervals, clamp to the recording, sort by
    # midpoint (which is the only property the search below uses).
    midpoints = sorted(
        (start + end) / 2.0
        for start, end in silences
        if end > start and end > 0 and start < duration
    )

    if duration <= max_seconds:
        return [Chunk(index=0, start=0.0, end=duration)]

    chunks: List[Chunk] = []
    cursor = 0.0
    index = 0

    while duration - cursor > max_seconds:
        nominal = cursor + target_seconds
        # A cut must leave a usable chunk behind it and must not exceed the
        # hard ceiling ahead of it.
        lower = max(cursor + min_chunk_seconds, nominal - search_window_seconds)
        upper = min(cursor + max_seconds, nominal + search_window_seconds)
        # It must also leave something after it worth transcribing.
        upper = min(upper, duration - min_chunk_seconds)

        cut = _nearest_midpoint(midpoints, nominal, lower, upper)
        if cut is None:
            # No silence in range — hard-cut at the ceiling, not at the target.
            # Cutting at the ceiling rather than the target minimises the NUMBER
            # of imperfect seams across the recording.
            cut = min(cursor + max_seconds, duration - min_chunk_seconds)

        # Defensive: never emit a zero/negative-length chunk even if the caller
        # passed a pathological combination of bounds.
        if cut <= cursor:
            cut = min(cursor + max_seconds, duration)

        chunks.append(Chunk(index=index, start=cursor, end=cut))
        cursor = cut
        index += 1

    chunks.append(Chunk(index=index, start=cursor, end=duration))
    return chunks


def _nearest_midpoint(
    midpoints: Sequence[float], nominal: float, lower: float, upper: float
) -> float | None:
    """The midpoint inside `[lower, upper]` closest to `nominal`, or None.

    Linear scan: `midpoints` is at most a few thousand entries for a multi-hour
    recording and this runs once per chunk boundary, so a bisect adds risk
    without buying anything measurable.
    """
    if lower > upper:
        return None
    best: float | None = None
    best_distance = float("inf")
    for mid in midpoints:
        if mid < lower:
            continue
        if mid > upper:
            break  # sorted — nothing further can qualify
        distance = abs(mid - nominal)
        if distance < best_distance:
            best = mid
            best_distance = distance
    return best


def merge_segments(
    parts: Sequence[Sequence[dict]],
    chunks: Sequence[Chunk],
) -> List[dict]:
    """Concatenate per-chunk segment lists, shifting timestamps to absolute time.

    Each chunk was decoded as a standalone file, so its segment timestamps start
    at 0. Adding `chunk.start` puts them back on the recording's timeline, which
    is what makes a transcript citable against the original audio.
    """
    merged: List[dict] = []
    for part, chunk in zip(parts, chunks):
        for segment in part:
            merged.append(
                {
                    **segment,
                    "start": round(float(segment.get("start", 0.0)) + chunk.start, 3),
                    "end": round(float(segment.get("end", 0.0)) + chunk.start, 3),
                }
            )
    # Re-index after the shift so `id` is monotonic across the whole recording.
    for position, segment in enumerate(merged):
        segment["id"] = position
    return merged


def join_text(parts: Sequence[str]) -> str:
    """Join per-chunk text with a single space, collapsing empty parts.

    Deliberately NOT `"\\n".join` — chunk boundaries are an artefact of our
    memory budget, not a feature of the speech, and leaking them as paragraph
    breaks would make the downstream RAG chunker split on a fiction.
    """
    cleaned = [part.strip() for part in parts if part and part.strip()]
    return " ".join(cleaned)
