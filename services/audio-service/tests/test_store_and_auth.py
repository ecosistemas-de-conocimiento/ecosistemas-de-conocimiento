"""Job store (against fakeredis) and API-key handling."""

from __future__ import annotations

import pytest

fakeredis = pytest.importorskip("fakeredis", reason="fakeredis not installed")

from app.auth import derive_api_key_id  # noqa: E402
from app.config import Settings  # noqa: E402
from app.store import (  # noqa: E402
    DLQ_TRANSCRIBE,
    JobRow,
    JobStore,
    STATUS_QUEUED,
    now_iso,
)


@pytest.fixture
def store():
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    return JobStore(
        redis, job_ttl=3600, transcript_ttl=3600, idempotency_ttl=3600, callback_ttl=3600
    )


def _row(transcribe_id="t-1", org="acme", project="repo") -> JobRow:
    return JobRow(
        transcribeId=transcribe_id,
        org=org,
        project=project,
        apiKeyId="deadbeefdeadbeef",
        status=STATUS_QUEUED,
        createdAt=now_iso(),
        updatedAt=now_iso(),
        filename="junta.m4a",
        bytes=12345,
        language="es",
        metadata={"sessionId": "9", "nested": {"a": 1}},
    )


# ---------------------------------------------------------------------------
# apiKeyId derivation — must stay byte-identical to ai-service's
# ---------------------------------------------------------------------------

def test_api_key_id_matches_the_ai_service_derivation():
    # sha256("dev-key-app") hex, first 16 chars. Computed independently.
    import hashlib

    expected = hashlib.sha256(b"dev-key-app").hexdigest()[:16]
    assert derive_api_key_id("dev-key-app") == expected
    assert len(derive_api_key_id("anything")) == 16


def test_api_key_id_never_contains_the_key():
    assert "supersecret" not in derive_api_key_id("supersecret")


def test_api_keys_parse_from_the_ai_service_json_shape():
    settings = Settings(
        API_KEYS=(
            '{"k1":{"org":"acme","project":"repo","role":"app",'
            '"callbackSecret":"' + "s" * 40 + '"},'
            '"k2":{"org":"acme","project":"repo","role":"admin"}}'
        )
    )
    keys = settings.api_keys
    assert keys["k1"].org == "acme"
    assert keys["k1"].role == "app"
    assert keys["k2"].role == "admin"
    # Defaults to `app` when omitted, like ai-service.
    assert Settings(API_KEYS='{"k":{"org":"o","project":"p"}}').api_keys["k"].role == "app"


def test_a_short_callback_secret_is_rejected():
    with pytest.raises(Exception):
        Settings(API_KEYS='{"k":{"org":"o","project":"p","callbackSecret":"short"}}').api_keys


# ---------------------------------------------------------------------------
# Job rows
# ---------------------------------------------------------------------------

async def test_job_round_trips_including_nested_metadata(store):
    await store.create_job(_row())
    loaded = await store.get_job("t-1")
    assert loaded is not None
    assert loaded.org == "acme"
    assert loaded.bytes == 12345
    assert loaded.metadata == {"sessionId": "9", "nested": {"a": 1}}
    assert loaded.durationSeconds is None


async def test_missing_job_returns_none(store):
    assert await store.get_job("nope") is None


async def test_partial_update_leaves_other_fields_alone(store):
    await store.create_job(_row())
    await store.update_job("t-1", status="processing", chunksTotal=4)
    loaded = await store.get_job("t-1")
    assert loaded.status == "processing"
    assert loaded.chunksTotal == 4
    assert loaded.filename == "junta.m4a"


async def test_transcript_round_trips_with_accents(store):
    payload = {"text": "La sesión de mañana", "segments": [{"id": 0}]}
    await store.put_transcript("t-1", payload)
    assert (await store.get_transcript("t-1"))["text"] == "La sesión de mañana"


