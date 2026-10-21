"""faster-whisper wrapper — the only module that imports the model runtime.

## Why faster-whisper (CTranslate2)

Judged against the four criteria, in priority order: (1) acceptable on CPU in
local Docker, (2) Spanish accuracy, (3) image size and cold start, (4) a clean
GPU upgrade path that does not change our API.

| option | CPU-viable | Spanish | image | GPU path |
|---|---|---|---|---|
| **faster-whisper** | yes, int8 | Whisper-class | ~1.3 GB, no torch | env flip |
| WhisperX | no, really wants CUDA | same ASR + alignment | ~6 GB with torch + pyannote | already GPU |
| whisper.cpp | yes, lightest | Whisper-class | ~300 MB | rebuild the binary |

**faster-whisper wins on 1, 3 and 4, and ties on 2.** It runs the same Whisper
weights through CTranslate2 with int8 quantisation: roughly 4x the throughput of
`openai-whisper` at a fraction of the memory, and — decisively — it does not
depend on PyTorch, which is what keeps the image around 1.3 GB instead of 6 GB.

**WhisperX is rejected.** What it adds over faster-whisper is wav2vec2 forced
alignment (word-level timestamps) and pyannote diarization (speaker labels).
Neither is needed here: we are producing a text document for a RAG corpus, and
nothing downstream reads word timings or speaker turns. Paying for them means
adding torch, pyannote, a second and third model download, and a HuggingFace
gated-repo acceptance step — and pyannote on CPU is slow enough to make the
local Docker demo unpleasant. ADR-0002 designed for a GPU box that was never
racked; that assumption is the one we are explicitly reversing.

**whisper.cpp is rejected, narrowly.** It is genuinely the lightest option and
would produce the smallest image. It loses on criterion 4: switching it to GPU
means rebuilding the binary against a CUDA backend, i.e. a different image, not
a different env var — which breaks the "same image, CPU locally, GPU on the
fleet" promise this service is built around. Its Python bindings are also
noticeably less maintained than faster-whisper's first-party API.

**On newer models.** NVIDIA's Canary/Parakeet family is genuinely competitive
and in some benchmarks better on Spanish, but it runs on NeMo, which means torch
plus a large framework — the WhisperX cost profile without the WhisperX
maturity. Not for a CPU container. Revisit if we get the GPU box.

## Why `large-v3-turbo` as the default weights

`large-v3-turbo` is `large-v3` with the decoder distilled from 32 layers to 4.
Decoding is several times faster while transcription quality stays close to
`large-v3` (the regression is concentrated in *translation*, which we never
use). Multilingual, so Spanish is first-class — unlike `distil-whisper`, whose
published distillations are English-only and therefore useless to us.

Trade-off, stated plainly: at int8 on CPU it is around 800 MB of weights and
transcribes roughly at or a little faster than real time on ~4 modern cores. A
30-minute recording is therefore a ~20–30 minute job on a laptop. That is fine
for an async queue and a demo; it is not fine for anything interactive, which is
one more reason the streaming half of ADR-0002 stays out of scope. Set
`WHISPER_MODEL=small` for a snappier demo at a real accuracy cost, or flip
`WHISPER_DEVICE=cuda` / `WHISPER_COMPUTE_TYPE=float16` on the fleet for a ~10x
speedup with no other change.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from .config import Settings

log = logging.getLogger("audio-service.transcriber")


@dataclass
class TranscriptPart:
    """One chunk's worth of decoded speech, timestamps still chunk-relative."""

    text: str
    segments: List[Dict[str, Any]]
    language: str
    language_probability: float
    duration: float


