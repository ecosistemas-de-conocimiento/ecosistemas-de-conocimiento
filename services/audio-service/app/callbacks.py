"""HMAC-signed completion callbacks.

⚠ THE SIGNING SCHEME AND THE HEADER NAMES ARE COPIED FROM ai-service ON PURPOSE.

`services/ai-service/src/services/callbacks/emit.ts` is the source of truth. The
scheme is:

    signature = HMAC_SHA256(secret, f"{unix_seconds}.{raw_body_bytes}")  -> hex

sent as:

    X-AIService-Timestamp: <unix_seconds>
    X-AIService-Signature: <hex>
    X-AIService-Event:     <envelope.event>

The `AIService` in those header names is the name of the *callback contract*,
not of the emitting service. Renaming them to `X-AudioService-*` would force
`apps/backend` to grow (and keep in sync) a SECOND verifier for an identical
scheme — the one thing worth avoiding. We add one purely additive header,
`X-Callback-Source: audio-service`, so a receiver that wants to branch on the
emitter can do so without parsing the body.

Two correctness rules inherited verbatim from ai-service, both of which cost it
a production incident:

1. **Sign the exact bytes you send.** We serialise the envelope ONCE into
   `bytes` and use that same buffer for both the HMAC and the request body. It
   is never re-parsed or re-serialised, not even across retries.
2. **Re-sign every attempt.** Receivers enforce a ±300s replay window on the
   timestamp. The retry schedule spans ~12m35s, so a signature minted once at
   enqueue is guaranteed to be stale by attempts 4 and 5 — exactly the attempts
   that only exist because the earlier ones failed. Each attempt re-signs the
   STORED body bytes with a fresh timestamp; the wire bytes stay byte-identical
   and only the two header values change.
"""

from __future__ import annotations

import hmac
import json
import time
from dataclasses import dataclass
from hashlib import sha256
from typing import Any, Dict, Mapping, Optional, Tuple

TIMESTAMP_HEADER = "X-AIService-Timestamp"
SIGNATURE_HEADER = "X-AIService-Signature"
EVENT_HEADER = "X-AIService-Event"
SOURCE_HEADER = "X-Callback-Source"
SOURCE_VALUE = "audio-service"

#: Retry schedule in SECONDS, from ai-service's `RETRY_SCHEDULE_MS`:
#: t+0, +5s, +30s, +2m, +10m, then dead-letter.
RETRY_SCHEDULE_SECONDS = [0, 5, 30, 120, 600]
MAX_ATTEMPTS = len(RETRY_SCHEDULE_SECONDS)

#: Terminal statuses — an attempt loop must never resume from these.
TERMINAL_STATUSES = {"delivered", "failed", "auth_failed", "dead_letter"}

RESPONSE_BODY_EXCERPT_LIMIT = 1024


def serialize_envelope(envelope: Mapping[str, Any]) -> bytes:
    """Serialise an envelope to the exact bytes that will be signed AND sent.

    `separators=(",", ":")` + `ensure_ascii=False` reproduces JavaScript's
    `JSON.stringify` output byte-for-byte for the shapes we emit: no whitespace,
    insertion-ordered keys, and raw UTF-8 for accented Spanish rather than
    `\\uXXXX` escapes. Byte-equality with the JS emitter is not strictly
    required for verification (the receiver hashes whatever bytes arrive), but
    it keeps a hand-diff of two deliveries legible and keeps Spanish payloads
    from inflating ~2x on the wire.
    """
    return json.dumps(
        envelope, separators=(",", ":"), ensure_ascii=False, default=str
    ).encode("utf-8")


def sign_body(body: bytes, secret: str, now: Optional[float] = None) -> Tuple[int, str]:
    """HMAC-SHA256 over ``f"{unix_seconds}.".encode() + body``.

    Returns `(signed_at_unix, hex_signature)`. Takes and returns bytes so no
    encode/decode round-trip can slip between signing and sending.
    """
    signed_at = int(now if now is not None else time.time())
    message = f"{signed_at}.".encode("utf-8") + body
    signature = hmac.new(secret.encode("utf-8"), message, sha256).hexdigest()
    return signed_at, signature


def verify_signature(
    body: bytes,
    secret: str,
    signed_at: int,
    signature: str,
    now: Optional[float] = None,
    tolerance_seconds: int = 300,
) -> bool:
    """Receiver-side verification, kept here so the contract has ONE home.

    Used by the test suite to prove the emitter and a conforming receiver agree,
    and available to anyone writing a receiver. Constant-time comparison; ±300s
    replay window, matching the contract.
    """
    current = now if now is not None else time.time()
    if abs(current - signed_at) > tolerance_seconds:
        return False
    _, expected = sign_body(body, secret, now=signed_at)
    return hmac.compare_digest(expected, signature)


