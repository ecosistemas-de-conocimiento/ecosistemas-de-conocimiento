"""Accepted upload formats.

Two gates, in order, and the second one is the real one:

1. **Extension / MIME allowlist** — a cheap early reject so we do not write a
   400 MB video to disk before discovering it has no audio track. Advisory only:
   browsers disagree wildly about the MIME type of `.m4a` (`audio/mp4`,
   `audio/x-m4a`, `audio/aac`, or empty), so an unknown MIME with a known
   extension is accepted, and vice versa.

2. **`ffprobe` must find a decodable audio stream** — this is authoritative and
   lives in `ffmpeg.py`. A `.mp3` that is actually a PDF fails here, as does an
   `.mp4` that is video-only.

We accept the audio track of a video container (`mp4`, `mov`, `webm`, `mkv`) on
purpose: people record meetings with a phone or a screen recorder and upload the
video. ffmpeg's `-vn` drops the video stream, so this costs us nothing.
"""

from __future__ import annotations

import os
from typing import Optional, Tuple

#: Extension -> canonical container name, for logging and metadata only.
ACCEPTED_EXTENSIONS = {
    ".mp3": "mp3",
    ".m4a": "m4a",
    ".mp4": "mp4",
    ".m4b": "m4a",
    ".aac": "aac",
    ".wav": "wav",
    ".wave": "wav",
    ".ogg": "ogg",
    ".oga": "ogg",
    ".opus": "opus",
    ".webm": "webm",
    ".flac": "flac",
    ".mkv": "mkv",
    ".mov": "mov",
    ".amr": "amr",
    ".3gp": "3gp",
    ".wma": "wma",
    ".aiff": "aiff",
    ".aif": "aiff",
}

ACCEPTED_MIME_TYPES = {
    "audio/mpeg",
    "audio/mp3",
    "audio/mp4",
    "audio/x-m4a",
    "audio/m4a",
    "audio/aac",
    "audio/wav",
    "audio/x-wav",
    "audio/wave",
    "audio/vnd.wave",
    "audio/ogg",
    "audio/opus",
    "audio/webm",
    "audio/flac",
    "audio/x-flac",
    "audio/amr",
    "audio/3gpp",
    "audio/x-ms-wma",
    "audio/aiff",
    "audio/x-aiff",
    "video/mp4",
    "video/quicktime",
    "video/webm",
    "video/x-matroska",
    "video/3gpp",
    # Some browsers and curl send this for a file input with no sniffed type.
    "application/octet-stream",
}

#: The subset worth putting in an `<input accept="...">` — see the integration
#: spec. Kept here so the frontend list and the server gate have one origin.
WEB_ACCEPT_HINT = (
    "audio/*,.mp3,.m4a,.wav,.ogg,.opus,.webm,.flac,.mp4"
)


def normalise_extension(filename: Optional[str]) -> str:
    if not filename:
        return ""
    return os.path.splitext(filename)[1].lower()


def is_accepted(filename: Optional[str], content_type: Optional[str]) -> Tuple[bool, str]:
    """Advisory gate. Returns `(accepted, reason_if_rejected)`.

    Accepts if EITHER signal is recognised. Rejects only when both are present
    and both are unrecognised — that is the case where we can be confident the
    caller sent the wrong thing, and it costs them a fast 415 instead of a slow
    ffprobe failure.
    """
    extension = normalise_extension(filename)
    mime = (content_type or "").split(";")[0].strip().lower()

    extension_ok = extension in ACCEPTED_EXTENSIONS
    mime_ok = mime in ACCEPTED_MIME_TYPES

    if extension_ok or mime_ok:
        return True, ""

    if not extension and not mime:
        # No signal at all — let ffprobe decide rather than guess.
        return True, ""

    return (
        False,
        f"Unsupported audio format (filename extension {extension or '<none>'!r}, "
        f"content type {mime or '<none>'!r}). Accepted: "
        + ", ".join(sorted(ACCEPTED_EXTENSIONS)),
    )


def safe_extension(filename: Optional[str]) -> str:
    """Extension to use for the on-disk scratch copy.

    Never trusts the uploaded name for anything but this suffix — the file is
    stored under a generated UUID, so a `../../etc/passwd` filename is inert.
    Falls back to `.bin`; ffmpeg sniffs the container anyway.
    """
    extension = normalise_extension(filename)
    if extension in ACCEPTED_EXTENSIONS:
        return extension
    return ".bin"