class Transcriber:
    """Holds the loaded model. One instance per worker process.

    Loading is explicit (`load()`) rather than lazy-on-first-use because a lazy
    load makes the first job pay a multi-second penalty AND opens a double-init
    race if `MAX_CONCURRENT_JOBS > 1`. The worker calls `load()` at startup and
    only then advertises itself as ready — the same posture as the sibling
    `bge-m3-service` and `rerank-service`.
    """

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._model: Any = None
        self._lock = threading.Lock()

    # ── Lifecycle ───────────────────────────────────────────────────────────
    @property
    def loaded(self) -> bool:
        return self._model is not None

    def load(self) -> None:
        """Construct the WhisperModel. Blocking and CPU-heavy — call off-loop.

        The heavy import is deliberately inside the function so that importing
        this module costs nothing. `app/worker.py` imports it unconditionally,
        including in the CALLBACK worker role, which must never pull CTranslate2
        into memory just to POST a webhook.
        """
        with self._lock:
            if self._model is not None:
                return
            from faster_whisper import WhisperModel  # noqa: PLC0415 (see docstring)

            settings = self.settings
            log.info(
                "loading whisper model=%s device=%s compute_type=%s cpu_threads=%s",
                settings.WHISPER_MODEL,
                settings.WHISPER_DEVICE,
                settings.WHISPER_COMPUTE_TYPE,
                settings.WHISPER_CPU_THREADS or "auto",
            )
            self._model = WhisperModel(
                settings.WHISPER_MODEL,
                device=settings.WHISPER_DEVICE,
                compute_type=settings.WHISPER_COMPUTE_TYPE,
                cpu_threads=settings.WHISPER_CPU_THREADS,
                num_workers=settings.WHISPER_NUM_WORKERS,
                download_root=settings.WHISPER_DOWNLOAD_ROOT,
            )
            log.info("whisper model ready")

    def warmup(self, wav_path: str) -> None:
        """Decode a tiny file so every lazily-mmapped weight page is resolved.

        Without this the first real job pays the page-fault cost mid-transcription
        and the readiness signal lies about how ready we are.
        """
        try:
            self.transcribe(wav_path)
        except Exception as exc:  # pragma: no cover - best effort
            log.warning("warmup decode failed (non-fatal): %s", exc)

    def describe(self) -> Dict[str, Any]:
        return {
            "name": self.settings.WHISPER_MODEL,
            "device": self.settings.WHISPER_DEVICE,
            "computeType": self.settings.WHISPER_COMPUTE_TYPE,
            "backend": "faster-whisper/ctranslate2",
        }

    # ── Inference ───────────────────────────────────────────────────────────
    def transcribe(self, wav_path: str, language: Optional[str] = None) -> TranscriptPart:
        """Decode one 16 kHz mono WAV. BLOCKING — run in a thread executor.

        `segments` comes back from faster-whisper as a *generator*: the decode
        does not actually happen until it is consumed. We consume it fully here
        so that (a) all decode errors surface inside this call rather than
        somewhere up the stack, and (b) the caller's timeout actually bounds the
        work.
        """
        if self._model is None:
            raise RuntimeError("Transcriber.load() was never called")

        settings = self.settings
        resolved_language = language if language is not None else settings.WHISPER_LANGUAGE
        # `""` and the `"auto"` sentinel both mean autodetect; faster-whisper
        # expresses that as `None`. The sentinel exists because a Redis hash
        # cannot distinguish an empty string from an absent field — see the
        # comment in `routes/transcribe.py`.
        language_arg = None if resolved_language in ("", "auto") else resolved_language

        segments_iter, info = self._model.transcribe(
            wav_path,
            language=language_arg,
            beam_size=settings.WHISPER_BEAM_SIZE,
            vad_filter=settings.WHISPER_VAD_FILTER,
            vad_parameters={"min_silence_duration_ms": settings.WHISPER_VAD_MIN_SILENCE_MS},
            condition_on_previous_text=settings.WHISPER_CONDITION_ON_PREVIOUS_TEXT,
            initial_prompt=settings.WHISPER_INITIAL_PROMPT or None,
            word_timestamps=False,
        )

        segments: List[Dict[str, Any]] = []
        pieces: List[str] = []
        for segment in segments_iter:
            text = (segment.text or "").strip()
            if not text:
                continue
            segments.append(
                {
                    "id": len(segments),
                    "start": round(float(segment.start), 3),
                    "end": round(float(segment.end), 3),
                    "text": text,
                    # `no_speech_prob` is the single most useful signal for
                    # spotting hallucinated segments over silence; keeping it
                    # lets a consumer filter without re-running anything.
                    "noSpeechProb": round(float(getattr(segment, "no_speech_prob", 0.0)), 4),
                }
            )
            pieces.append(text)

        return TranscriptPart(
            text=" ".join(pieces),
            segments=segments,
            language=getattr(info, "language", resolved_language) or resolved_language,
            language_probability=float(getattr(info, "language_probability", 0.0) or 0.0),
            duration=float(getattr(info, "duration", 0.0) or 0.0),
        )


def build_transcriber(settings: Settings) -> Any:
    """Pick the backend from `WHISPER_BACKEND`. The worker's only construction point.

    Both backends expose `loaded`, `load()`, `warmup()`, `describe()` and
    `transcribe(path, language) -> TranscriptPart`. The remote module is
    imported lazily so `local` mode never builds an httpx client it does not
    use, and `remote` mode never touches faster-whisper (that import lives
    inside `Transcriber.load`, which remote mode never calls).
    """
    if settings.WHISPER_BACKEND == "remote":
        from .remote_transcriber import RemoteTranscriber  # noqa: PLC0415

        return RemoteTranscriber(settings)
    return Transcriber(settings)
