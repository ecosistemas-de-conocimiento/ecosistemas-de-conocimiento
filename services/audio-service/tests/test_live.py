"""Live transcription: slice append, commit rule, decode of a cut WebM, route."""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from typing import List

import pytest

os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

from fastapi.testclient import TestClient  # noqa: E402

from app import live as live_mod  # noqa: E402
from app.config import Settings, get_settings  # noqa: E402
from app.live import (  # noqa: E402
    MAX_PER_OWNER,
    LiveError,
    LiveSession,
    LiveStore,
    LiveTranscriber,
    advance,
    cap_window,
    decode_pcm,
    new_bytes,
)
from app.main import create_app  # noqa: E402
from app.routes import live as live_routes  # noqa: E402
from app.transcriber import TranscriptPart  # noqa: E402

from .conftest import make_tone, requires_ffmpeg, transcode

KEY_A = "live-key-a"
KEY_B = "live-key-b"
API_KEYS_JSON = (
    '{"' + KEY_A + '":{"org":"acme","project":"repo","role":"app","callbackSecret":"' + "d" * 40 + '"},'
    '"' + KEY_B + '":{"org":"other","project":"repo","role":"app","callbackSecret":"' + "d" * 40 + '"}}'
)
SECRET_WORDS = "testimonio crudo que nunca se registra"


def _seg(start: float, end: float, text: str) -> dict:
    return {"id": 0, "start": start, "end": end, "text": text, "noSpeechProb": 0.0}


# ── new_bytes ───────────────────────────────────────────────────────────────

def test_new_bytes_is_idempotent_and_refuses_gaps():
    session = LiveSession()
    assert new_bytes(session, 0, b"abc") == b"abc"
    session.received = 3
    assert new_bytes(session, 0, b"abc") == b""  # resend
    assert new_bytes(session, 1, b"bcde") == b"de"  # overlap adds only the tail
    with pytest.raises(LiveError) as err:
        new_bytes(session, 9, b"x")
    assert err.value.status == 409


# ── per-owner cap ───────────────────────────────────────────────────────────

def test_one_owner_cannot_fill_the_store_and_oldest_is_evicted():
    store = LiveStore()
    for i in range(MAX_PER_OWNER + 3):
        store.get_or_create(f"key:u1.s{i}")
    assert len(store) == MAX_PER_OWNER
    # The newest survive; another owner is unaffected.
    store.get_or_create("key:u2.a")
    assert len(store) == MAX_PER_OWNER + 1
    assert store.drop(f"key:u1.s{MAX_PER_OWNER + 2}")
    assert not store.drop("key:u1.s0")


# ── commit rule ─────────────────────────────────────────────────────────────

def test_short_window_stays_tentative():
    session = LiveSession()
    advance(session, [_seg(0, 2, " hola"), _seg(2, 4, " mundo")], window_s=5.0, total_samples=80000)
    assert session.committed == [] and session.snapshot()["tentative"] == "hola mundo"
    assert session.committed_samples == 0


def test_long_window_commits_all_but_last_segment():
    session = LiveSession()
    advance(session, [_seg(0, 6, " uno pu"), _seg(6, 11, "ertas"), _seg(11, 13, " tres")], window_s=13.0, total_samples=208000)
    # A mid-word split ("pu" + "ertas") rejoins without a space.
    assert session.snapshot()["committed"] == "uno puertas"
    assert session.snapshot()["tentative"] == " tres"
    assert session.committed_samples == 11 * 16000


def test_never_cuts_before_a_mid_word_piece():
    session = LiveSession()
    advance(session, [_seg(0, 6, " uno"), _seg(6, 11, " porque du"), _seg(11, 13, "elen")], window_s=13.0, total_samples=208000)
    assert session.snapshot()["committed"] == "uno"
    assert session.snapshot()["tentative"] == " porque duelen"
    assert session.committed_samples == 6 * 16000


def test_cut_at_start_zero_or_past_window_is_ignored():
    session = LiveSession()
    # Missing start (0) on the only word-starting segment: no cut, no double commit.
    advance(session, [_seg(0, 6, " uno"), _seg(0, 11, " dos")], window_s=13.0, total_samples=208000)
    assert session.committed == [] and session.committed_samples == 0
    # A start past the window must not skip unheard audio.
    advance(session, [_seg(0, 6, " uno"), _seg(40, 41, " dos")], window_s=13.0, total_samples=208000)
    assert session.committed_samples == 0


def test_cap_window_bounds_the_audio_sent_when_whisper_keeps_failing():
    session = LiveSession(tentative=" algo")
    cap_window(session, total_samples=100 * 16000)
    assert session.committed_samples == 75 * 16000
    assert session.snapshot()["committed"] == "algo" and session.tentative == ""
    cap_window(session, total_samples=90 * 16000)  # within bounds: untouched
    assert session.committed_samples == 75 * 16000


def test_window_at_cap_commits_whole():
    session = LiveSession()
    advance(session, [_seg(0, 25, " largo")], window_s=26.0, total_samples=416000)
    assert session.snapshot()["committed"] == "largo" and session.tentative == ""
    assert session.committed_samples == 416000


# ── decode ──────────────────────────────────────────────────────────────────

