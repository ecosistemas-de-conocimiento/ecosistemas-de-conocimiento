"""The ASGI body-size guard.

Regression tests for a real hole: FastAPI parses a multipart body BEFORE it
resolves dependencies, so the route's own byte counter ran after Starlette had
already spooled the whole upload to a temp file — and after `require_auth` had
NOT yet run. An unauthenticated client could push gigabytes into the container
and get a 401 afterwards.
"""

from __future__ import annotations

import io

import pytest

pytest.importorskip("fastapi", reason="fastapi not installed")

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.limits import BodySizeLimitMiddleware  # noqa: E402

MAX = 1024


@pytest.fixture
def client():
    app = FastAPI()

    @app.post("/v1/echo")
    async def echo(payload: bytes = b"") -> dict:  # pragma: no cover - not reached
        return {"ok": True}

    @app.post("/v1/form")
    async def form_route() -> dict:
        return {"ok": True}

    @app.get("/health")
    async def health() -> dict:
        return {"status": "ok"}

    app.add_middleware(BodySizeLimitMiddleware, max_bytes=MAX, guarded_prefixes=("/v1/",))
    return TestClient(app)


def test_an_oversized_body_is_rejected_with_413(client):
    response = client.post("/v1/echo", content=b"x" * (MAX + 1))
    assert response.status_code == 413
    assert response.json()["error"] == "payload_too_large"


def test_the_rejection_happens_without_authentication(client):
    """The point of the fix: no credential is needed to be refused.

    The old behaviour accepted the bytes first and rejected the caller second,
    which is a denial-of-service anyone could run.
    """
    response = client.post("/v1/echo", content=b"x" * (MAX * 4))
    assert response.status_code == 413
    # Not 401 — we never got as far as looking for a token, and that is correct:
    # the body must be refused before anything reads it.


def test_an_oversized_multipart_upload_is_rejected(client):
    response = client.post(
        "/v1/form",
        files={"file": ("big.wav", io.BytesIO(b"\x00" * (MAX * 3)), "audio/wav")},
    )
    assert response.status_code == 413


def test_a_body_at_the_limit_passes(client):
    assert client.post("/v1/echo", content=b"x" * MAX).status_code != 413


def test_a_small_body_passes(client):
    assert client.post("/v1/echo", content=b"hello").status_code != 413


def test_unguarded_paths_are_untouched(client):
    """`/health` must answer even if something upstream is misbehaving."""
    assert client.get("/health").status_code == 200


def test_a_chunked_body_with_no_content_length_is_still_counted(client):
    """A client that omits Content-Length must not bypass the cap."""

    def chunks():
        for _ in range(8):
            yield b"y" * (MAX // 2)

    response = client.post("/v1/echo", content=chunks())
    # Either the middleware's streaming counter refuses it, or the connection is
    # torn down. What must NOT happen is a 2xx.
    assert response.status_code >= 400
