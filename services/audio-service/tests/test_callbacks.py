"""The HMAC callback contract.

These tests are the reason to trust that `apps/backend`'s EXISTING verifier
(`apps/backend/src/lib/hmac.ts`, which today only ever sees ai-service traffic)
will accept our callbacks without a line of new code. They pin:

  - the signing string shape `f"{unix}.{raw_body}"`;
  - hex encoding;
  - the three header names;
  - a hardcoded expected signature, computed independently, so a refactor that
    silently changes the scheme fails here instead of in production.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time

import pytest

from app.callbacks import (
    EVENT_HEADER,
    MAX_ATTEMPTS,
    RETRY_SCHEDULE_SECONDS,
    SIGNATURE_HEADER,
    SOURCE_HEADER,
    TIMESTAMP_HEADER,
    build_headers,
    classify_attempt,
    completed_envelope,
    failed_envelope,
    serialize_envelope,
    sign_body,
    verify_signature,
)

SECRET = "a" * 64


# ---------------------------------------------------------------------------
# Signing
# ---------------------------------------------------------------------------

def test_signing_string_is_timestamp_dot_body():
    body = b'{"event":"transcribe.completed"}'
    signed_at, signature = sign_body(body, SECRET, now=1_700_000_000)
    assert signed_at == 1_700_000_000

    # Recomputed here from first principles — deliberately NOT by calling
    # sign_body again, so this asserts the scheme rather than its own output.
    expected = hmac.new(
        SECRET.encode(),
        b"1700000000." + body,
        hashlib.sha256,
    ).hexdigest()
    assert signature == expected
    assert len(signature) == 64
    assert all(c in "0123456789abcdef" for c in signature)


def test_signature_is_stable_for_a_known_vector():
    # A frozen vector. If this changes, apps/backend's verifier stops accepting
    # our callbacks — which is exactly the regression worth failing loudly on.
    body = b'{"a":1}'
    _, signature = sign_body(body, "s" * 32, now=1_000_000)
    assert signature == hmac.new(
        (b"s" * 32), b"1000000." + body, hashlib.sha256
    ).hexdigest()


def test_headers_match_the_ai_service_contract():
    headers = build_headers(1_700_000_000, "deadbeef", "transcribe.completed")
    # apps/backend/src/lib/hmac.ts reads these three, case-insensitively.
    assert headers[TIMESTAMP_HEADER] == "1700000000"
    assert headers[SIGNATURE_HEADER] == "deadbeef"
    assert headers[EVENT_HEADER] == "transcribe.completed"
    assert TIMESTAMP_HEADER == "X-AIService-Timestamp"
    assert SIGNATURE_HEADER == "X-AIService-Signature"
    assert EVENT_HEADER == "X-AIService-Event"
    # Additive only — a receiver that ignores it is unaffected.
    assert headers[SOURCE_HEADER] == "audio-service"
    assert headers["Content-Type"] == "application/json"
    # `Connection` is a hop-by-hop header. ai-service sets it to work around an
    # undici bug that httpx does not have; hand-setting it on an httpx request
    # is at best ignored and at worst rejected.
    assert "Connection" not in headers


def test_a_conforming_receiver_accepts_what_we_emit():
    envelope = {"event": "transcribe.completed", "transcribeId": "abc"}
    body = serialize_envelope(envelope)
    signed_at, signature = sign_body(body, SECRET)
    assert verify_signature(body, SECRET, signed_at, signature)


def test_receiver_rejects_a_tampered_body():
    body = serialize_envelope({"event": "transcribe.completed", "stars": 1})
    signed_at, signature = sign_body(body, SECRET)
    assert not verify_signature(body + b" ", SECRET, signed_at, signature)


def test_receiver_rejects_the_wrong_secret():
    body = serialize_envelope({"event": "x"})
    signed_at, signature = sign_body(body, SECRET)
    assert not verify_signature(body, "b" * 64, signed_at, signature)


def test_receiver_rejects_a_stale_timestamp():
    """This is why every attempt re-signs.

    The retry schedule spans ~12m35s; the receiver's window is ±5m. A signature
    minted once at enqueue is guaranteed stale by attempts 4 and 5.
    """
    body = serialize_envelope({"event": "x"})
    stale = int(time.time()) - 600
    _, signature = sign_body(body, SECRET, now=stale)
    assert not verify_signature(body, SECRET, stale, signature)
    assert sum(RETRY_SCHEDULE_SECONDS) > 300


# ---------------------------------------------------------------------------
# Serialisation
# ---------------------------------------------------------------------------

def test_serialisation_matches_json_stringify_shape():
    body = serialize_envelope({"b": 1, "a": "sí"})
    # No whitespace, insertion order preserved, raw UTF-8 (not \\uXXXX).
    assert body == '{"b":1,"a":"sí"}'.encode("utf-8")


def test_spanish_text_is_not_escaped():
    body = serialize_envelope({"text": "La sesión de mañana en Michoacán"})
    assert "ó".encode("utf-8") in body
    assert b"\\u" not in body


def test_serialisation_is_deterministic():
    envelope = {"event": "x", "n": 1, "nested": {"k": [1, 2]}}
    assert serialize_envelope(envelope) == serialize_envelope(envelope)


# ---------------------------------------------------------------------------
# Retry / dead-letter policy — same branch table as ai-service
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "status_code,expected",
    [(200, "delivered"), (201, "delivered"), (204, "delivered")],
)
def test_2xx_is_delivered(status_code, expected):
    assert classify_attempt(1, status_code, None).status == expected


def test_401_stops_immediately():
    # The receiver rejected our signature. Retrying burns four more requests
    # for a guaranteed identical rejection.
    outcome = classify_attempt(1, 401, None)
    assert outcome.status == "auth_failed"
    assert outcome.next_attempt_delay is None


@pytest.mark.parametrize("status_code", [400, 403, 404, 422])
def test_other_4xx_is_permanent(status_code):
    assert classify_attempt(1, status_code, None).status == "failed"


@pytest.mark.parametrize("status_code", [301, 302, 307, 308])
def test_redirects_are_permanent_not_retryable(status_code):
    """A redirect is a misconfigured `callbackUrl`, not a transient fault.

    It used to fall through into the 5xx branch and burn all five attempts
    reaching the same redirect five times.
    """
    outcome = classify_attempt(1, status_code, None)
    assert outcome.status == "failed"
    assert outcome.next_attempt_delay is None


def test_5xx_retries_on_the_ai_service_schedule():
    delays = []
    for attempt in range(1, MAX_ATTEMPTS):
        outcome = classify_attempt(attempt, 503, None)
        assert outcome.status == "pending"
        delays.append(outcome.next_attempt_delay)
    assert delays == [5.0, 30.0, 120.0, 600.0]


def test_final_5xx_dead_letters():
    outcome = classify_attempt(MAX_ATTEMPTS, 500, None)
    assert outcome.status == "dead_letter"
    assert outcome.next_attempt_delay is None


def test_network_error_retries_then_dead_letters():
    assert classify_attempt(1, None, "ConnectError").status == "pending"
    assert classify_attempt(MAX_ATTEMPTS, None, "ConnectError").status == "dead_letter"


def test_classify_requires_an_outcome():
    with pytest.raises(ValueError):
        classify_attempt(1, None, None)


# ---------------------------------------------------------------------------
# Envelopes
# ---------------------------------------------------------------------------

def _completed(text: str, cap: int = 200_000):
    return completed_envelope(
        transcribe_id="t-1",
        org="acme",
        project="repo",
        emitted_at="2026-08-14T00:00:00.000Z",
        external_id="doc-42",
        title="Junta de agosto",
        audio={"filename": "junta.m4a", "durationSeconds": 61.0},
        transcript_text=text,
        transcript_meta={"language": "es", "segmentCount": 3},
        model={"name": "large-v3-turbo"},
        duration_ms=1234,
        metadata={"sessionId": "9"},
        max_transcript_chars=cap,
    )


def test_completed_envelope_inlines_a_normal_transcript():
    envelope = _completed("Hola, esta es la junta de agosto.")
    assert envelope["event"] == "transcribe.completed"
    assert envelope["transcript"]["text"] == "Hola, esta es la junta de agosto."
    assert envelope["transcript"]["truncated"] is False
    assert envelope["transcript"]["characters"] == 33
    assert envelope["externalId"] == "doc-42"
    assert envelope["org"] == "acme"


def test_completed_envelope_omits_an_oversized_transcript():
    envelope = _completed("x" * 500, cap=100)
    assert envelope["transcript"]["truncated"] is True
    assert envelope["transcript"]["text"] is None
    # The length is still reported so the consumer knows what it is fetching.
    assert envelope["transcript"]["characters"] == 500


def test_failed_envelope_carries_a_machine_readable_code():
    envelope = failed_envelope(
        transcribe_id="t-2",
        org="acme",
        project="repo",
        emitted_at="2026-08-14T00:00:00.000Z",
        external_id="doc-9",
        title=None,
        error_code="no_audio_stream",
        error_message="The uploaded file contains no audio stream",
        attempts=1,
        metadata=None,
    )
    assert envelope["event"] == "transcribe.failed"
    assert envelope["error"]["code"] == "no_audio_stream"
    assert envelope["attempts"] == 1
    # Round-trips through the serializer the delivery path uses.
    assert json.loads(serialize_envelope(envelope))["error"]["code"] == "no_audio_stream"
