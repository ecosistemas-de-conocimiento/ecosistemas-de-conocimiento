"""The upload allowlist. Advisory gate only — ffprobe is authoritative."""

from __future__ import annotations

import pytest

from app.audio.formats import is_accepted, safe_extension


@pytest.mark.parametrize(
    "filename,content_type",
    [
        ("junta.mp3", "audio/mpeg"),
        ("nota.m4a", "audio/x-m4a"),
        ("nota.m4a", "audio/mp4"),
        # Some browsers send nothing useful for m4a; the extension must carry it.
        ("nota.m4a", ""),
        ("entrevista.wav", "audio/wav"),
        ("clase.ogg", "audio/ogg"),
        ("clase.opus", "audio/opus"),
        # MediaRecorder's default.
        ("grabacion.webm", "audio/webm;codecs=opus"),
        # The audio track of a screen recording.
        ("reunion.mp4", "video/mp4"),
        ("reunion.mov", "video/quicktime"),
        ("archivo.flac", "audio/flac"),
        # curl with no --header sends octet-stream; the extension saves us.
        ("junta.mp3", "application/octet-stream"),
    ],
)
def test_formats_people_actually_upload_are_accepted(filename, content_type):
    accepted, reason = is_accepted(filename, content_type)
    assert accepted, reason


def test_a_known_mime_with_an_unknown_extension_is_accepted():
    # Recorder apps that name files without a suffix.
    assert is_accepted("recording", "audio/mpeg")[0] is True


def test_no_signal_at_all_defers_to_ffprobe():
    assert is_accepted(None, None)[0] is True
    assert is_accepted("", "")[0] is True


@pytest.mark.parametrize(
    "filename,content_type",
    [
        ("informe.pdf", "application/pdf"),
        ("hoja.xlsx", "application/vnd.ms-excel"),
        ("foto.png", "image/png"),
    ],
)
def test_obvious_non_audio_is_rejected_early(filename, content_type):
    accepted, reason = is_accepted(filename, content_type)
    assert accepted is False
    assert "Unsupported audio format" in reason


def test_safe_extension_never_trusts_the_uploaded_name():
    assert safe_extension("../../../etc/passwd") == ".bin"
    assert safe_extension("junta.mp3") == ".mp3"
    assert safe_extension("junta.MP3") == ".mp3"
    assert safe_extension(None) == ".bin"
    # A double extension resolves to the last one only.
    assert safe_extension("evil.mp3.sh") == ".bin"
