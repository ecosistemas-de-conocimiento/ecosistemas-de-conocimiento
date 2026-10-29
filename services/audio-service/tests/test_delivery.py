"""The callback delivery loop: signing, retry, dead-letter, replay.

Uses a stub HTTP client so the retry schedule can be exercised without waiting
12 minutes, and fakeredis so the delivery rows are real Redis writes.
"""

from __future__ import annotations

import base64
from typing import Any, Dict, List, Optional

import pytest

fakeredis = pytest.importorskip("fakeredis", reason="fakeredis not installed")

from app import delivery as delivery_module  # noqa: E402
from app.auth import derive_api_key_id  # noqa: E402
from app.callbacks import (  # noqa: E402
    SIGNATURE_HEADER,
    TIMESTAMP_HEADER,
    verify_signature,
)
from app.config import Settings  # noqa: E402
from app.delivery import attempt_delivery, enqueue_callback  # noqa: E402
from app.store import DLQ_CALLBACK, JobStore  # noqa: E402

RAW_KEY = "test-audio-key"
SECRET = "c" * 48
API_KEY_ID = derive_api_key_id(RAW_KEY)


@pytest.fixture
def settings() -> Settings:
    return Settings(
        API_KEYS=(
            '{"' + RAW_KEY + '":{"org":"acme","project":"repo","role":"app",'
            '"callbackSecret":"' + SECRET + '"}}'
        )
    )


@pytest.fixture
def store() -> JobStore:
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    return JobStore(
        redis, job_ttl=3600, transcript_ttl=3600, idempotency_ttl=3600, callback_ttl=3600
    )


class _Response:
    def __init__(self, status_code: int, text: str = "ok") -> None:
        self.status_code = status_code
        self.text = text


class StubClient:
    """Records every POST and replays a scripted sequence of outcomes."""

    def __init__(self, outcomes: List[Any]) -> None:
        self._outcomes = list(outcomes)
        self.calls: List[Dict[str, Any]] = []

    async def post(self, url: str, *, content: bytes, headers: Dict[str, str]) -> _Response:
        self.calls.append({"url": url, "content": content, "headers": headers})
        outcome = self._outcomes.pop(0) if self._outcomes else _Response(200)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    async def aclose(self) -> None:  # pragma: no cover - never owns the client
        pass


class StubPool:
    """Captures scheduled retries instead of enqueuing them."""

    def __init__(self) -> None:
        self.scheduled: List[Dict[str, Any]] = []


@pytest.fixture(autouse=True)
def _capture_enqueues(monkeypatch):
    scheduled: List[Dict[str, Any]] = []

    async def _fake_enqueue(
        pool, delivery_id, attempt, *, defer_seconds=0.0, nonce="", queue_name=None
    ):
        scheduled.append(
            {
                "deliveryId": delivery_id,
                "attempt": attempt,
                "defer": defer_seconds,
                "nonce": nonce,
                "queue": queue_name,
            }
        )

    monkeypatch.setattr(delivery_module, "enqueue_callback_delivery", _fake_enqueue)
    return scheduled


async def _enqueue(store, settings, url="https://backend.example/api/ai-service/callback"):
    return await enqueue_callback(
        envelope={"event": "transcribe.completed", "transcribeId": "t-1", "texto": "sí"},
        url=url,
        api_key_id=API_KEY_ID,
        org="acme",
        project="repo",
        source_id="t-1",
        store=store,
        pool=StubPool(),
        settings=settings,
    )


# ---------------------------------------------------------------------------

async def test_enqueue_stores_the_exact_bytes_and_schedules_attempt_one(
    store, settings, _capture_enqueues
):
    delivery_id = await _enqueue(store, settings)
    row = await store.get_delivery(delivery_id)
    assert row["status"] == "pending"
    assert row["event"] == "transcribe.completed"
    # Stored base64 so the bytes survive the Redis round-trip untouched.
    assert base64.b64decode(row["body"]) == '{"event":"transcribe.completed","transcribeId":"t-1","texto":"sí"}'.encode()
    assert len(_capture_enqueues) == 1
    scheduled = _capture_enqueues[0]
    assert scheduled["deliveryId"] == delivery_id
    assert scheduled["attempt"] == 1
    assert scheduled["defer"] == 0.0
    # 🔴 Deliveries must NOT land on the transcription queue: it runs one job at
    # a time with a timeout measured in hours, so a delivery behind a running
    # decode would wait for it to finish. That would make `transcribe.progress`
    # useless by construction.
    assert scheduled["queue"] == settings.CALLBACK_QUEUE_NAME
    assert scheduled["queue"] != settings.QUEUE_NAME


