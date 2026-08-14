"""REAL Spanish transcription, end to end, through the real model.

## Read this before trusting or dismissing this file

This test has **never been executed** by the agent that wrote it. The machine it
was written on has no `faster-whisper` installed and no TTS engine, so neither
the model nor the Spanish fixture could be produced there. It is written to run,
not asserted to have run. Treat its first green run as the moment the pipeline
is actually verified.

It is written to **skip loudly, never to pass vacuously**. Three preconditions,
each reported by name when missing:

  1. `AUDIO_E2E=1` — opt in. On CPU this takes tens of seconds to minutes.
  2. `faster_whisper` importable and the weights present.
  3. `tests/fixtures/spanish-sample.wav` — build it with
     `./scripts/make-fixtures.sh` (needs `espeak-ng`).

Inside a built container all three are one command away::

    docker compose run --rm -e AUDIO_E2E=1 audio-service-worker \\
      sh -c "apt-get update && apt-get install -y espeak-ng \\
             && ./scripts/make-fixtures.sh && pytest tests/test_transcribe_e2e.py -v"

## Why the assertion is content-word recall, not WER

The fixture is espeak-ng output: a formant synthesiser, not a person. A word
error rate measured against it would be a statement about espeak's prosody, not
about our pipeline. What we can honestly assert is that the distinctive Spanish
content words survive the whole path — container decode, VAD, chunking, model,
merge — with correct accents and no English contamination. That is the property
a regression would break.
"""

from __future__ import annotations

import os
import re
import unicodedata
from pathlib import Path

import pytest

from app.config import Settings
from app.pipeline import run_pipeline
from app.transcriber import Transcriber

pytestmark = pytest.mark.e2e

FIXTURE = Path(__file__).parent / "fixtures" / "spanish-sample.wav"

# Keep in sync with scripts/make-fixtures.sh.
SPOKEN_TEXT = (
    "La reunión del comité de transparencia se celebró el martes en la ciudad "
    "de Morelia. Se aprobó el presupuesto para el programa de educación "
    "ambiental."
)

#: Distinctive content words. Function words ("la", "de", "el") are excluded —
#: they carry no signal and would pass on almost any output.
EXPECTED_WORDS = [
    "reunión",
    "comité",
    "transparencia",
    "celebró",
    "martes",
    "ciudad",
    "morelia",
    "aprobó",
    "presupuesto",
    "programa",
    "educación",
    "ambiental",
]

#: A word appearing here means the model drifted to English — a real failure
#: mode when `language` is not pinned, and the reason WHISPER_LANGUAGE defaults
#: to "es".
ENGLISH_LEAKAGE = ["meeting", "committee", "budget", "city", "the", "tuesday"]


def _strip_accents(value: str) -> str:
    return "".join(
        ch for ch in unicodedata.normalize("NFD", value)
        if unicodedata.category(ch) != "Mn"
    )


def _tokens(text: str) -> set[str]:
    return set(re.findall(r"[a-záéíóúüñ]+", text.lower()))


def _require_preconditions() -> None:
    if os.environ.get("AUDIO_E2E") != "1":
        pytest.skip(
            "SKIPPED: set AUDIO_E2E=1 to run the real Spanish transcription test. "
            "It loads the Whisper model and takes tens of seconds on CPU."
        )
    pytest.importorskip(
        "faster_whisper",
        reason="SKIPPED: faster-whisper is not installed; pip install -r requirements.txt",
    )
    if not FIXTURE.exists():
        pytest.skip(
            f"SKIPPED: {FIXTURE} is missing. Build it with ./scripts/make-fixtures.sh "
            "(needs espeak-ng). It is generated, not committed."
        )


@pytest.fixture(scope="module")
def loaded_transcriber() -> Transcriber:
    _require_preconditions()
    # `small` by default here: this test is about the pipeline being correct,
    # not about squeezing the last point of accuracy, and `small` keeps a CI run
    # to well under a minute. Override with WHISPER_MODEL to test the real
    # production weights.
    settings = Settings(WHISPER_MODEL=os.environ.get("E2E_WHISPER_MODEL", "small"))
    transcriber = Transcriber(settings)
    transcriber.load()
    return transcriber


async def test_a_real_spanish_recording_transcribes(tmp_path, loaded_transcriber):
    settings = Settings(AUDIO_WORK_DIR=str(tmp_path))
    result = await run_pipeline(
        source_path=str(FIXTURE),
        scratch_dir=str(tmp_path / "scratch"),
        settings=settings,
        transcriber=loaded_transcriber,
        language="es",
    )

    assert result.text.strip(), "transcription produced no text at all"
    assert result.language == "es"
    assert result.chunk_count == 1
    assert result.duration_seconds > 1.0
    assert result.segments, "no segments were produced"
    assert result.segments[0]["start"] >= 0.0

    # Accent-insensitive matching: a missing accent is a cosmetic miss, and
    # failing on it would make this test about orthography rather than about
    # whether the pipeline works.
    found = {_strip_accents(word) for word in _tokens(result.text)}
    expected = [(word, _strip_accents(word)) for word in EXPECTED_WORDS]
    hits = [original for original, plain in expected if plain in found]

    recall = len(hits) / len(expected)
    assert recall >= 0.6, (
        f"only {len(hits)}/{len(expected)} expected Spanish content words were "
        f"recognised (recall {recall:.0%}).\n"
        f"  expected: {[w for w, _ in expected]}\n"
        f"  got     : {result.text!r}"
    )


async def test_the_output_is_spanish_not_english(tmp_path, loaded_transcriber):
    settings = Settings(AUDIO_WORK_DIR=str(tmp_path))
    result = await run_pipeline(
        source_path=str(FIXTURE),
        scratch_dir=str(tmp_path / "scratch-2"),
        settings=settings,
        transcriber=loaded_transcriber,
        language="es",
    )
    leaked = _tokens(result.text) & set(ENGLISH_LEAKAGE)
    assert not leaked, (
        f"English words {sorted(leaked)} in a Spanish transcription — the "
        f"language pin is not taking effect. Got: {result.text!r}"
    )


async def test_a_transcoded_m4a_gives_the_same_content(tmp_path, loaded_transcriber):
    """The format people actually upload from a phone, not a lab WAV."""
    m4a = FIXTURE.with_suffix(".m4a")
    if not m4a.exists():
        pytest.skip(f"SKIPPED: {m4a} is missing; run ./scripts/make-fixtures.sh")

    settings = Settings(AUDIO_WORK_DIR=str(tmp_path))
    from_wav = await run_pipeline(
        source_path=str(FIXTURE), scratch_dir=str(tmp_path / "a"),
        settings=settings, transcriber=loaded_transcriber, language="es",
    )
    from_m4a = await run_pipeline(
        source_path=str(m4a), scratch_dir=str(tmp_path / "b"),
        settings=settings, transcriber=loaded_transcriber, language="es",
    )
    wav_words = {_strip_accents(w) for w in _tokens(from_wav.text)}
    m4a_words = {_strip_accents(w) for w in _tokens(from_m4a.text)}
    if not wav_words:
        pytest.fail("the WAV path produced no words to compare against")
    overlap = len(wav_words & m4a_words) / len(wav_words)
    assert overlap >= 0.7, (
        f"lossy transcoding changed the transcript too much (overlap {overlap:.0%}).\n"
        f"  wav: {from_wav.text!r}\n"
        f"  m4a: {from_m4a.text!r}"
    )
