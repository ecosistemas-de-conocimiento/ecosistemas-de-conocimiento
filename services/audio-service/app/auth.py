"""Bearer-token auth — a line-for-line port of ai-service's `plugins/auth.ts`.

Same env var (`API_KEYS`), same JSON entry shape, same `apiKeyId` derivation
(SHA-256 of the raw key, hex, first 16 chars), same 401 body shape. A consumer
that can talk to ai-service can talk to this service by adding one entry to a
second `API_KEYS` blob — nothing new to learn.

`org` and `project` are ALWAYS taken from the key, never from the request body
or form. That is the same rule ai-service's `/v1/ingest` route enforces, and it
is the load-bearing half of tenant isolation: a caller cannot transcribe "into"
an organization its key does not map to.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Optional

from fastapi import Depends, Request
from fastapi.responses import JSONResponse

from .config import ApiKeyEntry, Settings, get_settings


@dataclass(frozen=True)
class AuthContext:
    """Opaque scoping tags. Never interpreted, only stamped and compared."""

    org: str
    project: str
    role: str
    #: SHA-256(key)[:16]. Safe to log; used to look up the callback secret.
    api_key_id: str


class AuthError(Exception):
    def __init__(self, message: str) -> None:
        self.message = message
        super().__init__(message)


def derive_api_key_id(raw_key: str) -> str:
    """SHA-256(key), hex-encoded, first 16 chars.

    MUST stay identical to ai-service's `deriveApiKeyId` — the callback-secret
    lookup on both sides keys off this value, and an operator reading logs
    should see the same fingerprint for the same key in both services.
    """
    return hashlib.sha256(raw_key.encode("utf-8")).hexdigest()[:16]


def extract_bearer(request: Request) -> Optional[str]:
    header = request.headers.get("authorization")
    if not header:
        return None
    parts = header.split(" ", 1)
    if len(parts) != 2:
        return None
    scheme, token = parts
    if scheme.lower() != "bearer":
        return None
    token = token.strip()
    return token or None


def resolve_entry(token: str, settings: Settings) -> Optional[ApiKeyEntry]:
    return settings.api_keys.get(token)


def resolve_callback_secret(api_key_id: str, settings: Settings) -> Optional[str]:
    """Walk `API_KEYS` and return the `callbackSecret` whose derived id matches.

    Same strategy as ai-service's `resolveCallbackSecret`: we store only the
    fingerprint on the delivery row, so the raw key never lands in Redis. Key
    counts are tiny; a linear scan is cheaper than a cache-invalidation story.
    """
    for raw_key, entry in settings.api_keys.items():
        if derive_api_key_id(raw_key) == api_key_id:
            return entry.callbackSecret
    return None


async def require_auth(
    request: Request, settings: Settings = Depends(get_settings)
) -> AuthContext:
    token = extract_bearer(request)
    if not token:
        raise AuthError("Missing bearer token")
    entry = resolve_entry(token, settings)
    if entry is None:
        raise AuthError("Unknown API key")
    return AuthContext(
        org=entry.org,
        project=entry.project,
        role=entry.role,
        api_key_id=derive_api_key_id(token),
    )


def auth_error_response(exc: AuthError) -> JSONResponse:
    """401 body shape copied from ai-service so consumers parse one shape."""
    return JSONResponse(
        status_code=401,
        content={"error": "unauthorized", "message": exc.message},
    )
