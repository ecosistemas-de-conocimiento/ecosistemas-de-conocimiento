"""RemoteTranscriber against a mocked whisper-server (httpx.MockTransport).

The response bodies mirror whisper.cpp `examples/server/server.cpp`
verbose_json (see the module docstring of `app/remote_transcriber.py`). No
network, no model, no ffmpeg — the "WAV" is a few bytes, since the mock never
decodes it.
"""

from __future__ import annotations

import sys
from typing import Callable, List

import httpx
import pytest

from app.config import Settings
from app.remote_transcriber import (
    CODE_REJECTED,
    CODE_UNAVAILABLE,
    RemoteTranscriber,
    RemoteTranscriberError,
)
from app.transcriber import Transcriber, TranscriptPart, build_transcriber
from app.worker import NON_RETRYABLE_CODES

BASE = "http://spark.test:8178"

VERBOSE_JSON = {
    "task": "transcribe",
    "language": "spanish",
    "duration": 12.5,
    "text": " Hola a todos. Bienvenidos.",
    "segments": [
        {"id": 0, "text": " Hola a todos.", "start": 0.0, "end": 2.4,
         "tokens": [1, 2], "words": [], "temperature": 0.0,
         "avg_logprob": -0.2, "no_speech_prob": 0.01234},
        # Whitespace-only segments are dropped, as in the local backend.
        {"id": 1, "text": "  ", "start": 2.4, "end": 3.0, "no_speech_prob": 0.9},
        {"id": 2, "text": " Bienvenidos.", "start": 3.0, "end": 4.56,
         "no_speech_prob": 0.02},
        # The stray trailing "," large-v3 emits on the Spark — dropped too.
        {"id": 3, "text": ",", "start": 4.56, "end": 4.6, "no_speech_prob": 0.5},
    ],
}


def _settings(**overrides) -> Settings:
    base = dict(WHISPER_BACKEND="remote", WHISPER_REMOTE_URL=BASE + "/")
    base.update(overrides)
    return Settings(**base)


def _make(handler: Callable[[httpx.Request], httpx.Response], **overrides) -> RemoteTranscriber:
    transcriber = RemoteTranscriber(_settings(**overrides), transport=httpx.MockTransport(handler))
    transcriber._loaded = True  # skip the /health probe; tested separately
    return transcriber


@pytest.fixture
def wav(tmp_path) -> str:
    path = tmp_path / "chunk-000.wav"
    path.write_bytes(b"RIFF....WAVEfmt ")
    return str(path)


# ── Success mapping ─────────────────────────────────────────────────────────

def test_success_maps_verbose_json_to_transcript_part(wav):
    seen: List[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=VERBOSE_JSON)

    part = _make(handler, WHISPER_REMOTE_TOKEN="tok-123").transcribe(wav, "es")

    assert isinstance(part, TranscriptPart)
    assert part.text == "Hola a todos. Bienvenidos."
    assert part.segments == [
        {"id": 0, "start": 0.0, "end": 2.4, "text": "Hola a todos.", "noSpeechProb": 0.0123},
        {"id": 1, "start": 3.0, "end": 4.56, "text": "Bienvenidos.", "noSpeechProb": 0.02},
    ]
    # Forced language: report the ISO code we asked for, not "spanish".
    assert part.language == "es"
    assert part.language_probability == 1.0
    assert part.duration == 12.5

    request = seen[0]
    assert str(request.url) == BASE + "/inference"  # trailing slash stripped
    assert request.headers["authorization"] == "Bearer tok-123"
    # 🔴 The Spark's token proxy answers 411 to chunked uploads.
    assert "transfer-encoding" not in request.headers
    body = request.read().decode("latin-1")
    assert int(request.headers["content-length"]) == len(request.content)
    for field, value in [
        ("response_format", "verbose_json"),
        ("language", "es"),
        ("temperature", "0.0"),
        ("temperature_inc", "0.2"),
        ("no_language_probabilities", "true"),
    ]:
        assert f'name="{field}"\r\n\r\n{value}\r\n' in body
    assert 'name="file"; filename="chunk-000.wav"' in body


def test_no_token_means_no_authorization_header(wav):
    def handler(request: httpx.Request) -> httpx.Response:
        assert "authorization" not in request.headers
        return httpx.Response(200, json=VERBOSE_JSON)

    _make(handler).transcribe(wav, "es")


def test_autodetect_reads_short_code_from_language_probabilities(wav):
    payload = dict(
        VERBOSE_JSON,
        detected_language="spanish",
        detected_language_probability=0.91,
        language_probabilities={"es": 0.91, "pt": 0.07},
    )

    def handler(request: httpx.Request) -> httpx.Response:
        body = request.read().decode("latin-1")
        assert 'name="language"\r\n\r\nauto\r\n' in body
        assert 'name="no_language_probabilities"\r\n\r\nfalse\r\n' in body
        return httpx.Response(200, json=payload)

    part = _make(handler).transcribe(wav, "auto")
    assert part.language == "es"
    assert part.language_probability == pytest.approx(0.91)


