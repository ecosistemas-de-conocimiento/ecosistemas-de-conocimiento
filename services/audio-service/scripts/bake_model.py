"""Download the Whisper weights at BUILD time, into an image layer.

Run from the Dockerfile. The point is that a container start never touches the
network: without this, every fresh container downloads ~800 MB from HuggingFace
before it can transcribe anything, which turns `docker compose up` into a
coffee break and makes the service unusable on a flaky connection or in an
air-gapped environment.

After this runs, the Dockerfile sets `HF_HUB_OFFLINE=1`, so the runtime is
provably offline — a typo in `WHISPER_MODEL` then fails loudly at boot instead
of silently pulling a second model into a container's ephemeral layer.

Sized by the `WHISPER_MODEL` build arg, so `--build-arg WHISPER_MODEL=small`
produces a ~250 MB image variant for constrained demos.
"""

from __future__ import annotations

import os
import sys

MODEL = os.environ.get("WHISPER_MODEL", "large-v3-turbo")
ROOT = os.environ.get("WHISPER_DOWNLOAD_ROOT", "/opt/whisper-cache")
# Bake with the CPU compute type; a GPU deployment re-quantises on load from the
# same fp16/int8 CT2 files, so one baked copy serves both targets.
COMPUTE_TYPE = os.environ.get("WHISPER_BAKE_COMPUTE_TYPE", "int8")


def main() -> int:
    os.makedirs(ROOT, exist_ok=True)
    print(f"[bake] downloading whisper model={MODEL!r} into {ROOT}", flush=True)

    from faster_whisper import WhisperModel

    try:
        from faster_whisper.utils import download_model

        download_model(MODEL, cache_dir=ROOT)
    except Exception as exc:  # noqa: BLE001 - any failure falls through
        # `download_model` is a convenience; constructing the model downloads
        # the same files. Keep going rather than failing the build on an API
        # rename in a patch release.
        print(f"[bake] download_model unavailable/failed ({exc}); "
              f"falling back to model construction", flush=True)

    # Construct once. This proves the files are complete and usable, and it
    # resolves the tokenizer + vocabulary files that `download_model` alone may
    # leave for lazy fetch.
    try:
        model = WhisperModel(
            MODEL, device="cpu", compute_type=COMPUTE_TYPE, download_root=ROOT
        )
    except Exception as exc:
        # The overwhelmingly likely cause is an unrecognised model name. Say so
        # here rather than letting a raw HuggingFace 404 be the build's last
        # word, because the shorthand set varies by faster-whisper version.
        print(
            f"\n[bake] FAILED to resolve WHISPER_MODEL={MODEL!r}: {exc}\n"
            f"[bake] If this is a shorthand your faster-whisper version does not\n"
            f"[bake] know, pass an explicit HuggingFace repo id instead, e.g.:\n"
            f"[bake]   --build-arg WHISPER_MODEL=deepdml/faster-whisper-large-v3-turbo-ct2\n"
            f"[bake]   --build-arg WHISPER_MODEL=Systran/faster-whisper-large-v3\n"
            f"[bake]   --build-arg WHISPER_MODEL=Systran/faster-whisper-small\n",
            file=sys.stderr,
            flush=True,
        )
        raise
    del model
    print(f"[bake] model {MODEL!r} baked into {ROOT}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