async def test_a_key_without_a_secret_records_auth_failed_and_never_posts(store):
    settings = Settings(API_KEYS='{"' + RAW_KEY + '":{"org":"acme","project":"repo"}}')
    delivery_id = await _enqueue(store, settings)
    row = await store.get_delivery(delivery_id)
    assert row["status"] == "auth_failed"
    assert "callbackSecret" in row["lastError"]


async def test_a_successful_attempt_is_verifiable_by_the_receiver(store, settings):
    delivery_id = await _enqueue(store, settings)
    client = StubClient([_Response(200)])
    status = await attempt_delivery(
        delivery_id, 1, store=store, pool=StubPool(), settings=settings, client=client
    )
    assert status == "delivered"

    call = client.calls[0]
    signed_at = int(call["headers"][TIMESTAMP_HEADER])
    signature = call["headers"][SIGNATURE_HEADER]
    # This is the assertion that matters: a receiver implementing the contract
    # (apps/backend/src/lib/hmac.ts) accepts what we put on the wire.
    assert verify_signature(call["content"], SECRET, signed_at, signature)


async def test_retries_follow_the_ai_service_schedule_then_dead_letter(
    store, settings, _capture_enqueues
):
    delivery_id = await _enqueue(store, settings)
    _capture_enqueues.clear()
    pool = StubPool()

    for attempt in range(1, 5):
        client = StubClient([_Response(503, "upstream down")])
        status = await attempt_delivery(
            delivery_id, attempt, store=store, pool=pool, settings=settings, client=client
        )
        assert status == "pending"

    assert [entry["defer"] for entry in _capture_enqueues] == [5.0, 30.0, 120.0, 600.0]

    client = StubClient([_Response(500)])
    status = await attempt_delivery(
        delivery_id, 5, store=store, pool=pool, settings=settings, client=client
    )
    assert status == "dead_letter"
    entries = await store.list_dead_letters(DLQ_CALLBACK)
    assert entries[0]["deliveryId"] == delivery_id
    assert entries[0]["attempts"] == 5


async def test_every_attempt_re_signs_but_never_re_serialises(store, settings):
    """The two rules from ai-service's incident history, together.

    Bytes identical across attempts (so the receiver's HMAC input is stable);
    timestamp and signature different (so attempt 5 is not rejected as a replay
    of a signature minted 12 minutes earlier).
    """
    delivery_id = await _enqueue(store, settings)
    pool = StubPool()

    client_a = StubClient([_Response(503)])
    await attempt_delivery(
        delivery_id, 1, store=store, pool=pool, settings=settings, client=client_a
    )
    # Force a different second — sign_body reads the wall clock.
    import time as _time

    _time.sleep(1.05)
    client_b = StubClient([_Response(200)])
    await attempt_delivery(
        delivery_id, 2, store=store, pool=pool, settings=settings, client=client_b
    )

    assert client_a.calls[0]["content"] == client_b.calls[0]["content"]
    assert (
        client_a.calls[0]["headers"][TIMESTAMP_HEADER]
        != client_b.calls[0]["headers"][TIMESTAMP_HEADER]
    )
    assert (
        client_a.calls[0]["headers"][SIGNATURE_HEADER]
        != client_b.calls[0]["headers"][SIGNATURE_HEADER]
    )


async def test_retries_stay_on_the_callback_queue(store, settings, _capture_enqueues):
    delivery_id = await _enqueue(store, settings)
    _capture_enqueues.clear()
    await attempt_delivery(
        delivery_id, 1, store=store, pool=StubPool(), settings=settings,
        client=StubClient([_Response(503)]),
    )
    assert _capture_enqueues[0]["queue"] == settings.CALLBACK_QUEUE_NAME


async def test_401_stops_the_loop(store, settings, _capture_enqueues):
    delivery_id = await _enqueue(store, settings)
    _capture_enqueues.clear()
    status = await attempt_delivery(
        delivery_id, 1, store=store, pool=StubPool(), settings=settings,
        client=StubClient([_Response(401, "unauthorized")]),
    )
    assert status == "auth_failed"
    assert _capture_enqueues == []


async def test_404_is_permanent(store, settings, _capture_enqueues):
    delivery_id = await _enqueue(store, settings)
    _capture_enqueues.clear()
    status = await attempt_delivery(
        delivery_id, 1, store=store, pool=StubPool(), settings=settings,
        client=StubClient([_Response(404)]),
    )
    assert status == "failed"
    assert _capture_enqueues == []


async def test_a_network_error_retries(store, settings, _capture_enqueues):
    delivery_id = await _enqueue(store, settings)
    _capture_enqueues.clear()
    status = await attempt_delivery(
        delivery_id, 1, store=store, pool=StubPool(), settings=settings,
        client=StubClient([ConnectionError("connection refused")]),
    )
    assert status == "pending"
    assert _capture_enqueues[0]["defer"] == 5.0
    row = await store.get_delivery(delivery_id)
    assert "connection refused" in row["lastError"]


