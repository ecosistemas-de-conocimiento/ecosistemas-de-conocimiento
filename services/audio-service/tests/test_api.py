"""HTTP surface: auth, upload validation, tenant scoping, status reads.

The queue is stubbed (we assert what was enqueued, not that a worker ran) and
Redis is fakeredis, but ffmpeg is REAL: the uploaded bytes are a genuine audio
file and the route's ffprobe gate actually runs.
"""

from __future__ import annotations

import io
from contextlib import asynccontextmanager
from typing import Any, Dict, List

import pytest

pytest.importorskip("fastapi", reason="fastapi not installed")
fakeredis = pytest.importorskip("fakeredis", reason="fakeredis not installed")

from fastapi.testclient import TestClient  # noqa: E402

from app.config import Settings, get_settings  # noqa: E402
from app.main import create_app  # noqa: E402
from app.routes import transcribe as transcribe_routes  # noqa: E402
from app.store import (  # noqa: E402
    JobRow,
    JobStore,
    STATUS_COMPLETED,
    STATUS_QUEUED,
    now_iso,
)
from .conftest import make_tone, requires_ffmpeg

pytestmark = requires_ffmpeg

APP_KEY = "test-app-key"
OTHER_KEY = "other-tenant-key"
ADMIN_KEY = "test-admin-key"
SECRET = "d" * 40

API_KEYS_JSON = (
    '{"' + APP_KEY + '":{"org":"acme","project":"repo","role":"app",'
    '"callbackSecret":"' + SECRET + '"},'
    '"' + OTHER_KEY + '":{"org":"other","project":"repo","role":"app",'
    '"callbackSecret":"' + SECRET + '"},'
    '"' + ADMIN_KEY + '":{"org":"acme","project":"repo","role":"admin"}}'
)


@pytest.fixture
def enqueued() -> List[str]:
    return []


@pytest.fixture
def client(tmp_path, monkeypatch, enqueued):
    settings = Settings(
        API_KEYS=API_KEYS_JSON,
        AUDIO_WORK_DIR=str(tmp_path / "work"),
        # 8 MiB is comfortably above a 75s 16 kHz mono WAV (~2.4 MB), so the
        # duration test below trips the DURATION cap and not the size cap.
        MAX_UPLOAD_BYTES=8 * 1024 * 1024,
        MAX_DURATION_SECONDS=60,
    )

    async def _fake_enqueue(pool, transcribe_id):
        enqueued.append(transcribe_id)
        return True

    monkeypatch.setattr(transcribe_routes, "enqueue_transcribe", _fake_enqueue)

    app = create_app()
    app.dependency_overrides[get_settings] = lambda: settings
    # One shared in-memory server, reachable from both an async client (what the
    # app uses) and a sync client (what a test uses to seed rows without
    # touching the app's event loop).
    server = fakeredis.FakeServer()
    redis = fakeredis.aioredis.FakeRedis(server=server, decode_responses=True)
    app.state.settings = settings
    app.state.redis = redis
    app.state.store = JobStore(
        redis, job_ttl=3600, transcript_ttl=3600, idempotency_ttl=3600, callback_ttl=3600
    )
    app.state.pool = object()
    # The real lifespan dials a real Redis and a real arq pool, so swap it for a
    # no-op — but STILL enter the client as a context manager. ⚠ Without the
    # `with`, TestClient runs every request on a fresh event loop, and the
    # async fakeredis connection (bound to the first request's loop) fails the
    # second request with "bound to a different event loop".
    @asynccontextmanager
    async def _no_lifespan(_app):
        yield

    app.router.lifespan_context = _no_lifespan
    with TestClient(app) as test_client:
        test_client.seed_redis = fakeredis.FakeStrictRedis(server=server, decode_responses=True)
        yield test_client


def _audio_bytes(tmp_path, seconds: float = 2.0) -> bytes:
    path = make_tone(str(tmp_path / "upload.wav"), seconds=seconds)
    with open(path, "rb") as handle:
        return handle.read()


def _upload(client, payload: bytes, *, key: str = APP_KEY, filename="junta.wav",
            content_type="audio/wav", data: Dict[str, Any] | None = None):
    return client.post(
        "/v1/transcribe",
        headers={"Authorization": f"Bearer {key}"},
        files={"file": (filename, io.BytesIO(payload), content_type)},
        data=data or {},
    )


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

def test_health_is_unauthenticated(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "audio-service"}