# ---------------------------------------------------------------------------
# Idempotency
# ---------------------------------------------------------------------------

async def test_first_claim_wins_and_the_second_gets_the_first_id(store):
    assert await store.claim_idempotency_key("acme", "repo", "k", "t-1") is None
    assert await store.claim_idempotency_key("acme", "repo", "k", "t-2") == "t-1"


async def test_idempotency_is_scoped_per_tenant(store):
    """Two organizations using the same key must not collide.

    Also closes a cross-tenant probe: without the scope, org B could learn that
    org A had used a given key.
    """
    assert await store.claim_idempotency_key("acme", "repo", "k", "t-1") is None
    assert await store.claim_idempotency_key("other", "repo", "k", "t-2") is None


async def test_a_released_key_can_be_reclaimed(store):
    await store.claim_idempotency_key("acme", "repo", "k", "t-1")
    await store.release_idempotency_key("acme", "repo", "k")
    assert await store.claim_idempotency_key("acme", "repo", "k", "t-2") is None


# ---------------------------------------------------------------------------
# Dead letters
# ---------------------------------------------------------------------------

async def test_dead_letters_are_readable_and_stamped(store):
    await store.dead_letter(DLQ_TRANSCRIBE, {"transcribeId": "t-1", "org": "acme"})
    entries = await store.list_dead_letters(DLQ_TRANSCRIBE)
    assert entries[0]["transcribeId"] == "t-1"
    assert "deadLetteredAt" in entries[0]
    assert await store.dead_letter_depth(DLQ_TRANSCRIBE) == 1


async def test_the_dead_letter_list_is_bounded(store):
    from app.store import DLQ_MAX_ENTRIES

    for index in range(DLQ_MAX_ENTRIES + 25):
        await store.dead_letter(DLQ_TRANSCRIBE, {"i": index})
    # Unbounded growth here would be a slow-motion Redis OOM.
    assert await store.dead_letter_depth(DLQ_TRANSCRIBE) == DLQ_MAX_ENTRIES


# ---------------------------------------------------------------------------
# In-flight registry + field clearing
# ---------------------------------------------------------------------------

async def test_in_flight_registry_round_trips(store):
    await store.mark_in_flight("t-1")
    await store.mark_in_flight("t-2")
    assert sorted(await store.list_in_flight()) == ["t-1", "t-2"]
    await store.clear_in_flight("t-1")
    assert await store.list_in_flight() == ["t-2"]


async def test_has_live_job_is_false_for_terminal_and_missing(store):
    """The sweeper's guard. A false positive here deletes a queued job's audio."""
    await store.create_job(_row("queued-1"))
    assert await store.has_live_job("queued-1") is True

    await store.update_job("queued-1", status="completed")
    assert await store.has_live_job("queued-1") is False
    assert await store.has_live_job("never-existed") is False


async def test_clear_job_fields_can_unset_an_error(store):
    """`update_job` can set a field but never unset one.

    Without this, an errorCode from a failed attempt survives a later
    successful retry and the status endpoint returns a completed job carrying
    an error block.
    """
    await store.create_job(_row())
    await store.update_job("t-1", errorCode="ffmpeg_timeout", errorMessage="boom")
    assert (await store.get_job("t-1")).errorCode == "ffmpeg_timeout"

    await store.clear_job_fields("t-1", "errorCode", "errorMessage")
    reloaded = await store.get_job("t-1")
    assert reloaded.errorCode is None
    assert reloaded.errorMessage is None


# ---------------------------------------------------------------------------
# Heartbeat
# ---------------------------------------------------------------------------

async def test_heartbeat_round_trips(store):
    await store.set_worker_heartbeat(60, {"modelLoaded": True, "model": {"name": "x"}})
    beat = await store.get_worker_heartbeat()
    assert beat["modelLoaded"] is True


async def test_absent_heartbeat_reads_as_none(store):
    assert await store.get_worker_heartbeat() is None