async def test_a_terminal_delivery_is_never_re_attempted(store, settings):
    delivery_id = await _enqueue(store, settings)
    await attempt_delivery(
        delivery_id, 1, store=store, pool=StubPool(), settings=settings,
        client=StubClient([_Response(200)]),
    )
    client = StubClient([_Response(200)])
    status = await attempt_delivery(
        delivery_id, 2, store=store, pool=StubPool(), settings=settings, client=client
    )
    assert status == "delivered"
    assert client.calls == []  # no second POST


async def test_a_key_rotated_out_between_attempts_fails_closed(store, settings):
    delivery_id = await _enqueue(store, settings)
    # The operator removed the key. Sending the stored signature would be a
    # guaranteed 401; we must not burn the request.
    rotated = Settings(API_KEYS="{}")
    client = StubClient([_Response(200)])
    status = await attempt_delivery(
        delivery_id, 1, store=store, pool=StubPool(), settings=rotated, client=client
    )
    assert status == "auth_failed"
    assert client.calls == []


async def test_a_replay_carries_a_nonce_so_its_retries_are_not_deduped(
    store, settings, _capture_enqueues
):
    """Regression: a replay used to die silently after one attempt.

    It restarts the chain at attempt 1, so its attempt-2 job id collided with
    the ORIGINAL run's attempt-2 id. arq de-duplicated it away and the retry
    never happened, leaving the row stuck at `pending`.
    """
    delivery_id = await _enqueue(store, settings)
    await store.update_delivery(delivery_id, replayNonce="feedface", attempt=0)
    _capture_enqueues.clear()

    await attempt_delivery(
        delivery_id, 1, store=store, pool=StubPool(), settings=settings,
        client=StubClient([_Response(503)]),
    )
    assert _capture_enqueues[0]["nonce"] == "feedface"

    from app.queue import callback_job_id

    assert callback_job_id(delivery_id, 2, "feedface") != callback_job_id(delivery_id, 2)


async def test_a_missing_delivery_row_aborts_quietly(store, settings):
    status = await attempt_delivery(
        "does-not-exist", 1, store=store, pool=StubPool(), settings=settings,
        client=StubClient([_Response(200)]),
    )
    assert status == "missing"


# ── Retention after delivery (audit 2026-10-28, retention cluster) ──────────

WEEK = 7 * 24 * 60 * 60


@pytest.fixture
def long_store() -> JobStore:
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    return JobStore(
        redis, job_ttl=86400, transcript_ttl=86400, idempotency_ttl=86400, callback_ttl=WEEK
    )


async def test_a_delivered_callback_keeps_its_body_and_transcript_one_hour_not_a_week(
    long_store, settings
):
    await long_store.put_transcript("t-1", {"text": "sí"})
    delivery_id = await _enqueue(long_store, settings)
    assert await long_store.redis.ttl("audio:callback:" + delivery_id) > 86400

    status = await attempt_delivery(
        delivery_id, 1, store=long_store, pool=StubPool(), settings=settings,
        client=StubClient([_Response(200)]),
    )
    assert status == "delivered"
    limit = settings.CALLBACK_DELIVERED_TTL_SECONDS
    assert limit <= 3600
    assert 0 < await long_store.redis.ttl("audio:callback:" + delivery_id) <= limit
    assert 0 < await long_store.redis.ttl("audio:transcript:t-1") <= limit


async def test_an_undelivered_callback_keeps_its_week_for_replay(long_store, settings):
    await long_store.put_transcript("t-1", {"text": "sí"})
    delivery_id = await _enqueue(long_store, settings)
    status = await attempt_delivery(
        delivery_id, 1, store=long_store, pool=StubPool(), settings=settings,
        client=StubClient([_Response(503)]),
    )
    assert status == "pending"
    assert await long_store.redis.ttl("audio:callback:" + delivery_id) > 86400
    assert await long_store.redis.ttl("audio:transcript:t-1") > 3600


async def test_delivery_never_lengthens_a_shorter_transcript_ttl(long_store, settings):
    await long_store.put_transcript("t-1", {"text": "sí"})
    await long_store.redis.expire("audio:transcript:t-1", 60)
    delivery_id = await _enqueue(long_store, settings)
    await attempt_delivery(
        delivery_id, 1, store=long_store, pool=StubPool(), settings=settings,
        client=StubClient([_Response(200)]),
    )
    assert 0 < await long_store.redis.ttl("audio:transcript:t-1") <= 60


async def test_delivery_without_a_transcript_does_not_create_one(long_store, settings):
    delivery_id = await _enqueue(long_store, settings)
    await attempt_delivery(
        delivery_id, 1, store=long_store, pool=StubPool(), settings=settings,
        client=StubClient([_Response(200)]),
    )
    assert await long_store.redis.exists("audio:transcript:t-1") == 0