def test_readiness_is_503_without_a_worker(client):
    """A worker-less deployment must NOT report ready.

    Otherwise the API happily accepts uploads that will never be transcribed —
    exactly the failure a readiness probe exists to catch.
    """
    response = client.get("/health/ready")
    assert response.status_code == 503
    assert response.json()["checks"]["worker"]["ok"] is False


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

def test_missing_token_is_401(client, tmp_path):
    response = client.post("/v1/transcribe", files={"file": ("a.wav", b"x", "audio/wav")})
    assert response.status_code == 401
    assert response.json()["error"] == "unauthorized"


def test_unknown_key_is_401(client, tmp_path):
    response = _upload(client, _audio_bytes(tmp_path), key="not-a-real-key")
    assert response.status_code == 401


def test_a_non_bearer_scheme_is_401(client):
    response = client.get("/v1/transcribe/x", headers={"Authorization": f"Basic {APP_KEY}"})
    assert response.status_code == 401


# ---------------------------------------------------------------------------
# Upload
# ---------------------------------------------------------------------------

def test_a_valid_upload_is_accepted_and_enqueued(client, tmp_path, enqueued):
    response = _upload(client, _audio_bytes(tmp_path))
    assert response.status_code == 202, response.text
    body = response.json()
    assert body["status"] == STATUS_QUEUED
    # org/project come from the KEY, never from the request.
    assert body["org"] == "acme"
    assert body["project"] == "repo"
    assert body["durationSeconds"] == pytest.approx(2.0, abs=0.1)
    assert enqueued == [body["transcribeId"]]


def test_the_caller_cannot_choose_its_own_org(client, tmp_path):
    response = _upload(
        client, _audio_bytes(tmp_path), data={"org": "someone-else", "project": "x"}
    )
    assert response.status_code == 202
    assert response.json()["org"] == "acme"


def test_a_pdf_is_rejected_before_it_reaches_the_queue(client, enqueued):
    response = _upload(
        client, b"%PDF-1.7\n", filename="informe.pdf", content_type="application/pdf"
    )
    assert response.status_code == 415
    assert enqueued == []


def test_a_renamed_pdf_is_caught_by_ffprobe(client, enqueued):
    """The extension allowlist is advisory; ffprobe is the real gate."""
    response = _upload(
        client, b"%PDF-1.7\nnot audio at all\n",
        filename="disfrazado.mp3", content_type="audio/mpeg",
    )
    assert response.status_code == 415
    assert enqueued == []


def test_an_empty_file_is_rejected(client, enqueued):
    assert _upload(client, b"").status_code == 400
    assert enqueued == []


def test_an_oversized_upload_is_413(client, tmp_path, enqueued):
    # The cap is enforced WHILE streaming, so this never lands in RAM whole.
    response = _upload(client, b"\x00" * (9 * 1024 * 1024), filename="grande.wav")
    assert response.status_code == 413
    assert enqueued == []


def test_an_over_long_recording_is_413(client, tmp_path, enqueued):
    # The fixture settings cap duration at 60s.
    response = _upload(client, _audio_bytes(tmp_path, seconds=75.0))
    assert response.status_code == 413
    assert enqueued == []


def test_bad_metadata_json_is_400(client, tmp_path):
    response = _upload(client, _audio_bytes(tmp_path), data={"metadata": "{not json"})
    assert response.status_code == 400


def test_metadata_must_be_an_object(client, tmp_path):
    response = _upload(client, _audio_bytes(tmp_path), data={"metadata": "[1,2]"})
    assert response.status_code == 400


def test_a_relative_callback_url_is_400(client, tmp_path):
    response = _upload(client, _audio_bytes(tmp_path), data={"callbackUrl": "/api/cb"})
    assert response.status_code == 400


def test_the_uploaded_audio_is_written_to_disk_for_the_worker(client, tmp_path):
    import os

    response = _upload(client, _audio_bytes(tmp_path))
    upload_dir = os.path.join(str(tmp_path / "work"), "uploads")
    assert len(os.listdir(upload_dir)) == 1
    # Stored under the generated id, never under the caller's filename.
    assert os.listdir(upload_dir)[0].startswith(response.json()["transcribeId"])


# ---------------------------------------------------------------------------
# Idempotency
# ---------------------------------------------------------------------------

def test_the_same_idempotency_key_does_not_transcribe_twice(client, tmp_path, enqueued):
    payload = _audio_bytes(tmp_path)
    first = _upload(client, payload, data={"idempotencyKey": "abc"})
    second = _upload(client, payload, data={"idempotencyKey": "abc"})
    assert first.status_code == 202
    assert second.status_code == 200
    assert second.json()["deduplicated"] is True
    assert second.json()["transcribeId"] == first.json()["transcribeId"]
    assert len(enqueued) == 1