# ── Error classification ────────────────────────────────────────────────────

@pytest.mark.parametrize("status", [500, 502, 503, 499, 429])
def test_5xx_and_transient_4xx_are_retryable(wav, status):
    transcriber = _make(lambda r: httpx.Response(status, json={"error": "failed to process audio"}))
    with pytest.raises(RemoteTranscriberError) as info:
        transcriber.transcribe(wav, "es")
    assert info.value.code == CODE_UNAVAILABLE
    assert info.value.status == status
    assert info.value.code not in NON_RETRYABLE_CODES


@pytest.mark.parametrize("status", [400, 401, 404, 413])
def test_4xx_is_permanent(wav, status):
    transcriber = _make(lambda r: httpx.Response(status, json={"error": "failed to read audio data"}))
    with pytest.raises(RemoteTranscriberError) as info:
        transcriber.transcribe(wav, "es")
    assert info.value.code == CODE_REJECTED
    assert info.value.code in NON_RETRYABLE_CODES
    assert "failed to read audio data" in str(info.value)


def test_timeout_is_retryable(wav):
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("read timed out", request=request)

    with pytest.raises(RemoteTranscriberError) as info:
        _make(handler).transcribe(wav, "es")
    assert info.value.code == CODE_UNAVAILABLE
    assert info.value.code not in NON_RETRYABLE_CODES


def test_connection_refused_is_retryable(wav):
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    with pytest.raises(RemoteTranscriberError) as info:
        _make(handler).transcribe(wav, "es")
    assert info.value.code == CODE_UNAVAILABLE


def test_non_json_200_is_retryable(wav):
    with pytest.raises(RemoteTranscriberError) as info:
        _make(lambda r: httpx.Response(200, text="<html>bad gateway</html>")).transcribe(wav, "es")
    assert info.value.code == CODE_UNAVAILABLE


# ── Lifecycle ───────────────────────────────────────────────────────────────

def test_load_warns_but_does_not_raise_when_server_is_down(caplog):
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route to host", request=request)

    transcriber = RemoteTranscriber(_settings(), transport=httpx.MockTransport(handler))
    assert not transcriber.loaded
    transcriber.load()
    # Ready means "configured worker is up"; a down Spark surfaces as retries.
    assert transcriber.loaded
    assert any("unreachable" in r.message for r in caplog.records)


def test_load_probes_health(caplog):
    paths: List[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        return httpx.Response(503, json={"status": "loading model"})

    transcriber = RemoteTranscriber(_settings(), transport=httpx.MockTransport(handler))
    transcriber.load()
    assert paths == ["/health"]
    assert transcriber.loaded
    assert any("503" in r.message for r in caplog.records)


def test_describe_does_not_leak_url_or_token():
    described = RemoteTranscriber(_settings(WHISPER_REMOTE_TOKEN="secret")).describe()
    assert described["backend"] == "whisper.cpp/remote"
    assert "spark.test" not in repr(described)
    assert "secret" not in repr(described)


# ── Backend selection ───────────────────────────────────────────────────────

def test_build_transcriber_selects_backend():
    assert isinstance(build_transcriber(Settings()), Transcriber)
    assert isinstance(build_transcriber(_settings()), RemoteTranscriber)


def test_remote_never_imports_faster_whisper(wav):
    sys.modules.pop("faster_whisper", None)
    transcriber = build_transcriber(_settings())
    transcriber._client = httpx.Client(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json=VERBOSE_JSON))
    )
    transcriber.load()
    transcriber.transcribe(wav, "es")
    assert "faster_whisper" not in sys.modules


def test_remote_requires_url():
    with pytest.raises(ValueError, match="WHISPER_REMOTE_URL"):
        Settings(WHISPER_BACKEND="remote", WHISPER_REMOTE_URL="")


def test_mid_word_segment_split_rejoins_without_a_space(wav):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"segments": [
            {"text": " puertas que se abren con el español y pu", "start": 0.0, "end": 2.0},
            {"text": "ertas que solo se abren", "start": 2.0, "end": 3.0},
            {"text": " con la confianza.", "start": 3.0, "end": 4.0},
        ]})

    part = _make(handler).transcribe(wav)
    assert part.text == "puertas que se abren con el español y puertas que solo se abren con la confianza."
    # Callback segments stay stripped; the live path opts into the raw spacing.
    assert part.segments[1]["text"] == "ertas que solo se abren"