@requires_ffmpeg
def test_decode_keeps_frames_of_a_stream_cut_mid_way(tmp_path):
    wav = make_tone(str(tmp_path / "t.wav"), seconds=4.0)
    webm = transcode(wav, str(tmp_path / "t.webm"))
    data = open(webm, "rb").read()
    pcm = asyncio.run(decode_pcm(data[: len(data) // 2]))
    seconds = len(pcm) / 2 / 16000
    assert 1.0 < seconds < 3.5


# ── route ───────────────────────────────────────────────────────────────────

class FakeTranscriber:
    def __init__(self) -> None:
        self.calls: List[float] = []

    def transcribe_bytes(self, audio: bytes, filename: str = "x.wav", language=None, *, keep_spacing=False) -> TranscriptPart:
        seconds = (len(audio) - 44) / 2 / 16000
        self.calls.append(seconds)
        return TranscriptPart(
            text=SECRET_WORDS, segments=[_seg(0, seconds, SECRET_WORDS)],
            language="es", language_probability=1.0, duration=seconds,
        )


@pytest.fixture
def live_client(monkeypatch):
    settings = Settings(API_KEYS=API_KEYS_JSON)
    fake = FakeTranscriber()
    live = LiveTranscriber(settings, transcriber=fake)
    app = create_app()
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[live_routes.get_live] = lambda: live

    @asynccontextmanager
    async def _no_lifespan(_app):
        yield

    app.router.lifespan_context = _no_lifespan
    with TestClient(app) as client:
        client.fake = fake
        client.live = live
        yield client
        client.portal.call(live.store.aclose)


@pytest.fixture
def webm(tmp_path) -> bytes:
    wav = make_tone(str(tmp_path / "t.wav"), seconds=3.0)
    return open(transcode(wav, str(tmp_path / "t.webm")), "rb").read()


def _auth(key: str) -> dict:
    return {"Authorization": f"Bearer {key}"}


@requires_ffmpeg
def test_chunks_return_partial_text_and_never_log_it(live_client, webm, caplog):
    caplog.set_level(logging.DEBUG)
    half = len(webm) // 2
    r1 = live_client.post("/v1/live/s1/chunk?offset=0", content=webm[:half], headers=_auth(KEY_A))
    assert r1.status_code == 200, r1.text
    r2 = live_client.post(f"/v1/live/s1/chunk?offset={half}", content=webm[half:], headers=_auth(KEY_A))
    body = r2.json()
    assert body["tentative"] == SECRET_WORDS
    assert body["received"] == len(webm)
    assert body["seconds"] > 2.5
    assert r2.headers["cache-control"] == "no-store"
    assert SECRET_WORDS not in caplog.text


@requires_ffmpeg
def test_sessions_are_scoped_per_api_key(live_client, webm):
    live_client.post("/v1/live/same/chunk?offset=0", content=webm, headers=_auth(KEY_A))
    # Same id under another key is a fresh session: offset 0 is expected, not len(webm).
    r = live_client.post(f"/v1/live/same/chunk?offset={len(webm)}", content=b"x", headers=_auth(KEY_B))
    assert r.status_code == 409
    assert len(live_client.live.store) == 1


@requires_ffmpeg
def test_delete_drops_session(live_client, webm):
    live_client.post("/v1/live/s2/chunk?offset=0", content=webm, headers=_auth(KEY_A))
    assert live_client.delete("/v1/live/s2", headers=_auth(KEY_A)).status_code == 204
    assert len(live_client.live.store) == 0


def test_requires_auth(live_client):
    assert live_client.post("/v1/live/s/chunk", content=b"x").status_code == 401


def test_bad_session_id(live_client):
    r = live_client.post("/v1/live/a%20b/chunk", content=b"x", headers=_auth(KEY_A))
    assert r.status_code == 400


def test_unavailable_without_remote_backend():
    live = LiveTranscriber(Settings(API_KEYS=API_KEYS_JSON, WHISPER_BACKEND="local"))
    with pytest.raises(LiveError) as err:
        asyncio.run(live.push("k", 0, b"x"))
    assert err.value.code == "live_unavailable"


def test_whisper_failure_is_502_without_text(monkeypatch):
    class Boom:
        def transcribe_bytes(self, *a, **k):
            raise RuntimeError(SECRET_WORDS)

    live = LiveTranscriber(Settings(API_KEYS=API_KEYS_JSON), transcriber=Boom())

    async def fake_decode(data, **kwargs):
        return b"\x00\x00" * 16000 * 2

    monkeypatch.setattr(live_mod, "decode_pcm", fake_decode)

    async def run():
        try:
            await live.push("k", 0, b"x")
        finally:
            await live.store.aclose()

    with pytest.raises(LiveError) as err:
        asyncio.run(run())
    assert err.value.status == 502 and SECRET_WORDS not in str(err.value)


@requires_ffmpeg
def test_long_stream_sends_bounded_windows(live_client, tmp_path):
    """60 s fed in slices: every Whisper call stays within MAX_WINDOW_S, and
    the session ends up decoding the whole stream (streaming decoder)."""
    wav = make_tone(str(tmp_path / "long.wav"), seconds=60.0)
    data = open(transcode(wav, str(tmp_path / "long.webm")), "rb").read()
    step = len(data) // 24 + 1
    body = None
    for i in range(24):
        r = live_client.post(
            f"/v1/live/u9.long/chunk?offset={i * step}",
            content=data[i * step:(i + 1) * step],
            headers=_auth(KEY_A),
        )
        assert r.status_code == 200, r.text
        body = r.json()
    assert body["received"] == len(data)
    assert body["seconds"] > 55
    assert max(live_client.fake.calls) <= 25.5
    session = next(iter(live_client.live.store._sessions.values()))
    assert session.head is None  # streaming decoder took over
    assert len(session.decoder.pcm) <= 26 * 32000