def test_a_rejected_upload_releases_its_idempotency_key(client, tmp_path, enqueued):
    """Otherwise a 413 would permanently poison that key for the tenant."""
    _upload(client, b"\x00" * (9 * 1024 * 1024), data={"idempotencyKey": "reuse-me"})
    good = _upload(client, _audio_bytes(tmp_path), data={"idempotencyKey": "reuse-me"})
    assert good.status_code == 202
    assert len(enqueued) == 1


def test_idempotency_keys_do_not_collide_across_tenants(client, tmp_path, enqueued):
    payload = _audio_bytes(tmp_path)
    first = _upload(client, payload, key=APP_KEY, data={"idempotencyKey": "shared"})
    second = _upload(client, payload, key=OTHER_KEY, data={"idempotencyKey": "shared"})
    assert first.status_code == 202
    assert second.status_code == 202
    assert first.json()["transcribeId"] != second.json()["transcribeId"]


# ---------------------------------------------------------------------------
# Status reads + tenant scoping
# ---------------------------------------------------------------------------

def test_status_reflects_the_queued_job(client, tmp_path):
    created = _upload(client, _audio_bytes(tmp_path), data={"externalId": "doc-42"}).json()
    response = client.get(
        f"/v1/transcribe/{created['transcribeId']}",
        headers={"Authorization": f"Bearer {APP_KEY}"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == STATUS_QUEUED
    assert body["externalId"] == "doc-42"
    assert body["transcript"] is None


def test_another_tenant_gets_404_not_403(client, tmp_path):
    """404, not 403: a 403 confirms the id exists, which is an existence oracle."""
    created = _upload(client, _audio_bytes(tmp_path)).json()
    response = client.get(
        f"/v1/transcribe/{created['transcribeId']}",
        headers={"Authorization": f"Bearer {OTHER_KEY}"},
    )
    assert response.status_code == 404


def test_an_unknown_id_is_404(client):
    response = client.get(
        "/v1/transcribe/00000000-0000-0000-0000-000000000000",
        headers={"Authorization": f"Bearer {APP_KEY}"},
    )
    assert response.status_code == 404


def test_a_completed_job_returns_text_and_omits_segments_by_default(client):
    import json

    from app.store import JOB_PREFIX, TRANSCRIPT_PREFIX

    row = JobRow(
        transcribeId="done-1", org="acme", project="repo",
        apiKeyId="x", status=STATUS_COMPLETED,
        createdAt=now_iso(), updatedAt=now_iso(),
    )
    client.seed_redis.hset(JOB_PREFIX + "done-1", mapping=row.to_redis())
    client.seed_redis.set(
        TRANSCRIPT_PREFIX + "done-1",
        json.dumps(
            {
                "text": "La sesión de mañana en Michoacán.",
                "segments": [{"id": 0, "start": 0.0, "end": 2.0, "text": "La sesión"}],
                "language": "es",
            },
            ensure_ascii=False,
        ),
    )

    headers = {"Authorization": f"Bearer {APP_KEY}"}
    default = client.get("/v1/transcribe/done-1", headers=headers).json()
    assert default["transcript"]["text"] == "La sesión de mañana en Michoacán."
    # Segments are heavy on a long recording and most consumers only want text.
    assert "segments" not in default["transcript"]

    with_segments = client.get(
        "/v1/transcribe/done-1?includeSegments=true", headers=headers
    ).json()
    assert len(with_segments["transcript"]["segments"]) == 1


# ---------------------------------------------------------------------------
# Admin
# ---------------------------------------------------------------------------

def test_dead_letter_listing_requires_an_admin_key(client):
    app_response = client.get(
        "/v1/admin/dead-letters", headers={"Authorization": f"Bearer {APP_KEY}"}
    )
    assert app_response.status_code == 403
    admin_response = client.get(
        "/v1/admin/dead-letters", headers={"Authorization": f"Bearer {ADMIN_KEY}"}
    )
    assert admin_response.status_code == 200
    assert admin_response.json()["queue"] == "transcribe"


def test_dead_letter_queue_name_is_validated(client):
    response = client.get(
        "/v1/admin/dead-letters?queue=bogus",
        headers={"Authorization": f"Bearer {ADMIN_KEY}"},
    )
    assert response.status_code == 400
