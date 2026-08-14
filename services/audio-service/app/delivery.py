"""Callback delivery — enqueue, attempt, retry, dead-letter.

The policy lives in `callbacks.py` (pure); the I/O lives here. Behaviour is a
port of ai-service's `enqueueCallback` / `attemptDelivery`:

  - the envelope is serialised ONCE at enqueue and the resulting bytes are
    stored verbatim; every attempt sends those exact bytes;
  - every attempt re-signs the stored bytes with a FRESH timestamp, because the
    receiver enforces a ±300s replay window and the retry schedule outlives it;
  - 2xx -> delivered; 401 -> auth_failed (stop: the receiver rejected our
    signature, retrying only burns requests); other 4xx -> failed; 5xx/network
    -> retry on `RETRY_SCHEDULE_SECONDS`, then dead-letter;
  - a key with no `callbackSecret` records an `auth_failed` row immediately so
    an operator has an audit trail instead of silence.
"""

from __future__ import annotations

import base64
import logging
import uuid
from typing import Any, Mapping, Optional

import httpx
from arq.connections import ArqRedis

from .callbacks import (
    build_headers,
    classify_attempt,
    serialize_envelope,
    sign_body,
    RESPONSE_BODY_EXCERPT_LIMIT,
)
from .config import Settings
from .auth import resolve_callback_secret
from .queue import enqueue_callback_delivery
from .store import DLQ_CALLBACK, JobStore, now_iso

log = logging.getLogger("audio-service.delivery")


async def enqueue_callback(
    *,
    envelope: Mapping[str, Any],
    url: str,
    api_key_id: str,
    org: str,
    project: str,
    source_id: str,
    store: JobStore,
    pool: ArqRedis,
    settings: Settings,
) -> str:
    """Persist a delivery row and schedule attempt 1. Returns the delivery id.

    Fire-and-forget by design: a terminal job transition must never block on a
    slow receiver, so this returns as soon as the row is written.
    """
    delivery_id = str(uuid.uuid4())
    body = serialize_envelope(envelope)
    event = str(envelope.get("event", ""))
    secret = resolve_callback_secret(api_key_id, settings)

    base_row = {
        "deliveryId": delivery_id,
        "org": org,
        "project": project,
        "sourceId": source_id,
        "event": event,
        "url": url,
        "apiKeyId": api_key_id,
        # base64 so the exact bytes survive the Redis round-trip untouched —
        # storing the decoded string would risk a re-encode changing them.
        "body": base64.b64encode(body).decode("ascii"),
        "createdAt": now_iso(),
        "attempt": 0,
    }

    if not secret:
        await store.create_delivery(
            delivery_id,
            {
                **base_row,
                "status": "auth_failed",
                "lastError": (
                    f"no callbackSecret configured for apiKeyId {api_key_id}; "
                    "the receiver cannot verify an unsigned callback"
                ),
            },
        )
        log.warning(
            "callback not signed: no callbackSecret for apiKeyId=%s event=%s",
            api_key_id,
            event,
        )
        return delivery_id

    await store.create_delivery(delivery_id, {**base_row, "status": "pending"})
    await enqueue_callback_delivery(
        pool,
        delivery_id,
        1,
        defer_seconds=0.0,
        queue_name=settings.CALLBACK_QUEUE_NAME,
    )
    return delivery_id


async def attempt_delivery(
    delivery_id: str,
    attempt: int,
    *,
    store: JobStore,
    pool: ArqRedis,
    settings: Settings,
    client: Optional[httpx.AsyncClient] = None,
) -> str:
    """Perform ONE delivery attempt. Returns the resulting status."""
    row = await store.get_delivery(delivery_id)
    if row is None:
        log.warning("callback delivery %s missing (expired?); aborting", delivery_id)
        return "missing"
    status = row.get("status", "pending")
    if status in {"delivered", "failed", "auth_failed", "dead_letter"}:
        return status

    body = base64.b64decode(row["body"])
    event = row.get("event", "")
    url = row.get("url", "")
    api_key_id = row.get("apiKeyId", "")

    # Re-sign with a fresh timestamp. If the key was rotated out between
    # enqueue and now, the stored signature was minted with a secret the
    # receiver no longer holds, so sending it would be a guaranteed 401 — record
    # the permanent auth failure with a precise reason instead of burning the
    # request.
    secret = resolve_callback_secret(api_key_id, settings)
    if not secret:
        await store.update_delivery(
            delivery_id,
            status="auth_failed",
            attempt=attempt,
            lastError=(
                f"no callbackSecret for apiKeyId {api_key_id} at attempt time "
                "(rotated out?)"
            ),
            updatedAt=now_iso(),
        )
        return "auth_failed"

    signed_at, signature = sign_body(body, secret)
    headers = build_headers(signed_at, signature, event)

    owns_client = client is None
    if client is None:
        client = httpx.AsyncClient(timeout=settings.CALLBACK_TIMEOUT_SECONDS)

    status_code: Optional[int] = None
    network_error: Optional[str] = None
    excerpt = ""
    try:
        response = await client.post(url, content=body, headers=headers)
        status_code = response.status_code
        excerpt = response.text[:RESPONSE_BODY_EXCERPT_LIMIT]
    except Exception as exc:  # httpx raises a family of transport errors
        network_error = f"{type(exc).__name__}: {exc}"
    finally:
        if owns_client:
            await client.aclose()

    outcome = classify_attempt(attempt, status_code, network_error)

    await store.update_delivery(
        delivery_id,
        status=outcome.status,
        attempt=attempt,
        signedAtUnix=signed_at,
        signature=signature,
        responseStatus=status_code if status_code is not None else "",
        responseBodyExcerpt=excerpt,
        lastError=network_error or "",
        lastAttemptAt=now_iso(),
        updatedAt=now_iso(),
    )

    if outcome.status == "pending" and outcome.next_attempt_delay is not None:
        await enqueue_callback_delivery(
            pool,
            delivery_id,
            attempt + 1,
            defer_seconds=outcome.next_attempt_delay,
            # Carry the replay nonce forward so a replayed chain keeps its own
            # job ids and is never deduped against the original run's.
            nonce=row.get("replayNonce", ""),
            queue_name=settings.CALLBACK_QUEUE_NAME,
        )
    elif outcome.status == "dead_letter":
        await store.dead_letter(
            DLQ_CALLBACK,
            {
                "deliveryId": delivery_id,
                "event": event,
                "url": url,
                "org": row.get("org", ""),
                "project": row.get("project", ""),
                "sourceId": row.get("sourceId", ""),
                "attempts": attempt,
                "lastError": network_error or f"HTTP {status_code}",
            },
        )
        log.error(
            "callback dead-lettered deliveryId=%s event=%s after %s attempts",
            delivery_id,
            event,
            attempt,
        )

    return outcome.status