def build_headers(signed_at: int, signature: str, event: str) -> Dict[str, str]:
    # NB: ai-service sets `Connection: close` here because undici's keep-alive
    # pool tripped ERR_HTTP_SOCKET_ASSIGNED against the Next.js receiver. That
    # is a bug in undici, not in the receiver, and httpx/h11 does not share it —
    # so we deliberately do NOT copy that header. Hand-setting hop-by-hop
    # headers on an httpx request is at best ignored and at worst rejected.
    return {
        "Content-Type": "application/json",
        TIMESTAMP_HEADER: str(signed_at),
        SIGNATURE_HEADER: signature,
        EVENT_HEADER: event,
        SOURCE_HEADER: SOURCE_VALUE,
    }


@dataclass(frozen=True)
class DeliveryOutcome:
    """What one attempt decided, given a response (or a network error).

    Split out as a pure function (`classify_attempt`) so the retry/dead-letter
    policy is unit-testable without a socket. Mirrors ai-service's branch table
    exactly: 2xx delivered; 401 auth_failed (stop — the receiver rejected our
    signature, retrying just burns requests); other 4xx failed (permanent client
    rejection); 5xx / network retry until the schedule runs out, then
    dead-letter.
    """

    status: str
    next_attempt_delay: Optional[float]


def classify_attempt(
    attempt: int,
    status_code: Optional[int],
    network_error: Optional[str],
) -> DeliveryOutcome:
    """`attempt` is 1-based: the number of the attempt that JUST happened."""
    if status_code is not None:
        if 200 <= status_code < 300:
            return DeliveryOutcome("delivered", None)
        if status_code == 401:
            return DeliveryOutcome("auth_failed", None)
        if 300 <= status_code < 400:
            # A redirect is a misconfigured `callbackUrl`, not a transient
            # fault. Retrying it five times reaches the same redirect five
            # times. (httpx does not auto-follow by default, and we would not
            # want it to: a signed POST must not be replayed to an arbitrary
            # Location.)
            return DeliveryOutcome("failed", None)
        if 400 <= status_code < 500:
            return DeliveryOutcome("failed", None)
    elif network_error is None:
        # Neither a response nor an error: caller bug.
        raise ValueError("classify_attempt needs either status_code or network_error")

    # 5xx or network error — retry if the schedule has room left.
    if attempt >= MAX_ATTEMPTS:
        return DeliveryOutcome("dead_letter", None)
    return DeliveryOutcome("pending", float(RETRY_SCHEDULE_SECONDS[attempt]))


# ---------------------------------------------------------------------------
# Envelope builders — the wire contract for this service's events.
# ---------------------------------------------------------------------------

def completed_envelope(
    *,
    transcribe_id: str,
    org: str,
    project: str,
    emitted_at: str,
    external_id: Optional[str],
    title: Optional[str],
    audio: Mapping[str, Any],
    transcript_text: str,
    transcript_meta: Mapping[str, Any],
    model: Mapping[str, Any],
    duration_ms: int,
    metadata: Optional[Mapping[str, Any]],
    max_transcript_chars: int,
) -> Dict[str, Any]:
    """`transcribe.completed`.

    The transcript text rides the callback so the common case is a single hop:
    receive → ingest. Above `max_transcript_chars` the text is omitted and
    `truncated: true` is set — the consumer must then
    `GET /v1/transcribe/:transcribeId` for the full text. This keeps a 6-hour
    recording from POSTing a multi-megabyte webhook body through a proxy that
    may well cap it.
    """
    truncated = len(transcript_text) > max_transcript_chars
    return {
        "event": "transcribe.completed",
        "emittedAt": emitted_at,
        "transcribeId": transcribe_id,
        "org": org,
        "project": project,
        "externalId": external_id,
        "title": title,
        "audio": dict(audio),
        "transcript": {
            **dict(transcript_meta),
            "characters": len(transcript_text),
            "truncated": truncated,
            "text": None if truncated else transcript_text,
        },
        "model": dict(model),
        "durationMs": duration_ms,
        "metadata": dict(metadata) if metadata else None,
    }


def failed_envelope(
    *,
    transcribe_id: str,
    org: str,
    project: str,
    emitted_at: str,
    external_id: Optional[str],
    title: Optional[str],
    error_code: str,
    error_message: str,
    attempts: int,
    metadata: Optional[Mapping[str, Any]],
) -> Dict[str, Any]:
    return {
        "event": "transcribe.failed",
        "emittedAt": emitted_at,
        "transcribeId": transcribe_id,
        "org": org,
        "project": project,
        "externalId": external_id,
        "title": title,
        "error": {"code": error_code, "message": error_message},
        "attempts": attempts,
        "metadata": dict(metadata) if metadata else None,
    }


def progress_envelope(
    *,
    transcribe_id: str,
    org: str,
    project: str,
    emitted_at: str,
    external_id: Optional[str],
    chunks_done: int,
    chunks_total: int,
) -> Dict[str, Any]:
    return {
        "event": "transcribe.progress",
        "emittedAt": emitted_at,
        "transcribeId": transcribe_id,
        "org": org,
        "project": project,
        "externalId": external_id,
        "chunksDone": chunks_done,
        "chunksTotal": chunks_total,
    }
