"""Request-body size guard, as raw ASGI middleware.

## Why this exists, and why it cannot live in the route

FastAPI resolves a request in this order:

    1. parse the body        ← `await request.form()` for multipart
    2. solve dependencies    ← `require_auth` runs HERE
    3. call the endpoint     ← our `MAX_UPLOAD_BYTES` counter used to be here

So by the time the route counts a single byte, Starlette has already spooled the
**entire** upload into a `SpooledTemporaryFile` — which rolls over to the system
temp directory past 1 MiB, i.e. onto the container's writable layer, which is
neither the mounted `AUDIO_WORK_DIR` volume nor covered by our sweeper.

Two consequences, both bad:

- **The cap did not cap anything.** It bounded the second copy, after the first
  was already on disk. Peak disk was 2× the upload.
- **Authentication had not happened yet.** Any client with no token at all could
  push arbitrary gigabytes into the container and receive a 401 afterwards.
  That is a denial-of-service with no credential required.

Middleware runs *before* routing, so this is the only place the check can be
both early and unconditional. It is deliberately raw ASGI rather than
`BaseHTTPMiddleware`: the latter wraps the body in a queue and would itself
buffer what we are trying not to buffer.

The route keeps its own counter as a belt-and-braces check against a lying
`Content-Length`, and this middleware counts streamed bytes when the header is
absent (chunked transfer encoding), so all three paths are covered.
"""

from __future__ import annotations

import json
from typing import Any, Awaitable, Callable, Dict

Scope = Dict[str, Any]
Receive = Callable[[], Awaitable[Dict[str, Any]]]
Send = Callable[[Dict[str, Any]], Awaitable[None]]


class BodySizeLimitMiddleware:
    """Reject a request whose body exceeds `max_bytes`, before it is parsed."""

    def __init__(self, app: Any, max_bytes: int, guarded_prefixes: tuple[str, ...] = ("/v1/",)):
        self.app = app
        self.max_bytes = max_bytes
        self.guarded_prefixes = guarded_prefixes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        if not any(path.startswith(prefix) for prefix in self.guarded_prefixes):
            await self.app(scope, receive, send)
            return

        # ── Declared size ────────────────────────────────────────────────────
        declared = _content_length(scope)
        if declared is not None and declared > self.max_bytes:
            await _reject(send, self.max_bytes)
            return

        # ── Streamed size (no Content-Length, i.e. chunked) ──────────────────
        # Wrap `receive` so the counter runs as the server reads, not after.
        state = {"seen": 0, "rejected": False}

        async def counting_receive() -> Dict[str, Any]:
            message = await receive()
            if message.get("type") == "http.request":
                state["seen"] += len(message.get("body", b"") or b"")
                if state["seen"] > self.max_bytes:
                    state["rejected"] = True
                    # Cut the body off. We cannot send our own 413 from here —
                    # the app already owns `send` — so we signal a disconnect
                    # and the request fails fast without the remaining bytes
                    # ever being buffered. The client sees a 4xx/5xx or a
                    # dropped connection rather than our clean 413 envelope.
                    #
                    # That is an acceptable second-best: honest clients send
                    # `Content-Length` and get the clean 413 above. This branch
                    # only catches chunked uploads, where the goal is simply to
                    # stop reading.
                    return {"type": "http.disconnect"}
            return message

        await self.app(scope, counting_receive, send)


def _content_length(scope: Scope) -> int | None:
    for name, value in scope.get("headers", []):
        if name.lower() == b"content-length":
            try:
                return int(value)
            except (TypeError, ValueError):
                return None
    return None


async def _reject(send: Send, max_bytes: int) -> None:
    body = json.dumps(
        {
            "error": "payload_too_large",
            "message": (
                f"Request body exceeds the {max_bytes // (1024 * 1024)} MiB limit"
            ),
        }
    ).encode("utf-8")
    await send(
        {
            "type": "http.response.start",
            "status": 413,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode("ascii")),
                # Tell the client not to keep sending; some will honour it.
                (b"connection", b"close"),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})
